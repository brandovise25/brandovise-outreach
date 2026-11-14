import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db.ts';
import { TokenService } from './auth/tokens.ts';
import { OpenRouterClient } from './ai/openrouter.ts';
import { startRepliesWorker } from './replies.ts';
import { startCompanyWorker } from './web/company-worker.ts';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const deps = {
  config,
  db,
  tokens: new TokenService(config.JWT_SECRET),
  openrouter: config.OPENROUTER_API_KEY
    ? new OpenRouterClient(config.OPENROUTER_API_KEY, config.OPENROUTER_BASE_URL)
    : undefined,
};
const app = await buildApp(deps);

const shutdown = async () => {
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
startCompanyWorker(deps);
startRepliesWorker(deps);
