import type { KeyValueStore } from '@outreach/shared';

// Service workers have no localStorage; chrome.storage.local survives worker restarts.
export const chromeStore: KeyValueStore = {
  async get<T>(key: string) {
    const r = await browser.storage.local.get(key);
    return r[key] as T | undefined;
  },
  async set(key, value) {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await browser.storage.local.remove(key);
  },
};
