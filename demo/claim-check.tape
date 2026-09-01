# Records the claim-check gate refusing a false "tests pass".
#
#   demo/build-fixture.sh && vhs demo/claim-check.tape      (run from the repository root)
#
# Nothing in this tape prints expected output. Every line the GIF shows is written by the code being
# recorded: the ledger by `record-activity.mjs`, the verdict by `claim-check.mjs`. The fixture is built
# off camera because building it is not what the GIF is about — see demo/build-fixture.sh, where the
# failing run the ledger reports is a real `npm test` and a real exit code.

Output demo/claim-check.gif

Require jq

Set Shell bash
Set FontSize 18
Set Width 1020
Set Height 330
Set Padding 22
Set TypingSpeed 22ms

Hide
Type `export PS1="$ " && demo/build-fixture.sh && cd /tmp/provenly-demo` Enter
Sleep 15s
Type "clear" Enter
Sleep 1s
Show

# What the harness recorded this turn: one edit, and one test run that failed.
Type "cat .claude/.harness/ledger.jsonl" Enter
Sleep 2500ms

# What the model said on its way out.
Type "jq -r .last_assistant_message stop-2.json" Enter
Sleep 2500ms

# The Stop hook, on the payload Claude Code sends it.
Type "node .claude/harness/claim-check.mjs < stop-2.json | jq -r .reason" Enter
Sleep 5s
