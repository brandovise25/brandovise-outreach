// Compares dotted numeric versions ("1.2.10" > "1.2.9"). Missing parts count as 0.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function isVersionAllowed(version: string, minVersion: string): boolean {
  return compareVersions(version, minVersion) >= 0;
}
