import { afterAll, describe, expect, it } from 'vitest';
import { makeApp, owner, resetData } from './helpers.ts';

const { app, db } = await makeApp();
afterAll(async () => {
  await app.close();
  await db.end();
});

// 17.11.2026: suggested withdrawals counted as drafts to review and paused prospecting for days.
describe('dashboard counts', () => {
  it('approve_contacts leaves suggested withdrawals out', async () => {
    await resetData();
    const counts = await owner(async (c) => {
      await c.query(`delete from outreach.action_queue; delete from outreach.prospects where id in (9801, 9802);
        insert into outreach.prospects (id, linkedin_url, full_name, stage) values
          (9801, 'https://www.linkedin.com/in/zaehl-eins/', 'Zähl Eins', 'invited'),
          (9802, 'https://www.linkedin.com/in/zaehl-zwei/', 'Zähl Zwei', 'accepted');
        insert into outreach.action_queue (prospect_id, action, step, due_at, status) values
          (9801, 'withdraw', 1, now(), 'proposed'),
          (9802, 'message', 2, now(), 'proposed')`);
      const u = (await c.query(`select id from outreach.app_users limit 1`)).rows[0].id;
      return (await c.query(`select public.ext_dashboard($1) -> 'counts' as c`, [u])).rows[0].c;
    });
    expect(counts.approve).toBe(2);
    expect(counts.approve_contacts).toBe(1);
    await owner((c) =>
      c.query(
        `delete from outreach.action_queue; delete from outreach.prospects where id in (9801, 9802)`,
      ),
    );
  });
});
