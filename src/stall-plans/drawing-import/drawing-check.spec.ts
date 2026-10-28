import { ConfigService } from '@nestjs/config';

import type { PageVectors } from '../cad/pdf-vectors';
import { checkPrompt, parseFindings } from './drawing-check';
import { DrawingCheckService } from './drawing-check.service';
import { renderOverlay } from './overlay-image';
import type { ExtractedStall, UnresolvedLabel } from './stall-extraction';

const stall = (key: string, name: string, x: number, y: number): ExtractedStall =>
  ({
    key,
    name,
    outlinePt: [
      { x, z: y },
      { x: x + 30, z: y },
      { x: x + 30, z: y + 30 },
      { x, z: y + 30 },
    ],
  }) as ExtractedStall;

const stalls = [stall('a', '11-01 A', 100, 100), stall('b', '11-01 B', 140, 100)];
const unresolved: UnresolvedLabel[] = [
  { texts: ['11-02 C'], x: 300, y: 300, reason: 'no outline' },
];
const vectors = {
  width: 600,
  height: 600,
  rotation: 0,
  paths: [
    {
      layer: 'L',
      stroke: '#000',
      fill: null,
      width: 1,
      segments: [{ x1: 0, y1: 0, x2: 500, y2: 500 }],
    },
  ],
  texts: [],
  layers: ['L'],
  pageCount: 1,
} as PageVectors;

describe('the drawing check', () => {
  const image = renderOverlay(vectors, stalls, unresolved)!;

  it('should picture the stalls and the labels without one, small enough to send', () => {
    expect(image.jpeg.length).toBeGreaterThan(0);
    expect(image.jpeg.length).toBeLessThanOrEqual(130_000);
    expect(image.scale).toBeGreaterThan(0);
  });

  it('should keep only findings about stalls it knows, and tie a missing stall to a nearby label', () => {
    const centre = {
      x: ((300 - image.originX) * image.scale) / image.width,
      y: ((300 - image.originY) * image.scale) / image.height,
    };
    const answer = `Here you go:\n\`\`\`json\n${JSON.stringify({
      missing: [
        { x: centre.x, y: centre.y, note: 'No outline for C' },
        { x: 2, y: 0.1 },
      ],
      extra: [{ stall: 1, note: 'Not a stall' }, { stall: 99 }, { stall: '99-99 Z' }],
      wrong: [{ stall: '11-01 B' }],
    })}\n\`\`\``;

    const found = parseFindings(answer, stalls, unresolved, image, 40);

    expect(found.map((f) => [f.kind, f.stallKey])).toEqual([
      ['missing', null],
      ['extra', 'a'],
      ['wrong', 'b'],
    ]);
    expect(found[0].unresolved).toBe(0);
    expect(found[0].at!.x).toBeCloseTo(300, 0);
  });

  it('should read nothing from an answer that is not JSON', () => {
    expect(parseFindings('looks fine to me', stalls, unresolved, image, 40)).toEqual([]);
    expect(checkPrompt(['A', 'B'])).toContain('1 = A; 2 = B');
  });
});

describe('DrawingCheckService', () => {
  const config = (values: Record<string, string>) =>
    ({ get: (k: string) => values[k] }) as unknown as ConfigService;
  const real = global.fetch;
  afterEach(() => {
    global.fetch = real;
  });

  it('should skip without a key', async () => {
    const out = await new DrawingCheckService(config({})).check(null, stalls, unresolved, 1);
    expect(out.status).toBe('skipped');
  });

  it('should send the picture to the vision model, and report a failure without throwing', async () => {
    const image = renderOverlay(vectors, stalls, unresolved)!;
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"missing":[],"extra":[],"wrong":[]}' } }],
          }),
        ),
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new DrawingCheckService(config({ NVIDIA_API_KEY: 'k' }));

    const ok = await service.check(image, stalls, unresolved, 1);
    expect(ok).toMatchObject({
      status: 'done',
      model: 'meta/llama-3.2-90b-vision-instruct',
      findings: [],
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).messages[0].content).toContain(
      '<img src="data:image/jpeg;base64,',
    );

    global.fetch = jest.fn(() =>
      Promise.resolve(new Response('no', { status: 500 })),
    ) as unknown as typeof fetch;
    expect((await service.check(image, stalls, unresolved, 1)).status).toBe('failed');
  });
});
