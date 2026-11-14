import { chromeStore } from './chrome-store.ts';

// App sign-in warning (Jibran, 08.11.2026): when the extension loses its Brandovise login without
// Jibran signing out, the robot silently stops. Now the icon gets a red "!", its tooltip says why,
// and a notification appears once. Signing out on purpose (or switching servers) shows nothing.

const TOKENS_KEY = 'auth.tokens';
const ON_PURPOSE_KEY = 'auth.signedOutOnPurpose';

export async function markSignOutOnPurpose(): Promise<void> {
  await chromeStore.set(ON_PURPOSE_KEY, true);
}

async function show(signedIn: boolean, onPurpose: boolean): Promise<void> {
  try {
    if (signedIn || onPurpose) {
      const text = await browser.action.getBadgeText({});
      if (text === '!') await browser.action.setBadgeText({ text: '' });
      return;
    }
    await browser.action.setBadgeText({ text: '!' });
    await browser.action.setBadgeBackgroundColor({ color: '#c0392b' });
    await browser.action.setTitle({
      title:
        'Brandovise Outreach: signed out of the app. The robot is stopped until you sign in again.',
    });
  } catch {
    // not available in tests
  }
}

export function watchAppLogin(): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[TOKENS_KEY]) return;
    const { oldValue, newValue } = changes[TOKENS_KEY];
    void (async () => {
      if (newValue) {
        await chromeStore.remove(ON_PURPOSE_KEY);
        await show(true, false);
        return;
      }
      if (!oldValue) return;
      const onPurpose = (await chromeStore.get<boolean>(ON_PURPOSE_KEY)) === true;
      await show(false, onPurpose);
      if (!onPurpose)
        await browser.notifications
          .create(`signout-${Date.now()}`, {
            type: 'basic',
            iconUrl: browser.runtime.getURL('/icon-off/128.png'),
            title: 'Brandovise Outreach is signed out',
            message: 'The robot is stopped. Open the side panel and sign in again.',
          })
          .catch(() => undefined);
    })();
  });
  // After a browser restart: show the state as it is.
  void (async () => {
    const signedIn = (await chromeStore.get(TOKENS_KEY)) !== undefined;
    await show(signedIn, (await chromeStore.get<boolean>(ON_PURPOSE_KEY)) === true);
  })();
}
