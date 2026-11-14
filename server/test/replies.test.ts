import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

// Replies: opt-outs and legal wording are decided in code, the rest is classified, answers are drafted
// for approval only, and a deal stage can be set.

let classes: { index: number; class: string; reason: string }[] = [];
let draft = '';
let failAi = false;
const bodies: string[] = [];
const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
  const body = String(init!.body);
  bodies.push(body);
  if (failAi) return new Response('boom', { status: 500 });
  const content = body.includes('"classify_reply"')
    ? JSON.stringify({ replies: classes })
    : JSON.stringify({ reply: draft });
  return new Response(
    JSON.stringify({
      model: 'anthropic/claude-sonnet-5.5',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 100, cost: 0.005 },
    }),
  );
});
const { app, db } = await makeApp(fetchMock);
let token = '';
afterAll(async () => {
  await app.close();
  await db.end();
});
const auth = () => ({ authorization: `Bearer ${token}` });
const post = (url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: payload as object });
const person = (id: number) =>
  owner((c) =>
    c.query(
      `select stage, reply_outcome, reply_priority, reply_reason, deal_stage from outreach.prospects where id = $1`,
      [id],
    ),
  ).then((r) => r.rows[0]);
const replyRow = (id: number) =>
  owner((c) =>
    c.query(
      `select status, message_text, approved_via from outreach.action_queue where prospect_id = $1 and action = 'reply'`,
      [id],
    ),
  ).then((r) => r.rows[0]);

const DRAFT =
  'Guten Tag Lena,\n\ndanke für die Rückmeldung. Nach dem Jahreswechsel passt gut, ich melde mich dann bei Ihnen.\n\nBeste Grüße\nJibran';

beforeEach(async () => {
  fetchMock.mockClear();
  bodies.length = 0;
  failAi = false;
  draft = DRAFT;
  classes = [
    { index: 0, class: 'later', reason: 'asks to talk after the new year' },
    { index: 1, class: 'not_interested', reason: 'says there is no need' },
  ];
  await resetData();
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
  await owner(async (c) => {
    await c.query(
      `delete from outreach.action_queue; delete from outreach.events; delete from outreach.candidates; delete from outreach.prospects`,
    );
    await c.query(`update outreach.settings set value = 'true' where key = 'auto_approve'`);
    await c.query(`delete from outreach.campaign_actions where campaign_id = 'test-camp'`);
    await c.query(`delete from outreach.campaigns where id = 'test-camp'`);
    await c.query(
      `insert into outreach.campaigns (id, name, status) values ('test-camp', 'Test', 'on')`,
    );
    await c.query(
      `insert into outreach.prospects (id, linkedin_url, full_name, first_name, company, stage, campaign_id, replied_at, reply_snippet) values
        (9401, 'https://www.linkedin.com/in/later-l/', 'Lena Later', 'Lena', 'Z', 'replied', 'test-camp', now() - interval '1 day', 'Hallo, gerne nach dem Jahreswechsel noch einmal.'),
        (9402, 'https://www.linkedin.com/in/nobody-n/', 'Nora Nein', 'Nora', 'W', 'replied', 'test-camp', now() - interval '2 days', 'Danke, aktuell kein Bedarf.'),
        (9403, 'https://www.linkedin.com/in/opt-o/', 'Olga Out', 'Olga', 'X', 'replied', 'test-camp', now() - interval '3 days', 'Bitte keine weiteren Nachrichten.'),
        (9404, 'https://www.linkedin.com/in/legal-l/', 'Lars Legal', 'Lars', 'Y', 'replied', 'test-camp', now() - interval '4 days', 'Woher haben Sie meine Daten? Das geht an meinen Anwalt.')`,
    );
    await c.query(`delete from outreach.action_queue`);
  });
});

describe('replies step', () => {
  it('blocks opt-outs, hands legal wording to Jibran, drafts for "later" and leaves a no alone', async () => {
    const r = (await post('/panel/replies/process')).json();
    expect(r).toMatchObject({
      seen: 4,
      blocked: 1,
      for_jibran: 1,
      drafted: 1,
      no_answer: 1,
      deferred: 0,
    });
    // the model never saw the two that code decided
    expect(bodies.join(' ')).not.toMatch(/Olga Out|Lars Legal/);
    expect(await person(9403)).toMatchObject({ stage: 'blacklisted', reply_outcome: 'opt_out' });
    expect(await person(9404)).toMatchObject({
      stage: 'replied',
      reply_outcome: 'needs_jibran',
      reply_priority: 1,
    });
    expect(await replyRow(9404)).toBeUndefined();
    expect(await person(9402)).toMatchObject({
      reply_outcome: 'not_interested',
      reply_priority: 3,
    });
    expect(await replyRow(9402)).toBeUndefined();
    // the draft waits for approval even with auto_approve on
    expect(await person(9401)).toMatchObject({ reply_outcome: 'not_now', reply_priority: 2 });
    expect(await replyRow(9401)).toMatchObject({
      status: 'proposed',
      message_text: DRAFT,
      approved_via: null,
    });
    // a second call finds nothing new
    fetchMock.mockClear();
    expect((await post('/panel/replies/process')).json()).toMatchObject({ seen: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists the inbox, approves an edited answer after the checks and sets a deal stage', async () => {
    await post('/panel/replies/process');
    const inbox = (
      await app.inject({ method: 'GET', url: '/panel/replies', headers: auth() })
    ).json();
    expect(inbox.items.map((x: { id: number }) => x.id)).toEqual([9404, 9401]);
    expect(inbox.items[1]).toMatchObject({ outcome: 'not_now', draft_status: 'proposed' });
    expect(inbox.counts).toMatchObject({ unclassified: 0, needs_jibran: 1 });
    const queue = (
      await app.inject({ method: 'GET', url: '/panel/queue', headers: auth() })
    ).json();
    expect(queue.find((x: { prospect_id: number }) => x.prospect_id === 9401)).toMatchObject({
      action: 'reply',
      reply_outcome: 'not_now',
    });
    expect((await post('/panel/replies/9401', { action: 'approve', text: ' ' })).statusCode).toBe(
      422,
    );
    const ok = await post('/panel/replies/9401', {
      action: 'approve',
      text: DRAFT.replace('passt gut', 'passt mir gut'),
    });
    expect(ok.statusCode).toBe(200);
    expect(await replyRow(9401)).toMatchObject({ status: 'approved', approved_via: 'dashboard' });
    await post('/panel/replies/9404', { action: 'answered' });
    await post('/panel/deals/9401', { stage: 'meeting', note: 'Call am 18.11.' });
    expect(await person(9401)).toMatchObject({ deal_stage: 'meeting' });
    const deals = (
      await app.inject({ method: 'GET', url: '/panel/replies?filter=deals', headers: auth() })
    ).json();
    expect(deals.items.map((x: { id: number }) => x.id)).toEqual([9401]);
    expect((await post('/panel/deals/9401', { stage: 'someday' })).statusCode).toBe(400);
  });

  it('leaves replies for the next call when the AI is not available', async () => {
    failAi = true;
    const r = (await post('/panel/replies/process')).json();
    expect(r).toMatchObject({ blocked: 1, for_jibran: 1, drafted: 0 });
    expect(r.deferred).toBe(2);
    expect((await person(9401)).reply_outcome).toBeNull();
  });
});
