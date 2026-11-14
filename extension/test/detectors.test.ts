// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { linkedInWarning } from '../src/lib/adapters/detectors.ts';

function page(html: string, size: { w: number; h: number } | null) {
  document.body.innerHTML = html;
  const frame = document.querySelector('iframe');
  if (frame && size) {
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      width: size.w,
      height: size.h,
    } as DOMRect);
  }
}

describe('linkedInWarning', () => {
  it('ignores an invisible reCAPTCHA frame on a normal page', () => {
    page(
      '<main><iframe src="https://www.google.com/recaptcha/enterprise/anchor?k=x" style="display:none"></iframe></main>',
      { w: 0, h: 0 },
    );
    expect(linkedInWarning(document, '/company/x/posts/')).toBeNull();
    page(
      '<main><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor"></iframe></main>',
      { w: 1, h: 1 },
    );
    expect(linkedInWarning(document, '/company/x/posts/')).toBeNull();
  });

  it('stops on a visible CAPTCHA and says what it saw', () => {
    page(
      '<main><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/bframe"></iframe></main>',
      { w: 400, h: 580 },
    );
    expect(linkedInWarning(document, '/feed/')).toMatch(
      /^CAPTCHA shown \(.*recaptcha.*, 400x580\)$/,
    );
  });

  it('stops on challenge pages and warning dialogs', () => {
    page('<main></main>', null);
    expect(linkedInWarning(document, '/checkpoint/challenge/abc')).toMatch(/checkpoint/);
    page('<div role="dialog">You’ve reached the weekly invitation limit</div>', null);
    expect(linkedInWarning(document, '/feed/')).toMatch(/weekly invitation limit/);
    page('<p>In my post I talk about unusual activity in claims data.</p>', null);
    expect(linkedInWarning(document, '/feed/')).toBeNull(); // post text is not a warning
  });
});
