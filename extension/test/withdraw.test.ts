// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAD_MORE, withdrawInvite } from '../src/lib/adapters/send.ts';

// The Sent list shows 10 invitations and grows by 10 with each "Load more" click.
function sentList(total: number) {
  document.body.innerHTML = '<main><ul id="list"></ul><div id="foot"></div></main>';
  const list = document.getElementById('list')!;
  let shown = 0;
  const addPage = () => {
    for (const end = Math.min(total, shown + 10); shown < end; shown++) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.setAttribute('aria-label', `Withdraw invitation sent to Person ${shown + 1}`);
      b.textContent = 'Withdraw';
      li.append(b);
      list.append(li);
    }
    document.getElementById('foot')!.innerHTML =
      shown < total ? '<button type="button"><span>Load more</span></button>' : '';
    document.querySelector('#foot button')?.addEventListener('click', addPage);
  };
  addPage();
}

const run = async (name: string) => {
  const p = withdrawInvite(name, true);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  return p;
};

describe('withdrawInvite', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clicks "Load more" until it finds an old invitation', async () => {
    sentList(120);
    const r = await run('Person 95');
    expect(r).toMatchObject({ ok: true, step: 'found' });
  });
  it('finds an invitation on the first page without loading more', async () => {
    sentList(120);
    expect((await run('Person 3')).ok).toBe(true);
    expect(document.querySelectorAll('li').length).toBe(10);
  });
  it('reports how far it looked when the person is not listed', async () => {
    sentList(35);
    const r = await run('Nobody Here');
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/35 listed after 3 "Load more" clicks/);
  });
  it('knows the German button text', () => {
    expect(LOAD_MORE.test('Mehr laden')).toBe(true);
    expect(LOAD_MORE.test('Load more')).toBe(true);
    expect(LOAD_MORE.test('Withdraw')).toBe(false);
  });
});
