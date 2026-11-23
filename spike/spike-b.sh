vb() { npx vb "$@"; }
id() { node -pe 'const j=JSON.parse(require("fs").readFileSync(0));j.id??j.task?.id??j.message?.id'; }
echo "== 4 expiry + fencing"
L=$(vb tasks create fleet/leases "run lead-flight-app" --json | id)
vb tasks claim $L --as mac-studio --lease 30s
( npx vb tail fleet/ > tail.log 2>&1 & echo $! > tail.pid )
node -e 'setTimeout(()=>{},33000)'
vb tasks claim $L --as vm-2 --lease 2m; echo "takeover exit $?"
vb tasks complete $L "done" --as mac-studio; echo "stale holder complete exit $?"
echo "== 5 worker tasks with needs"
A=$(vb tasks create fleet/work/flight-sync "implement outbox" --label role=implementer --json | id)
B=$(vb tasks create fleet/work/flight-sync "review outbox" --label role=reviewer --needs $A --json | id)
vb tasks fleet/work/
vb tasks claim --ready fleet/work/ --label role=reviewer --as fs-reviewer; echo "reviewer early exit $?"
vb tasks claim --ready fleet/work/ --label role=implementer --as fs-implementer
vb tasks complete $A "commit a1b2c3" --as fs-implementer
vb tasks claim --ready fleet/work/ --label role=reviewer --as fs-reviewer; echo "reviewer after exit $?"
echo "== 6 prd.md size"
head -c 30000 /Users/pruett/projects/flight/.fleet/projects/flight-sync/prd.md > prd.md; wc -c prd.md
vb post fleet/docs/flight-sync - < prd.md; echo "post 30k exit $?"
vb post fleet/docs/flight-sync "prd.md v2" --attach prd.md --label doc=prd.md; echo "attach exit $?"
kill $(cat tail.pid); echo "== tail"; cat tail.log
