import { HttpException, HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { configuration, type AiConfig } from '../config/configuration';
import { AiProvider } from '../config/env.validation';
import { AiService } from './ai.service';

const groq = { provider: AiProvider.Groq, apiKey: 'g', model: 'gpt', baseUrl: 'http://ollama' };
const gemini = {
  provider: AiProvider.Gemini,
  apiKey: 'm',
  model: 'flash',
  baseUrl: 'http://ollama',
};
const ollama = {
  provider: AiProvider.Ollama,
  apiKey: null,
  model: 'qwen',
  baseUrl: 'http://ollama',
};

function service(chain: AiConfig['chain']): AiService {
  const config = { getOrThrow: () => ({ chain, skipped: [] }) } as unknown as ConfigService;
  return new AiService(config);
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const answers = {
  groq: () => json({ choices: [{ message: { content: 'from groq' } }] }),
  gemini: () => json({ candidates: [{ content: { parts: [{ text: 'from gemini' }] } }] }),
  ollama: () => json({ message: { content: 'from ollama' } }),
};
const host = (url: string) =>
  url.includes('groq.com') ? 'groq' : url.includes('googleapis') ? 'gemini' : 'ollama';

describe('AiService fallback', () => {
  let fetchMock: jest.SpyInstance;
  const asked = () => fetchMock.mock.calls.map(([url]) => host(String(url)));
  const ask = (ai: AiService) => ai.turn('system', [{ role: 'user', text: 'hi' }], []);

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('answers with the first model when it can', async () => {
    fetchMock.mockImplementation(async () => answers.groq());
    await expect(ask(service([groq, gemini, ollama]))).resolves.toMatchObject({
      text: 'from groq',
    });
    expect(asked()).toEqual(['groq']);
  });

  it('falls to Gemini when Groq is rate-limited, then to Ollama when Gemini fails', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      host(url) === 'groq'
        ? json({ error: 'Rate limit. Please try again in 12.5s' }, 429)
        : host(url) === 'gemini'
          ? json({ error: 'bad key' }, 401)
          : answers.ollama(),
    );
    await expect(ask(service([groq, gemini, ollama]))).resolves.toMatchObject({
      text: 'from ollama',
    });
    expect(asked()).toEqual(['groq', 'gemini', 'ollama']);
  });

  it('passes over a rate-limited model until its limit resets, without giving it up', async () => {
    const ai = service([groq, gemini]);
    fetchMock.mockImplementation(async (url: string) =>
      host(url) === 'groq' ? json({}, 429, { 'retry-after': '60' }) : answers.gemini(),
    );
    await ask(ai);
    fetchMock.mockClear();
    await expect(ask(ai)).resolves.toMatchObject({ text: 'from gemini' });
    // Gemini first now; Groq rests.
    expect(asked()).toEqual(['gemini']);
  });

  it('says how long to wait when every model is rate-limited', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      json({}, 429, { 'retry-after': host(url) === 'groq' ? '40' : '9' }),
    );
    const error = await ask(service([groq, gemini])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((error as HttpException).message).toContain('about 9 seconds');
  });

  it('reports a failure when no model answers, and an unset assistant when none is set up', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(ask(service([groq, ollama]))).rejects.toMatchObject({ status: 502 });
    await expect(ask(service([]))).rejects.toMatchObject({ status: 503 });
  });
});

describe('AI configuration', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const set = (env: Record<string, string>) => {
    for (const k of Object.keys(process.env)) {
      if (/^(AI_|GROQ_|GEMINI_|LLM_)/.test(k)) delete process.env[k];
    }
    Object.assign(process.env, env);
    return configuration().ai;
  };

  it('keeps the order asked for, each with its own key, and leaves out one without a key', () => {
    const ai = set({
      AI_PROVIDERS: 'groq, gemini ,ollama',
      GROQ_API_KEY: 'g',
      GROQ_MODEL: 'openai/gpt-oss-120b',
      LLM_TEXT_MODEL: 'qwen3:4b',
    });
    expect(ai.chain.map((m) => [m.provider, m.model])).toEqual([
      ['groq', 'openai/gpt-oss-120b'],
      ['ollama', 'qwen3:4b'],
    ]);
    expect(ai.skipped).toEqual(['gemini (no GEMINI_API_KEY)']);
  });

  it('still reads AI_PROVIDER, AI_API_KEY and AI_MODEL alone', () => {
    const ai = set({ AI_PROVIDER: 'groq', AI_API_KEY: 'k', AI_MODEL: 'openai/gpt-oss-20b' });
    expect(ai.chain).toEqual([
      {
        provider: 'groq',
        apiKey: 'k',
        model: 'openai/gpt-oss-20b',
        baseUrl: 'http://127.0.0.1:11434',
      },
    ]);
  });
});
