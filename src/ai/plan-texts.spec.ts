import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';

import type { LlmConfig } from '../config/configuration';
import { OllamaClient } from './ollama.client';
import { PlanTextReaderService } from './plan-text-reader.service';
import {
  distinctTexts,
  planTextAnswerSchema,
  planTextPrompt,
  readImageTextAnswer,
  readPlanTextAnswer,
  ruleKind,
} from './plan-texts';

const row = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/itpo', name), 'utf8')).data[0];

interface EvalCase {
  text: string;
  kind: string;
  source: string;
}
const evalCases = JSON.parse(
  readFileSync(join(__dirname, '../../test/fixtures/plan-texts/eval.json'), 'utf8'),
) as EvalCase[];

describe('plan text rules', () => {
  it('know every gate, exit and toilet code on ITPO plans', () => {
    const wrong = ['hall-14ff.json', 'hall-8-9-10.json']
      .flatMap((name) => (row(name).exit_labels as { text: string }[]).map((l) => l.text))
      .filter((text) => ruleKind(text) !== 'label')
      .map((text) => `${text} -> ${ruleKind(text)}`);
    expect(wrong).toEqual([]);
  });

  it('know every facility ITPO draws as an icon', () => {
    const expected: Record<string, string> = {
      'Toilet (Male)': 'icon:toilet-male',
      'Toilet (Female)': 'icon:toilet-female',
      'Stairs/Elevators': 'icon:stairs',
      'Emergency Exit': 'icon:emergency-exit',
      'Cargo/Service Entry': 'icon:cargo-truck',
      'Drinking Water': 'icon:drinking-water',
      'Circulation Area': 'icon:circulation',
      'Entry from Hall 12 & Metro': 'icon:entry',
    };
    const wrong = Object.entries(expected)
      .filter(([text, kind]) => ruleKind(text) !== kind)
      .map(([text]) => `${text} -> ${ruleKind(text)}`);
    expect(wrong).toEqual([]);
  });

  it('read legend rows as the area they explain', () => {
    expect(ruleKind('Fire curtains (No construction zone below)')).toBe('area:fire_curtain');
    expect(ruleKind('Compulsory passage for entry/exit/services')).toBe('area:passage');
    expect(ruleKind('NC - No Construction Zone')).toBe('area:no_build');
    expect(ruleKind('Columns')).toBe('area:column');
    expect(ruleKind('Electrical panel')).toBe('area:utility');
    expect(ruleKind('Area not available for exhibitions')).toBe('area:unavailable');
    expect(ruleKind('Main entry/exit')).toBe('area:entry');
  });

  it('keep stall numbers, sizes and title blocks off the plan', () => {
    for (const text of ['12A-27', '5G-12', 'N3-05', 'B', 'b', '95&96', 'B & C', 'Vending-07']) {
      expect([text, ruleKind(text)]).toEqual([text, 'stall_number']);
    }
    for (const text of ['3m', '9 sqm', '12x6', '23.50', '9m²', '4500']) {
      expect([text, ruleKind(text)]).toEqual([text, 'dimension']);
    }
    for (const text of [
      'GROUND FLOOR PLAN',
      'Scale 1:500',
      'Hall 5 Layout - IITF 2026',
      'GF4-1:',
    ]) {
      expect([text, ruleKind(text)]).toEqual([text, 'title']);
    }
  });

  it('do not mistake facilities or typos for codes', () => {
    expect(ruleKind('WC')).toBe('icon:toilet');
    expect(ruleKind('FOVER 5F')).toBe('label');
    expect(ruleKind('FOYER-14F')).toBe('label');
  });

  it('leave unknown wording to the model', () => {
    expect(ruleKind('Guardarropa')).toBeUndefined();
    expect(ruleKind('Zona de descanso')).toBeUndefined();
  });

  it('are right on at least 99% of ITPO’s own texts, and never put them on the wrong layer', () => {
    const layer = (kind: string | undefined) =>
      !kind || kind === 'none'
        ? 'unknown'
        : kind.startsWith('icon:')
          ? 'icons'
          : kind.startsWith('area:')
            ? 'legend'
            : kind === 'label'
              ? 'labels'
              : 'off-plan';
    const itpo = evalCases.filter((c) => c.source.startsWith('itpo'));
    const exact = itpo.filter((c) => ruleKind(c.text) === c.kind).length;
    const misplaced = itpo.filter(
      (c) => layer(ruleKind(c.text)) !== 'unknown' && layer(ruleKind(c.text)) !== layer(c.kind),
    );
    expect(exact / itpo.length).toBeGreaterThanOrEqual(0.99);
    expect(misplaced.map((c) => c.text)).toEqual([]);
  });

  it('collapse whitespace and drop duplicates', () => {
    expect(distinctTexts(['  GF4-1 ', 'GF4-1', 'Foyer\n B', ''])).toEqual(['GF4-1', 'Foyer B']);
  });
});

