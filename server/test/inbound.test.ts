import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { rulesForAction, validateDraft, type VerifiedFit } from '@outreach/shared';
import type { AppDeps } from '../src/app.ts';
import { assessInbound } from '../src/routes/inbound.ts';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';

const { app, db } = await makeApp();
const deps = { db } as unknown as AppDeps;
let token = '';
let userId = '';
afterAll(async () => {
  await app.close();
  await db.end();
});

const today = new Date().toISOString().slice(0, 10);
const NEW = 'https://www.linkedin.com/in/neue-person/';
const MINE = 'https://www.linkedin.com/in/selbst-eingeladen/';
const OLD = 'https://www.linkedin.com/in/alte-verbindung/';

beforeEach(async () => {
  await resetData();
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
  await owner(async (c) => {
    userId = (await c.query(`select id from outreach.app_users`)).rows[0].id;
    await c.query(`delete from outreach.inbound_connections; delete from outreach.sent_seen;
      delete from outreach.received_seen;
      delete from outreach.action_queue; delete from outreach.events;
      delete from outreach.candidates; delete from outreach.prospects;
      update outreach.campaigns set status = 'off' where status = 'on';
      delete from outreach.campaign_actions where campaign_id = 'in-camp';
      delete from outreach.campaigns where id = 'in-camp';
      insert into outreach.campaigns (id, name, status) values ('in-camp', 'Inbound test', 'on');
      insert into outreach.campaign_actions (campaign_id, step, action_type, text, delay) values
        ('in-camp', 1, 'connect', null, interval '0'),
        ('in-camp', 2, 'message', E'Guten Tag _FN_, danke für die Vernetzung.\\n\\nWie läuft es bei Ihnen?', interval '4 hours'),
        ('in-camp', 3, 'message', E'Guten Tag _FN_, noch eine Frage.', interval '7 days');
      update outreach.settings set value = '"2026-01-01"' where key = 'inbound_since'`);
  });
});
afterAll(() =>
  owner((c) =>
    c.query(`delete from outreach.inbound_connections; delete from outreach.action_queue;
      delete from outreach.candidates; delete from outreach.prospects;
      delete from outreach.campaign_actions where campaign_id = 'in-camp';
      delete from outreach.campaigns where id = 'in-camp'`),
  ),
);

const sync = (connections: unknown[], sent: unknown[] = [], received: unknown[] = []) =>
  app.inject({
    method: 'POST',
    url: '/ext/sync',
    headers: { authorization: `Bearer ${token}` },
    payload: { jobId: null, connections, sent: { total: 1, items: sent }, received, inbox: [] },
  });
const origin = (url: string) =>
  owner((c) =>
    c.query(`select origin, asked from outreach.inbound_connections where linkedin_url = $1`, [
      url,
    ]),
  ).then((r) => r.rows[0]);
const conn = (url: string, name: string, connectedOn = today) => ({
  name,
  profileUrl: url,
  connectedOn,
  headline: 'Inhaber Maklerbüro',
});
const profile = (name: string) => ({
  name,
  headline: 'Inhaber Maklerbüro',
  location: null,
  about: null,
  experience: [],
});
const fit = (status: VerifiedFit['status']) =>
  (async () => ({ status, reason: `test ${status}`, evidence: [] })) as unknown as (
    c: string,
  ) => Promise<VerifiedFit>;
const queue = (url: string) =>
  owner((c) =>
    c.query(
      `select q.action, q.step, q.status, q.message_text, q.due_at <= now() as due, p.stage, p.source
       from outreach.action_queue q join outreach.prospects p on p.id = q.prospect_id
       where p.linkedin_url = $1 order by q.step`,
      [url],
    ),
  ).then((r) => r.rows);

