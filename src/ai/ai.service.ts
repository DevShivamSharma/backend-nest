import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { AssistantRole } from './dto/assistant.dto';
import type { PlannerTool } from './planner-tools';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The conversation, in the model's chat format. */
export interface AgentMessage {
  role: AssistantRole;
  text?: string;
  calls?: ToolCall[];
  callId?: string;
  name?: string;
  result?: string;
}

/** The model's next move: words for the person, and tools it wants run first (maybe none). */
export interface AgentTurn {
  text: string;
  calls: ToolCall[];
}

/** Which model gave a turn. */
export interface AnsweredBy {
  provider: 'nvidia';
  model: string;
}

const ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
/** Longest wait for the model's answer. */
const TIMEOUT_MS = 60_000;
/** A rate limit that does not say how long it lasts is waited out this long. */
const COOL_DOWN_S = 30;

/**
 * One turn of the assistant's model, with tools: NVIDIA's hosted model (build.nvidia.com), the
 * only one used. The key (NVIDIA_API_KEY) stays on the server and is never logged or returned;
 * failures are reported without it.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly apiKey: string | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('NVIDIA_API_KEY')?.trim() || null;
    this.model = config.get<string>('NVIDIA_MODEL')?.trim() || DEFAULT_MODEL;
    if (this.apiKey) this.logger.log(`AI model: nvidia ${this.model}`);
  }

  async turn(
    system: string,
    messages: AgentMessage[],
    tools: PlannerTool[],
  ): Promise<AgentTurn & { answeredBy: AnsweredBy }> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'The AI assistant is not set up: the server has no NVIDIA_API_KEY.',
      );
    }
    const started = Date.now();
    try {
      const turn = await this.ask(this.apiKey, system, messages, tools);
      if (!turn.text.trim() && !turn.calls.length) throw new Error('empty answer');
      this.logger.log(
        `AI answered by nvidia ${this.model} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );
      return {
        text: turn.text.trim(),
        calls: turn.calls,
        answeredBy: { provider: 'nvidia', model: this.model },
      };
    } catch (error) {
      this.logger.warn(
        `nvidia ${this.model} did not answer: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      if (error instanceof ProviderError && error.status === 429) {
        // The planner reads the seconds from this sentence and waits that long by itself.
        throw new HttpException(
          `The AI model's limit is used up for the moment. Try again in about ${error.retryAfter ?? COOL_DOWN_S} seconds.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new BadGatewayException('The AI assistant could not answer just now. Try again.');
    }
  }

  private async ask(
    apiKey: string,
    system: string,
    messages: AgentMessage[],
    tools: PlannerTool[],
  ): Promise<AgentTurn> {
    const wire = [
      { role: 'system', content: system },
      ...messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.callId, content: m.result ?? '' };
        }
        if (m.role === 'assistant' && m.calls?.length) {
          return {
            role: 'assistant',
            content: m.text ?? '',
            tool_calls: m.calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          };
        }
        return { role: m.role, content: m.text ?? '' };
      }),
    ];
    const body = (await this.post(apiKey, {
      model: this.model,
      messages: wire,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      // Nemotron thinks first unless told not to; the planner waits on every answer.
      chat_template_kwargs: { enable_thinking: false },
    })) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id?: string; function?: { name: string; arguments?: string } }>;
        };
      }>;
    };
    const message = body.choices?.[0]?.message;
    return {
      // Reasoning models write their thinking first; only the answer is shown and spoken.
      text: (message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, ''),
      calls: (message?.tool_calls ?? [])
        .filter((c) => c.function?.name)
        .map((c) => ({
          id: c.id ?? randomUUID(),
          name: c.function!.name,
          args: parseArgs(c.function!.arguments),
        })),
    };
  }

  /** A JSON POST with a timeout; a non-2xx answer is an error naming only its status. */
  private async post(apiKey: string, payload: unknown): Promise<unknown> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // The provider's own message helps with a wrong model or key; it never contains the key.
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(response.status, detail, retryAfter(response, detail));
    }
    return response.json();
  }
}

/** The provider's refusal, with its status and, when it said, the seconds to wait. */
class ProviderError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfter: number | null,
  ) {
    super(`HTTP ${status} ${detail}`);
  }
}

/** Seconds a rate-limited call asks to wait: its Retry-After, or "try again in 21.8s". */
function retryAfter(response: Response, detail: string): number | null {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  const said = /try again in ([\d.]+)\s*s/i.exec(detail)?.[1];
  return said ? Math.ceil(Number(said)) : null;
}

/** Tool arguments arrive as a JSON string; bad JSON is no args. */
function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
