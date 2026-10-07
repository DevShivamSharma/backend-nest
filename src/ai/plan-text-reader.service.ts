import { Injectable, Logger } from '@nestjs/common';

import { OllamaClient } from './ollama.client';
import {
  distinctTexts,
  IMAGE_TEXT_PROMPT,
  IMAGE_TEXT_SCHEMA,
  ImageText,
  PLAN_TEXT_SYSTEM_PROMPT,
  PlanTextKind,
  planTextAnswerSchema,
  planTextPrompt,
  readImageTextAnswer,
  readPlanTextAnswer,
  ruleKind,
  TEXTS_PER_REQUEST,
} from './plan-texts';

export interface PlanTextReading {
  kind: PlanTextKind;
  /** Who decided: the built-in rules, the local model, or nobody (left as `none`). */
  by: 'rules' | 'model' | 'default';
  /**
   * The person importing should confirm this one: the model's two readings disagreed, or no
   * one could read it. Never set for the rules' answers.
   */
  review: boolean;
}

export interface PlanTextsResult {
  readings: Map<string, PlanTextReading>;
  /** Whether the local model took part, and why not when it did not. */
  model: { used: boolean; name: string | null; note: string | null };
}

/**
 * Says what each text of a floor plan is. The built-in rules answer first; the local model
 * answers for the texts the rules cannot place. When no model server is configured, or it
 * fails, the rules' answers stand and the rest are `none`: a plan always imports.
 *
 * The model reads every batch twice, the second time in reverse order. A small model that is
 * unsure tends to change its answer with the order; where the two readings differ, the text is
 * marked for review instead of being guessed.
 */
@Injectable()
export class PlanTextReaderService {
  private readonly logger = new Logger(PlanTextReaderService.name);

  constructor(private readonly ollama: OllamaClient) {}

  /**
   * `instructions` are the importer's own notes for the model ("the legend is in Hindi"); they
   * only help it choose among the fixed kinds and never override the rules.
   */
  async classify(
    texts: readonly string[],
    options: {
      instructions?: string | null;
      /** Called as the model works through the texts: (done, total). */
      onProgress?: (done: number, total: number) => void;
    } = {},
  ): Promise<PlanTextsResult> {
    const readings = new Map<string, PlanTextReading>();
    const open: string[] = [];
    for (const text of distinctTexts(texts)) {
      const kind = ruleKind(text);
      if (kind) {
        readings.set(text, { kind, by: 'rules', review: false });
      } else {
        open.push(text);
      }
    }

    const model = { used: false, name: null as string | null, note: null as string | null };
    if (open.length && !this.ollama.configured) {
      model.note = 'No local model is configured; texts the rules do not know are left out.';
    } else if (open.length) {
      model.name = this.ollama.textModel;
      try {
        for (let start = 0; start < open.length; start += TEXTS_PER_REQUEST) {
          const batch = open.slice(start, start + TEXTS_PER_REQUEST);
          const first = await this.ask(batch, options.instructions);
          const second = await this.ask([...batch].reverse(), options.instructions);
          for (const text of batch) {
            const a = first.get(text);
            const b = second.get(text);
            const kind = a ?? b;
            if (kind) {
              readings.set(text, { kind, by: 'model', review: a !== b });
            }
          }
          options.onProgress?.(Math.min(open.length, start + batch.length), open.length);
        }
        model.used = true;
      } catch (error) {
        // Answers already read are kept; the rest fall back below.
        model.note = `The local model could not finish: ${(error as Error).message}`;
        this.logger.warn(model.note);
      }
    }

    for (const text of open) {
      if (!readings.has(text)) {
        readings.set(text, { kind: 'none', by: 'default', review: true });
      }
    }
    return { readings, model };
  }

  private async ask(
    batch: readonly string[],
    instructions?: string | null,
  ): Promise<Map<string, PlanTextKind>> {
    const answer = await this.ollama.chatJson(
      this.ollama.textModel,
      [
        { role: 'system', content: PLAN_TEXT_SYSTEM_PROMPT },
        { role: 'user', content: planTextPrompt(batch, instructions) },
      ],
      planTextAnswerSchema(batch.length),
    );
    return readPlanTextAnswer(answer, batch);
  }

  /** Reads the texts off a plan image with the local vision model. */
  async readImage(
    pngBase64: string,
    size: { width: number; height: number },
  ): Promise<ImageText[]> {
    const answer = await this.ollama.chatJson(
      this.ollama.visionModel,
      [{ role: 'user', content: IMAGE_TEXT_PROMPT, images: [pngBase64] }],
      IMAGE_TEXT_SCHEMA,
    );
    return readImageTextAnswer(answer, size);
  }

  /** What the Super Admin console shows about the local models. */
  async status(): Promise<{
    configured: boolean;
    reachable: boolean;
    textModel: { name: string; installed: boolean };
    visionModel: { name: string; installed: boolean };
    note: string | null;
  }> {
    const base = {
      configured: this.ollama.configured,
      textModel: { name: this.ollama.textModel, installed: false },
      visionModel: { name: this.ollama.visionModel, installed: false },
    };
    if (!this.ollama.configured) {
      return { ...base, reachable: false, note: 'Set LLM_BASE_URL to use a local model.' };
    }
    try {
      const installed = new Set(await this.ollama.installedModels());
      const has = (name: string) => installed.has(name) || installed.has(`${name}:latest`);
      return {
        ...base,
        reachable: true,
        textModel: { ...base.textModel, installed: has(base.textModel.name) },
        visionModel: { ...base.visionModel, installed: has(base.visionModel.name) },
        note: null,
      };
    } catch (error) {
      return { ...base, reachable: false, note: (error as Error).message };
    }
  }
}
