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

import type { AiConfig } from '../config/configuration';
import { AiProvider } from '../config/env.validation';
import type { AssistantRole } from './dto/assistant.dto';
import type { PlannerTool } from './planner-tools';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Gemini's signature of its reasoning; sent back with the call. */
  signature?: string;
}

/** The conversation, in one shape for every provider. */
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

/** Longest wait for a model's answer. */
const TIMEOUT_MS = 60_000;

/**
 * One turn of the configured model, with tools: Gemini's or Groq's API, or a local Ollama. The
 * key stays on the server and is never logged; failures are reported without it.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly config: AiConfig;

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<AiConfig>('ai');
  }

  async turn(system: string, messages: AgentMessage[], tools: PlannerTool[]): Promise<AgentTurn> {
    const { provider, apiKey } = this.config;
    if (provider !== AiProvider.Ollama && !apiKey) {
      throw new ServiceUnavailableException(
        'The AI assistant is not set up: AI_API_KEY is missing on the server.',
      );
    }
    try {
      const turn =
        provider === AiProvider.Gemini
          ? await this.gemini(system, messages, tools)
          : await this.openAiStyle(system, messages, tools);
      if (!turn.text.trim() && !turn.calls.length) throw new Error('empty answer');
      return { text: turn.text.trim(), calls: turn.calls };
    } catch (error) {
      this.logger.warn(
        `${provider} did not answer: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      if (error instanceof ProviderError && error.status === 429) {
        const wait = error.retryAfter ?? 20;
        // The planner reads the seconds from this sentence and waits that long by itself.
        throw new HttpException(
          `The AI model's free limit is used up for the moment. Try again in about ${wait} seconds.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new BadGatewayException('The AI assistant could not answer just now. Try again.');
    }
  }

  // ---- Gemini ---------------------------------------------------------------------------------

  private async gemini(
    system: string,
    messages: AgentMessage[],
    tools: PlannerTool[],
  ): Promise<AgentTurn> {
    const { model, apiKey } = this.config;
    type Part = Record<string, unknown>;
    const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        const part = {
          functionResponse: { name: m.name ?? 'tool', response: { result: m.result ?? '' } },
        };
        // Answers to one turn's calls go back together.
        const last = contents.at(-1);
        if (last?.role === 'user' && last.parts.every((p) => 'functionResponse' in p)) {
          last.parts.push(part);
        } else {
          contents.push({ role: 'user', parts: [part] });
        }
      } else if (m.role === 'assistant') {
        const parts: Part[] = m.text ? [{ text: m.text }] : [];
        for (const c of m.calls ?? []) {
          parts.push({
            functionCall: { name: c.name, args: c.args },
            ...(c.signature ? { thoughtSignature: c.signature } : {}),
          });
        }
        if (parts.length) contents.push({ role: 'model', parts });
      } else if (m.text) {
        contents.push({ role: 'user', parts: [{ text: m.text }] });
      }
    }
    const body = await this.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': apiKey! },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              // A tool without parameters declares none.
              ...(Object.keys(t.parameters.properties ?? {}).length
                ? { parameters: t.parameters }
                : {}),
            })),
          },
        ],
      },
    );
    const parts =
      (
        body as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
                thought?: boolean;
                thoughtSignature?: string;
                functionCall?: { name: string; args?: Record<string, unknown> };
              }>;
            };
          }>;
        }
      ).candidates?.[0]?.content?.parts ?? [];
    return {
      text: parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join(''),
      calls: parts
        .filter((p) => p.functionCall)
        .map((p) => ({
          id: randomUUID(),
          name: p.functionCall!.name,
          args: p.functionCall!.args ?? {},
          ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}),
        })),
    };
  }

  // ---- Groq and Ollama (the OpenAI chat format) -----------------------------------------------

  private async openAiStyle(
    system: string,
    messages: AgentMessage[],
    tools: PlannerTool[],
  ): Promise<AgentTurn> {
    const { provider, model, apiKey, baseUrl } = this.config;
    const ollama = provider === AiProvider.Ollama;
    const wire = [
      { role: 'system', content: system },
      ...messages.map((m) => {
        if (m.role === 'tool') {
          return ollama
            ? { role: 'tool', content: m.result ?? '', tool_name: m.name }
            : { role: 'tool', tool_call_id: m.callId, content: m.result ?? '' };
        }
        if (m.role === 'assistant' && m.calls?.length) {
          return {
            role: 'assistant',
            content: m.text ?? '',
            tool_calls: m.calls.map((c) => ({
              ...(ollama ? {} : { id: c.id, type: 'function' }),
              function: { name: c.name, arguments: ollama ? c.args : JSON.stringify(c.args) },
            })),
          };
        }
        return { role: m.role, content: m.text ?? '' };
      }),
    ];
    const body = await this.post(
      ollama ? `${baseUrl}/api/chat` : 'https://api.groq.com/openai/v1/chat/completions',
      ollama ? {} : { authorization: `Bearer ${apiKey}` },
      {
        model,
        messages: wire,
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        ...(ollama ? { stream: false } : {}),
      },
    );
    type WireCall = {
      id?: string;
      function?: { name: string; arguments?: string | Record<string, unknown> };
    };
    const message = ollama
      ? (body as { message?: { content?: string; tool_calls?: WireCall[] } }).message
      : (body as { choices?: Array<{ message?: { content?: string; tool_calls?: WireCall[] } }> })
          .choices?.[0]?.message;
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
  private async post(
    url: string,
    headers: Record<string, string>,
    payload: unknown,
  ): Promise<unknown> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
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

/** A provider's refusal, with its status and, when it said, the seconds to wait. */
class ProviderError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfter: number | null,
  ) {
    super(`HTTP ${status} ${detail}`);
  }
}

/** Seconds a rate-limited provider asks to wait: its Retry-After, or "try again in 21.8s". */
function retryAfter(response: Response, detail: string): number | null {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  const said = /try again in ([\d.]+)\s*s/i.exec(detail)?.[1];
  return said ? Math.ceil(Number(said)) : null;
}

/** Tool arguments arrive as a JSON string (Groq) or an object (Ollama); bad JSON is no args. */
function parseArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
