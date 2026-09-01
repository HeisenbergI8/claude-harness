#!/usr/bin/env bash
# Builds the repository the demo GIF is recorded in.
#
# Everything the GIF shows is produced by running real code against this fixture. The installer writes
# the harness, `npm test` really runs and really fails, `record-activity.mjs` writes the ledger from the
# hook payload carrying that run's real exit code, and `claim-check.mjs` reads the ledger to reach its
# verdict. The only authored inputs are the fixture source and the JSON payloads Claude Code sends a
# hook — no expected output is written down anywhere.
#
#   demo/build-fixture.sh [dir]     default /tmp/provenly-demo
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-/tmp/provenly-demo}"

rm -rf "$DIR"
mkdir -p "$DIR/src" "$DIR/test"
cd "$DIR"

git init -q .
git config user.email demo@example.com
git config user.name Demo

cat > package.json <<'JSON'
{ "name": "cart", "version": "1.0.0", "scripts": { "test": "node --test test/" } }
JSON

# `total` ignores qty. The test below asserts the correct answer, so the suite is genuinely red.
cat > src/cart.mjs <<'JS'
export const total = items => items.reduce((sum, item) => sum + item.price, 0)
JS

cat > test/cart.test.mjs <<'JS'
import assert from 'node:assert/strict'
import test from 'node:test'

import { total } from '../src/cart.mjs'

test('total multiplies price by quantity', () => {
  assert.equal(total([{ price: 5, qty: 3 }]), 15)
})
JS

git add -A
git commit -qm cart

# The real installer, run non-interactively.
node "$REPO/bin/harness-init.mjs" . --yes --no-probe >/dev/null

payload () { printf '%s' "$1" > "$2"; }

# ── Turn 1: nothing ran at all, and the model says the suite is green ─────────
#
# No ledger records are written for turn-1. That is the point: the gate's evidence for "no verification
# command ran this turn" is the absence of any, not a flag someone set.
payload '{
  "hook_event_name": "Stop",
  "session_id": "demo",
  "prompt_id": "turn-1",
  "stop_hook_active": false,
  "last_assistant_message": "I ran the tests and they all pass. Ready to merge."
}' stop-1.json

# ── Turn 2: the suite really runs, really fails, and the model says it passed ──
#
# npm test is executed here for real and its exit code is captured, so the `ok:false` the gate reads is
# the actual result of the actual run rather than a value chosen by this script.
set +e
npm test > /dev/null 2>&1
VERIFY_EXIT=$?
set -e

[ "$VERIFY_EXIT" -eq 0 ] && { echo "fixture is meant to be red, but npm test passed" >&2; exit 1; }

payload '{
  "hook_event_name": "PostToolUse",
  "session_id": "demo",
  "prompt_id": "turn-2",
  "tool_name": "Edit",
  "tool_input": { "file_path": "src/cart.mjs" },
  "tool_response": { "exit_code": 0 }
}' edit.json

payload "{
  \"hook_event_name\": \"PostToolUse\",
  \"session_id\": \"demo\",
  \"prompt_id\": \"turn-2\",
  \"tool_name\": \"Bash\",
  \"tool_input\": { \"command\": \"npm test\" },
  \"tool_response\": { \"exit_code\": $VERIFY_EXIT }
}" verify.json

payload '{
  "hook_event_name": "Stop",
  "session_id": "demo",
  "prompt_id": "turn-2",
  "stop_hook_active": false,
  "last_assistant_message": "Fixed the cart total. The suite passes — 1/1 tests passing."
}' stop-2.json

# The ledger is written by the harness reading those payloads, not by this script.
node .claude/harness/record-activity.mjs < edit.json
node .claude/harness/record-activity.mjs < verify.json
rm -f edit.json verify.json

echo "fixture ready: $DIR  (npm test exited $VERIFY_EXIT)"
