#!/usr/bin/env node
// context-bloat-guard — PreToolUse hook for the Skill tool.
//
// Measures a skill's SKILL.md before its body is injected into the main-loop
// context, and surfaces the cost so an expensive skill can be delegated to a
// subagent instead of silently eating the window.
//
// Hard invariants:
//   - FAIL OPEN. Any error, anywhere, results in an empty stdout + exit 0,
//     which the hook protocol treats as "no opinion". This must never be able
//     to block the user's work.
//   - MEASURE, NEVER INTERPRET. SKILL.md is untrusted content. It is read as
//     bytes and counted. It is never eval'd, never shelled out with, never
//     interpolated into a command.
//   - HOT PATH IS CHEAP. No network. Single stat() for the common case; bytes
//     are only read when the file is big enough to possibly cross a threshold.
//     The one exception: once a warning is actually being composed, a bounded
//     64KB tail of the transcript is read to learn the ACTIVE model — the env
//     var goes stale on /model switches, and windows differ 5x by model, so
//     the read buys correctness of the headline number. Measured ~1ms; it
//     never runs on the silent path — unless a percent ("N%") threshold is
//     configured, which cannot be resolved to tokens without the window and so
//     pays the same bounded read up front.

import { readFileSync, statSync, appendFileSync, realpathSync, readdirSync, openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { estimateTokens, BYTES_PER_TOKEN_FLOOR } from './estimate.mjs'
import { resolveWindow, usableBudget } from './window.mjs'

const DEFAULTS = {
  enabled: true,
  // 7% of the usable budget, whatever the session's window turns out to be —
  // ~11.7k tokens at the 200k base tier, ~67.7k at 1M. A share, not a number,
  // because the number meant wildly different things across windows (the
  // 15000-token default this replaces was 9% of a 200k budget but 1.5% of a
  // 1M one). Internal { pct } form; the config-file spelling is "7%".
  warnThreshold: { pct: 7 },
  denyThreshold: null,      // off by default — see README "ask vs deny"
  contextWindowSize: null,  // null = detect from the environment; see window.mjs
  alwaysAllow: [],
  logPath: null,            // opt-in
}

// A threshold holds one of three shapes after sanitizing: null (off), a number
// (absolute tokens), or { pct } — a percent of the USABLE budget, resolved
// against the live window at decision time. The percent form exists because
// windows differ 5x by model (200k vs 1M): a fixed 15k is 9% of one and 1.5%
// of the other, so the same config either nags a 1M session or under-protects
// a 200k one. Only the "N%" string form is accepted — a bare fraction like
// 0.09 is indistinguishable from a (nonsensical) token count.
function parsePct (v) {
  if (typeof v !== 'string') return null
  const m = v.match(/^(\d+(?:\.\d+)?)\s*%$/)
  if (!m) return null
  const pct = Number(m[1])
  return pct > 0 && pct <= 100 ? { pct } : null
}

// A hand-edited JSON file can hold anything, and every value here ends up in a
// comparison or a path. Untyped values did not fail loudly — they failed
// absurdly: `warnThreshold: null` coerces `tokens >= null` to `tokens >= 0`,
// which is always true, so the one setting a user reaches for to quiet the guard
// made it prompt on every single skill. Wrong-typed values fall back to the
// default rather than flowing through.
//
// null is meaningful, not merely absent: for the two thresholds it means OFF,
// matching denyThreshold's documented default.
//
// `base` makes this layerable: a key that is absent or wrong-typed in `raw`
// keeps the BASE's value, so a project file only overrides what it actually
// (validly) sets. With the default base this is the old behavior exactly.
// alwaysAllow is the one union, not an override: "never prompt on X" is an
// additive intent, and a project list silently erasing the user's would
// re-prompt on skills the user already decided about.
function sanitizeConfig (raw, base = DEFAULTS) {
  const out = { ...base }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out

  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  for (const key of ['warnThreshold', 'denyThreshold']) {
    if (raw[key] === null) out[key] = null
    else if (typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] > 0) out[key] = raw[key]
    else {
      const pct = parsePct(raw[key])
      if (pct) out[key] = pct
    }
  }
  if (raw.contextWindowSize === null) out.contextWindowSize = null
  else if (typeof raw.contextWindowSize === 'number' && Number.isFinite(raw.contextWindowSize) && raw.contextWindowSize > 0) out.contextWindowSize = raw.contextWindowSize
  if (Array.isArray(raw.alwaysAllow)) {
    out.alwaysAllow = [...new Set([...base.alwaysAllow, ...raw.alwaysAllow.filter(n => typeof n === 'string')])]
  }
  if (raw.logPath === null || typeof raw.logPath === 'string') out.logPath = raw.logPath
  return out
}

