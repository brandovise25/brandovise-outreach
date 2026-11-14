import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, owner, resetData } from './helpers.ts';

const { app, db } = await makeApp();
afterAll(async () => {
  await app.close();
  await db.end();
});

const TOKEN = 'test-api-token-0123456789abcdef0123456789';
let rpcId = 0;
async function mcp(method: string, params: unknown = {}, token = TOKEN) {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'x-api-token': token,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
  });
  return res;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await mcp('tools/call', { name, arguments: args });
  expect(res.statusCode).toBe(200);
  const r = res.json().result as { content: { text: string }[]; isError?: boolean };
  const text = r.content[0]!.text;
  return { isError: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
}

const GOOD =
  'Anna, die Zuordnung zum richtigen Vertrag ist der Teil, der im Innendienst die meiste Zeit frisst.\n\nWie viele der Mails landen bei Ihnen heute schon ohne Handarbeit in der richtigen Akte?';

beforeEach(async () => {
  await resetData();
  await owner(async (c) => {
    await c.query('delete from outreach.engagement');
    await c.query(
      `delete from outreach.action_queue; delete from outreach.events; delete from outreach.prospects`,
    );
    await c.query(
      `insert into outreach.engagement (id, post_url, author_name, comment_draft, status) values
      (9501, 'https://www.linkedin.com/feed/update/urn:li:activity:9501/', 'Anna Muster', $1, 'drafted'),
      (9502, 'https://www.linkedin.com/feed/update/urn:li:activity:9502/', 'Bernd Beispiel', 'Toller Beitrag #KI', 'drafted')`,
      [GOOD],
    );
    await c.query(`delete from outreach.campaigns where id = 'mcp-camp'`);
    await c.query(
      `insert into outreach.campaigns (id, name, status) values ('mcp-camp', 'MCP', 'on')`,
    );
    await c.query(`insert into outreach.prospects (id, linkedin_url, full_name, first_name, stage, campaign_id) values
      (9601, 'https://www.linkedin.com/in/hans-b/', 'Hans Bittner', 'Hans', 'approved', 'mcp-camp')`);
    await c.query(`insert into outreach.action_queue (id, prospect_id, campaign_id, action, message_text, due_at, status) values
      (7601, 9601, 'mcp-camp', 'connect', null, now(), 'proposed')`);
  });
});

const comment = (id: number) =>
  owner((c) =>
    c.query('select status, reviewed_via, comment_draft from outreach.engagement where id = $1', [
      id,
    ]),
  ).then((r) => r.rows[0]);
const queueRow = (id: number) =>
  owner((c) =>
    c.query('select status, approved_via from outreach.action_queue where id = $1', [id]),
  ).then((r) => r.rows[0]);

