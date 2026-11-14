# Brandovise Outreach

A self-hosted LinkedIn outreach assistant: a Chrome extension that does the browser work, a server
that holds the data and the rules, a web app to review everything, and an MCP server so Claude can
run it with you. Built by Brandovise GmbH for its own outreach to small professional offices.

**License: source-available, free for non-commercial use** ([PolyForm Noncommercial 1.0.0](LICENSE)).
You may read, run, change and share the code for any non-commercial purpose. Commercial use, including
selling it, offering it as a service or using it in paid client work, needs written permission from
Brandovise GmbH. Because of this restriction it is not "open source" in the OSI sense.

## What it does

- **Finds leads.** Searches LinkedIn by keyword or starts from a list of companies (pasted domains,
  a web search, or offices from OpenStreetMap). It reads each company's public website for signals
  (shop platform, chat widget, WhatsApp support, hiring) and the Impressum for the owner's name.
- **Checks fit.** An AI fit check against your targeting rules decides whom to contact. Unclear cases
  wait for you.
- **Writes the first contact.** Invite notes and first messages that open with one concrete fact about
  the person. Checks in code (length, formal address, no grading, no invented numbers, the fact must
  really appear) run before anything can be approved.
- **Comments.** Reads your feed, picks posts worth answering, drafts comments in your voice, and checks
  every number and quote against the post before posting.
- **Handles replies.** Sorts replies (interested, question, objection, later, not interested, opt-out),
  drafts an answer for your approval, and tracks the deal stage. Opt-outs stop the sequence for good.
- **Learns.** Shows which openings, keywords and hooks lead to accepted invites and replies. A study
  round compares how real people comment with your drafts and proposes new drafting rules.

## Safety rules built into the code

- Nothing is sent, posted or connected without your approval, or an auto-approve switch you turn on
  yourself. Replies are never auto-approved.
- Every LinkedIn job runs in its own tab and never touches a tab you opened.
- Daily and weekly caps, send windows and pauses between jobs live in the settings.
- On any LinkedIn warning the robot stops. It never solves a CAPTCHA, never logs in and never types a
  password. There is nothing in it meant to hide automation from LinkedIn.
- Page text (profiles, posts, messages) is treated as data, never as instructions to the AI.
- Through MCP, anything that sends or changes behaviour returns a preview first; Claude must ask you
  in the chat before it repeats the call with your confirmation.

**Your responsibility.** LinkedIn's User Agreement restricts automated activity, and using this tool
can get an account limited. Data protection law (GDPR) and unfair-competition law (in Germany UWG §7)
apply to whom you contact and how. Use low volumes, review what goes out, and check the rules for your
country. The software comes without warranty (see the license).

## How it is built

| Part | Folder | What it is |
|---|---|---|
| Chrome extension | `extension/` | WXT, Manifest V3, TypeScript. Side panel that frames the web app; content scripts that read and act on LinkedIn pages. |
| Server | `server/` | Fastify API, AI tasks through OpenRouter, MCP endpoint at `/mcp`. Reaches the database only through `public.ext_*` functions. |
| Web app | `web/` | React, served by the server at `/app/`. |
| Shared | `packages/shared/` | Zod contracts and the deterministic checks used by server and extension. |
| Database | `db/migrations/` | PostgreSQL schema `outreach` (dbmate). Sequences and follow-ups run as database triggers. |

## Run it locally

Requirements: Node.js 22+, Docker, Chrome.

```bash
npm install
echo "OPENROUTER_API_KEY=sk-or-..." > .env   # your OpenRouter key, read by docker compose
docker compose up -d --build         # Postgres on 127.0.0.1:54330, API on http://localhost:3300
scripts/local-user.sh you@example.com   # create your login
npm run zip -w extension             # extension/.output/*.zip
```

Unzip the extension into a folder that stays put and load it in `chrome://extensions` (Developer mode,
"Load unpacked"). In the side panel, choose the local server and log in.

AI tasks need the OpenRouter key; without it the rest works and AI steps report that AI is not
configured. For a server, the variables are listed in `.env.prod.example`. The prompts and rule
documents live in the database and can be edited in the app under Settings → Prompts & rules; the
defaults are written for Brandovise's own audience, so adapt them to yours.

Hosting on a VPS: see [docs/DEPLOY.md](docs/DEPLOY.md). Claude integration: see [docs/MCP.md](docs/MCP.md).

## Tests

```bash
scripts/test-db.sh up    # throwaway Postgres on port 54329
npm test
npm run lint && npm run typecheck
```

## Contributing

Issues and pull requests are welcome. By contributing you agree that your contribution is licensed
under the same terms. Keep secrets out of the repo (a gitleaks pre-commit hook checks this), add tests
for behaviour changes, and never add anything meant to evade LinkedIn's detection.

Required Notice: Copyright 2026 Brandovise GmbH