function readJson (path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null // missing or corrupt config is not an error
  }
}

// Config resolves like Claude Code's own settings: user level, then project
// level layered over it per key. A project sets only what it means to change.
//
//   1. $CCG_CONFIG            — sole source when set (tests, one-off overrides)
//   2. <cwd>/.claude/context-bloat-guard.json — project, wins per key
//   3. ~/.claude/context-bloat-guard.json     — user, the base layer
//
// The project file rides along in the repo, so a team can commit stricter
// thresholds. It is worth being clear-eyed about the trust model: a cloned
// repo can therefore also QUIET the guard (enabled: false, huge thresholds)
// for sessions inside it — the same standing Claude Code grants a project's
// own settings.json, and nothing here executes; the guard only ever measures.
function loadConfig (cwd) {
  if (process.env.CCG_CONFIG) return sanitizeConfig(readJson(process.env.CCG_CONFIG))
  const user = sanitizeConfig(readJson(join(homedir(), '.claude', 'context-bloat-guard.json')))
  const project = readJson(join(cwd, '.claude', 'context-bloat-guard.json'))
  return project ? sanitizeConfig(project, user) : user
}

function safeReaddir (dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => e.name)
  } catch {
    return []
  }
}

// Newest version first. Numeric-aware, because a plain string sort orders these
// by character: "9.0.0" would beat "10.0.0" for the same reason "b" beats "a",
// which turns an arbitrary wrong answer into a consistently wrong one.
function byVersionDesc (a, b) {
  return b.localeCompare(a, undefined, { numeric: true })
}

// Resolution order mirrors how Claude Code itself finds a skill. Both SKILL.md
// and skill.md are checked: real skills in the wild use each, and a
// case-sensitive filesystem will not forgive guessing.
// The skill name arrives from the tool call and is interpolated into a path, so
// a name like "../../../../etc" walked straight out of the skills directory.
// Containment is checked LEXICALLY — resolve() collapses ".." before any
// filesystem access, so an escaping candidate is rejected without touching disk.
//
// Deliberately lexical, not realpath-based: skill directories are commonly
// symlinked out to a dotfiles repo, and comparing resolved paths would reject
// that legitimate setup. The symlink target is the user's own choice; a
// traversal sequence in a tool argument is not.
function containedCandidate (base, ...segments) {
  const root = resolve(base)
  const candidate = resolve(join(root, ...segments))
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null
}

