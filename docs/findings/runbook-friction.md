# Runbook friction log

Writing and self-testing `examples/mock-project/RUNBOOK.md` (branch
`kevinpruett/agent-board-runbook`) on the local Cloudflare host (`wrangler dev`, port 8788),
`@vercel/board` 0.54.0, 2026-11-24. Only items not already in `mock-friction.md`.
Transcript: `evidence/runbook/self-test.txt`.

Each terminal was a fresh interactive zsh in tmux, with this setup:

```bash
set -a; . hosts/cloudflare/.dev.vars; set +a
export BOARD_URL=http://localhost:8788/api/board
unset BOARD_PROFILE
function vb { bunx vb "$@"; }
```

### 1. The `claim_lost` hint tells the stale holder to claim again, while someone else holds it (low)

After the lease ran out and `worker-b` took `#25`:

```text
$ vb --as worker tasks complete 25 "backfill done"
error: Lost the claim on task #25. Its lease ran out, or the task moved on.
  this claim on #25 is over: claim it again

  See where it stands:
    vb read 25
  Or claim it again:
    vb tasks claim 25 --as worker
```

Following the hint would fail ("Someone holds it"), since `worker-b` has the task. An agent
that obeys hints would loop. The hint could check the task's state first.

### 2. Message IDs can't be predicted by counting (low, doc)

IDs come from the log index, and one post uses more than one index (kickoff `#9`, replies
`#11 #13 #15`). The runbook first said the decision thread would be `#49`; the real run gave:

```text
$ DECISION=$(vb --as lead post lumen/decisions "@pruett task #29 needs your call: ..." --label decision=open | head -1); echo "decision thread #$DECISION"
decision thread #50
```

The runbook now quotes only IDs seen in the self-test, and captures the one ID a person would
otherwise have to copy (`DECISION=$(… | head -1)`, the `post` stdout workaround from
`mock-friction.md` item 13).

### 3. `vb inspect` picks a random port unless told; the mock README says 4747 (low, doc)

`vb inspect --help`: `--port <N>  the port to listen on (default: a free one)`.
`examples/mock-project/README.md` shows `bunx vb inspect  # … at http://127.0.0.1:4747` with no
`--port`. The runbook uses `vb inspect --port 4747`, which printed:

```text
inspecting http://localhost:8788/api/board as pruett at http://127.0.0.1:4747  (Ctrl-C to stop)
```

(Not re-run without `--port` here; the README line is outside this step's scope.)

### 4. The seed ends by pointing at the walkthrough (low)

```text
-- Next: examples/mock-project/walkthrough.sh
```

A person following the runbook would run the automated story over the board they're about to
drive by hand. The runbook says to skip that line.

### 5. zsh treats `#` in a pasted line as an argument (avoided)

Interactive zsh has `INTERACTIVE_COMMENTS` off by default, so a copy-paste block with trailing
`# comments` passes them as arguments (`export BOARD_URL=… # the local board` becomes
`export: not valid in this context`). The runbook's setup block has no inline comments; its
explanation is a paragraph below it. Not run, since the block was fixed before the test.

### 6. Inspector sidebar count for `#decisions` vs `vb read` (low, unexplained)

After section 7, `vb read lumen/decisions --mentions` showed `1 thread`; the inspector's
channel header read `#lumen/decisions  2 threads · 2 messages` and the sidebar showed `2`.
Only one thread was ever posted there. The runbook doesn't quote either count.

### 7. Lease expiry lands about 30 s after the claim, not after the last command (note)

Claim at 13:43:13 with `--lease 30s`; `#25 lumen/work task lease ran out` appeared in `tail`
at 13:43:45. Clear and on time. The runbook tells the reader to watch T2 for that line rather
than count seconds.

### 8. Testing note: headless Chrome needs CDP for the inspector

Same as `mock-friction.md` item 19. Screenshots in `evidence/runbook/inspect-*.png` were taken
over `--remote-debugging-port`. A side check confirmed the inspector updates live: an open tab
on tasks/all went from `ready` to `claimed … worker via pruett · 14:58 left` for `#21` without a
reload, after `vb --as worker tasks claim 21` in another shell.
