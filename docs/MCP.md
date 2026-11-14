# MCP server: the outreach robot in Claude

The server answers MCP at `/mcp` (streamable HTTP, stateless). Code: `server/src/routes/mcp.ts`, tests: `server/test/mcp.test.ts`. The newer tools call the web app's own routes, so they run the same checks as the app.

## What Claude can do

| Tool | Does |
|---|---|
| `status` | Limits, counts waiting, auto-post, what the robot is doing |
| `robot_health` | Why the robot works or waits: each extension's last check-in, last error and last job request; robot hours, pause, queue, gating settings |
| `report` | Numbers for a report (per campaign, per week, replies waiting, baseline from before the robot, jobs, failures, comments) |
| `list_comments`, `list_queue`, `list_leads`, `list_campaigns`, `activity`, `list_jobs`, `job_log` | Read |
| `review_comment` | Approve, reject or edit a comment draft |
| `review_queue` | Approve, reject, edit or postpone an invite or message |
| `review_lead` | Approve a lead into a campaign, or reject it |
| `get_settings`, `set_setting` | All Settings-page values (caps, send windows, robot hours, pacing, auto switches, AI budget, pause); every change asks first |
| `set_live` | Live sending on, or back to dry run; asks first |
| `set_campaign` | Campaign on or off; switching on asks first |
| `start_job`, `cancel_job` | Comment round, sync, prospecting, send round, post an approved comment, company lookup, study round (comment library), voice profile round |
| `dashboard`, `campaign`, `send_preview` | Start page numbers, one campaign in detail, what the next send round would send |
| `comment_library`, `label_library_comment` | Comments collected by study rounds; mark good or bad examples |
| `comment_study`, `analyse_comments`, `decide_comment_study` | The latest study, a new analysis (a few cents), apply or dismiss its rules; applying asks first |
| `set_comment_live`, `set_autopost` | Comment posting live or practice, auto-post on or off; switching on asks first |
| `list_texts`, `edit_doc`, `edit_prompt` | Rule documents and AI prompts; saving or reverting asks first |
| `list_keywords`, `set_keywords` | Prospecting keywords and how each did; replacing the list asks first |
| `voice_profile`, `review_voice` | The writing voice; approving a new one asks first |
| `list_companies`, `add_companies`, `find_companies`, `search_usage`, `set_company_campaign` | Companies and their website signals; add by domain, web search or city and office kind |
| `message_stats`, `set_deal_stage` | How each opening did; where a conversation stands |

**Approving, changing a setting, going live, switching a campaign or auto-post on, and changing rules, prompts, keywords or the voice need Jibran's yes in the chat.** An approve call without `user_confirmed` changes nothing and returns `ask_user_in_chat` with exactly what would be posted or sent. Claude asks, and repeats the call with `user_confirmed=true` only after the yes. This is enforced by Claude following the server's instructions, not by the server, so keep Claude's tool permission prompt on for the review tools (don't "always allow" them). Approvals made through Claude are marked: `action_queue.approved_via = 'mcp'`, `engagement.reviewed_via = 'mcp'`.

Approving through Claude runs the full comment rules (the side panel lets Jibran override some of them; Claude gets no override). Rejecting, editing and "later" need no confirmation.

## Connect

The token is `API_TOKEN` from the server's environment (the same one `scripts/outreach.sh` uses, in `.env`). Never paste it into a chat or commit it.

**Claude Code** (run in a terminal, once):
```bash
claude mcp add --scope user --transport http brandovise-outreach https://outreach.example.com/mcp --header "x-api-token: $(grep -E '^API_TOKEN=' .env | cut -d= -f2-)"
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Desktop):
```json
{
  "mcpServers": {
    "brandovise-outreach": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.15.2", "https://outreach.example.com/mcp", "--header", "x-api-token:${OUTREACH_TOKEN}"],
      "env": { "OUTREACH_TOKEN": "<API_TOKEN>" }
    }
  }
}
```

claude.ai (web, phone) is not supported yet: it needs an OAuth login on the server.