describe('MCP server', () => {
  it('refuses a wrong token', async () => {
    expect((await mcp('tools/list', {}, 'wrong')).statusCode).toBe(401);
  });

  it('answers the handshake with its name and the safety instructions', async () => {
    const res = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(res.json().result).toMatchObject({ serverInfo: { name: 'brandovise-outreach' } });
    expect(res.json().result.instructions).toMatch(
      /ask_user_in_chat[\s\S]*untrusted|untrusted[\s\S]*ask_user_in_chat/,
    );
  });

  it('lists the tools and marks the review tools as not read-only', async () => {
    const res = await mcp('tools/list');
    const tools = res.json().result.tools as {
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }[];
    const names = tools.map((t) => t.name);
    for (const n of [
      'status',
      'report',
      'list_comments',
      'list_queue',
      'review_comment',
      'review_queue',
      'review_lead',
      'start_job',
    ])
      expect(names).toContain(n);
    expect(tools.find((t) => t.name === 'review_comment')!.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'report')!.annotations?.readOnlyHint).toBe(true);
  });

  it('asks in chat before approving a comment, and approves only with user_confirmed', async () => {
    const first = await call('review_comment', { id: 9501, decision: 'approve' });
    expect(first.data).toMatchObject({
      step: 'ask_user_in_chat',
      changed: false,
      would: { text: GOOD },
    });
    expect((await comment(9501)).status).toBe('drafted');

    const second = await call('review_comment', {
      id: 9501,
      decision: 'approve',
      user_confirmed: true,
    });
    expect(second.isError).toBe(false);
    expect(await comment(9501)).toMatchObject({ status: 'approved', reviewed_via: 'mcp' });
  });

  it('refuses to approve a comment that breaks the rules, and rejects without asking', async () => {
    const r = await call('review_comment', { id: 9502, decision: 'approve', user_confirmed: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not approvable/);
    expect((await comment(9502)).status).toBe('drafted');

    await call('review_comment', { id: 9502, decision: 'reject' });
    expect(await comment(9502)).toMatchObject({ status: 'rejected', reviewed_via: null });
  });

  it('asks before approving an invite and marks it as approved via mcp', async () => {
    const first = await call('review_queue', { id: 7601, decision: 'approve' });
    expect(first.data).toMatchObject({
      step: 'ask_user_in_chat',
      would: { action: 'approve connect', person: 'Hans Bittner' },
    });
    expect((await queueRow(7601)).status).toBe('proposed');

    await call('review_queue', { id: 7601, decision: 'approve', user_confirmed: true });
    expect(await queueRow(7601)).toMatchObject({ status: 'approved', approved_via: 'mcp' });
  });

  it('returns the report numbers', async () => {
    const r = await call('report', { weeks: 2 });
    expect(r.data).toHaveProperty('campaigns');
    expect(r.data).toHaveProperty('weekly');
    expect(r.data).toHaveProperty('replies_waiting');
    expect(r.data.comments).toMatchObject({ drafted: 2 });
  });

  it('changes a setting only after the yes in chat, validated like the Settings page', async () => {
    const bad = await call('set_setting', { key: 'job_hours', value: { from: 9, to: 8 } });
    expect(bad.isError).toBe(true);

    const first = await call('set_setting', { key: 'job_hours', value: { from: 7, to: 23 } });
    expect(first.data).toMatchObject({
      step: 'ask_user_in_chat',
      would: { key: 'job_hours', to: { from: 7, to: 23 } },
    });
    const before = await call('get_settings');
    expect(before.data.job_hours?.value).not.toEqual({ from: 7, to: 23 });

    await call('set_setting', {
      key: 'job_hours',
      value: { from: 7, to: 23 },
      user_confirmed: true,
    });
    expect((await call('get_settings')).data.job_hours.value).toEqual({ from: 7, to: 23 });
    await owner((c) =>
      c.query(
        `update outreach.settings set value = '{"from": 7, "to": 21}' where key = 'job_hours'`,
      ),
    );
  });

  it('asks before going live', async () => {
    const r = await call('set_live', { live: true });
    expect(r.data).toMatchObject({ step: 'ask_user_in_chat', would: { action: 'go live' } });
  });

  it('reports robot health: devices, why jobs wait, the queue and the gating settings', async () => {
    const r = await call('robot_health');
    expect(r.data).toHaveProperty('devices');
    expect(r.data).toHaveProperty('queued');
    expect(r.data).toHaveProperty('berlin_hour');
    expect(r.data.settings).toHaveProperty('job_hours');
  });

  it('queues a round', async () => {
    const r = await call('start_job', { kind: 'sync_round' });
    expect(r.isError).toBe(false);
    const jobs = await owner((c) =>
      c.query(`select kind, created_by from outreach.ext_jobs where kind = 'sync_round'`),
    );
    expect(jobs.rows.at(-1)).toMatchObject({ kind: 'sync_round', created_by: 'api' });
  });
  it('reads everything the web app shows, through the app routes (14.11.2026)', async () => {
    for (const [name, args] of [
      ['dashboard', {}],
      ['campaign', { id: 'mcp-camp' }],
      ['send_preview', {}],
      ['comment_library', {}],
      ['comment_study', {}],
      ['list_texts', {}],
      ['list_keywords', {}],
      ['voice_profile', {}],
      ['list_companies', {}],
      ['search_usage', {}],
      ['message_stats', {}],
    ] as const) {
      const r = await call(name, args);
      expect({ name, isError: r.isError, text: r.isError ? r.text : '' }).toEqual({
        name,
        isError: false,
        text: '',
      });
    }
  });

  it('changes rules and keywords only after the yes in chat', async () => {
    const kw = `MCP Testbegriff ${Date.now()}`;
    const asked = await call('set_keywords', {
      keywords: [{ keyword: kw, segment: 'makler', campaign: null }],
    });
    expect(asked.data).toMatchObject({ step: 'ask_user_in_chat', changed: false });
    expect((await call('list_keywords')).data.keywords).not.toContainEqual(
      expect.objectContaining({ keyword: kw }),
    );
    const done = await call('set_keywords', {
      keywords: [{ keyword: kw, segment: 'makler', campaign: null }],
      user_confirmed: true,
    });
    expect(done.isError).toBe(false);
    expect((await call('list_keywords')).data.keywords).toContainEqual(
      expect.objectContaining({ keyword: kw }),
    );
    expect((await call('decide_comment_study', { id: 1, decision: 'apply' })).data).toMatchObject({
      step: 'ask_user_in_chat',
    });
    expect((await call('set_autopost', { on: true })).data).toMatchObject({
      step: 'ask_user_in_chat',
    });
    expect(
      (await call('edit_doc', { key: 'engagement_rules', content: 'x'.repeat(30) })).data,
    ).toMatchObject({ step: 'ask_user_in_chat' });
  });

  it('adds companies, sets a deal stage and queues a study round', async () => {
    const added = await call('add_companies', {
      text: 'beispiel-makler.de, https://www.muster-shop.de/',
    });
    expect(added.data).toMatchObject({ found: 2 });
    const deal = await call('set_deal_stage', { id: 9601, stage: 'qualifying' });
    expect(deal.isError).toBe(false);
    const stage = await owner((c) =>
      c.query('select deal_stage from outreach.prospects where id = 9601'),
    );
    expect(stage.rows[0].deal_stage).toBe('qualifying');
    const job = await call('start_job', {
      kind: 'study_comments',
      profiles: ['https://www.linkedin.com/in/anna-muster/'],
    });
    expect(job.isError).toBe(false);
    const jobs = await owner((c) =>
      c.query(
        `select params from outreach.ext_jobs where kind = 'study_comments' order by id desc limit 1`,
      ),
    );
    expect(jobs.rows[0].params).toMatchObject({
      profiles: ['https://www.linkedin.com/in/anna-muster/'],
    });
  });
});
