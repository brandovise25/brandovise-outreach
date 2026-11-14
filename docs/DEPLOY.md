# Running and deploying

**How the parts fit together:**
- The **Docker server** (API plus web app) holds the database logic and the whole interface at `/app/`: Today, Approve, Leads, Comments, Log.
  - UI changes deploy with the server. Locally that's `docker compose up -d --build`; in production, Easypanel rebuilds on push.
  - The app also works in any browser tab: `http://localhost:3300/app/` locally, `https://outreach.<domain>/app/` on the server.
- The **Chrome extension** is a thin shell:
  - its side panel shows the server's app;
  - it holds the login;
  - it does the LinkedIn-only work: reading pages now; sending later, and only after your click.

  It needs a reload in `chrome://extensions` only when that LinkedIn part changes.

The same server image runs locally (docker compose) and on the VPS (Easypanel). The extension is one zip that can point at either.

## 1. Local (on the Mac)

```bash
npm install
docker compose up -d --build          # Postgres on 127.0.0.1:54330, API on http://localhost:3300
scripts/local-user.sh you@example.com # create your local login (prompts for a password)
npm run zip -w extension              # extension/.output/brandovise-outreach-<version>-chrome.zip
```

- The API container runs the migrations on start (`RUN_MIGRATIONS=true`).
- Schema: the baseline migration is the real Supabase `outreach` schema. Data: `SUPABASE_DB_URL=... scripts/import-supabase.sh`. It copies everything into the local database, read-only on Supabase, and compares row counts.
- AI test: `OPENROUTER_API_KEY=... docker compose up -d` passes your key into the local API. The key stays in your shell and is never written to the repo.
- To reset: `docker compose down -v`. This deletes the local database.
- To run the E2E test: `docker compose up -d && npm run build -w extension && npx playwright test`. It needs `.env.e2e` with a local test user (see `e2e/extension.spec.ts`).

## 2. Install the extension from the zip

1. Unzip `brandovise-outreach-<version>-chrome.zip` into a folder that stays put (for example `~/Extensions/brandovise-outreach`).
2. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and choose that folder.
3. The extension ID is always `jldmmlhhnmoomahfmeobddgobklcjdof`, pinned by the key in `extension/extension-key.pub.txt`.
4. Open the extension's **Options** page and pick a server:
   - **Local:** `http://localhost:3300`
   - **Server:** `https://outreach.<your-domain>`
5. Click **Use this server**. Chrome asks for access to that server; allow it.
6. Sign in.
7. To update: unzip the new version over the same folder, then click the reload icon on `chrome://extensions`.

Switching servers signs you out of the old one. Tokens are never sent to a different server.

## 3. VPS with Easypanel: one Compose service (recommended)

`docker-compose.prod.yml` holds everything: Postgres 17, the API/web app, and a nightly `pg_dump` backup (14 daily, 8 weekly, 6 monthly).

1. In Easypanel, open your project and add a service: **+ Service → Compose**.
2. **Source:**
   - GitHub repo `<your-github-user>/<your-fork>`, branch `main`.
   - Compose file path: `docker-compose.prod.yml`.
3. **Environment:** the variables from `.env.prod.example`, with values from `openssl rand -hex 32`. Use hex: special characters break database URLs.
   ```
   POSTGRES_PASSWORD=
   API_RPC_PASSWORD=
   JWT_SECRET=
   OPENROUTER_API_KEY=
   API_TOKEN=
   ```
4. **Domains:** `outreach.<your-domain>` → service `api`, port `3000`, HTTPS on. Point a DNS A record at the VPS.
5. **Deploy.**
   - The `api` logs show `migrations applied, settings seeded, api_rpc password set`.
   - `https://outreach.<your-domain>/health` returns `{"ok":true}`.
6. **Create your user** in the `api` container's console (it prompts for the password):
   ```bash
   OWNER_DATABASE_URL=$MIGRATION_DATABASE_URL node_modules/.bin/tsx server/src/cli/create-user.ts you@example.com
   ```

Notes:
- Postgres has no published port, so it is reachable only inside the stack.
- Backups go to the `backups` volume. Copy them off the server regularly.

## 3b. Alternative: separate Easypanel services (App + Postgres)

**Data:** the migrations create the schema.

1. **Project:** create a project in Easypanel, e.g. `outreach`.
2. **Postgres service:**
   - Add a Postgres service, version 17 (same as Supabase and local), e.g. `db`.
   - Note its internal host (Easypanel shows it, e.g. `outreach_db`), the user and the password.
   - Turn on Easypanel's scheduled backups for this service, to S3 or a Storage Box.
3. **Staging database:** in the Postgres service console, run `create database outreach_staging;`.
4. **Import the Supabase data** with `scripts/import-supabase.sh` (see "Data" above).
5. **App service `api`:**
   - Source: GitHub repo `<your-github-user>/<your-fork>`, branch `main`. Easypanel needs access to the repo.
   - Build: Dockerfile, path `server/Dockerfile`, build context the repo root.
   - Environment (Easypanel "Environment" tab; the values live only there):
     ```
     NODE_ENV=production
     PORT=3000
     RUN_MIGRATIONS=true
     MIGRATION_DATABASE_URL=postgres://<db-user>:<db-password>@<db-host>:5432/outreach?sslmode=disable
     API_RPC_PASSWORD=<openssl rand -base64 32>
     DATABASE_URL=postgres://api_rpc:<same API_RPC_PASSWORD>@<db-host>:5432/outreach
     JWT_SECRET=<openssl rand -base64 48>
     ALLOWED_ORIGINS=chrome-extension://jldmmlhhnmoomahfmeobddgobklcjdof
     OPENROUTER_API_KEY=<your key>
     API_TOKEN=<openssl rand -hex 32>   # remote API for scripts/outreach.sh and Claude; cannot approve
     ```
   - Domains: `outreach.<your-domain>` → port 3000, HTTPS on (Easypanel issues the certificate). Point a DNS A record at the VPS.
   - Deploy. The logs should show `migrations applied`. Check `https://outreach.<your-domain>/health`.
6. **Create your user** in the app's console:
   ```bash
   OWNER_DATABASE_URL=$MIGRATION_DATABASE_URL node_modules/.bin/tsx server/src/cli/create-user.ts you@example.com
   ```
7. **Optional staging app:** a second app service with the same settings, `.../outreach_staging` in both database URLs, and its own domain.

**Migrations and review:** migrations run when the container starts. Every migration is reviewed in the repo, and tried locally and on staging, before it is merged to `main`. A deploy of `main` then applies it to prod.

**Keep the Postgres service internal.** Do not expose its port publicly in Easypanel.

## Deploying updates (scripts/deploy.sh)

After `git push`, run `scripts/deploy.sh`. It refuses when the latest commit is not on GitHub, calls the
Easypanel deploy link from `DEPLOY_HOOK_URL` in the git-ignored `.env`, and waits until the server has applied
the newest migration. The link carries a secret token: never paste it into a file in the repo (the
`easypanel-deploy-hook` rule in `.gitleaks.toml` blocks the commit). Regenerate it in Easypanel if it leaks.