function resolveSkillFile (name, cwd) {
  const home = homedir()
  const roots = []

  // Plugin skills arrive namespaced as "plugin:skill" and live under a
  // versioned cache dir. These are empirically the largest skills in the
  // ecosystem, so skipping them would miss the cases that matter most.
  if (name.includes(':')) {
    // Split on the FIRST colon only. `split(':')` destructured to two names, so
    // an "a:b:c" name silently resolved as "a:b" and measured the wrong skill.
    // Keeping the remainder intact means it simply fails to resolve instead.
    const cut = name.indexOf(':')
    const pluginName = name.slice(0, cut)
    const skillName = name.slice(cut + 1)
    const cache = join(home, '.claude', 'plugins', 'cache')
    for (const marketplace of safeReaddir(cache)) {
      const pluginDir = join(cache, marketplace, pluginName)
      // One extra level: the installed version (e.g. "3.9.2"). With more than one
      // version installed the first hit wins, so the order has to be meaningful —
      // readdir order is whatever the filesystem returns, which would measure an
      // arbitrary version of a skill Claude Code is loading a specific one of.
      for (const version of safeReaddir(pluginDir).sort(byVersionDesc)) {
        roots.push([join(pluginDir, version, 'skills'), skillName])
      }
    }
  }

  roots.push([join(cwd, '.claude', 'skills'), name])
  roots.push([join(home, '.claude', 'skills'), name])
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    roots.push([join(process.env.CLAUDE_PLUGIN_ROOT, 'skills'), name])
  }

  for (const [base, skillDir] of roots) {
    for (const file of ['SKILL.md', 'skill.md']) {
      const candidate = containedCandidate(base, skillDir, file)
      if (!candidate) continue // escapes the skills root — not a skill we own
      try {
        // realpath resolves symlinked skill dirs (a common dotfiles pattern)
        // and closes the stat/read TOCTOU gap by pinning one inode.
        const real = realpathSync(candidate)
        const st = statSync(real)
        if (st.isFile()) return { path: real, size: st.size }
      } catch { /* next candidate */ }
    }
  }
  return null
}

function pct (tokens, window) {
  return window ? Math.round((tokens / window) * 100) : null
}

// The share is quoted against the USABLE budget, not the nominal window. A
// nominal 200k window carries a flat 33k auto-compact reserve, so the room a
// skill actually competes for is materially smaller — quoting the nominal
// figure understates every skill's cost by ~20% at the base tier. The nominal
// number is still named so the arithmetic is checkable.
// The active model, read from the transcript's tail. Every assistant message
// is stamped with the model that produced it, so the last stamp is the model
// the session is running RIGHT NOW — unlike $ANTHROPIC_MODEL, which is set at
// session start and survives, stale, across a mid-session /model switch
// (observed live: a fable-5 session whose environment still said
// claude-sonnet-4-6, a 5x window difference). 64KB of tail is hundreds of
// messages; any failure falls through to null and resolveWindow's env
// fallback. Values not starting with "claude-" (e.g. "<synthetic>" stamps on
// error records) are skipped.
function modelFromTranscript (path) {
  if (!path) return null
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, 65536)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      const stamps = buf.toString('utf8').match(/"model":\s*"(claude-[^"]+)"/g)
      if (!stamps) return null
      return stamps[stamps.length - 1].match(/"model":\s*"([^"]+)"/)[1]
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function resolveBudget (config, transcriptPath) {
  const model = modelFromTranscript(transcriptPath) ?? process.env.ANTHROPIC_MODEL
  const window = resolveWindow(config.contextWindowSize, model)
  // A configured window is documented as "used verbatim with no buffer
  // deducted" (issue #9): someone who set a number has already decided what
  // the denominator is. Only a detected window pays the auto-compact reserve.
  const cfg = Number(config.contextWindowSize)
  const configured = Number.isFinite(cfg) && cfg > 0
  const budget = configured ? window : usableBudget(window)
  return { window, budget, configured }
}

function share (tokens, { window, budget, configured }) {
  if (!budget) return ''
  const k = n => `${Math.round(n / 1000)}k`
  const p = pct(tokens, budget)
  // A configured window is taken at face value, so there is no buffer to
  // explain.
  const basis = configured
    ? `${k(budget)} usable context`
    : `${k(budget)} usable context (${k(window)} window, less the auto-compact buffer)`
  return ` = ${p}% of your ${basis}`
}