describe('incoming connections', () => {
  it('records new connections since the start day and asks for a fit check', async () => {
    const r = await sync([conn(NEW, 'Neue Person'), conn(OLD, 'Alte Verbindung', '2025-12-01')]);
    expect(r.statusCode).toBe(200);
    expect(r.json().inboundAdded).toBe(1);
    expect(r.json().inboundToCheck).toEqual([{ url: NEW, name: 'Neue Person' }]);
    // a second sync does not add them again
    expect((await sync([conn(NEW, 'Neue Person')])).json().inboundAdded).toBe(0);
  });

  it('a fit gets the thank-you for the request, waiting for approval, then the follow-ups', async () => {
    // seen on Invitations received first: they asked
    await sync([], [], [{ name: 'Neue Person', profileUrl: NEW }]);
    await sync([conn(NEW, 'Neue Person')]);
    expect(await origin(NEW)).toEqual({ origin: 'requested', asked: true });
    const res = await assessInbound(
      deps,
      userId,
      { url: NEW, profile: profile('Neue Person') },
      fit('yes'),
    );
    expect(res.status).toBe('fit');
    const rows = await queue(NEW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'message',
      step: 2,
      status: 'proposed',
      due: true,
      stage: 'accepted',
      source: 'inbound',
    });
    expect(rows[0].message_text).toMatch(/^Guten Tag Neue, danke für Ihre Vernetzungsanfrage\./);
    // once sent, the campaign's next message is scheduled by the triggers
    await owner((c) =>
      c.query(
        `update outreach.action_queue set status = 'done' where prospect_id =
         (select id from outreach.prospects where linkedin_url = $1)`,
        [NEW],
      ),
    );
    const after = await queue(NEW);
    expect(after.map((q) => [q.step, q.status])).toEqual([
      [2, 'done'],
      [3, 'scheduled'],
    ]);
    expect(after[1].stage).toBe('msg1_sent');
  });

  it('someone Jibran invited by hand gets "danke für die Vernetzung"', async () => {
    await sync([], [{ name: 'Selbst', profileUrl: MINE, sentDaysAgo: 2 }]);
    await sync([conn(MINE, 'Selbst Eingeladen')]);
    await assessInbound(deps, userId, { url: MINE, profile: profile('Selbst') }, fit('yes'));
    const [q] = await queue(MINE);
    expect(q.message_text).toMatch(/danke für die Vernetzung\./);
    expect(await origin(MINE)).toEqual({ origin: 'invited', asked: false });
  });

  it('seen on neither page: not sure who asked, so the neutral thank-you (16.11.2026)', async () => {
    await sync([conn(NEW, 'Neue Person')]);
    expect(await origin(NEW)).toEqual({ origin: 'unknown', asked: false });
    await assessInbound(deps, userId, { url: NEW, profile: profile('Neue Person') }, fit('yes'));
    const [q] = await queue(NEW);
    expect(q.message_text).toMatch(/^Guten Tag Neue, danke für die Vernetzung\./);
  });

  it('Approve and Leads say where each contact came from', async () => {
    await sync(
      [],
      [{ name: 'Selbst', profileUrl: MINE, sentDaysAgo: 2 }],
      [{ name: 'Neue Person', profileUrl: NEW }],
    );
    await sync([conn(NEW, 'Neue Person'), conn(MINE, 'Selbst Eingeladen'), conn(OLD, 'Dritte')]);
    await assessInbound(deps, userId, { url: NEW, profile: profile('Neue Person') }, fit('yes'));
    await assessInbound(deps, userId, { url: MINE, profile: profile('Selbst') }, fit('yes'));
    await assessInbound(deps, userId, { url: OLD, profile: profile('Dritte') }, fit('no'));
    await owner((c) =>
      c.query(`insert into outreach.prospects (id, linkedin_url, full_name, stage, campaign_id) values
          (9701, 'https://www.linkedin.com/in/robot-eingeladen/', 'Robot Eingeladen', 'approved', 'in-camp');
        update outreach.action_queue set status = 'proposed', due_at = now() where prospect_id = 9701`),
    );
    const q = (
      await app.inject({
        method: 'GET',
        url: '/panel/queue',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json() as { full_name: string; origin: string }[];
    const byName = Object.fromEntries(q.map((r) => [r.full_name, r.origin]));
    expect(byName).toMatchObject({
      'Neue Person': 'requested',
      Selbst: 'invited', // the name comes from the profile that was opened
      'Robot Eingeladen': 'robot',
    });
    const leads = (
      await app.inject({
        method: 'GET',
        url: '/panel/leads',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json() as { full_name: string; origin: string }[];
    expect(leads.find((l) => l.full_name === 'Dritte')?.origin).toBe('unknown');
    // a robot invite that is accepted is recorded as 'existing' and stays a robot invite
    await owner((c) =>
      c.query(
        `update outreach.prospects set stage = 'invited', invited_at = now() where id = 9701`,
      ),
    );
    await sync([conn('https://www.linkedin.com/in/robot-eingeladen/', 'Robot Eingeladen')]);
    const again = (
      await app.inject({
        method: 'GET',
        url: '/panel/queue',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json() as { full_name: string; origin: string }[];
    expect(again.find((r) => r.full_name === 'Robot Eingeladen')?.origin).toBe('robot');
  });

  it('no fit: listed in Leads, and approving it enrolls without an invite', async () => {
    await sync([conn(NEW, 'Neue Person')]);
    const res = await assessInbound(
      deps,
      userId,
      { url: NEW, profile: profile('Neue Person') },
      fit('no'),
    );
    expect(res.status).toBe('no_fit');
    expect(await queue(NEW)).toEqual([]);
    const lead = await owner((c) =>
      c.query(`select id, verdict, inbound from outreach.candidates where linkedin_url = $1`, [
        NEW,
      ]),
    ).then((r) => r.rows[0]);
    expect(lead).toMatchObject({ verdict: 'staged', inbound: true });

    const review = await owner((c) =>
      c.query(`select public.ext_review_lead($1, $2, 'approve', 'in-camp', null) as r`, [
        userId,
        lead.id,
      ]),
    ).then((r) => r.rows[0].r);
    expect(review.verdict).toBe('approved');
    const rows = await queue(NEW);
    expect(rows.map((q) => [q.action, q.status])).toEqual([['message', 'proposed']]);
  });

  it('gives up after three failed tries', async () => {
    await sync([conn(NEW, 'Neue Person')]);
    for (let i = 0; i < 3; i++)
      await owner((c) =>
        c.query(`select public.ext_inbound_assessed($1, $2, '{"status":"failed"}')`, [userId, NEW]),
      );
    expect((await sync([])).json().inboundToCheck).toEqual([]);
  });

  it('the broker campaign thank-you passes the message checks', async () => {
    const text = await owner((c) =>
      c.query(
        `select outreach.inbound_text('ki-agenten-makler', null, 'Anna', true) as t,
                exists (select 1 from outreach.campaigns where id = 'ki-agenten-makler') as there`,
      ),
    ).then((r) => r.rows[0]);
    if (!text.there) return; // the campaign comes from the Supabase import, not every test DB has it
    expect(text.t).toMatch(/^Guten Tag Anna, danke für Ihre Vernetzungsanfrage\./);
    const banned = await owner((c) =>
      c.query(`select body from outreach.docs where key = 'banned_phrases'`),
    ).then((r) => (r.rows[0]?.body ?? '').split('\n').filter(Boolean));
    expect(validateDraft(text.t, rulesForAction('message', banned)).errors).toEqual([]);
  });

  it('the white-label partner campaign has its own thank-you that passes the message checks', async () => {
    const r = await owner((c) =>
      c.query(
        `select outreach.inbound_text('white-label-partner', null, 'Anna', true) as asked,
                outreach.inbound_text('white-label-partner', null, 'Anna', false) as other,
                outreach.ext_target_group('white-label-partner') as target,
                (select status from outreach.campaigns where id = 'white-label-partner') as status`,
      ),
    ).then((x) => x.rows[0]);
    expect(r.status).not.toBeNull(); // created 'on'; this test file switches campaigns off first
    expect(r.target).toMatch(/White-Label-Partner/);
    expect(r.asked).toMatch(
      /^Guten Tag Anna, danke für Ihre Vernetzungsanfrage\.\n\nWie ich sehe, sind wir im selben Feld/,
    );
    expect(r.other).toMatch(/^Guten Tag Anna, danke für die Vernetzung\./);
    for (const t of [r.asked, r.other])
      expect(validateDraft(t, rulesForAction('message', [])).errors).toEqual([]);
  });
});
