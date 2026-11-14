#!/usr/bin/env bash
# Remote control of the outreach app through its API (token from .env, never printed).
#   scripts/outreach.sh status            # limits, counts, auto-post state
#   scripts/outreach.sh round             # queue a comment round (runs in the extension's own window)
#   scripts/outreach.sh sync              # queue a sync: accepted invites, new replies, pending count
#   scripts/outreach.sh prospect          # queue a prospect round (search, screen, fit check, leads)
#   scripts/outreach.sh sync-pages        # queue a capture of inbox / connections / sent invitations
#   scripts/outreach.sh post <comment-id> # queue posting of a comment Jibran has already approved
#   scripts/outreach.sh capture <url>...  # developer: save up to 10 LinkedIn pages raw (robot tab)
#   scripts/outreach.sh read <url>...     # developer: like capture, but reads each page through (scroll, "see more")
#   scripts/outreach.sh comments          # list comment drafts
#   scripts/outreach.sh jobs              # recent jobs and their results
#   scripts/outreach.sh cancel <job-id>   # cancel a queued job / stop a running one
#   scripts/outreach.sh robot             # what the robot is doing right now
#   scripts/outreach.sh log [job-id]      # step-by-step log (latest first)
# Server: OUTREACH_URL from the environment or .env (now the Easypanel server); else the local one.
set -euo pipefail
cd "$(dirname "$0")/.."
URL=${OUTREACH_URL:-$(grep -E "^OUTREACH_URL=" .env 2>/dev/null | cut -d= -f2- || true)}
URL=${URL:-http://localhost:3300}
TOKEN=${API_TOKEN:-$(grep -E '^API_TOKEN=' .env 2>/dev/null | cut -d= -f2- || true)}
[[ -n "$TOKEN" ]] || { echo "API_TOKEN missing (in .env or the environment)" >&2; exit 1; }
api() { curl -sS -X "$1" "$URL/api$2" -H "x-api-token: $TOKEN" ${3:+-H 'content-type: application/json' -d "$3"}; echo; }
case "${1:-status}" in
  status)     api GET /status | python3 -c 'import sys,json; d=json.load(sys.stdin); db=d.get("dashboard",{}); l=db.get("limits",{}); a=d.get("autopost",{}); print(json.dumps({"invite_status":l.get("invite_status"),"pending":l.get("pending_invites"),"waiting":db.get("counts"),"autopost":a},indent=1))' ;;
  round)      api POST /jobs '{"kind":"comment_round"}' ;;
  sync)       api POST /jobs '{"kind":"sync_round"}' ;;
  prospect)   api POST /jobs '{"kind":"prospect_round"}' ;;
  sync-pages) api POST /jobs '{"kind":"capture_sync"}' ;;
  capture)    shift; urls=$(python3 -c 'import json,sys; print(json.dumps([u for u in sys.argv[1:] if u.startswith("https://www.linkedin.com/")][:10]))' "$@"); api POST /jobs "{\"kind\":\"capture_sync\",\"params\":{\"urls\":$urls}}" ;;
  read)       shift; urls=$(python3 -c 'import json,sys; print(json.dumps([u for u in sys.argv[1:] if u.startswith("https://www.linkedin.com/")][:10]))' "$@"); api POST /jobs "{\"kind\":\"capture_sync\",\"params\":{\"deep\":true,\"urls\":$urls}}" ;;
  post)       api POST /jobs "{\"kind\":\"post_comment\",\"params\":{\"id\":${2:?comment id}}}" ;;
  comments)   api GET /comments | python3 -c 'import sys,json; [print(c["id"], c["status"], "|", c.get("author_name"), "|", (c.get("comment_draft") or "")[:70].replace("\n"," ")) for c in json.load(sys.stdin)]' ;;
  jobs)       api GET /jobs | python3 -c 'import sys,json; [print(j["id"], j["kind"], j["status"], j["created_by"], (j.get("result") or {}).get("message","")[:90]) for j in json.load(sys.stdin)[:15]]' ;;
  cancel)     api POST "/jobs/${2:?job id}/stop" ;;
  robot)      api GET /robot | python3 -c '
import sys,json; d=json.load(sys.stdin); r=d.get("running")
if r:
  print("RUNNING", r["id"], r["kind"], "since", r["started_at"], json.dumps(r.get("progress") or {}))
  [print("  ", e["at"][11:19], e["level"], e["message"]) for e in r["events"]]
else:
  l=d.get("last") or {}; print("idle; last:", l.get("id"), l.get("kind"), l.get("status"), (l.get("result") or {}).get("message",""))
q=d.get("queued") or []
if q: print("queued:", ", ".join(f"{j["id"]} {j["kind"]}" for j in q))' ;;
  log)        api GET "/job-events?limit=${3:-60}${2:+&job=$2}" | python3 -c 'import sys,json; [print(e["at"][11:19], f"#{e["job_id"]}", e["kind"], e["level"].upper() if e["level"]!="info" else "", e["message"]) for e in reversed(json.load(sys.stdin))]' ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