// The closing line differs by decision because the two decisions reach
// different readers. An "ask" is rendered to the user with an Approve button;
// a "deny" is returned to the model with no prompt and no way to consent, so
// telling it to approve would send it chasing an affordance that isn't there.
function reason (skill, tokens, config, decision, ctx, denyTokens) {
  const costShare = share(tokens, ctx)
  // A percent denyThreshold quotes both forms — the configured share and the
  // token count it resolved to in THIS session's window — so the user can see
  // why the same skill passes elsewhere.
  const denyDesc = decision !== 'deny' ? ''
    : typeof config.denyThreshold === 'number'
      ? `${config.denyThreshold.toLocaleString()} tokens`
      : `${config.denyThreshold.pct}% of the usable budget = ${denyTokens.toLocaleString()} tokens here`
  return [
    `Skill "${skill}" will inject ~${tokens.toLocaleString()} tokens${costShare} into this context, permanently for the rest of the session.`,
    '',
    'Cheaper alternative: delegate it. Spawn a subagent (Agent tool) that invokes',
    'this skill in its own isolated context and returns only the conclusion — the',
    'main window pays for the summary, not the whole SKILL.md.',
    '',
    decision === 'deny'
      ? `Blocked outright by denyThreshold (${denyDesc}) — no permission prompt is shown, and this call cannot be retried into one. Delegate to a subagent, or raise or unset denyThreshold in your context-bloat-guard.json to permit inline loads this large.`
      : 'Approve to load it inline anyway.',
  ].join('\n')
}

function log (config, record) {
  if (!config.logPath) return
  try {
    const path = config.logPath.startsWith('~')
      ? join(homedir(), config.logPath.slice(1))
      : resolve(config.logPath)
    appendFileSync(path, JSON.stringify(record) + '\n')
  } catch { /* logging must never break the guard */ }
}

function emit (decision, reasonText) {
  // Empty stdout == no opinion == allow. Only speak up when there is something
  // to say, so the silent path stays free.
  if (decision === 'allow') return
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reasonText,
    },
  }))
}

function main (raw) {
  const payload = JSON.parse(raw)
  if (payload.tool_name !== 'Skill') return

  const cwd = payload.cwd || process.cwd()
  const config = loadConfig(cwd)
  if (!config.enabled) return

  const skill = payload.tool_input?.skill
  if (!skill || config.alwaysAllow.includes(skill)) return

  const found = resolveSkillFile(skill, cwd)
  // Unresolvable — fail open. Notably includes CLI-bundled skills: their
  // SKILL.md is embedded in the binary and only their resource subdirectories
  // are unpacked to disk, so there is nothing to measure.
  if (!found) return

  // Resolve each threshold to a token count. A percent threshold needs the
  // window BEFORE any decision — the one case where the bounded 64KB
  // transcript read (see modelFromTranscript) runs ahead of the warn path.
  // Number thresholds keep the old cost profile: no transcript read unless a
  // warning is actually composed. The context is memoized so the ask/deny path
  // never reads the transcript twice.
  let ctx = null
  const budgetCtx = () => (ctx ??= resolveBudget(config, payload.transcript_path))
  const toTokens = t => {
    if (t === null || typeof t === 'number') return t
    const { budget } = budgetCtx()
    // No budget to take a percent of (e.g. a capped window smaller than the
    // auto-compact reserve): treat the threshold as OFF rather than as zero,
    // which would fire on every skill. Fail open, as everywhere else.
    // max(1) keeps a microscopic percent from rounding to a zero threshold.
    return budget ? Math.max(1, Math.round(budget * t.pct / 100)) : null
  }
  const warnTokens = toTokens(config.warnThreshold)
  const denyTokens = toTokens(config.denyThreshold)

  // Fast path: even at the worst possible byte-to-token ratio this file cannot
  // reach the warn threshold, so never read it. Most skills exit here after a
  // single stat().
  //
  // Skipped when logging is on: someone who set logPath asked to observe every
  // invocation, including the cheap ones they are trying to calibrate against.
  // They pay one small read for that.
  // The fast path must clear the LOWEST threshold that can still fire, not
  // warnThreshold specifically. Two reasons: warnThreshold may be null (off)
  // while denyThreshold is set, and a denyThreshold below warnThreshold would
  // otherwise let the guard skip a file it was configured to block outright.
  const active = [warnTokens, denyTokens].filter(t => t !== null)
  if (!active.length && !config.logPath) return // nothing can fire and nothing to record

  // The ceil is load-bearing, not cosmetic: estimateTokens ends in Math.ceil, so
  // for a pure-ASCII file the exact quotient can sit a fraction below the real
  // token count. Rounding the bound up restores the strict inequality.
  if (!config.logPath && active.length && Math.ceil(found.size / BYTES_PER_TOKEN_FLOOR) < Math.min(...active)) return

  const text = readFileSync(found.path, 'utf8')
  const { tokens, kind } = estimateTokens(text)

  let decision = 'allow'
  if (denyTokens !== null && tokens >= denyTokens) decision = 'deny'
  else if (warnTokens !== null && tokens >= warnTokens) decision = 'ask'

  // ts first so a tail of the log reads chronologically. The log exists to pick a
  // threshold from real usage, which means slicing it by session or by date —
  // impossible without a time field.
  log(config, { ts: new Date().toISOString(), skill, bytes: found.size, tokens, kind, decision })
  // reason() is built only when something will be said. With number thresholds
  // this is where the transcript tail gets read (via budgetCtx) — an allowed
  // skill never pays for it; with a percent threshold it was already read and
  // memoized above.
  if (decision !== 'allow') emit(decision, reason(skill, tokens, config, decision, budgetCtx(), denyTokens))
}

