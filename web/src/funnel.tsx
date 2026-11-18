import { useState } from 'react';
import { useData } from './views.tsx';

// Funnel (Jibran, 18.11.2026): how many were invited, accepted, written to, replied, replied with
// interest, got to a meeting and were won; in total and per campaign, for the last 30 or 90 days or ever.

type Step = 'invited' | 'accepted' | 'messaged' | 'replied' | 'hot' | 'meeting' | 'won';
type Counts = Record<Step, number>;
interface FunnelData {
  days: number | null;
  total: Counts;
  campaigns: (Counts & { campaign_id: string; name: string | null; status: string | null })[];
}
const STEPS: { id: Step; label: string }[] = [
  { id: 'invited', label: 'Invited' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'messaged', label: 'Messaged' },
  { id: 'replied', label: 'Replied' },
  { id: 'hot', label: 'Hot reply' },
  { id: 'meeting', label: 'Meeting' },
  { id: 'won', label: 'Won' },
];
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : '–');

export function Funnel({ refreshKey }: { refreshKey: number }) {
  const [days, setDays] = useState<number | null>(30);
  const [pick, setPick] = useState<string | null>(null);
  const { data } = useData<FunnelData>(`/panel/funnel${days ? `?days=${days}` : ''}`, refreshKey);
  if (!data) return null;
  const row = pick ? data.campaigns.find((c) => c.campaign_id === pick) : undefined;
  const counts: Counts = row ?? data.total;
  const max = Math.max(counts.invited, 1);
  return (
    <div className="card stack">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
        <h2 style={{ margin: 0 }}>Funnel{row ? `: ${row.name ?? row.campaign_id}` : ''}</h2>
        <div className="row" style={{ gap: 4 }}>
          {([30, 90, null] as const).map((d) => (
            <button
              key={String(d)}
              className={`btn ${days === d ? 'primary' : ''}`}
              onClick={() => setDays(d)}
            >
              {d ? `${d} days` : 'All time'}
            </button>
          ))}
        </div>
      </div>
      <div className="small muted">
        {days
          ? `People invited in the last ${days} days.`
          : 'Everyone, including the imported history.'}{' '}
        The percentage is the share of the step before.
      </div>
      <div className="stack" style={{ gap: 4 }}>
        {STEPS.map((s, i) => {
          const n = counts[s.id];
          const prev = i > 0 ? counts[STEPS[i - 1]!.id] : null;
          return (
            <div key={s.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="small" style={{ width: 80 }}>
                {s.label}
              </span>
              <div style={{ flex: 1, background: 'var(--line, #8882)', borderRadius: 4 }}>
                <div
                  style={{
                    width: `${Math.max((100 * n) / max, n ? 2 : 0)}%`,
                    background: 'var(--accent, #3b82f6)',
                    borderRadius: 4,
                    height: 14,
                  }}
                />
              </div>
              <span className="small" style={{ width: 90, textAlign: 'right' }}>
                <b>{n}</b>
                {prev !== null && <span className="muted"> · {pct(n, prev)}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <table className="small" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th align="left">Campaign</th>
            {STEPS.map((s) => (
              <th key={s.id} align="right">
                {s.label}
              </th>
            ))}
            <th align="right">Reply %</th>
          </tr>
        </thead>
        <tbody>
          {data.campaigns.map((c) => (
            <tr
              key={c.campaign_id}
              onClick={() => setPick(pick === c.campaign_id ? null : c.campaign_id)}
              style={{ cursor: 'pointer', fontWeight: pick === c.campaign_id ? 700 : undefined }}
              title="Show this campaign in the bars (click again for all)"
            >
              <td>
                {c.name ?? c.campaign_id}
                {c.status === 'on' && <span className="badge ok"> on</span>}
              </td>
              {STEPS.map((s) => (
                <td key={s.id} align="right">
                  {c[s.id]}
                </td>
              ))}
              <td align="right">{pct(c.replied, c.accepted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
