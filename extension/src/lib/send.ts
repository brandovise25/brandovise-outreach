import type { ApiClient } from '@outreach/shared';
import type { JobRun } from './job-run.ts';
import { withRobotTab, type RobotTab } from './robot-tab.ts';
import type { SendAttempt } from './adapters/send.ts';

// Send round (Jibran's "Send approved" click). The server hands out only items that pass every check
// (paused, send window, limits, approved, due, not older than 14 days, no reply in between). While dry
// run is on, each item is a PRACTICE: typed and read back, then cancelled. 40-120 s between items.

interface Item {
  id: number;
  action: 'connect' | 'message' | 'reply' | 'withdraw';
  message_text: string | null;
  full_name: string | null;
  linkedin_url: string;
}
interface Batch {
  items: Item[];
  practice: boolean;
  paused: boolean;
  window_open: boolean;
  stale: number;
}

const SENT = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';

async function read(run: JobRun, tab: RobotTab, steps: number) {
  for (let s = 0; s < steps; s++) {
    await tab.send({ type: 'gentleScroll' }).catch(() => undefined);
    await run.wait(3000, 7000, 'reading');
  }
}

export async function runSendRound(
  deps: { api: ApiClient },
  run: JobRun,
  max = 5,
): Promise<{ state: string; message: string }> {
  const n = Math.min(10, Math.max(1, Math.round(max)));
  const batch = (await deps.api.panel('GET', `/ext/send/batch?max=${n}`)) as Batch;
  if (batch.stale)
    await run.log(
      `${batch.stale} approved item(s) are older than 14 days and are skipped; approve them again if still wanted.`,
      {
        level: 'warn',
      },
    );
  if (batch.paused) return { state: 'done', message: 'The robot is paused: nothing to send.' };
  if (!batch.window_open)
    return { state: 'done', message: 'Outside your send times (Settings): nothing sent.' };
  if (!batch.items.length)
    return { state: 'done', message: 'Nothing approved and due within the limits.' };
  const mode = batch.practice ? 'PRACTICE (dry run: nothing is sent)' : 'LIVE';
  await run.log(
    `${mode}: ${batch.items.length} item(s): ${batch.items.map((i) => `${i.action} ${i.full_name ?? ''}`).join(', ')}`,
    {
      progress: { items: 0, maxItems: batch.items.length },
    },
  );

  const results: string[] = [];
  let captured = new Set<string>();
  let failShots = 0;
  await withRobotTab(
    run,
    batch.items[0]!.action === 'withdraw' ? SENT : batch.items[0]!.linkedin_url,
    async (tab) => {
      for (let i = 0; i < batch.items.length; i++) {
        const it = batch.items[i]!;
        if (i > 0) await run.wait(40_000, 120_000, 'between sends');
        const who = it.full_name ?? 'this person';
        let attempt: SendAttempt;
        try {
          if (it.action === 'withdraw') {
            // The list stays loaded between withdrawals, so only open it after another kind of item.
            if (i > 0 && batch.items[i - 1]!.action !== 'withdraw')
              await tab.goto(SENT, 'Opening sent invitations');
            await read(run, tab, 1);
            attempt = await tab.send<SendAttempt>({
              type: 'sendWithdraw',
              name: who,
              practice: batch.practice,
            });
          } else {
            if (i > 0) await tab.goto(it.linkedin_url, `Opening ${who}'s profile`);
            await run.log(
              `${it.action === 'connect' ? 'Invite' : it.action === 'reply' ? 'Reply' : 'Message'}: ${who}`,
              {
                step: it.action,
              },
            );
            await read(run, tab, 2 + Math.floor(Math.random() * 2));
            if (it.action === 'connect') {
              attempt = await tab.send<SendAttempt>({
                type: 'sendConnect',
                note: it.message_text ?? '',
                practice: batch.practice,
              });
            } else {
              const prof = await tab.send<{ messageHref: string | null }>({
                type: 'inspectProfile',
              });
              if (!prof.messageHref) {
                attempt = {
                  practice: batch.practice,
                  ok: false,
                  step: 'profile',
                  note: 'No Message button on the profile.',
                  finalButton: null,
                };
              } else {
                await tab.goto(prof.messageHref, 'Opening the conversation');
                attempt = await tab.send<SendAttempt>({
                  type: 'sendMessage',
                  body: it.message_text ?? '',
                  practice: batch.practice,
                });
              }
            }
          }
        } catch (err) {
          attempt = {
            practice: batch.practice,
            ok: false,
            step: 'error',
            note: err instanceof Error ? err.message : String(err),
            finalButton: null,
          };
          if (/robot tab was closed|Stopped/i.test(attempt.note)) throw err;
        }
        // Practice: save the first dialog / message box of each kind as it looked before cancelling, so the
        // steps can be checked on real HTML (stays in the server's private capture folder).
        // A live invite whose dialog did not open is saved too (at most 2 per round).
        const failedDialog =
          !attempt.ok && (attempt.step === 'dialog' || attempt.step === 'note') && failShots < 2;
        if ((batch.practice && !captured.has(it.action)) || failedDialog) {
          captured = new Set([...captured, it.action]);
          if (failedDialog) failShots++;
          const snap = await tab
            .send<{ html: string | null; lang: string }>({ type: 'takeSnapshot' })
            .catch(() => null);
          if (snap?.html)
            await deps.api
              .panel('POST', '/panel/dev/capture', {
                kind: `send-${it.action}${failedDialog ? '-failed' : ''}`,
                lang: snap.lang,
                html: snap.html,
                redacted: false,
              })
              .catch(() => undefined);
        }
        await deps.api.panel('POST', `/ext/send/${it.id}/result`, {
          practice: batch.practice,
          ok: attempt.ok,
          note: attempt.note,
          detail: { step: attempt.step, finalButton: attempt.finalButton },
        });
        await run.log(`${who}: ${attempt.note}`, {
          level: attempt.ok ? 'info' : 'warn',
          progress: { items: i + 1 },
        });
        results.push(`${it.action} ${who}: ${attempt.ok ? 'ok' : 'failed'}`);
        if (attempt.note.startsWith('Stopped:')) throw new Error(attempt.note);
      }
    },
  );
  const ok = results.filter((r) => r.endsWith('ok')).length;
  return {
    state: 'done',
    message: `${batch.practice ? 'Practice' : 'Live'}: ${ok} of ${results.length} worked. ${results.join('; ')}`,
  };
}