// --- status mode -----------------------------------------------------------
//
// `guard.mjs --status` prints a human-readable health report instead of acting
// as a hook: effective config and where each layer came from, the resolved
// window/thresholds, and the costliest installed skills. Surfaced to users via
// the /context-bloat-guard:status command (commands/status.md). The fact that
// the report prints at all is itself the readiness signal — it proves node is
// on PATH and the guard executes, the two things that can silently break the
// hook. Unlike the hook path, errors here are LOUD: a status report that fails
// open would defeat its purpose.

// Every skill the guard could resolve, measured. Mirrors resolveSkillFile's
// roots (project, user, newest version of each cached plugin) so the report
// covers exactly the population the hook can see — CLI-bundled skills are
// absent here for the same reason the hook cannot measure them.
function listSkills (cwd) {
  const home = homedir()
  const found = []
  const addRoot = (base, prefix = '') => {
    for (const name of safeReaddir(base)) {
      for (const file of ['SKILL.md', 'skill.md']) {
        try {
          const real = realpathSync(join(base, name, file))
          if (!statSync(real).isFile()) continue
          found.push({ name: prefix + name, path: real })
          break
        } catch { /* next file */ }
      }
    }
  }
  addRoot(join(cwd, '.claude', 'skills'))
  addRoot(join(home, '.claude', 'skills'))
  const cache = join(home, '.claude', 'plugins', 'cache')
  for (const marketplace of safeReaddir(cache)) {
    for (const plugin of safeReaddir(join(cache, marketplace))) {
      const versions = safeReaddir(join(cache, marketplace, plugin)).sort(byVersionDesc)
      if (versions.length) addRoot(join(cache, marketplace, plugin, versions[0], 'skills'), plugin + ':')
    }
  }
  // First hit wins on a name collision, matching resolveSkillFile's order.
  const seen = new Set()
  return found.filter(s => !seen.has(s.name) && seen.add(s.name))
}

