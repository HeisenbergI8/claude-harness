#!/usr/bin/env node
// Installs the harness into a target repository.
//
//   npx github:HeisenbergI8/claude-harness init  install into the current directory
//   node bin/harness-init.mjs [target]         install (or top up) into `target`, default cwd
//                                              a bare leading `init` is a subcommand, not a target
//   node bin/harness-init.mjs --dry-run        print every change without making one
//   node bin/harness-init.mjs --upgrade        refresh the scripts only; never touch config or settings
//   node bin/harness-init.mjs --force          also overwrite an existing harness.config.json
//   node bin/harness-init.mjs --no-probe       skip running the detected commands to check they work
//   node bin/harness-init.mjs --yes            accept every detected value; never prompt
//
// ── TWO RULES THIS FILE OBEYS ──────────────────────────────────────────────────
//
// 1. NEVER CLOBBER. A target repo may already have a `.claude/settings.json` full of the user's own
//    hooks, permissions and settings. Hooks are MERGED entry by entry, keyed on the script they invoke,
//    so running this twice is a no-op and running it on a configured repo adds rather than replaces.
//
// 2. DETECTION PROPOSES, THE USER DISPOSES. A guessed verify command that does not exist is worse than
//    no command at all, because the gate then fails for a reason that has nothing to do with the code.
//    Everything detected is printed, with the file to edit if it is wrong — and then each command is
//    actually RUN, because a printed command is only checked by a reader who already knows the answer.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { probeCommand } from '../template/.claude/harness/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = resolve(HERE, '../template')

const args = process.argv.slice(2)
const flags = new Set(args.filter(arg => arg.startsWith('--')))

// ── `init` IS A SUBCOMMAND, NOT A DIRECTORY ────────────────────────────────────
//
// The documented install is `npx github:HeisenbergI8/claude-harness init`, so `init` arrives here as a
// positional argument — and the only positional this script takes is the TARGET DIRECTORY. Without
// this it installed into a new subdirectory called `init`, and did so silently: every path it printed
// was plausible, and the repo the user was standing in got nothing.
//
// Only a BARE leading `init` is swallowed. An explicit path — `./init`, `/srv/init` — is still a
// target, which leaves the escape hatch open for a directory that really is called that.
const positionals = args.filter(arg => !arg.startsWith('--'))
const paths = positionals[0] === 'init' ? positionals.slice(1) : positionals
const target = resolve(paths[0] ?? process.cwd())

const dryRun = flags.has('--dry-run')
const upgrade = flags.has('--upgrade')
const force = flags.has('--force')
const probe = !flags.has('--no-probe') && !dryRun

// Prompting requires a real terminal on BOTH ends. `npx` from a shell has one; a CI job, a pipe, and
// the test suite do not — and there the old non-interactive behaviour is not a fallback but the
// correct answer, so this is checked rather than attempted and rescued.
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !flags.has('--yes') && !dryRun && !upgrade

const changes = []
const log = message => console.log(message)
const record = (verb, path) => changes.push(`${verb.padEnd(9)} ${path}`)

