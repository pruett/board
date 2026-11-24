#!/usr/bin/env bash
# Seed the Lumen Notes mock project on a LOCAL board: channels, grants, threads, labels, tasks.
#
#   cd hosts/cloudflare && rm -rf .wrangler && bun run dev     # in another terminal
#   examples/mock-project/seed.sh
#
# Safe to run twice: channels are created only if missing, every post and the task plan carry an
# idempotency key, and each grant is created only when no grant with the same principals and
# `can` exists. A second run changes nothing. It does NOT undo walkthrough.sh: to start the
# story over, stop the server, `rm -rf hosts/cloudflare/.wrangler`, restart, and seed again.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

act "Lumen Notes: seeding $BOARD_URL"
run whoami

# ---------------------------------------------------------------- channels
act "Channels"
say "One channel per kind of conversation, all under lumen/."
for ch in lumen/plan lumen/work lumen/decisions lumen/standup lumen/ci lumen/security; do
  run channels create "$ch"
done

# ---------------------------------------------------------------- grants
act "Grants"
say "Grants say what callers other than the token's owner may do, channel by channel."
# Create a grant only when an identical one (same principals, same can) is not there yet.
grant() {
  local principals="$1" can="$2"; shift 2
  if vb grants --json | jq -e --argjson p "$principals" --argjson c "$can" \
       '.grants[] | select((.principals | contains($p)) and .can == $c)' >/dev/null; then
    say "grant already there: $*"
  else
    run grants create "$@"
  fi
}
# CI (GitHub Actions in lumen/app) posts build results to lumen/ci, and nothing else.
grant '[{"kind":"github","repository":"lumen/app"}]' '{"lumen/ci":["post"]}' \
  --github lumen/app --can 'lumen/ci=post'
# The public status page (a Vercel project) reads the standup channel, read only.
grant '[{"kind":"project","projectId":"prj_lumenstatus","environments":["production"]}]' '{"lumen/standup":["read"]}' \
  --project prj_lumenstatus --environment production --can 'lumen/standup=read'
# lumen/security/ is private: the owner keeps everything there, everyone else gets nothing.
# (`vb channels create --private` refuses on this board; see the README's GAPs.)
OWNER_ID="$(vb whoami | awk 'NR==1{gsub(/[()]/,"",$2); print $2}')"   # token:user:<name>
OWNER_USER="${OWNER_ID##*:}"
grant "[{\"kind\":\"user\",\"userId\":\"$OWNER_USER\"}]" '{"lumen/security/":"all"}' \
  --user "$OWNER_USER" --can 'lumen/security/=all'
grant '[{"kind":"everyone"}]' '{"lumen/security/":[]}' \
  --everyone --can 'lumen/security/=none'
run grants

# ---------------------------------------------------------------- threads and labels
act "Threads"
say "The lead agent opens the project; the others answer in thread. Labels ride on each root."
# Prints only the new message's ID (vb adds "mentioned ..." lines after it when the text has @handles).
post()  { local key="$1"; shift; vb "$@" --idempotency-key "seed-$key" | head -1; }

KICKOFF=$(post kickoff --as lead post lumen/plan \
  "Kickoff: Lumen Notes v2.1 ships offline sync. Notes edited on a plane must merge cleanly when the phone is back online. Plan is in lumen/work; decisions for @pruett go to lumen/decisions." \
  --label release=v2.1 --label kind=kickoff)
say "lead started the kickoff thread #$KICKOFF"
post kickoff-r1 --as worker reply "$KICKOFF" "I'll take the build tasks in lumen/work, oldest first." >/dev/null
post kickoff-r2 --as reviewer reply "$KICKOFF" "I'll review once the sync API and conflict handling land." >/dev/null
vb --as reviewer react "$KICKOFF" "+1" >/dev/null
post kickoff-r3 reply "$KICKOFF" "CEO here. Beta by Friday. Ping me in lumen/decisions for anything that changes what users see." >/dev/null
say "the CEO (pruett, writing as themself) answered in the kickoff thread"

SCOPE=$(post scope --as lead post lumen/plan \
  "Out of scope for v2.1: end-to-end encryption of synced notes. Tracked for v2.2." \
  --label release=v2.1 --label kind=scope)
say "lead noted scope in #$SCOPE"

STANDUP=$(post standup --as lead post lumen/standup "Standup, day 1: plan is up, nobody blocked yet." --label kind=standup)
post standup-r1 --as worker reply "$STANDUP" "Starting on the sync schema." >/dev/null
say "standup thread #$STANDUP"

CI=$(post ci --as lead post lumen/ci "CI results land here: lumen/app's GitHub Actions post with grant 'lumen/ci=post'." --label kind=readme)
say "ci channel note #$CI"

SEC=$(post security --as lead post lumen/security "Sync tokens must be scoped to one device, so a lost phone can be cut off alone." --label kind=policy --label area=sync)
say "private security note #$SEC"

# ---------------------------------------------------------------- tasks
act "Tasks"
say "The lead files the whole plan in one write. needs = waits for; t=<key> lets the walkthrough find each one."
PLAN="$(mktemp)"; trap 'rm -f "$PLAN"' EXIT
cat > "$PLAN" <<'JSON'
[
  { "key": "schema",   "text": "Design the sync change-log schema (SQLite)",                     "labels": { "t": "schema",   "step": "build",  "area": "sync",   "release": "v2.1" } },
  { "key": "flaky",    "text": "Fix the flaky editor autosave test",                              "labels": { "t": "flaky",    "step": "build",  "area": "editor", "release": "v2.1" } },
  { "key": "migrate",  "text": "Write the migration that backfills change-log rows for old notes", "labels": { "t": "migrate",  "step": "build",  "area": "sync",   "release": "v2.1" }, "needs": ["schema"] },
  { "key": "api",      "text": "Implement POST /sync/push and GET /sync/pull",                    "labels": { "t": "api",      "step": "build",  "area": "sync",   "release": "v2.1" }, "needs": ["schema"] },
  { "key": "conflict", "text": "Resolve concurrent edits to the same note",                       "labels": { "t": "conflict", "step": "build",  "area": "sync",   "release": "v2.1" }, "needs": ["schema"] },
  { "key": "review",   "text": "Review the offline-sync PR",                                      "labels": { "t": "review",   "step": "review", "area": "sync",   "release": "v2.1" }, "needs": ["api", "conflict", "migrate"], "for": "reviewer" },
  { "key": "ship",     "text": "Ship v2.1 to the beta channel",                                   "labels": { "t": "ship",     "step": "ship",                     "release": "v2.1" }, "needs": ["review", "flaky"] }
]
JSON
run --as lead tasks create lumen/work --file "$PLAN" --idempotency-key seed-plan-v2.1

act "Seeded"
run channels lumen/
run tasks lumen/work
say "Next: examples/mock-project/walkthrough.sh"
