// Runs database migrations, applies the settings seed (insert-if-missing), then sets the api_rpc password.
// Used by the container entrypoint (RUN_MIGRATIONS=true), scripts/test-db.sh and CI.
//   MIGRATION_DATABASE_URL  owner connection (can create tables and roles)
//   API_RPC_PASSWORD        password for the restricted role the API connects with
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const url = process.env.MIGRATION_DATABASE_URL;
const apiPassword = process.env.API_RPC_PASSWORD;
if (!url || !apiPassword) {
  console.error('MIGRATION_DATABASE_URL and API_RPC_PASSWORD are required');
  process.exit(1);
}

// Say clearly what is wrong without printing the URL (it contains the password).
try {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname) throw new Error();
} catch {
  console.error(
    'MIGRATION_DATABASE_URL is not a valid postgres://user:password@host:5432/db URL. ' +
      'Check for leftover placeholders, and URL-encode special characters (@ : / ? # %) in the password.',
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const dbmate = createRequire(import.meta.url).resolve('dbmate/dist/cli.js');
  execFileSync(
    process.execPath,
    [dbmate, '--migrations-dir', join(root, 'db/migrations'), '--no-dump-schema', '--wait', 'up'],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
  );

  await client.query(readFileSync(join(root, 'db/seed/ext_settings.sql'), 'utf8'));
  await client.query(`alter role api_rpc login password ${client.escapeLiteral(apiPassword)}`);
  console.warn('migrations applied, settings seeded, api_rpc password set');
} finally {
  await client.end();
}
