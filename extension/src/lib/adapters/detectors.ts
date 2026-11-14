// Signs that LinkedIn wants this traffic to stop (PLAN rule 2, browsing_conduct "Never retry a page that
// refused you"). Any hit stops the current action immediately.
const BLOCKED_PATHS = /^\/(checkpoint|authwall|uas\/login|login|signup)\b/;
const WARNING_TEXT = [
  /weekly invitation limit/i,
  /you['’]ve reached the (weekly )?limit/i,
  /unusual activity/i,
  /security (check|verification)/i,
  /verify (that )?you['’]?re (a )?human/i,
  /your account (has been|is) restricted/i,
  /Einladungslimit/i,
  /ungewöhnliche Aktivität/i,
  /Sicherheitsüberprüfung/i,
  /Konto (wurde )?eingeschränkt/i,
];

// Visible to a person: has a real size, and neither it nor an ancestor is hidden.
export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 60 || r.height < 60) return false;
  for (let e: Element | null = el; e; e = e.parentElement) {
    const st = getComputedStyle(e);
    // An unset opacity is "" (fully visible), not 0.
    const transparent = st.opacity !== '' && Number(st.opacity) === 0;
    if (st.display === 'none' || st.visibility === 'hidden' || transparent) return false;
  }
  return true;
}

export function linkedInWarning(doc: Document, pathname: string): string | null {
  if (BLOCKED_PATHS.test(pathname)) return `LinkedIn redirected to ${pathname}`;
  // LinkedIn embeds invisible reCAPTCHA frames on normal pages (seen 09.10.2026 on a company feed that
  // loaded fine). Only a CAPTCHA a person could actually see counts.
  const captcha = Array.from(
    doc.querySelectorAll<HTMLElement>(
      'iframe[src*="captcha" i], iframe[title*="captcha" i], #captcha-internal',
    ),
  ).find(isVisible);
  if (captcha) {
    const r = captcha.getBoundingClientRect();
    const src = (captcha.getAttribute('src') ?? captcha.getAttribute('title') ?? captcha.id).slice(
      0,
      80,
    );
    return `CAPTCHA shown (${src}, ${Math.round(r.width)}x${Math.round(r.height)})`;
  }
  // Only dialogs and alerts: post texts may mention these words without being a warning.
  const surfaces = Array.from(
    doc.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"], .artdeco-modal'),
  );
  for (const el of surfaces) {
    const text = el.textContent ?? '';
    const hit = WARNING_TEXT.find((re) => re.test(text));
    if (hit) return `LinkedIn warning: "${text.trim().replace(/\s+/g, ' ').slice(0, 140)}"`;
  }
  return null;
}
