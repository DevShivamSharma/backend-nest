import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { LlmConfig } from '../config/configuration';

export class LlmUnavailableError extends Error {}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
  /** Base64 images, for a vision model. */
  images?: string[];
}

/**
 * Talks to Ollama, the local open-source model server (https://ollama.com). Every answer is
 * requested as JSON following a schema (Ollama "structured outputs"), at temperature 0, with
 * the model's thinking switched off: the answer is checked, never trusted.
 *
 * Nothing leaves the machine the server runs on; there is no key.
 */
@Injectable()
export class OllamaClient {
  private readonly config: LlmConfig;

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<LlmConfig>('llm');
  }

  get configured(): boolean {
    return this.config.baseUrl !== null;
  }

  get textModel(): string {
    return this.config.textModel;
  }

  get visionModel(): string {
    return this.config.visionModel;
  }

  /** The model names installed on the server. */
  async installedModels(): Promise<string[]> {
    const body = (await this.request('/api/tags', undefined, 5_000)) as {
      models?: { name?: unknown }[];
    };
    return (body.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === 'string');
  }

  /** One chat turn whose answer is JSON in the given schema, parsed (still unchecked). */
  async chatJson(model: string, messages: ChatMessage[], schema: object): Promise<unknown> {
    const body = (await this.request(
      '/api/chat',
      {
        model,
        messages,
        format: schema,
        stream: false,
        think: false,
        options: { temperature: 0 },
      },
      this.config.timeoutMs,
    )) as { message?: { content?: unknown } };
    const content = body.message?.content;
    if (typeof content !== 'string') {
      throw new LlmUnavailableError(`${model} gave no answer.`);
    }
    try {
      return JSON.parse(content);
    } catch {
      throw new LlmUnavailableError(`${model} did not answer in JSON.`);
    }
  }

  private async request(path: string, payload: object | undefined, timeoutMs: number) {
    if (!this.config.baseUrl) {
      throw new LlmUnavailableError('No model server is configured (LLM_BASE_URL).');
    }
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method: payload ? 'POST' : 'GET',
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = (error as Error).name === 'TimeoutError' ? 'timed out' : 'cannot be reached';
      throw new LlmUnavailableError(`The model server ${reason}.`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LlmUnavailableError(
        `The model server answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`,
      );
    }
    return (await response.json()) as unknown;
  }
}
