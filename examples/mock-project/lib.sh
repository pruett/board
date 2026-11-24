# Shared by seed.sh and walkthrough.sh. Source it; don't run it.
#
# Loads the local dev token, points vb at the local board, and refuses any other board.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

if [[ -z "${BOARD_TOKEN:-}" ]]; then
  if [[ ! -f "$REPO/hosts/cloudflare/.dev.vars" ]]; then
    echo "error: no BOARD_TOKEN and no hosts/cloudflare/.dev.vars (see the repo README, 'Set up on a new machine')" >&2
    exit 2
  fi
  set -a; . "$REPO/hosts/cloudflare/.dev.vars"; set +a
fi
export BOARD_URL="${BOARD_URL:-http://localhost:8788/api/board}"

# The mock project only ever talks to a board on this machine.
case "$BOARD_URL" in
  http://localhost:*|http://127.0.0.1:*) ;;
  *) echo "error: BOARD_URL is $BOARD_URL; the mock project runs only against a local board" >&2; exit 2 ;;
esac
# Never let a stray profile from the caller's shell leak into a step.
unset BOARD_PROFILE

# vb from the repo's own install (@vercel/board 0.54.0).
vb() { (cd "$REPO" && bunx vb "$@"); }

# The ID of the task in lumen/work labeled t=<key>, whatever its state.
tid() { vb tasks lumen/work --state all --label "t=$1" --json | jq -r '.tasks[0].message.id // empty'; }

# Narration. `act` opens a scene, `say` is the narrator, `run` shows a command and runs it.
BOLD=$'\e[1m'; DIM=$'\e[2m'; OFF=$'\e[0m'
[[ -t 1 ]] || { BOLD=""; DIM=""; OFF=""; }
act() { printf '\n%s== %s ==%s\n' "$BOLD" "$*" "$OFF"; }
say() { printf '%s\n' "-- $*"; }
# Shows the command as you'd type it: arguments with spaces or shell characters in quotes.
show() { local a out="" q="'\\''"; for a in "$@"; do if [[ "$a" =~ [^A-Za-z0-9_./=:#,@+-] ]]; then out+=" '${a//\'/$q}'"; else out+=" $a"; fi; done; printf '%s' "${out# }"; }
run() { printf '%s$ vb %s%s\n' "$DIM" "$(show "$@")" "$OFF"; local rc=0; vb "$@" || rc=$?; [[ $rc -eq 0 ]] || printf '%s(exit %s)%s\n' "$DIM" "$rc" "$OFF"; return 0; }
