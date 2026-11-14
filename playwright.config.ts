import { defineConfig } from '@playwright/test';

// E2E against the built extension and the local docker-compose stack.
//   docker compose up -d && npm run build -w extension && npx playwright test
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
});
