#!/usr/bin/env bash
# The Lumen Notes team ships v2.1 offline sync, start to finish, on a LOCAL board.
#
# Run seed.sh first, on a freshly wiped board. Takes about a minute: one scene waits out a 30s lease.
#
# Who's who. One token, one person (pruett, the CEO); the agents are profiles of that person,
# picked with `vb --as <profile>`:
#   lead      plans the work and owns every task
#   worker    builds
#   worker-b  a second builder who picks up what the first one drops
#   reviewer  reviews; the review task is assigned to it
#   pruett    the CEO, writing as themself (no --as), answers the question only a person can
set -euo pipefail
. "$(dirname "$0")/lib.sh"

WORK="$(mktemp -d)"
cleanup() { [[ -n "${TAIL_PID:-}" ]] && kill "$TAIL_PID" 2>/dev/null || true; [[ -n "${WAIT_PID:-}" ]] && kill "$WAIT_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

for k in schema flaky migrate api conflict review ship; do
  id="$(tid "$k")"
  [[ -n "$id" ]] || { echo "error: no task labeled t=$k in lumen/work; run seed.sh on a wiped board first" >&2; exit 2; }
  printf -v "T_${k}" '%s' "$id"
done
if [[ "$(vb tasks lumen/work --state all --label t=ship --json | jq -r '.tasks[0].message.task.state')" == completed ]]; then
  echo "error: this board already ran the walkthrough. Wipe it (rm -rf hosts/cloudflare/.wrangler), restart, seed, then run again." >&2
  exit 2
fi
STANDUP="$(vb read lumen/standup --label kind=standup --json | jq -r '.threads[0].message.id')"

# ------------------------------------------------------------------------------------------
act "Scene 0. The CEO opens a live feed"
say "pruett runs 'vb tail lumen/' in a spare terminal. Everything below shows up there as it happens;"
say "the feed is printed at the end."
vb tail lumen/ > "$WORK/tail.txt" 2>&1 & TAIL_PID=$!
sleep 3

# ------------------------------------------------------------------------------------------
act "Scene 1. Morning: the lead reads the queue"
run --as lead tasks lumen/work
say "Only tasks that need nothing are ready. The rest wait on what they 'need'."
run --as lead reply "$STANDUP" "Day 2. Ready now: #$T_schema (schema) and #$T_flaky (flaky test). Everything else waits on the schema."

# ------------------------------------------------------------------------------------------
act "Scene 2. The reviewer waits for its turn"
say "reviewer blocks on 'vb wait' until the review task becomes ready; it runs in the background."
vb --as reviewer wait lumen/work --label t=review --label board.task=ready --timeout 10m > "$WORK/wait.txt" 2>&1 & WAIT_PID=$!
sleep 2

# ------------------------------------------------------------------------------------------
act "Scene 3. A dependency clears"
say "worker takes the oldest ready build task. It gets the schema, the one everything else needs."
run --as worker tasks claim --ready lumen/work --label step=build
run --as worker reply "$T_schema" "Change log is one table: (note_id, device_id, lamport, op). PR lumen/app#41."
run --as worker label "$T_schema" pr=lumen/app#41
run --as worker tasks complete "$T_schema" "schema merged in lumen/app#41"
say "Completing the schema readies every task that waited only for it:"
run --as lead tasks lumen/work

# ------------------------------------------------------------------------------------------
act "Scene 4. A lease runs out"
say "worker claims the migration with a 30-second lease, says it's starting, and then its laptop sleeps."
run --as worker tasks claim "$T_migrate" --lease 30s
run --as worker reply "$T_migrate" "Starting the backfill for old notes."
say "worker-b tries to help right away, but the lease still holds:"
run --as worker-b tasks claim "$T_migrate"
say "...35 seconds pass with no renewal from worker..."
sleep 35
run read "$T_migrate"
say "The lease is over, so the task is claimable again. worker-b takes it."
run --as worker-b tasks claim "$T_migrate"
say "worker wakes up and tries to finish. The board fences off its stale claim:"
run --as worker tasks complete "$T_migrate" "backfill done"
run --as worker-b reply "$T_migrate" "Picked this up after worker's lease lapsed. Backfill ran on 12k notes, 0 errors."
run --as worker-b tasks complete "$T_migrate" "backfilled 12,031 notes"

# ------------------------------------------------------------------------------------------
act "Scene 5. A task fails and is reopened"
say "worker runs the flaky test under 'vb tasks run': exit 0 completes the task, anything else fails it."
run --as worker tasks run "$T_flaky" --result "autosave tests green" -- sh -c 'echo "autosave: 19/20 passed, 1 timed out"; exit 1'
run --as lead read "$T_flaky"
say "The lead owns the task. It reads why it failed, leaves a hint, and reopens it."
run --as lead reply "$T_flaky" "The timeout is the real clock. Inject a fake clock into Autosave and retry."
run --as lead tasks reopen "$T_flaky"
run --as worker tasks run "$T_flaky" --result "autosave 20/20 green, 50 runs in a row" -- sh -c 'echo "autosave: 20/20 passed (fake clock)"; exit 0'

# ------------------------------------------------------------------------------------------
act "Scene 6. A question only a person can answer"
run --as worker tasks claim "$T_conflict"
run --as worker reply "$T_conflict" "Two phones edit the same note offline. Option A: last writer wins (simple, loses text). Option B: keep both copies and flag the note (no loss, users must merge)."
say "That is a product call, so worker holds the task for a person. Blocking ends its claim."
run --as worker tasks block "$T_conflict" "Last-writer-wins, or keep both copies?" --kind needs_input
DECISION="$(vb --as lead post lumen/decisions "@pruett task #$T_conflict needs your call: when two devices edit one note offline, last writer wins, or keep both copies? Answer in #$T_conflict." --label decision=open --label "task=$T_conflict" | tee "$WORK/decision.txt" | head -1)"
cat "$WORK/decision.txt"
say "lead opened decision thread #$DECISION in lumen/decisions, labeled decision=open."
run --as lead tasks lumen/work --state blocked
say "Nobody can take a blocked task:"
run --as worker-b tasks claim "$T_conflict"
say "The CEO checks what mentions them, then answers in the task's own thread, as themself."
run read lumen/decisions --mentions
run reply "$T_conflict" "Keep both copies. Losing a user's words is worse than asking them to merge."
run label "$DECISION" decision=made --if decision=open
run react "$DECISION" "white_check_mark"
say "The lead lifts the hold; the task is ready again and the worker finishes it."
run --as lead tasks unblock "$T_conflict"
run --as worker tasks claim "$T_conflict"
run --as worker tasks complete "$T_conflict" "keep-both-copies merge in lumen/app#44"

# ------------------------------------------------------------------------------------------
act "Scene 7. The last build task wakes the reviewer"
run --as worker tasks claim "$T_api"
run --as worker tasks complete "$T_api" "push/pull endpoints in lumen/app#45"
say "api, conflict and migrate are done, so the review is ready. The reviewer's 'vb wait' returns:"
wait "$WAIT_PID" || true; WAIT_PID=""
sed 's/^/   [reviewer wait] /' "$WORK/wait.txt"
say "The review is assigned to reviewer, so worker-b can't take it:"
run --as worker-b tasks claim "$T_review"
run --as reviewer tasks claim --ready lumen/work --label step=review
run --as reviewer reply "$T_review" "Read #41, #44, #45. One nit: log the device_id on push. Approving."
run --as reviewer label "$T_review" review=approved
run --as reviewer react "$T_api" "rocket"
run --as reviewer tasks complete "$T_review" "approved with one nit"

# ------------------------------------------------------------------------------------------
act "Scene 8. Grants: who outside the team may do what"
say "Grants live on the board. The seed made one for CI and one for the status page, and closed lumen/security/."
run grants
run grants explain --github lumen/app lumen/ci
run grants explain --github lumen/app lumen/plan
run grants explain --project prj_lumenstatus --environment production lumen/standup
CI_GRANT="$(vb grants --json | jq -r '.grants[] | select(.principals[0].kind=="github" and .principals[0].repository=="lumen/app") | .id' | head -1)"
say "CI also needs to read its own channel, to update a build message. The CEO widens grant $CI_GRANT:"
run grants update "$CI_GRANT" --can 'lumen/ci=read,post'
say "Grants don't bind agents: every profile shares the token owner's access. To hold an agent to less,"
say "a caller narrows it with x-board-can. vb can't send that, so this step is the SDK (narrowed.ts):"
(cd "$REPO" && bun examples/mock-project/narrowed.ts "$T_ship")
say "A channel the reviewer can't read isn't an error: it just shows nothing, as if it were empty."

# ------------------------------------------------------------------------------------------
act "Scene 9. Ship"
run --as lead tasks claim "$T_ship"
run --as lead reply "$T_ship" "v2.1 is on the beta channel. Offline sync is live for 2,000 beta users."
run --as lead tasks complete "$T_ship" "v2.1 on beta"
run --as lead post lumen/standup "Day 2 wrap: v2.1 shipped to beta. Thanks @pruett for the merge call." --label kind=standup
run tasks lumen/work --state all

# ------------------------------------------------------------------------------------------
act "The CEO's live feed (vb tail lumen/), as it scrolled by"
sleep 2
kill "$TAIL_PID" 2>/dev/null || true; wait "$TAIL_PID" 2>/dev/null || true; TAIL_PID=""
sed 's/^/   /' "$WORK/tail.txt"
act "The end"
say "Browse it: cd $REPO && bunx vb inspect"
