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
//   - HOT PATH IS CHEAP. No network. No transcript parsing. Single stat() for
//     the common case; bytes are only read when the file is big enough to
//     possibly cross a threshold.

import { readFileSync, statSync, appendFileSync, realpathSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { estimateTokens, BYTES_PER_TOKEN_FLOOR } from './estimate.mjs'
import { resolveWindow, usableBudget } from './window.mjs'

const DEFAULTS = {
  enabled: true,
  warnThreshold: 15000,     // tokens; ~9% of a 200k window's usable budget
  denyThreshold: null,      // off by default — see README "ask vs deny"
  contextWindowSize: null,  // null = detect from the environment; see window.mjs
  alwaysAllow: [],
  logPath: null,            // opt-in
}

function loadConfig () {
  const path = process.env.CCG_CONFIG || join(homedir(), '.claude', 'context-bloat-guard.json')
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    return DEFAULTS // missing or corrupt config is not an error
  }
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

// Resolution order mirrors how Claude Code itself finds a skill. Both SKILL.md
// and skill.md are checked: real skills in the wild use each, and a
// case-sensitive filesystem will not forgive guessing.
function resolveSkillFile (name, cwd) {
  const home = homedir()
  const roots = []

  // Plugin skills arrive namespaced as "plugin:skill" and live under a
  // versioned cache dir. These are empirically the largest skills in the
  // ecosystem, so skipping them would miss the cases that matter most.
  if (name.includes(':')) {
    const [pluginName, skillName] = name.split(':')
    const cache = join(home, '.claude', 'plugins', 'cache')
    for (const marketplace of safeReaddir(cache)) {
      const pluginDir = join(cache, marketplace, pluginName)
      // One extra level: the installed version (e.g. "3.9.2").
      for (const version of safeReaddir(pluginDir)) {
        roots.push(join(pluginDir, version, 'skills', skillName))
      }
    }
  }

  roots.push(join(cwd, '.claude', 'skills', name))
  roots.push(join(home, '.claude', 'skills', name))
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    roots.push(join(process.env.CLAUDE_PLUGIN_ROOT, 'skills', name))
  }

  for (const root of roots) {
    for (const file of ['SKILL.md', 'skill.md']) {
      const candidate = join(root, file)
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
// nominal 200k window carries a ~33k auto-compact buffer and a reserved output
// budget, so the room a skill actually competes for is materially smaller —
// quoting the nominal figure understates every skill's cost by ~20%. The
// nominal number is still named so the arithmetic is checkable.
function share (tokens, config) {
  const window = resolveWindow(config.contextWindowSize)
  const budget = usableBudget(window)
  if (!budget) return ''
  const k = n => `${Math.round(n / 1000)}k`
  const p = pct(tokens, budget)
  // An explicitly configured window is taken at face value, so there is no
  // buffer to explain.
  const basis = config.contextWindowSize
    ? `${k(budget)} usable context`
    : `${k(budget)} usable context (${k(window)} window, less the auto-compact buffer and reserved output)`
  return ` = ${p}% of your ${basis}`
}

// The closing line differs by decision because the two decisions reach
// different readers. An "ask" is rendered to the user with an Approve button;
// a "deny" is returned to the model with no prompt and no way to consent, so
// telling it to approve would send it chasing an affordance that isn't there.
function reason (skill, tokens, config, decision) {
  const costShare = share(tokens, config)
  return [
    `Skill "${skill}" will inject ~${tokens.toLocaleString()} tokens${costShare} into this context, permanently for the rest of the session.`,
    '',
    'Cheaper alternative: delegate it. Spawn a subagent (Agent tool) that invokes',
    'this skill in its own isolated context and returns only the conclusion — the',
    'main window pays for the summary, not the whole SKILL.md.',
    '',
    decision === 'deny'
      ? `Blocked outright by denyThreshold (${config.denyThreshold.toLocaleString()} tokens) — no permission prompt is shown, and this call cannot be retried into one. Delegate to a subagent, or raise or unset denyThreshold in your context-bloat-guard.json to permit inline loads this large.`
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

  const config = loadConfig()
  if (!config.enabled) return

  const skill = payload.tool_input?.skill
  if (!skill || config.alwaysAllow.includes(skill)) return

  const found = resolveSkillFile(skill, payload.cwd || process.cwd())
  // Unresolvable — fail open. Notably includes CLI-bundled skills: their
  // SKILL.md is embedded in the binary and only their resource subdirectories
  // are unpacked to disk, so there is nothing to measure.
  if (!found) return

  // Fast path: even at the worst possible byte-to-token ratio this file cannot
  // reach the warn threshold, so never read it. Most skills exit here after a
  // single stat().
  //
  // Skipped when logging is on: someone who set logPath asked to observe every
  // invocation, including the cheap ones they are trying to calibrate against.
  // They pay one small read for that.
  // The ceil is load-bearing, not cosmetic: estimateTokens ends in Math.ceil, so
  // for a pure-ASCII file the exact quotient can sit a fraction below the real
  // token count. Rounding the bound up restores the strict inequality.
  if (!config.logPath && Math.ceil(found.size / BYTES_PER_TOKEN_FLOOR) < config.warnThreshold) return

  const text = readFileSync(found.path, 'utf8')
  const { tokens, kind } = estimateTokens(text)

  let decision = 'allow'
  if (config.denyThreshold !== null && tokens >= config.denyThreshold) decision = 'deny'
  else if (tokens >= config.warnThreshold) decision = 'ask'

  log(config, { skill, bytes: found.size, tokens, kind, decision })
  emit(decision, reason(skill, tokens, config, decision))
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
