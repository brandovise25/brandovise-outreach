import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

// Public key that pins the extension id (see extension-id.txt), so reinstalling from the zip
// keeps the same id and storage. It is a public key, not a secret; the private key was discarded.
const key = readFileSync(new URL('./extension-key.pub.txt', import.meta.url), 'utf8').trim();

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  zip: { artifactTemplate: 'brandovise-outreach-{{version}}-chrome.zip' },
  manifest: {
    name: 'Brandovise Outreach',
    description: 'LinkedIn outreach assistant for Brandovise. Nothing is sent without approval.',
    minimum_chrome_version: '120',
    key,
    permissions: ['storage', 'alarms', 'sidePanel', 'notifications', 'tabGroups'],
    host_permissions: ['https://www.linkedin.com/*'],
    // The API server is chosen on the options page; Chrome asks for access to that one origin.
    optional_host_permissions: ['http://localhost/*', 'http://127.0.0.1/*', 'https://*/*'],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
    action: { default_title: 'Brandovise Outreach' },
  },
});
