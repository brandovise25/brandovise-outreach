import { useState } from 'react';
import { openTab, panelPost } from './api.ts';
import { useData } from './views.tsx';
import { CommentStudy } from './study.tsx';

// Comment library: real comments read under LinkedIn posts (Jibran's and other people's). Mark good and
// bad examples; drafting uses them as style references (good: write like this, bad: never like this).

interface Sample {
  id: number;
  post_url: string | null;
  post_author: string | null;
  post_excerpt: string | null;
  author: string;
  author_headline: string | null;
  text: string;
  reactions: number | null;
  is_reply: boolean;
  reply_to: string | null;
  is_mine: boolean;
  lang: string | null;
  chars: number;
  label: 'good' | 'bad' | null;
  note: string | null;
}
interface Library {
  counts: Record<string, number>;
  stats: {
    mine_median_chars: number | null;
    others_median_chars: number | null;
    others_liked_median_chars: number | null;
  };
  items: Sample[];
}
type Filter = 'all' | 'others' | 'mine' | 'liked' | 'good' | 'bad';

export function CommentLibrary({
  refreshKey,
  toast,
}: {
  refreshKey: number;
  toast: (m: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const { data, error, reload } = useData<Library>(
    `/panel/comment-library?filter=${filter}&limit=300`,
    refreshKey,
  );
  const mark = async (s: Sample, label: 'good' | 'bad' | null) => {
    const note =
      label === 'bad' && s.label !== 'bad'
        ? prompt('Why is it bad? (optional, helps the AI)', s.note ?? '')
        : null;
    await panelPost(`/panel/comment-library/${s.id}/label`, { label, note });
    reload();
    toast(label ? `Marked as ${label}.` : 'Mark removed.');
  };
  const n = (x: number | null | undefined) => (x == null ? '–' : Math.round(x));

  // group by post, in the order the server returns them
  const groups: { url: string; author: string | null; excerpt: string | null; items: Sample[] }[] =
    [];
  for (const s of data?.items ?? []) {
    const g = groups.find((x) => x.url === (s.post_url ?? ''));
    if (g) g.items.push(s);
    else
      groups.push({
        url: s.post_url ?? '',
        author: s.post_author,
        excerpt: s.post_excerpt,
        items: [s],
      });
  }

  return (
    <>
      <CommentStudy refreshKey={refreshKey} toast={toast} />
      <div className="card stack">
        <div className="small">
          Real comments the robot read under posts. Mark good ones 👍 and bad ones 👎: new drafts
          copy the style of the good ones and avoid the bad ones.
        </div>
        {data && (
          <div className="small muted">
            {data.counts.all ?? 0} comments under {data.counts.posts ?? 0} posts · typical length:
            yours {n(data.stats.mine_median_chars)} chars, others{' '}
            {n(data.stats.others_median_chars)}, well-liked others{' '}
            {n(data.stats.others_liked_median_chars)}
          </div>
        )}
      </div>
      <div className="tabs" role="tablist" style={{ marginTop: 4 }}>
        {(
          [
            ['all', 'All'],
            ['others', 'Others'],
            ['mine', 'Mine'],
            ['liked', 'Well-liked'],
            ['good', '👍 Good'],
            ['bad', '👎 Bad'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            className="tab"
            aria-selected={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
            {!!data?.counts[id] && <span className="n">{data.counts[id]}</span>}
          </button>
        ))}
      </div>
      {!data ? (
        <div className="empty">{error ? `Could not load: ${error}` : 'Loading…'}</div>
      ) : !groups.length ? (
        <div className="empty">
          Nothing here yet. Comments are collected when the robot reads post pages.
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.url} className="card stack">
            <div className="row between">
              <b className="small">{g.author ?? 'Post'}</b>
              {g.url && (
                <button className="btn" onClick={() => openTab(g.url)}>
                  Open post
                </button>
              )}
            </div>
            {g.excerpt && <div className="small muted">{g.excerpt.slice(0, 220)}…</div>}
            {g.items.map((s) => (
              <div
                key={s.id}
                className="stack"
                style={{
                  borderLeft: `3px solid ${s.is_mine ? 'var(--accent, #4a7)' : 'transparent'}`,
                  paddingLeft: s.is_reply ? 18 : 8,
                }}
              >
                <div className="row between small">
                  <span>
                    <b>{s.is_mine ? 'You' : s.author}</b>
                    {s.reply_to && <span className="muted"> → {s.reply_to}</span>}
                    <span className="muted">
                      {' '}
                      · {s.chars} chars{s.reactions ? ` · ${s.reactions} 👍` : ''}
                      {s.lang ? ` · ${s.lang}` : ''}
                    </span>
                  </span>
                  <span className="row" style={{ gap: 4 }}>
                    <button
                      className="btn"
                      aria-pressed={s.label === 'good'}
                      title="Good example"
                      onClick={() => void mark(s, s.label === 'good' ? null : 'good')}
                    >
                      {s.label === 'good' ? '👍 good' : '👍'}
                    </button>
                    <button
                      className="btn"
                      aria-pressed={s.label === 'bad'}
                      title="Bad example"
                      onClick={() => void mark(s, s.label === 'bad' ? null : 'bad')}
                    >
                      {s.label === 'bad' ? '👎 bad' : '👎'}
                    </button>
                  </span>
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{s.text}</div>
                {s.note && <div className="small muted">Note: {s.note}</div>}
              </div>
            ))}
          </div>
        ))
      )}
    </>
  );
}
