# Lessons

One file per lesson. See `.claude/skills/lesson-keeper/SKILL.md` for the four-test bar before
writing one, and remember the intended end state of a lesson is DELETION — once it hardens into a rule
it graduates into CONVENTIONS.md or a guard, and the file is removed.

```bash
node .claude/harness/lessons.mjs list    # what is on file, with hit counts
node .claude/harness/lessons.mjs audit   # cap, duplicates, graduation candidates
node .claude/harness/lessons.mjs stats   # which have never matched a prompt
```
