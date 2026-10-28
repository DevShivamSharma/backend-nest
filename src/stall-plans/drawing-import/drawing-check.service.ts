import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type AiCheck, checkPrompt, parseFindings } from './drawing-check';
import type { OverlayImage } from './overlay-image';
import type { ExtractedStall, UnresolvedLabel } from './stall-extraction';

const ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_MODEL = 'meta/llama-3.2-90b-vision-instruct';
const TIMEOUT_MS = 60_000;

/**
 * A second look at a plan read from a drawing: NVIDIA's vision model is shown the drawing with the
 * found stalls laid over it and says what looks missing, extra or wrong. It only advises; where a
 * stall stands is the geometry's. Never fails the import: without a key, or when the model does not
 * answer, the check is skipped or reported as failed.
 */
@Injectable()
export class DrawingCheckService {
  private readonly logger = new Logger(DrawingCheckService.name);
  private readonly apiKey: string | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('NVIDIA_API_KEY')?.trim() || null;
    this.model = config.get<string>('NVIDIA_VISION_MODEL')?.trim() || DEFAULT_MODEL;
  }

  async check(
    image: OverlayImage | null,
    stalls: readonly ExtractedStall[],
    unresolved: readonly UnresolvedLabel[],
    /** Page points per metre: a label within a few metres of the spot is the same one. */
    pitch: number,
  ): Promise<AiCheck> {
    if (!this.apiKey) {
      return {
        status: 'skipped',
        model: null,
        findings: [],
        message: 'No NVIDIA key on the server.',
      };
    }
    if (!image || !stalls.length) {
      return { status: 'skipped', model: null, findings: [], message: 'Nothing to look at.' };
    }
    try {
      const picture = `<img src="data:image/jpeg;base64,${image.jpeg.toString('base64')}" />`;
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'user', content: `${checkPrompt(stalls.map((s) => s.name))}\n\n${picture}` },
          ],
          max_tokens: 1200,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = body.choices?.[0]?.message?.content ?? '';
      return {
        status: 'done',
        model: this.model,
        findings: parseFindings(text, stalls, unresolved, image, 4 * pitch),
      };
    } catch (error) {
      this.logger.warn(
        `Drawing check by ${this.model} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return {
        status: 'failed',
        model: this.model,
        findings: [],
        message: 'The check did not answer.',
      };
    }
  }
}
