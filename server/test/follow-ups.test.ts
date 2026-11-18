import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/ai/openrouter.ts';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';

// Follow-ups on replies (18.11.2026). The AI is replaced per task (json_schema name). Names invented.
const answers: Record<string, unknown> = {
  reply_follow_up_date: {
    items: [{ index: 0, on: '2026-11-15', reason: 'ab Mitte November' }],
  },
  draft_follow_up: {
    message:
      'Guten Tag Bernd,\n\nSie hatten geschrieben, dass es ab Mitte November besser passt. Passt es jetzt für einen kurzen Austausch?\n\nBeste Grüße\nJibran',
  },
};
const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
  const name = JSON.parse(String(init!.body)).response_format.json_schema.name as string;
  return new Response(
    JSON.stringify({
      model: 'anthropic/claude-haiku-5.5',
      choices: [{ message: { content: JSON.stringify(answers[name]) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 100, cost: 0.001 },
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
  await owner((c) =>
    c.query(`delete from outreach.action_queue where prospect_id between 9901 and 9904;
      delete from outreach.prospects where id between 9901 and 9904;
      insert into outreach.prospects (id, linkedin_url, full_name, first_name, stage, replied_at, reply_snippet,
                                      reply_outcome, reply_classified_at, reply_follow_up_on) values
        (9901, 'https://www.linkedin.com/in/fu-spaeter/', 'Bernd Später', 'Bernd', 'replied', '2026-09-25',
         'Lass uns gerne ab Mitte November noch mal sprechen.', 'not_now', now(), null),
        (9902, 'https://www.linkedin.com/in/fu-heiss/', 'Hanna Heiß', 'Hanna', 'replied', '2026-09-20',
         'Klingt spannend, was kostet sowas?', 'interested', now(), null),
        (9903, 'https://www.linkedin.com/in/fu-nein/', 'Nils Nein', 'Nils', 'replied', '2026-09-20',
         'Kein Interesse.', 'not_interested', now(), null),
        (9904, 'https://www.linkedin.com/in/fu-zukunft/', 'Zora Zukunft', 'Zora', 'replied', '2026-11-01',
         'Bitte im Februar wieder.', 'not_now', now(), '2099-02-01');
      -- Hanna's answer was approved long ago and never sent
      insert into outreach.action_queue (prospect_id, action, message_text, due_at, status, approved_at)
        values (9902, 'reply', 'Alte Antwort', now() - interval '50 days', 'approved', now() - interval '50 days')`),
  );
});
afterAll(() =>
  owner((c) =>
    c.query(`delete from outreach.action_queue where prospect_id between 9901 and 9904;
      delete from outreach.prospects where id between 9901 and 9904`),
  ),
);

const board = async () =>
  (
    (await app.inject({ method: 'GET', url: '/panel/replies/board', headers: auth() })).json() as {
      id: number;
      section: string;
      follow_up_on: string | null;
      draft_status: string | null;
      draft: string | null;
      draft_stale: boolean;
    }[]
  ).filter((r) => r.id >= 9901 && r.id <= 9904);

describe('follow-ups on replies', () => {
  it('sorts everyone who replied into sections', async () => {
    const b = Object.fromEntries((await board()).map((r) => [r.id, r]));
    expect(b[9901]!.section).toBe('later'); // date not read yet
    expect(b[9902]).toMatchObject({ section: 'hot', draft_status: 'approved', draft_stale: true });
    expect(b[9903]!.section).toBe('closed');
    expect(b[9904]!.section).toBe('later');
  });

  it('reads the date, then drafts for hot and due people only, for approval', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/panel/replies/follow-ups',
      headers: auth(),
      payload: { max: 10 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ dated: 1, drafted: 2 });
    const b = Object.fromEntries((await board()).map((x) => [x.id, x]));
    expect(b[9901]).toMatchObject({
      section: 'due',
      follow_up_on: '2026-11-15',
      draft_status: 'proposed',
    });
    expect(b[9901]!.draft).toMatch(/ab Mitte November/);
    // the stale approval became a fresh draft that waits again
    expect(b[9902]).toMatchObject({ section: 'hot', draft_status: 'proposed', draft_stale: false });
    expect(b[9903]!.draft_status).toBeNull();
    expect(b[9904]!.draft_status).toBeNull();
    // nothing was approved or sent
    const approved = await owner((c) =>
      c.query(
        `select count(*)::int n from outreach.action_queue where prospect_id between 9901 and 9904 and status = 'approved'`,
      ),
    );
    expect(approved.rows[0].n).toBe(0);
  });

  it('a date can be set by hand', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/panel/replies/9904/follow-up-on',
      headers: auth(),
      payload: { on: '2026-01-10' },
    });
    expect(r.statusCode).toBe(200);
    expect((await board()).find((x) => x.id === 9904)!.section).toBe('due');
  });
});

describe('funnel', () => {
  it('counts each step, later steps implying the earlier ones', async () => {
    const f = (
      await app.inject({ method: 'GET', url: '/panel/funnel', headers: auth() })
    ).json() as {
      total: Record<
        'invited' | 'accepted' | 'messaged' | 'replied' | 'hot' | 'meeting' | 'won',
        number
      >;
      campaigns: unknown[];
    };
    const t = f.total;
    expect(t.invited).toBeGreaterThanOrEqual(t.accepted);
    expect(t.accepted).toBeGreaterThanOrEqual(t.messaged);
    expect(t.messaged).toBeGreaterThanOrEqual(t.replied);
    expect(t.replied).toBeGreaterThanOrEqual(4); // the four replies of this file
    expect(t.hot).toBeGreaterThanOrEqual(1); // the interested one
    const recent = (
      await app.inject({ method: 'GET', url: '/panel/funnel?days=30', headers: auth() })
    ).json() as { days: number };
    expect(recent.days).toBe(30);
  });
});
