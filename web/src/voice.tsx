import { useState } from 'react';
import { ago, panelPost } from './api.ts';
import { startJob, waitForJob } from './robot.tsx';
import { useData } from './views.tsx';

// Voice tab: how Jibran writes (from his own posts, comments and profile) and a sharper version.
// Only the approved profile is used for drafts.

interface Profile {
  summary: string;
  languages: string;
  address_form: string;
  tone: string;
  rhythm: string;
  openers: string[];
  closers: string[];
  phrases: string[];
  avoids: string[];
  topics: string[];
  signature_lines: string[];
  story_bank: { fact: string; quote: string }[];
  comment_style: string;
  coverage_note: string;
}
interface Better {
  keep: string[];
  drop: string[];
  rules: string[];
  rewrite_example: { before: string; after: string };
  headline_options: string[];
  about_opening: string;
}
interface Row {
  id: number;
  created_at: string;
  approved_at: string | null;
  profile: Profile;
  better: Better;
  fingerprint: {
    samples: { posts: number; comments: number };
    address: { sie: number; du: number };
    commentChars: { median: number } | null;
    language: { german: number; english: number };
  };
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="stack small">
      <strong>{title}</strong>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function VoiceCard({
  row,
  draft,
  onDone,
}: {
  row: Row;
  draft: boolean;
  onDone: (m: string) => void;
}) {
  const p = row.profile;
  const b = row.better;
  const f = row.fingerprint;
  const decide = async (decision: 'approve' | 'reject') => {
    await panelPost(`/panel/voice/${row.id}`, { decision });
    onDone(
      decision === 'approve' ? 'Voice profile approved: new drafts use it.' : 'Draft discarded.',
    );
  };
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>{draft ? 'New voice profile (draft)' : 'Your voice (in use)'}</h2>
        <span className="muted small">
          {f.samples.posts} posts · {f.samples.comments} comments ·{' '}
          {ago(row.approved_at ?? row.created_at)}
        </span>
      </div>
      <p style={{ margin: 0 }}>{p.summary}</p>
      <div className="muted small">
        {p.languages} · address: {p.address_form} · tone: {p.tone}
        {f.commentChars ? ` · comments ~${f.commentChars.median} characters` : ''}
      </div>
      <div className="small">Rhythm: {p.rhythm}</div>
      <div className="small">Comment style: {p.comment_style}</div>
      <List title="Topics" items={p.topics} />
      <List title="Phrases you use" items={p.phrases.map((x) => `“${x}”`)} />
      <List title="Lines in your voice" items={p.signature_lines.map((x) => `“${x}”`)} />
      <List
        title="Facts you have stated publicly (drafts may use only these)"
        items={p.story_bank.map((s) => s.fact)}
      />
      <List title="You avoid" items={p.avoids} />
      <div className="muted small">{p.coverage_note}</div>

      <h2 style={{ margin: '8px 0 0' }}>Better version</h2>
      <List title="Keep" items={b.keep} />
      <List title="Drop" items={b.drop} />
      <List title="Sharper rules for drafts" items={b.rules} />
      {b.rewrite_example.before && (
        <div className="stack small">
          <strong>Example from your text</strong>
          <div className="quote">{b.rewrite_example.before}</div>
          <div className="quote">→ {b.rewrite_example.after}</div>
        </div>
      )}
      <List
        title="Headline ideas (for your LinkedIn profile, you change it yourself)"
        items={b.headline_options}
      />
      {b.about_opening && (
        <div className="stack small">
          <strong>About: a stronger opening</strong>
          <div className="quote">{b.about_opening}</div>
        </div>
      )}
      {draft && (
        <div className="actions">
          <button className="btn primary" onClick={() => void decide('approve')}>
            Use this voice for drafts
          </button>
          <button className="btn danger" onClick={() => void decide('reject')}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

export function Voice({ refreshKey, toast }: { refreshKey: number; toast: (m: string) => void }) {
  const { data, error, reload } = useData<{
    draft: Row | null;
    approved: Row | null;
    failed: {
      id: number;
      created_at: string;
      error: string;
      posts: number;
      comments: number;
    } | null;
  }>('/panel/voice', refreshKey);
  const [status, setStatus] = useState<string | null>(null);
  const build = async () => {
    try {
      const id = await startJob('voice_profile');
      setStatus('Queued…');
      const r = await waitForJob(id, setStatus, 30 * 60_000);
      setStatus(null);
      reload();
      toast(r.message || r.status);
    } catch (e) {
      setStatus(null);
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const retry = async () => {
    setStatus('Describing your voice again (AI, about 1-2 minutes)…');
    try {
      await panelPost('/panel/voice/retry', {});
      toast('Voice profile ready for review.');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus(null);
      reload();
    }
  };
  if (!data) return <div className="card empty">{error ?? 'Loading…'}</div>;
  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Your voice</h2>
        <div className="muted small">
          The robot reads your own profile, Experience, recent posts and comments (about 5 minutes,
          only “see more” is clicked), then the AI describes how you write, with quotes from your
          real texts, and suggests a sharper version. You approve it; comment and message drafts
          then sound like you.
        </div>
        <div className="actions">
          <button className="btn primary" disabled={!!status} onClick={() => void build()}>
            {data.approved || data.draft ? 'Read my posts again' : 'Build my voice profile'}
          </button>
        </div>
        {status && <div className="small">{status}</div>}
        {data.failed && !status && (
          <div className="stack small">
            <div className="error">
              The last attempt ({ago(data.failed.created_at)} ago) read {data.failed.posts} posts
              and {data.failed.comments} comments, but the AI step failed: {data.failed.error}
            </div>
            <div className="actions">
              <button className="btn" onClick={() => void retry()}>
                Try again (no LinkedIn visit)
              </button>
            </div>
          </div>
        )}
      </div>
      {(data.draft || data.approved || data.failed) && (
        <ProfileCheck refreshKey={refreshKey} toast={toast} />
      )}
      {data.draft && <VoiceCard row={data.draft} draft onDone={(m) => (toast(m), reload())} />}
      {data.approved && (
        <VoiceCard row={data.approved} draft={false} onDone={(m) => (toast(m), reload())} />
      )}
    </div>
  );
}

interface Check {
  id: number;
  created_at: string;
  samples_read_at: string | null;
  posts: string[] | null;
  findings: { section: string; status: 'pass' | 'needs-work' | 'fail' | 'unknown'; note: string }[];
  rewrites: {
    score: number;
    priorities: string[];
    headline_options: string[];
    about: string;
    current_role: { title: string; description: string };
    skills_top: string[];
    featured_post_indexes: number[];
    notes: string;
  };
}

const STATUS: Record<string, [string, string]> = {
  pass: ['ok', 'good'],
  'needs-work': ['warn', 'improve'],
  fail: ['bad', 'fix'],
  unknown: ['', 'not read'],
};

function Copy({ text, toast }: { text: string; toast: (m: string) => void }) {
  return (
    <button
      className="btn link small"
      onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied.'))}
    >
      Copy
    </button>
  );
}

export function ProfileCheck({
  refreshKey,
  toast,
}: {
  refreshKey: number;
  toast: (m: string) => void;
}) {
  const { data, error, reload } = useData<Check | null>('/panel/profile-check', refreshKey);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await panelPost('/panel/profile-check', {});
      reload();
      toast('Profile check ready.');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (data === undefined && !error) return null;
  const r = data?.rewrites;
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Profile check</h2>
        {r && (
          <span className={`badge ${r.score >= 75 ? 'ok' : r.score >= 50 ? 'warn' : 'bad'}`}>
            {r.score}/100
          </span>
        )}
      </div>
      <div className="muted small">
        Scores your LinkedIn profile for brokers and offices looking for AI agents and automation,
        from what the robot read for your voice profile (no new LinkedIn visit, about 1 minute).
        Rewrites use only facts from your own texts. You change your profile on LinkedIn yourself.
      </div>
      <div className="actions">
        <button className="btn primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Checking…' : data ? 'Check again' : 'Check my profile'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {data && r && (
        <>
          <div className="timeline">
            {data.findings.map((f) => (
              <div key={f.section} className="tl">
                <span className={`badge ${STATUS[f.status]?.[0] ?? ''}`}>
                  {STATUS[f.status]?.[1] ?? f.status}
                </span>
                <div className="small">
                  <strong>{f.section}</strong> · {f.note}
                </div>
              </div>
            ))}
          </div>
          <List title="Do first" items={r.priorities} />
          <div className="stack small">
            <strong>Headline options</strong>
            {r.headline_options.map((h, i) => (
              <div key={i} className="row between quote">
                <span>{h}</span>
                <Copy text={h} toast={toast} />
              </div>
            ))}
          </div>
          <div className="stack small">
            <div className="row between">
              <strong>About (new)</strong>
              <Copy text={r.about} toast={toast} />
            </div>
            <div className="quote" style={{ whiteSpace: 'pre-wrap' }}>
              {r.about}
            </div>
          </div>
          <div className="stack small">
            <div className="row between">
              <strong>Current role: {r.current_role.title}</strong>
              <Copy text={r.current_role.description} toast={toast} />
            </div>
            <div className="quote" style={{ whiteSpace: 'pre-wrap' }}>
              {r.current_role.description}
            </div>
          </div>
          <List title="Skills to pin" items={r.skills_top} />
          <List
            title="Posts to pin in Featured"
            items={r.featured_post_indexes.map(
              (i) => (data.posts?.[i] ?? `post ${i + 1}`).slice(0, 120) + '…',
            )}
          />
          {r.notes && <div className="muted small">{r.notes}</div>}
          <div className="muted small">Checked {ago(data.created_at)} ago.</div>
        </>
      )}
    </div>
  );
}
