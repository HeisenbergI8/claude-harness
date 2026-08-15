#!/usr/bin/env node
// Installs the harness into a target repository.
//
//   node bin/harness-init.mjs [target]         install (or top up) into `target`, default cwd
//   node bin/harness-init.mjs --dry-run        print every change without making one
//   node bin/harness-init.mjs --upgrade        refresh the scripts only; never touch config or settings
//   node bin/harness-init.mjs --force          also overwrite an existing harness.config.json
//
// ── TWO RULES THIS FILE OBEYS ──────────────────────────────────────────────────
//
// 1. NEVER CLOBBER. A target repo may already have a `.claude/settings.json` full of the user's own
//    hooks, permissions and settings. Hooks are MERGED entry by entry, keyed on the script they invoke,
//    so running this twice is a no-op and running it on a configured repo adds rather than replaces.
//
// 2. DETECTION PROPOSES, THE USER DISPOSES. A guessed verify command that does not exist is worse than
//    no command at all, because the gate then fails for a reason that has nothing to do with the code.
//    Everything detected is printed, with the file to edit if it is wrong.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = resolve(HERE, '../template')

const args = process.argv.slice(2)
const flags = new Set(args.filter(arg => arg.startsWith('--')))
const target = resolve(args.find(arg => !arg.startsWith('--')) ?? process.cwd())

const dryRun = flags.has('--dry-run')
const upgrade = flags.has('--upgrade')
const force = flags.has('--force')

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

const main = () => {
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

  log('\nNext:')
  log('  1. Open harness.config.json and check the two commands are the ones you actually run.')
  log('  2. FILL IN CONVENTIONS.md — and delete every section you do not fill.')
  log('     The agents read it as the authority on this project. A scaffold left as-is is worse than')
  log('     no file at all, because they will follow it.')
  log('  3. Commit both. They define what "verified" and "correct" mean here, so they belong in a diff.')
  log('  4. RESTART your Claude Code session — hooks are read at startup and will not fire until you do.')
  log('  5. Run one turn, then `node .claude/harness/selftest.mjs` to confirm the hooks actually fired.')
  log('\n     "Configured" and "firing" are different states. Step 5 is the one that tells them apart.')
}

if (process.argv[1]?.endsWith('harness-init.mjs')) main()
