import { useState } from 'react';
import { openTab, panelPost } from './api.ts';
import { startJob } from './robot.tsx';
import { useData } from './views.tsx';

// Comment study: collect posts + comments (robot), let the AI compare how people comment with Jibran's
// comments, and review the proposed DRAFTING rules. Nothing changes until "Use these rules".

interface SetStats {
  n: number;
  chars: { p25: number; median: number; p75: number };
  share: Record<
    'question' | 'emoji' | 'sie' | 'du' | 'opensWithName' | 'oneParagraph' | 'english',
    number
  >;
}
interface Study {
  id: number;
  created_at: string;
  status: 'ready' | 'applied' | 'dismissed';
  posts: number;
  comments: number;
  stats: { posts: number; others: SetStats; liked: SetStats; mine: SetStats };
  findings: {
    summary: string;
    by_kind: { kind: string; how_people_comment: string }[];
    relevance: string;
    jibran_differs: string[];
    copy: string[];
    avoid: string[];
    posts: {
      index: number;
      topic: string;
      kind: string;
      asks_readers: boolean;
      why: string;
      url: string | null;
      author: string | null;
    }[];
    cost_usd?: number;
  };
  proposed_rules: string;
  current_rules: string | null;
  applied_version: number | null;
}

const drafting = (rules: string | null) =>
  rules?.match(/^DRAFTING[^\n]*\n[\s\S]*?(?=^MARKETING LEVEL:|(?![\s\S]))/m)?.[0]?.trim() ?? '';
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function CommentStudy({
  refreshKey,
  toast,
}: {
  refreshKey: number;
  toast: (m: string) => void;
}) {
  const { data: study, reload } = useData<Study | null>('/panel/comment-library/study', refreshKey);
  const [profiles, setProfiles] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const collect = async () => {
    const list = profiles
      .split(/[\s,]+/)
      .filter((u) => /^https:\/\/www\.linkedin\.com\/(in|company)\//.test(u))
      .slice(0, 5);
    await startJob('study_comments', { profiles: list, posts: 10 });
    toast(
      list.length
        ? `Study round queued: ${list.length} profile${list.length === 1 ? '' : 's'}.`
        : 'Study round queued: 10 posts from your feed.',
    );
  };
  const analyse = async () => {
    setBusy('Analysing the library (about a minute)…');
    try {
      const r = await panelPost<{ posts: number; comments: number; costUsd: number }>(
        '/panel/comment-library/analyze',
        { posts: 30 },
      );
      toast(`Study ready: ${r.posts} posts, ${r.comments} comments ($${r.costUsd.toFixed(2)}).`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const decide = async (decision: 'apply' | 'dismiss') => {
    if (!study) return;
    if (
      decision === 'apply' &&
      !confirm(
        'Use the proposed DRAFTING rules for all new comment drafts? The old rules stay in the history (Settings → Prompts & rules).',
      )
    )
      return;
    const r = await panelPost<{ version?: number }>(
      `/panel/comment-library/study/${study.id}/decide`,
      { decision },
    );
    toast(
      decision === 'apply'
        ? `New comment rules active (version ${r.version}).`
        : 'Proposal dismissed.',
    );
    reload();
  };

  const row = (label: string, s: SetStats | undefined) =>
    s && s.n ? (
      <tr>
        <td>{label}</td>
        <td>{s.n}</td>
        <td>
          {s.chars.median}{' '}
          <span className="muted">
            ({s.chars.p25}–{s.chars.p75})
          </span>
        </td>
        <td>{pct(s.share.opensWithName)}</td>
        <td>{pct(s.share.question)}</td>
        <td>{pct(s.share.emoji)}</td>
        <td>
          {pct(s.share.sie)} / {pct(s.share.du)}
        </td>
        <td>{pct(s.share.oneParagraph)}</td>
      </tr>
    ) : null;

  return (
    <div className="card stack">
      <b>Train the comments</b>
      <div className="small muted">
        1. Collect: the robot reads posts and their comments (optional: paste up to 5 profile links,
        it reads their recent posts that have a discussion). 2. Analyse: the AI compares how people
        comment with your comments. 3. Review the proposed rules and use them, or not.
      </div>
      <textarea
        rows={2}
        placeholder="Optional: profile links, e.g. https://www.linkedin.com/in/…"
        value={profiles}
        onChange={(e) => setProfiles(e.target.value)}
      />
      <div className="row" style={{ gap: 6 }}>
        <button className="btn" onClick={() => void collect()}>
          Collect (study round)
        </button>
        <button className="btn primary" disabled={!!busy} onClick={() => void analyse()}>
          Analyse library
        </button>
        {busy && <span className="small muted">{busy}</span>}
      </div>

      {study && (
        <div className="stack">
          <div className="small">
            <b>Study #{study.id}</b> · {new Date(study.created_at).toLocaleString('de-DE')} ·{' '}
            {study.posts} posts, {study.comments} comments · <b>{study.status}</b>
          </div>
          <table className="small" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th align="left">Who</th>
                <th>n</th>
                <th>Chars (median, middle half)</th>
                <th>Starts with name</th>
                <th>Question</th>
                <th>Emoji</th>
                <th>Sie / du</th>
                <th>One paragraph</th>
              </tr>
            </thead>
            <tbody>
              {row('Others', study.stats.others)}
              {row('Others, 3+ likes', study.stats.liked)}
              {row('You', study.stats.mine)}
            </tbody>
          </table>
          <div style={{ whiteSpace: 'pre-wrap' }}>{study.findings.summary}</div>
          {!!study.findings.jibran_differs.length && (
            <div className="small">
              <b>What your comments do differently</b>
              <ul>
                {study.findings.jibran_differs.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="small" style={{ flex: 1 }}>
              <b>Do</b>
              <ul>
                {study.findings.copy.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
            <div className="small" style={{ flex: 1 }}>
              <b>Avoid</b>
              <ul>
                {study.findings.avoid.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
          {!!study.findings.by_kind.length && (
            <div className="small">
              <b>By kind of post</b>
              <ul>
                {study.findings.by_kind.map((k, i) => (
                  <li key={i}>
                    <b>{k.kind}:</b> {k.how_people_comment}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="small">
            <b>Relevance:</b> {study.findings.relevance}
          </div>
          <details className="small">
            <summary>Per post ({study.findings.posts.length})</summary>
            <ul>
              {study.findings.posts.map((p) => (
                <li key={p.index}>
                  <b>{p.author}</b> · {p.kind}
                  {p.asks_readers ? ' · asks readers' : ''}: {p.topic}.{' '}
                  <span className="muted">{p.why}</span>{' '}
                  {p.url && (
                    <a href={p.url} onClick={(e) => (e.preventDefault(), openTab(p.url))}>
                      open
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <b className="small">Current drafting rules</b>
              <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>
                {drafting(study.status === 'ready' ? study.current_rules : null) ||
                  '(see Settings)'}
              </pre>
            </div>
            <div style={{ flex: 1 }}>
              <b className="small">Proposed</b>
              <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>
                {drafting(study.proposed_rules)}
              </pre>
            </div>
          </div>
          {study.status === 'ready' && (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn primary" onClick={() => void decide('apply')}>
                Use these rules
              </button>
              <button className="btn" onClick={() => void decide('dismiss')}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
