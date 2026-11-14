// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { redactDocument, redactHref, redactText } from '../src/lib/redact.ts';

describe('redactText', () => {
  it('keeps LinkedIn UI words and dates, hides everything else', () => {
    expect(redactText('Connect')).toBe('Connect');
    expect(redactText('Jan 2021 - Present · 4 yrs 10 mos')).toBe(
      'Jan 2021 - Present · 4 yrs 10 mos',
    );
    expect(redactText('Anna Wagner')).toBe('xxxx xxxxxx');
    expect(redactText('Invite Anna Wagner to connect')).toBe('Invite xxxx xxxxxx to connect');
    expect(redactText('3w')).toBe('3w');
  });
});

describe('redactHref', () => {
  it('replaces profile slugs consistently and long ids', () => {
    expect(redactHref('/in/anna-wagner-123/?miniProfileUrn=abc')).toMatch(
      /^https:\/\/www\.linkedin\.com\/in\/person-\d+\/$/,
    );
    const a = redactHref('https://www.linkedin.com/feed/update/urn:li:activity:7351234567890/');
    const b = redactHref('https://www.linkedin.com/feed/update/urn:li:activity:7351234567891/');
    expect(a).toMatch(/urn:li:activity:9{12}\d\/$/);
    expect(a).not.toBe(b); // distinct posts stay distinct
    expect(a).not.toContain('7351234567890');
    expect(redactHref('https://wagner-finanz.de')).toBe('https://example.com/');
  });
});

describe('redactDocument', () => {
  it('drops embedded data and personal text but keeps structure and labels', () => {
    document.documentElement.innerHTML = `
      <head><script>var me = "Anna Wagner";</script><style>.x{}</style></head>
      <body><main>
        <section class="artdeco-card"><h1 class="text-heading-xlarge">Anna Wagner</h1>
          <div class="text-body-medium">Versicherungsmaklerin | Inhaberin Wagner Finanz</div>
          <img src="https://media.licdn.com/anna.jpg" alt="Anna Wagner">
          <button aria-label="Invite Anna Wagner to connect" class="artdeco-button"><span>Connect</span></button>
          <a href="/in/anna-wagner/overlay/contact-info/">Contact info</a>
          <code style="display:none">{"firstName":"Anna","lastName":"Wagner"}</code>
        </section>
        <section><h2><span aria-hidden="true">About</span></h2><p>Unabhängiges Maklerbüro seit 2011</p></section>
      </main></body>`;
    const html = redactDocument(document);
    expect(html).not.toMatch(/Anna|Wagner|Versicherungsmaklerin|Unabhängiges|licdn/);
    expect(html).toContain('aria-label="Invite xxxx xxxxxx to connect"');
    expect(html).toContain('<span>Connect</span>');
    expect(html).toContain('class="text-heading-xlarge"');
    expect(html).toContain('About');
    expect(html).toContain('2011');
    expect(html).toMatch(
      /href="https:\/\/www\.linkedin\.com\/in\/person-1\/overlay\/contact-info\/"/,
    );
  });
});