describe('model answers', () => {
  const texts = ['Guardarropa', 'Ascensor norte', 'Zona de descanso'];

  it('number the texts, and pass the importer’s notes on, fenced and capped', () => {
    expect(planTextPrompt(texts)).toBe(
      'Texts (3):\n1. "Guardarropa"\n2. "Ascensor norte"\n3. "Zona de descanso"',
    );
    const withNotes = planTextPrompt(texts, `Legend is in Spanish. ${'x'.repeat(2000)}`);
    expect(withNotes).toMatch(/^Notes from the person importing/);
    expect(withNotes).toContain('Legend is in Spanish.');
    expect(withNotes.length).toBeLessThan(1300);
  });

  it('ask for every text copied back with one known kind', () => {
    expect(planTextAnswerSchema(3)).toMatchObject({
      properties: {
        answers: {
          minItems: 3,
          maxItems: 3,
          items: { properties: { kind: { enum: expect.arrayContaining(['label']) } } },
        },
      },
    });
  });

  it('accept answers about the right text, skipping unknown kinds and lost places', () => {
    const answer = {
      answers: [
        { text: 'guardarropa ', kind: 'label' },
        { text: 'Ascensor norte', kind: 'icon:teleporter' },
        { text: 'Something else', kind: 'none' },
      ],
    };
    expect([...readPlanTextAnswer(answer, texts)]).toEqual([['Guardarropa', 'label']]);
  });

  it('refuse a list of the wrong length whole', () => {
    const two = { answers: texts.slice(0, 2).map((text) => ({ text, kind: 'label' })) };
    expect(readPlanTextAnswer(two, texts).size).toBe(0);
    expect(readPlanTextAnswer('nonsense', texts).size).toBe(0);
  });

  it('keep only image texts whose box lies inside the image', () => {
    const answer = {
      texts: [
        { text: 'GF4-1', x: 10, y: 10, width: 40, height: 12 },
        { text: 'Outside', x: 990, y: 10, width: 40, height: 12 },
        { text: '', x: 1, y: 1, width: 5, height: 5 },
        { text: 'Bad', x: 'a', y: 1, width: 5, height: 5 },
      ],
    };
    expect(readImageTextAnswer(answer, { width: 1000, height: 800 })).toEqual([
      { text: 'GF4-1', x: 10, y: 10, width: 40, height: 12 },
    ]);
  });
});

describe('PlanTextReaderService', () => {
  const llm = (baseUrl: string | null): LlmConfig => ({
    baseUrl,
    textModel: 'qwen3:4b',
    visionModel: 'qwen3-vl:4b',
    timeoutMs: 5_000,
  });
  const reader = (baseUrl: string | null) =>
    new PlanTextReaderService(
      new OllamaClient({ getOrThrow: () => llm(baseUrl) } as unknown as ConfigService),
    );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  afterEach(() => jest.restoreAllMocks());

  it('works from the rules alone when no model is configured', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const result = await reader(null).classify(['GF4-1', 'Guardarropa']);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.readings.get('GF4-1')).toEqual({ kind: 'label', by: 'rules', review: false });
    expect(result.readings.get('Guardarropa')).toEqual({
      kind: 'none',
      by: 'default',
      review: true,
    });
    expect(result.model).toMatchObject({ used: false, note: expect.stringMatching(/configured/) });
  });

  it('asks the local model only about texts the rules do not know, with the notes', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () =>
      json({
        message: {
          content: JSON.stringify({ answers: [{ text: 'Guardarropa', kind: 'label' }] }),
        },
      }),
    );
    const result = await reader('http://ollama.test').classify(['Toilet (Male)', 'Guardarropa'], {
      instructions: 'Spanish plan',
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://ollama.test/api/chat');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toMatchObject({ model: 'qwen3:4b', stream: false, think: false });
    expect(sent.format.properties.answers.maxItems).toBe(1);
    expect(sent.messages[1].content).toContain('Spanish plan');
    expect(sent.messages[1].content).toContain('1. "Guardarropa"');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.readings.get('Guardarropa')).toEqual({
      kind: 'label',
      by: 'model',
      review: false,
    });
    expect(result.readings.get('Toilet (Male)')).toMatchObject({ kind: 'icon:toilet-male' });
    expect(result.model).toEqual({ used: true, name: 'qwen3:4b', note: null });
  });

  it('marks a text for review when the two readings disagree', async () => {
    const answers = [
      {
        answers: [
          { text: 'Guardarropa', kind: 'label' },
          { text: 'Zona X', kind: 'none' },
        ],
      },
      {
        answers: [
          { text: 'Zona X', kind: 'none' },
          { text: 'Guardarropa', kind: 'none' },
        ],
      },
    ];
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () =>
        json({ message: { content: JSON.stringify(answers.shift()) } }),
      );
    const result = await reader('http://ollama.test').classify(['Guardarropa', 'Zona X']);

    // Second reading is reversed: ['Zona X', 'Guardarropa'] -> Guardarropa read as 'none'.
    expect(result.readings.get('Guardarropa')).toEqual({
      kind: 'label',
      by: 'model',
      review: true,
    });
    expect(result.readings.get('Zona X')).toEqual({ kind: 'none', by: 'model', review: false });
  });

  it('still answers when the model server is down', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const result = await reader('http://ollama.test').classify(['Guardarropa']);

    expect(result.readings.get('Guardarropa')).toEqual({
      kind: 'none',
      by: 'default',
      review: true,
    });
    expect(result.model.note).toMatch(/cannot be reached/);
  });

  it('reports which models are installed', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(json({ models: [{ name: 'qwen3:4b' }, { name: 'llama3.2:latest' }] }));
    await expect(reader('http://ollama.test').status()).resolves.toMatchObject({
      reachable: true,
      textModel: { name: 'qwen3:4b', installed: true },
      visionModel: { name: 'qwen3-vl:4b', installed: false },
    });
  });
});
