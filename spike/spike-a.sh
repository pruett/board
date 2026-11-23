set -u
vb() { npx vb "$@"; }
echo "== 1 inbox: report twice with one idempotency key"
vb post fleet/inbox "flight-sync: PR #28 ready for review" --as lead-flight-sync --label kind=report --label project=flight-sync --idempotency-key report:flight-sync:1
vb post fleet/inbox "flight-sync: PR #28 ready for review" --as lead-flight-sync --label kind=report --label project=flight-sync --idempotency-key report:flight-sync:1
vb read fleet/inbox
echo "== 2 queue item with attachment + conditional answer"
printf 'fake png' > shot.png
Q=$(vb post fleet/queue "PR #28: review and hand-test before merge" --as captain --label state=open --label priority=p2 --label kind=review --attach shot.png --json | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));j.id??j.message?.id')
echo "queue id: $Q"
vb label $Q state=answered --if state=open ; echo "exit $?"
vb label $Q state=answered --if state=open ; echo "second conditional exit $?"
vb read $Q
echo "== 3 lead lease"
L=$(vb tasks create fleet/leases "run lead-flight-sync" --label lead=lead-flight-sync --json | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));j.id??j.task?.id')
echo "lease task: $L"
vb tasks claim $L --as mac-studio --lease 30s; echo "claim A exit $?"
vb tasks claim $L --as vm-2 --lease 30s; echo "claim B exit $?"
vb tasks renew $L --as mac-studio; echo "renew A exit $?"
