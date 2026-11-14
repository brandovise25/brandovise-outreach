import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';

const { app, db } = await makeApp();
let token = '';
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await resetData();
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
});
const h = () => ({ authorization: `Bearer ${token}` });
const set = (key: string, value: unknown) =>
  app.inject({ method: 'POST', url: `/panel/settings/${key}`, headers: h(), payload: { value } });

describe('settings tab', () => {
  it('saves valid values and the limits use them', async () => {
    expect((await set('daily_invite_cap', 12)).statusCode).toBe(200);
    expect((await set('robot_schedule', { '1': [['08:00', '18:00']], '0': [] })).statusCode).toBe(
      200,
    );
    const s = (await app.inject({ method: 'GET', url: '/panel/settings', headers: h() })).json();
    expect(s.daily_invite_cap.value).toBe(12);
    expect(s.robot_schedule.value['1']).toEqual([['08:00', '18:00']]);
    const lim = await owner((c) => c.query('select outreach.limits() l'));
    expect(lim.rows[0].l.daily_invite_cap).toBe(12);
  });
  it('rejects values outside the safe range and keys that are not editable', async () => {
    expect((await set('daily_invite_cap', 500)).statusCode).toBe(400);
    expect((await set('robot_schedule', { '1': [['18:00', '08:00']] })).statusCode).toBe(400);
    expect((await set('ext_dry_run', false)).statusCode).toBe(400);
    expect((await set('comment_round_times', ['25:00'])).statusCode).toBe(400);
  });
  it('comment filters return counts and only the chosen status', async () => {
    await owner((c) =>
      c.query(`delete from outreach.engagement;
        insert into outreach.engagement (post_key, comment_draft, status, posted_at) values
        ('a','x','posted', now() - interval '20 days'), ('b','y','rejected', null), ('c','z','drafted', null)`),
    );
    const r = (
      await app.inject({ method: 'GET', url: '/panel/comments/list?filter=posted', headers: h() })
    ).json();
    expect(r.counts).toMatchObject({ posted: 1, rejected: 1, review: 1, approved: 0 });
    expect(r.items.map((i: { post_key?: string; status: string }) => i.status)).toEqual(['posted']);
  });
});

describe('live switch and automatic jobs', () => {
  const live = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/panel/live', headers: h(), payload });
  const dry = async () =>
    (await owner((c) => c.query(`select value from outreach.settings where key = 'ext_dry_run'`)))
      .rows[0]?.value;
  it('goes live only with the typed confirmation and goes back without one', async () => {
    expect((await live({ live: true })).statusCode).toBe(400);
    expect((await live({ live: true, confirm: 'yes' })).statusCode).toBe(400);
    const on = await live({ live: true, confirm: 'LIVE' });
    expect(on.statusCode).toBe(200);
    expect(on.json().live).toBe(true);
    expect(await dry()).toBe('false');
    expect((await live({ live: false })).statusCode).toBe(200);
    expect(await dry()).toBe('true');
  });
  it('saves the automatic switches and shows the daily invite target', async () => {
    expect((await set('prospect_auto', true)).statusCode).toBe(200);
    expect((await set('send_auto', true)).statusCode).toBe(200);
    expect((await set('send_auto', 'yes')).statusCode).toBe(400);
    await set('daily_invite_cap', 20);
    await set('weekly_invite_cap', 100);
    const week = [['09:00', '17:00']];
    await set('robot_schedule', { '1': week, '2': week, '3': week, '4': week, '5': week });
    const s = (await app.inject({ method: 'GET', url: '/panel/settings', headers: h() })).json();
    expect(s.prospect_auto.value).toBe(true);
    expect(s.send_auto.value).toBe(true);
    // 100 / 5 send days = 20, varied by +-20 % and never above the daily cap of 20
    expect(s.invite_day_target.value).toBeGreaterThanOrEqual(16);
    expect(s.invite_day_target.value).toBeLessThanOrEqual(20);
    await set('weekly_invite_cap', 30); // 30 / 5 = 6 -> 5..7
    const t = (await app.inject({ method: 'GET', url: '/panel/settings', headers: h() })).json();
    expect(t.invite_day_target.value).toBeGreaterThanOrEqual(5);
    expect(t.invite_day_target.value).toBeLessThanOrEqual(7);
  });
});

describe('prompts and rules', () => {
  it('edits a prompt as a new active version, guards placeholders and <page_data>, and reverts', async () => {
    const texts = (await app.inject({ method: 'GET', url: '/panel/texts', headers: h() })).json();
    const p = texts.prompts.find((x: { task: string }) => x.task === 'engagement_pick');
    expect(p).toBeTruthy();
    const save = (system_prompt: string, user_template: string) =>
      app.inject({
        method: 'POST',
        url: '/panel/texts/prompt/engagement_pick',
        headers: h(),
        payload: { system_prompt, user_template },
      });
    // placeholder removed -> refused
    expect((await save(p.system_prompt, 'Today is {{today}}.')).statusCode).toBe(400);
    // page text moved out of <page_data> -> refused
    expect(
      (
        await save(
          p.system_prompt,
          p.user_template.replace('<page_data>', '').replace('</page_data>', ''),
        )
      ).statusCode,
    ).toBe(400);
    const ok = await save(p.system_prompt + '\nEnd with praise.', p.user_template);
    expect(ok.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/panel/texts', headers: h() })).json();
    const np = after.prompts.find((x: { task: string }) => x.task === 'engagement_pick');
    expect(np.version).toBeGreaterThan(p.version);
    expect(np.system_prompt).toMatch(/End with praise\.$/);
    await app.inject({
      method: 'POST',
      url: '/panel/texts/prompt/engagement_pick/revert',
      headers: h(),
      payload: {},
    });
    const back = (await app.inject({ method: 'GET', url: '/panel/texts', headers: h() })).json();
    expect(back.prompts.find((x: { task: string }) => x.task === 'engagement_pick').version).toBe(
      np.version - 1,
    );
  });
  it('saves a rule text as a new version, only for allowed texts', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/panel/texts/doc/voice_rules',
      headers: h(),
      payload: { content: 'Immer Sie-Form. Kurze Sätze. Keine Emojis in Nachrichten.' },
    });
    expect(r.statusCode).toBe(200);
    const bad = await app.inject({
      method: 'POST',
      url: '/panel/texts/doc/secret_stuff',
      headers: h(),
      payload: { content: 'x'.repeat(30) },
    });
    expect(bad.statusCode).toBe(400);
  });
});
