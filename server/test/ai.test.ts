import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

let nextResponse: () => Response;
const fetchMock = vi.fn<FetchLike>(async () => nextResponse());
const { app, db } = await makeApp(fetchMock);
let token = '';
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(async () => {
  fetchMock.mockClear();
  await resetData();
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
});

const ok = (content: unknown, cost = 0.0001) =>
  new Response(
    JSON.stringify({
      model: 'openai/gpt-4o-mini',
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, cost },
    }),
    { status: 200 },
  );

const ping = () =>
  app.inject({
    method: 'POST',
    url: '/ai/ping',
    headers: { authorization: `Bearer ${token}` },
    payload: { input: { word: 'hi' } },
  });

describe('ai proxy', () => {
  it('sends the strict schema and privacy routing, and logs the call without input', async () => {
    nextResponse = () => ok({ pong: true, echo: 'hi' });
    const res = await ping();
    expect(res.statusCode).toBe(200);
    expect(res.json().output).toEqual({ pong: true, echo: 'hi' });

    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(sent.provider).toEqual({ require_parameters: true, data_collection: 'deny', zdr: true });
    expect(sent).not.toHaveProperty('temperature');

    const rows = await owner((c) =>
      c.query('select task, ok, cost_usd::float as cost from outreach.ai_calls'),
    );
    expect(rows.rows).toEqual([{ task: 'ping', ok: true, cost: 0.0001 }]);
  });

  it('retries schema failures twice, logs each, then gives up', async () => {
    nextResponse = () => ok({ pong: false });
    const res = await ping();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/needs human/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const rows = await owner((c) =>
      c.query('select ok, error from outreach.ai_calls order by created_at'),
    );
    expect(rows.rows.map((r) => r.ok)).toEqual([false, false, false]);
    expect(rows.rows[2].error).toMatch(/attempt 3/);
  });

  it('retries server errors, logs every attempt, then reports the failure', async () => {
    nextResponse = () => new Response('boom', { status: 500 });
    const res = await ping();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/AI call failed: OpenRouter HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const rows = await owner((c) => c.query('select ok from outreach.ai_calls'));
    expect(rows.rows).toEqual([{ ok: false }, { ok: false }, { ok: false }]);
  });

  it('does not retry a request error (4xx)', async () => {
    nextResponse = () => new Response('{"error":{"message":"bad"}}', { status: 400 });
    expect((await ping()).statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops when the daily budget is used up', async () => {
    await owner((c) =>
      c.query(`update outreach.settings set value = '0.0001' where key = 'ai_daily_budget_usd'`),
    );
    nextResponse = () => ok({ pong: true, echo: 'hi' }, 0.0001);
    expect((await ping()).statusCode).toBe(200);
    expect((await ping()).statusCode).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown tasks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ai/nope',
      headers: { authorization: `Bearer ${token}` },
      payload: { input: {} },
    });
    expect(res.statusCode).toBe(404);
  });
});