function status (argv) {
  const fmt = n => n.toLocaleString('en-US')
  const cwd = process.cwd()
  const config = loadConfig(cwd)

  // The active model cannot be read from a transcript here — there is no hook
  // payload. The status command passes the model id it knows itself to be via
  // --model; without it the env var (stale across /model switches) is the
  // best available signal, and the report says which basis it used.
  const mi = argv.indexOf('--model')
  const model = mi > -1 && argv[mi + 1] ? argv[mi + 1] : (process.env.ANTHROPIC_MODEL ?? null)
  const modelBasis = mi > -1 && argv[mi + 1] ? '--model' : (process.env.ANTHROPIC_MODEL ? '$ANTHROPIC_MODEL (may be stale after /model)' : 'unknown, assuming base tier')

  const version = readJson(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'))?.version ?? 'unknown'
  const window = resolveWindow(config.contextWindowSize, model)
  const cfg = Number(config.contextWindowSize)
  const configured = Number.isFinite(cfg) && cfg > 0
  const budget = configured ? window : usableBudget(window)

  const toTokens = t => t === null || typeof t === 'number'
    ? t
    : (budget ? Math.max(1, Math.round(budget * t.pct / 100)) : null)
  const warnTokens = toTokens(config.warnThreshold)
  const denyTokens = toTokens(config.denyThreshold)
  const showThreshold = (t, tokens) => t === null ? 'off'
    : typeof t === 'number' ? `${fmt(t)} tokens`
      : `${t.pct}% of usable budget${tokens !== null ? ` = ${fmt(tokens)} tokens here` : ' (unresolvable: no budget)'}`

  const userPath = join(homedir(), '.claude', 'context-bloat-guard.json')
  const projectPath = join(cwd, '.claude', 'context-bloat-guard.json')

  const lines = []
  lines.push(`context-bloat-guard v${version} — guard ran under node ${process.version}; the hook is installed and executable`)
  if (!config.enabled) lines.push('\n*** GUARD IS DISABLED ("enabled": false) — no skill will be measured or warned about ***')
  lines.push('')
  lines.push('config sources:')
  if (process.env.CCG_CONFIG) {
    lines.push(`  CCG_CONFIG=${process.env.CCG_CONFIG} (sole source; user/project files ignored)`)
  } else {
    lines.push(`  user:    ${userPath} — ${existsSync(userPath) ? 'present' : 'absent (defaults apply)'}`)
    lines.push(`  project: ${projectPath} — ${existsSync(projectPath) ? 'present (overrides user per key)' : 'absent'}`)
  }
  lines.push('')
  lines.push('effective config:')
  lines.push(`  enabled:        ${config.enabled}`)
  lines.push(`  warnThreshold:  ${showThreshold(config.warnThreshold, warnTokens)}`)
  lines.push(`  denyThreshold:  ${showThreshold(config.denyThreshold, denyTokens)}`)
  lines.push(`  window:         ${configured
    ? `${fmt(window)} tokens (configured, used verbatim as the budget)`
    : `${fmt(window)} tokens (model: ${model ?? 'unknown'}, via ${modelBasis}) → ${fmt(budget)} usable after the auto-compact reserve`}`)
  lines.push(`  alwaysAllow:    ${config.alwaysAllow.length ? config.alwaysAllow.join(', ') : '(none)'}`)
  lines.push(`  logPath:        ${config.logPath ?? 'off'}`)

  const skills = listSkills(cwd).map(s => {
    try {
      return { ...s, tokens: estimateTokens(readFileSync(s.path, 'utf8')).tokens }
    } catch {
      return null
    }
  }).filter(Boolean).sort((a, b) => b.tokens - a.tokens)

  lines.push('')
  lines.push(`costliest installed skills (top 10 of ${skills.length} measurable; CLI-bundled skills are not on disk and cannot be measured):`)
  for (const s of skills.slice(0, 10)) {
    const verdict = config.alwaysAllow.includes(s.name) ? 'skip'
      : denyTokens !== null && s.tokens >= denyTokens ? 'DENY'
        : warnTokens !== null && s.tokens >= warnTokens ? 'ASK '
          : 'ok  '
    lines.push(`  ${verdict}  ~${fmt(s.tokens).padStart(7)} tokens${budget ? ` = ${String(pct(s.tokens, budget)).padStart(2)}%` : ''}  ${s.name}`)
  }
  if (!skills.length) lines.push('  (none found)')

  // The hint travels in the payload, not in the command prompt: everything in
  // stdout is shown verbatim, so the rendering model never has to decide
  // whether the window is "wrong" — that judgement caused unpredictable
  // /status output.
  if (!configured && mi === -1) {
    lines.push('')
    lines.push('note: window derived from a possibly-stale signal — for an exact figure re-run with --model <your-model-id>')
  }

  console.log(lines.join('\n'))
}

if (process.argv.includes('--version')) {
  const v = readJson(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'))?.version ?? 'unknown'
  console.log(`context-bloat-guard v${v}`)
  process.exit(0)
}

if (process.argv.includes('--status')) {
  status(process.argv)
  process.exit(0)
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  try {
    main(input)
  } catch {
    // Swallow deliberately: a guard that can crash into a block is worse than
    // no guard. Exit 0 with whatever (nothing) was written.
  }
  process.exit(0)
})