const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const write = (path, content) => {
  if (dryRun) return

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

// ── Detection ──────────────────────────────────────────────────────────────────
//
// Each detector returns null when it does not apply. The first match wins, so the more specific ones
// come first — a Rust project with a Makefile is a Rust project.

const packageManager = root => {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb'))) return 'bun'

  return 'npm'
}

// Picks the first script whose name appears in `names`. Returns the runner invocation, not the script
// body, because that is what will appear in the shell and therefore in the ledger.
const pickScript = (scripts, names, runner) => {
  for (const name of names) {
    if (scripts?.[name]) return `${runner} run ${name}`
  }

  return null
}

const DETECTORS = [
  {
    name: 'node',
    detect: root => existsSync(join(root, 'package.json')),
    build: root => {
      const runner = packageManager(root)
      const scripts = readJson(join(root, 'package.json'))?.scripts ?? {}

      const verify = pickScript(scripts, ['verify', 'check', 'ci', 'test'], runner)
      const fast = pickScript(scripts, ['verify:fast', 'typecheck', 'tsc', 'lint'], runner)

      return {
        commands: { verify, verifyFast: fast ?? verify },
        source: { include: ['src/**', 'app/**', 'lib/**', 'test/**', 'tests/**'], exclude: ['**/*.md', '**/__snapshots__/**'] },
        note: verify
          ? null
          : 'package.json has no verify/check/ci/test script — commands.verify is null and the repair loop is inert.'
      }
    }
  },
  {
    name: 'rust',
    detect: root => existsSync(join(root, 'Cargo.toml')),
    build: () => ({
      commands: { verify: 'cargo check && cargo test', verifyFast: 'cargo check' },
      source: { include: ['src/**', 'tests/**', 'benches/**'], exclude: ['target/**'] }
    })
  },
  {
    name: 'go',
    detect: root => existsSync(join(root, 'go.mod')),
    build: () => ({
      commands: { verify: 'go build ./... && go vet ./... && go test ./...', verifyFast: 'go build ./... && go vet ./...' },
      source: { include: ['**/*.go'], exclude: ['vendor/**'] }
    })
  },
  {
    name: 'python',
    detect: root =>
      ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'].some(file => existsSync(join(root, file))),
    build: root => {
      const pyproject = existsSync(join(root, 'pyproject.toml')) ? readFileSync(join(root, 'pyproject.toml'), 'utf8') : ''
      const hasRuff = pyproject.includes('[tool.ruff') || existsSync(join(root, 'ruff.toml'))
      const hasMypy = pyproject.includes('[tool.mypy') || existsSync(join(root, 'mypy.ini'))

      const fastParts = [hasRuff && 'ruff check .', hasMypy && 'mypy .'].filter(Boolean)

      return {
        commands: {
          verify: [...fastParts, 'pytest -q'].join(' && '),
          verifyFast: fastParts.length ? fastParts.join(' && ') : 'pytest -q -x'
        },
        source: { include: ['src/**', 'tests/**', 'test/**', '**/*.py'], exclude: ['**/.venv/**', '**/*.md'] }
      }
    }
  },
  {
    name: 'make',
    detect: root => existsSync(join(root, 'Makefile')),
    build: root => {
      const makefile = readFileSync(join(root, 'Makefile'), 'utf8')
      const target = ['check', 'verify', 'test'].find(name => new RegExp(`^${name}:`, 'm').test(makefile))

      return {
        commands: { verify: target ? `make ${target}` : null, verifyFast: target ? `make ${target}` : null },
        source: { include: ['src/**', 'lib/**', 'tests/**'], exclude: ['**/*.md'] },
        note: target ? null : 'Makefile has no check/verify/test target — fill in commands yourself.'
      }
    }
  }
]

const detect = root => {
  for (const detector of DETECTORS) {
    if (!detector.detect(root)) continue

    return { name: detector.name, ...detector.build(root) }
  }

  return {
    name: 'unknown',
    commands: { verify: null, verifyFast: null },
    source: { include: ['src/**', 'lib/**', 'tests/**'], exclude: ['**/*.md'] },
    note: 'Could not identify the project type. Fill in commands.verify and commands.verifyFast by hand.'
  }
}

// ── Settings merge ─────────────────────────────────────────────────────────────
//
// Exported for the tests. Keyed on the SCRIPT a hook invokes, so re-running is idempotent and an
// existing user hook on the same event is never displaced.
export const scriptOf = hook => {
  const fromArgs = (hook?.args ?? []).find(arg => typeof arg === 'string' && arg.endsWith('.mjs'))

  if (fromArgs) return fromArgs

  return typeof hook?.command === 'string' ? (hook.command.match(/([\w./-]+\.mjs)/)?.[1] ?? null) : null
}

export const mergeSettings = (existing, incoming) => {
  const merged = { ...(existing ?? {}) }

  merged.hooks = { ...(existing?.hooks ?? {}) }

  for (const [event, incomingMatchers] of Object.entries(incoming.hooks ?? {})) {
    const current = [...(merged.hooks[event] ?? [])]

    for (const incomingMatcher of incomingMatchers) {
      // Find an existing group with the same matcher to extend, rather than adding a duplicate group.
      const slot = current.findIndex(group => (group.matcher ?? null) === (incomingMatcher.matcher ?? null))
      const group = slot >= 0 ? { ...current[slot], hooks: [...(current[slot].hooks ?? [])] } : { ...incomingMatcher, hooks: [] }

      const present = new Set(group.hooks.map(scriptOf).filter(Boolean))

      for (const hook of incomingMatcher.hooks ?? []) {
        const script = scriptOf(hook)

        if (script && present.has(script)) continue

        group.hooks.push(hook)
        if (script) present.add(script)
      }

      if (slot >= 0) current[slot] = group
      else current.push(group)
    }

    merged.hooks[event] = current
  }

  // Anything the incoming template declares outside `hooks` is a suggestion, never an override.
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'hooks' || key === '$schema') continue
    if (!(key in merged)) merged[key] = value
  }

  if (!merged.$schema && incoming.$schema) merged.$schema = incoming.$schema

  return merged
}

