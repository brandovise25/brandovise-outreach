import type { Status } from './messages.ts';

export function StatusCard({ status }: { status: Status }) {
  const rows: [string, string][] = [
    ['Server', status.apiUrl || 'not chosen yet'],
    ['Version', status.version],
    ['Signed in', status.signedIn ? 'yes' : 'no'],
    ['Dry run', status.dryRun === null ? '–' : status.dryRun ? 'on (nothing is sent)' : 'OFF'],
    ['Paused', status.paused === null ? '–' : status.paused ? 'yes' : 'no'],
    ['Last heartbeat', status.lastHeartbeat ?? '–'],
  ];
  return (
    <dl
      aria-label="Status"
      style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem' }}
    >
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: '#555' }}>{k}</dt>
          <dd style={{ margin: 0 }}>{v}</dd>
        </div>
      ))}
      {status.lastError && (
        <div style={{ display: 'contents' }}>
          <dt style={{ color: '#b00020' }}>Last error</dt>
          <dd style={{ margin: 0, color: '#b00020' }}>{status.lastError}</dd>
        </div>
      )}
    </dl>
  );
}
