import { ConfigService } from '@nestjs/config';

import { AiService } from './ai.service';

const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const reply = (body: unknown, init: ResponseInit = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, ...init }));

describe('AiService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('should refuse when the server has no NVIDIA key', async () => {
    await expect(
      new AiService(config({})).turn('s', [{ role: 'user', text: 'hi' }], []),
    ).rejects.toThrow(/not set up/);
  });

  it('should ask only NVIDIA, with the key in the header and thinking off, and read its tool calls', async () => {
    const fetchMock = jest.fn(() =>
      reply({
        choices: [
          {
            message: {
              content: '<think>x</think>Done.',
              tool_calls: [
                { id: 'c1', function: { name: 'get_plan_summary', arguments: '{"a":1}' } },
              ],
            },
          },
        ],
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const ai = new AiService(config({ NVIDIA_API_KEY: 'k' }));
    const turn = await ai.turn('sys', [{ role: 'user', text: 'hi' }], []);
    expect(turn.text).toBe('Done.');
    expect(turn.calls).toEqual([{ id: 'c1', name: 'get_plan_summary', args: { a: 1 } }]);
    expect(turn.answeredBy.provider).toBe('nvidia');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('integrate.api.nvidia.com');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string).chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
  });

  it('should tell the planner how long to wait when rate limited', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '12' } })),
    ) as unknown as typeof fetch;
    await expect(
      new AiService(config({ NVIDIA_API_KEY: 'k' })).turn('s', [{ role: 'user', text: 'hi' }], []),
    ).rejects.toThrow(/about 12 seconds/);
  });
});