// ── gitignore ──────────────────────────────────────────────────────────────────
//
// The state directory is runtime scratch and must never be committed. The CONFIG must be — see the note
// in config.mjs about why a definition of "verified" that can move without a diff is not a gate.
// Copies a directory tree, SKIPPING anything that already exists.
//
// Prompts are tuned in place. Overwriting a file somebody adjusted three weeks ago is invisible damage:
// nothing errors, and the behaviour drifts back to stock without anyone noticing.
const copyTreeIfAbsent = (source, destination, root) => {
  let entries

  try {
    entries = readdirSync(source, { withFileTypes: true })
  } catch {
    return
  }

  if (!dryRun) mkdirSync(destination, { recursive: true })

  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)

    if (entry.isDirectory()) {
      copyTreeIfAbsent(from, to, root)
      continue
    }

    const relative = to.replace(`${root}/`, '')

    if (existsSync(to)) {
      record('keep', `${relative}  (yours)`)
      continue
    }

    record('create', relative)

    if (!dryRun) {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
}

export const ensureGitignore = (text, entry) => {
  const lines = (text ?? '').split('\n')

  if (lines.some(line => line.trim() === entry)) return null

  const suffix = text && !text.endsWith('\n') ? '\n' : ''

  return `${text ?? ''}${suffix}\n# claude-harness runtime state (the config at the root is tracked, this is not)\n${entry}\n`
}

// ── Main ───────────────────────────────────────────────────────────────────────

// ── Asking, instead of telling someone to go and edit JSON ─────────────────────
//
// These two commands ARE the gate — everything else in this repo is machinery for deciding when to run
// them. Detection gets them right often enough to be worth doing, and wrong often enough that its
// output cannot be the final answer.
//
// The version of this that only PRINTED its guess and pointed at `harness.config.json` was asking
// somebody who had just installed the tool to already know what the tool wanted. Asking costs one line
// each and removes the config file from the setup path entirely.
const PROMPTS = {
  verify: ['Full check', 'Run when you want to know the whole tree is healthy. Usually your test suite.'],
  verifyFast: ['Fast check', 'Runs at the END OF EVERY TURN, so it has to be quick — a typecheck, or unit tests only.']
}

const describe = result => {
  if (result.verdict === 'missing') return `does not run — ${result.detail}`
  if (result.verdict === 'fail') return `runs (exit ${result.status} — your tree is red, which is fine here)`
  if (result.verdict === 'slow') return 'runs (still going after 15s, so it exists)'
  if (result.verdict === 'skipped') return 'not checked — it runs the selftest'

  return 'runs'
}

export const confirmCommands = async (detected, rl) => {
  log('\nThe harness needs two commands. Press Enter to accept a suggestion, or type your own.')
  log('Neither is permanent — both live in harness.config.json.')

  const commands = {}

  // Ctrl+D, Ctrl+C, or a closed stdin must not fail the install. Everything before this point is
  // already on disk, and abandoning the run there would leave the scripts installed with no config —
  // a worse state than the one the detected defaults give, which is a complete and working install.
  let aborted = false

  const askOnce = async prompt => {
    if (aborted) return ''

    try {
      return (await rl.question(prompt)).trim()
    } catch {
      aborted = true

      return ''
    }
  }

  for (const key of ['verify', 'verifyFast']) {
    const [title, help] = PROMPTS[key]
    let current = detected[key]

    if (!aborted) log(`\n  ${title} — ${help}`)

    // Two passes. One is not enough to correct a bad guess; three is nagging somebody who has already
    // said they want to keep it.
    for (let attempt = 0; attempt < 2 && !aborted; attempt += 1) {
      const answer = await askOnce(`  ${current ? `[${current}]` : '(nothing detected)'} > `)

      if (aborted) break

      const chosen = answer || current

      if (!chosen) {
        log('    left unset — the gate that needs it will stand aside until you fill it in')
        break
      }

      current = chosen

      if (!probe) break

      const result = probeCommand(chosen, { cwd: target })

      log(`    ${describe(result)}`)

      if (result.runnable) break

      log(
        attempt === 0
          ? '    That would block every turn. Type one that works here, or press Enter to keep it anyway.'
          : '    Kept. Fix it in harness.config.json before your first turn.'
      )
    }

    commands[key] = current ?? null
  }

  if (aborted) log('\n  (no answer — keeping the detected commands)')

  return { commands, aborted }
}

