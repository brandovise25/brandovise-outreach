// Creates or resets an app user. Run on the server: npm run -w server create-user -- <email>
// Connects with OWNER_DATABASE_URL (the api_rpc role cannot write tables). Password is prompted, never passed as an argument.
import pg from 'pg';
import { hashPassword } from '../auth/passwords.ts';

const email = process.argv[2];
const url = process.env.OWNER_DATABASE_URL;
if (!email || !url) {
  console.error('usage: OWNER_DATABASE_URL=... npm run -w server create-user -- <email>');
  process.exit(1);
}

const password = await readPassword('Password (min 12 chars): ');
if (password.length < 12) {
  console.error('password too short');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(
  `insert into outreach.app_users (email, password_hash) values ($1, $2)
   on conflict (email) do update set password_hash = excluded.password_hash, enabled = true`,
  [email.toLowerCase(), await hashPassword(password)],
);
await client.end();
console.warn(`user ${email} saved`);

// Reads a password without echoing it. On a terminal, keystrokes are read in raw mode; when stdin is
// piped (scripts), the first line is used.
async function readPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += String(chunk);
    return data.split(/\r?\n/)[0] ?? '';
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (key: string) => {
      for (const ch of key) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          cleanup();
          return reject(new Error('cancelled'));
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}