const main = async () => {
  if (!existsSync(TEMPLATE)) {
    console.error(`Template directory missing: ${TEMPLATE}`)
    process.exit(1)
  }

  log(`claude-harness -> ${target}${dryRun ? '  (dry run — nothing will be written)' : ''}\n`)

  // 1. Scripts. Always refreshed; they are the harness, and a stale copy is the thing --upgrade exists
  //    to fix.
  const scriptsDir = join(target, '.claude/harness')
  const sourceDir = join(TEMPLATE, '.claude/harness')

  if (!dryRun) mkdirSync(scriptsDir, { recursive: true })

  for (const file of readdirSync(sourceDir)) {
    const destination = join(scriptsDir, file)

    record(existsSync(destination) ? 'update' : 'create', `.claude/harness/${file}`)

    if (!dryRun) copyFileSync(join(sourceDir, file), destination)
  }

  // 2. Agents and skills.
  //
  // NEVER OVERWRITTEN, even on --upgrade. These are prompts, and a project that has been running for a
  // month has almost certainly tuned them — silently replacing a tuned agent with the stock one is the
  // most damaging thing this installer could do, because the damage is invisible until behaviour drifts.
  for (const [source, destination] of [
    [join(TEMPLATE, '.claude/agents'), join(target, '.claude/agents')],
    [join(TEMPLATE, '.claude/skills'), join(target, '.claude/skills')]
  ]) {
    copyTreeIfAbsent(source, destination, target)
  }

  if (upgrade) {
    log(changes.join('\n'))
    log('\nScripts refreshed. Config and settings.json left untouched (--upgrade).')
    log('Run `node .claude/harness/selftest.mjs` to confirm nothing drifted.')
    return
  }

  // 2. Config.
  const configPath = join(target, 'harness.config.json')
  const configExists = existsSync(configPath)
  const detected = detect(target)

  // Asked BEFORE the config is written, so the answer is what lands on disk. Skipped when a config
  // already exists — that file is the user's, and re-prompting for values they have already tuned is
  // the same clobbering mistake as overwriting it.
  let confirmed = false

  if (interactive && (!configExists || force)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    try {
      const answers = await confirmCommands(detected.commands, rl)

      detected.commands = answers.commands
      // An abandoned prompt leaves the commands unverified, so the printed check below still earns
      // its place. Only a completed pass makes it redundant.
      confirmed = !answers.aborted
    } finally {
      rl.close()
    }
  }

  if (configExists && !force) {
    record('keep', 'harness.config.json  (exists — pass --force to overwrite)')
  } else {
    const config = {
      $schema: 'https://raw.githubusercontent.com/HeisenbergI8/claude-harness/main/harness.schema.json',
      commands: detected.commands,
      source: detected.source
    }

    record(configExists ? 'overwrite' : 'create', 'harness.config.json')
    write(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }

  // 2b. CONVENTIONS.md — scaffolded once, never overwritten.
  //
  // This is the single most important file for the agents, and the one the installer cannot fill in.
  const conventionsPath = join(target, 'CONVENTIONS.md')

  if (existsSync(conventionsPath)) {
    record('keep', 'CONVENTIONS.md  (yours)')
  } else {
    record('create', 'CONVENTIONS.md')
    write(conventionsPath, readFileSync(join(TEMPLATE, 'CONVENTIONS.md'), 'utf8'))
  }

  // 3. settings.json — merged, never replaced.
  const settingsPath = join(target, '.claude/settings.json')
  const incoming = readJson(join(TEMPLATE, '.claude/settings.json'))
  const existing = readJson(settingsPath)

  const merged = mergeSettings(existing, incoming)

  record(existing ? 'merge' : 'create', '.claude/settings.json')
  write(settingsPath, `${JSON.stringify(merged, null, 2)}\n`)

  // 4. gitignore for the runtime state directory.
  const gitignorePath = join(target, '.gitignore')
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
  const updated = ensureGitignore(gitignore, '.claude/.harness/')

  if (updated) {
    record(existsSync(gitignorePath) ? 'append' : 'create', '.gitignore  (.claude/.harness/)')
    write(gitignorePath, updated)
  }

  log(changes.join('\n'))

  log(`\nDetected project type: ${detected.name}`)
  log(`  verify:      ${detected.commands.verify ?? '(none — you must fill this in)'}`)
  log(`  verify:fast: ${detected.commands.verifyFast ?? '(none — you must fill this in)'}`)

  if (detected.note) log(`\n  ! ${detected.note}`)

  // Rule 2, enforced rather than stated. A command that was only ever printed is checked by a reader
  // who already knows what it should say — which is nobody installing this for the first time.
  const broken = []

  // `confirmed` means each command was already probed as it was chosen, and repeating it here would
  // run the test suite a second time to print what the user just watched happen.
  if (probe && !confirmed && (detected.commands.verify || detected.commands.verifyFast)) {
    log('\nChecking those commands actually run:')

    for (const [name, command] of [['verify', detected.commands.verify], ['verify:fast', detected.commands.verifyFast]]) {
      if (!command) continue

      const result = probeCommand(command, { cwd: target })
      const label = `  ${`${name}:`.padEnd(13)}`

      if (result.verdict === 'missing') {
        log(`${label}CANNOT RUN — ${result.detail}`)
        broken.push(name)
      } else if (result.verdict === 'fail') {
        // Worth saying out loud: a red tree at install time is not a setup problem, and someone who
        // has just been told to check their commands will otherwise read a non-zero exit as one.
        log(`${label}runs (exited ${result.status} — your tree is red, which is not a setup problem)`)
      } else if (result.verdict === 'slow') {
        log(`${label}runs (still going after 15s, so the command exists)`)
      } else if (result.verdict === 'skipped') {
        log(`${label}skipped — it runs the selftest, which would call this check from inside itself`)
      } else {
        log(`${label}runs, exit 0`)
      }
    }

    if (broken.length) {
      const everyTurn = broken.includes('verify:fast')

      log(
        `\n  ! ${broken.join(' and ')} cannot run. This is the one setup mistake that looks like a working\n` +
          `    install: the config is valid, the hooks are registered, and the gate fails anyway.\n\n` +
          (everyTurn
            ? `    verify:fast runs at the END OF EVERY TURN, so until this is fixed every turn will be\n` +
              `    blocked by an error that has nothing to do with the code just written.\n\n`
            : `    verify is the closing gate, so it will block instead of confirming a healthy tree.\n\n`) +
          `    FIX: open harness.config.json and set the command to what you actually run by hand,\n` +
          `    or install the missing tool. Then run this installer again to re-check.`
      )
    }
  }

  log('\nNext:')

  if (!confirmed) {
    log('  1. Open harness.config.json and check the two commands are the ones you actually run.')
  }

  log(`  ${confirmed ? 1 : 2}. RESTART your Claude Code session. Hooks are read at startup, so until you do,`)
  log('     nothing you just installed is running. This is the step people skip.')
  log(`  ${confirmed ? 2 : 3}. Take one ordinary turn, then check the harness is actually alive:`)
  log('       node .claude/harness/selftest.mjs')
  log('     Ending in "ok" means the gates are real. "Configured" and "firing" are different states,')
  log('     and this is the only thing that tells them apart.')
  log(`  ${confirmed ? 3 : 4}. Fill in CONVENTIONS.md when you have ten minutes — four short sections.`)
  log('     Delete any you cannot fill honestly; a half-filled scaffold is worse than none, because')
  log('     the agents follow whatever it says.')
  log(`  ${confirmed ? 4 : 5}. Commit harness.config.json and CONVENTIONS.md. They define what "verified" and`)
  log('     "correct" mean here, so they belong in a diff.')
}

// ── AM I THE PROGRAM, OR A MODULE SOMEONE IMPORTED? ────────────────────────────
//
// This used to ask whether `process.argv[1]` ENDED WITH this file's name, which is false on the one
// install path everyone actually uses. npm links a bin as `node_modules/.bin/claude-harness`, so under
// `npx` argv[1] is that SYMLINK — the name does not match, `main()` never runs, and the process exits 0
// having printed nothing at all. A silent success is the worst possible failure for an installer:
// every signal the user has says it worked.
//
// Resolving both sides to their real paths is what makes `node bin/harness-init.mjs`, a linked bin, and
// an `import` from the test suite all agree. It fails CLOSED — anything unreadable means "not the
// entrypoint", so a bad argv can never cause an unasked-for install.
const isEntrypoint = () => {
  if (!process.argv[1]) return false

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  main().catch(error => {
    console.error(`\nharness-init failed: ${error.message}`)
    process.exit(1)
  })
}
