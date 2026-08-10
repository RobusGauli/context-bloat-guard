#!/usr/bin/env node
// Integration tests: drive guard.mjs the way the hook runtime does — real
// payload on stdin, assert on stdout. No mocking of the contract under test.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { estimateTokens, scriptCounts, BYTES_PER_TOKEN_FLOOR } from '../hooks/estimate.mjs'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'guard.mjs')
const sandbox = mkdtempSync(join(tmpdir(), 'ccg-'))
let pass = 0
let fail = 0

function makeSkill (name, body, filename = 'SKILL.md') {
  const dir = join(sandbox, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), body)
}

let configSeq = 0
function run (payload, config, env) {
  const configPath = join(sandbox, `config-${configSeq++}.json`)
  writeFileSync(configPath, JSON.stringify(config ?? {}))
  const out = execFileSync('node', [GUARD], {
    input: JSON.stringify(payload),
    env: { ...process.env, CCG_CONFIG: configPath, ...env },
    encoding: 'utf8',
  })
  return out ? JSON.parse(out) : null
}

function check (label, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${actual}, want ${expected}`}`)
  ok ? pass++ : fail++
}

const skillCall = name => ({ tool_name: 'Skill', tool_input: { skill: name }, cwd: sandbox })
const decision = r => r?.hookSpecificOutput?.permissionDecision ?? 'allow'
const reasonOf = r => r?.hookSpecificOutput?.permissionDecisionReason ?? ''

// --- happy paths ---
makeSkill('tiny', '# tiny\n' + 'short prose. '.repeat(20))
check('small skill passes silently', decision(run(skillCall('tiny'))), 'allow')

makeSkill('huge', '# huge\n' + 'the quick brown fox jumps over the lazy dog. '.repeat(6000))
check('large skill asks', decision(run(skillCall('huge'))), 'ask')

check('alwaysAllow bypasses', decision(run(skillCall('huge'), { alwaysAllow: ['huge'] })), 'allow')
check('disabled bypasses', decision(run(skillCall('huge'), { enabled: false })), 'allow')
check('deny when configured', decision(run(skillCall('huge'), { denyThreshold: 1000 })), 'deny')

// A deny reaches the model with no prompt attached, so it must not claim an
// Approve affordance that does not exist.
const denyReason = reasonOf(run(skillCall('huge'), { denyThreshold: 1000 }))
const askReason = reasonOf(run(skillCall('huge')))
check('deny reason omits approve wording', /approve/i.test(denyReason), false)
check('deny reason names the escape hatch', denyReason.includes('denyThreshold'), true)
check('ask reason keeps approve wording', /approve/i.test(askReason), true)
check('high threshold allows', decision(run(skillCall('huge'), { warnThreshold: 10_000_000 })), 'allow')

// --- config validation ---
// null means OFF for a threshold. Before sanitizeConfig, `tokens >= null`
// coerced to `tokens >= 0` and prompted on EVERY skill — the exact opposite of
// what someone setting null is asking for.
check('warnThreshold null silences the warning', decision(run(skillCall('huge'), { warnThreshold: null })), 'allow')
check('warnThreshold null still allows tiny skills', decision(run(skillCall('tiny'), { warnThreshold: null })), 'allow')
// ...but an explicit denyThreshold must still fire with warnThreshold off, and
// the fast path has to clear that lower bar rather than the absent one.
check('warnThreshold null keeps denyThreshold live', decision(run(skillCall('huge'), { warnThreshold: null, denyThreshold: 1000 })), 'deny')
// A denyThreshold below warnThreshold must not be skipped by the fast path.
check('deny below warn is not skipped', decision(run(skillCall('huge'), { warnThreshold: 10_000_000, denyThreshold: 1000 })), 'deny')

// Wrong-typed values fall back to the default instead of reaching a comparison.
check('string threshold falls back to default', decision(run(skillCall('huge'), { warnThreshold: 'lots' })), 'ask')
check('negative threshold falls back to default', decision(run(skillCall('tiny'), { warnThreshold: -1 })), 'allow')
check('object threshold falls back to default', decision(run(skillCall('huge'), { warnThreshold: {} })), 'ask')
check('string enabled falls back to default', decision(run(skillCall('huge'), { enabled: 'false' })), 'ask')
check('non-array alwaysAllow is ignored', decision(run(skillCall('huge'), { alwaysAllow: 'huge' })), 'ask')
check('non-string config is ignored wholesale', decision(run(skillCall('huge'), [1, 2, 3])), 'ask')

// lowercase skill.md is used by real skills (brain, google, slack)
makeSkill('lower', '# lower\n' + 'prose here. '.repeat(6000), 'skill.md')
check('lowercase skill.md resolves', decision(run(skillCall('lower'))), 'ask')

// --- fail-open cases: every one of these must allow ---
check('non-Skill tool ignored', decision(run({ tool_name: 'Bash', tool_input: { command: 'ls' } })), 'allow')
check('missing skill on disk', decision(run(skillCall('does-not-exist'))), 'allow')
check('missing tool_input', decision(run({ tool_name: 'Skill', cwd: sandbox })), 'allow')

const empty = execFileSync('node', [GUARD], { input: 'not json at all', encoding: 'utf8' })
check('malformed stdin exits clean', empty, '')

// --- path traversal ---
// The skill name is interpolated into a path, so it must not be able to walk out
// of the skills root. The previous version of this test used "../../../../etc"
// and passed only because /etc/SKILL.md does not happen to exist — it asserted
// nothing. These plant a real, oversized SKILL.md at the traversal target, so a
// guard that follows the escape returns 'ask' and fails the check.
const bigBody = '# escaped\n' + 'the quick brown fox jumps over the lazy dog. '.repeat(6000)
mkdirSync(join(sandbox, '.claude', 'outside'), { recursive: true })
writeFileSync(join(sandbox, '.claude', 'outside', 'SKILL.md'), bigBody)
check('traversal cannot reach a real file above the root', decision(run(skillCall('../outside'))), 'allow')

mkdirSync(join(sandbox, 'elsewhere', 'deep'), { recursive: true })
writeFileSync(join(sandbox, 'elsewhere', 'deep', 'SKILL.md'), bigBody)
check('multi-segment traversal is rejected', decision(run(skillCall('../../elsewhere/deep'))), 'allow')
check('traversal name is inert', decision(run(skillCall('../../../../etc'))), 'allow')

// The containment check is lexical precisely so this keeps working: symlinking a
// skill directory out to a dotfiles repo is a documented, legitimate pattern, and
// a realpath-based check would have rejected it.
mkdirSync(join(sandbox, 'dotfiles', 'linked'), { recursive: true })
writeFileSync(join(sandbox, 'dotfiles', 'linked', 'SKILL.md'), bigBody)
symlinkSync(join(sandbox, 'dotfiles', 'linked'), join(sandbox, '.claude', 'skills', 'linked'))
check('symlinked skill dir still resolves', decision(run(skillCall('linked'))), 'ask')

// Namespaced names split on the FIRST colon only. Destructuring `split(':')`
// silently resolved "a:b:c" as plugin "a" skill "b" — measuring a different
// skill than the one invoked. HOME is redirected so the plugin cache is a
// fixture rather than the developer's real one.
const fakeHome = join(sandbox, 'home')
const cachedSkill = join(fakeHome, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills', 'b')
mkdirSync(cachedSkill, { recursive: true })
writeFileSync(join(cachedSkill, 'SKILL.md'), bigBody)
check('two-segment plugin skill resolves', decision(run(skillCall('plug:b'), {}, { HOME: fakeHome })), 'ask')
check('three-segment name does not resolve to its prefix', decision(run(skillCall('plug:b:c'), {}, { HOME: fakeHome })), 'allow')

// With several versions of a plugin installed, the first hit wins — so the order
// must be meaningful rather than whatever readdir returns. These two cases pin
// both halves: newest wins, and "newest" is compared numerically.
const tinyBody = '# tiny\n' + 'short prose. '.repeat(20)
function makeVersioned (homeDir, versions) {
  for (const [version, body] of Object.entries(versions)) {
    const dir = join(homeDir, '.claude', 'plugins', 'cache', 'mkt', 'plug', version, 'skills', 'b')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), body)
  }
  return homeDir
}
// 2.0.0 is huge, 10.0.0 is tiny. A plain string sort picks "2.0.0" (character
// order: "2" > "1") and would answer 'ask'; numeric order picks 10.0.0.
const numericHome = makeVersioned(join(sandbox, 'home-numeric'), { '2.0.0': bigBody, '10.0.0': tinyBody })
check('double-digit version beats single-digit', decision(run(skillCall('plug:b'), {}, { HOME: numericHome })), 'allow')
// Reversed payloads, so a rule of "always pick the smaller file" cannot pass both.
const newestHome = makeVersioned(join(sandbox, 'home-newest'), { '1.0.0': tinyBody, '2.0.0': bigBody })
check('newest version is the one measured', decision(run(skillCall('plug:b'), {}, { HOME: newestHome })), 'ask')

// --- estimator sanity: CJK must not be scored as if it were ASCII prose ---
makeSkill('cjk', '# 中文\n' + '这是一个很长的中文文档需要很多标记。'.repeat(900))
check('CJK skill asks', decision(run(skillCall('cjk'))), 'ask')

// Regression: a handful of CJK characters in an otherwise English skill must be
// billed only on those characters. An all-or-nothing classifier priced a 3.5 KB
// English file at the Han rate because 1.6% of it was one Chinese example —
// measured +180% error against count_tokens.
const english = 'the guard measures a skill before it enters the window. '.repeat(60)
const sprinkled = english + '例如：这是一个例子。'
const plain = estimateTokens(english)
const mixed = estimateTokens(sprinkled)
check('sprinkled CJK is not classed cjk', mixed.kind !== 'cjk', true)
check('sprinkled CJK bills per character', mixed.tokens - plain.tokens < 20, true)

// Astral-plane Han (CJK Ext B and later) must be billed at the Han rate, not as
// English prose. Covering only the BMP left these in the non-CJK remainder at
// RATIO.prose: 100 characters estimated 43 tokens against ~112 real, which is
// under-counting — the failure mode the estimator exists to avoid.
const astralHan = '\u{20000}\u{2A700}\u{2F800}'.repeat(40)
const bmpHan = '中'.repeat(120)
check('astral Han is classed cjk', estimateTokens(astralHan).kind, 'cjk')
check('astral Han counts as Han characters', scriptCounts(astralHan).han, 120)
check('astral Han prices like BMP Han', estimateTokens(astralHan).tokens, estimateTokens(bmpHan).tokens)
// Ext G/H sit above the Ext B–F block and need their own range.
check('CJK Ext G is classed cjk', estimateTokens('\u{30000}'.repeat(100)).kind, 'cjk')
// The u flag must not change how BMP text is counted.
check('BMP Han unchanged by the u flag', estimateTokens(bmpHan).tokens, 135)

// --- the stat-only fast path must never skip a file that would warn ---
// Regression: an ASCII markdown table is the densest input there is (1 byte per
// character at the table divisor). A floor derived from CJK alone bounded this
// 33 KB file at 14,740 tokens, under the 15,000 default, so it was never read
// and never warned about — while its real cost is ~15,700.
let tableBody = ''
while (Buffer.byteLength(tableBody) < 33000) tableBody += '| aaa | bbb | ccc |\n'
makeSkill('dense-table', tableBody)
// Guard the fixture itself: the regression only exercises the fast path while
// the file sits in the dead band — big enough to cross the threshold, small
// enough that the old floor bounded it under.
const denseTokens = estimateTokens(tableBody).tokens
check('table fixture crosses the default threshold', denseTokens >= 15000, true)
check('table fixture was skipped by the old floor', Buffer.byteLength(tableBody) / (3 / 1.34) < 15000, true)
check('dense ASCII table asks', decision(run(skillCall('dense-table'))), 'ask')

// The invariant the fast path rests on, asserted directly rather than inferred
// from any single fixture: for every input, the byte bound must be at least the
// real estimate. The ceil mirrors guard.mjs — estimateTokens ends in Math.ceil,
// so the raw quotient can sit a fraction low on pure-ASCII input.
const FLOOR_FIXTURES = {
  'ascii table': '| aaa | bbb | ccc |\n',
  'ascii code': '```js\nconst x = foo(bar, baz);\n```\n',
  'ascii prose': 'the guard measures a skill before it enters the window. ',
  'hangul': '이것은한국어문서입니다스킬파일은',
  'hangul spaced': '이것은 한국어 문서입니다 스킬 파일은 ',
  'han': '技能文件大小直接影响上下文窗口',
  'kana': 'これはにほんごのぶんしょうです',
  'cyrillic': 'это документ навыка для окна контекста ',
  'mixed 50/50': '| aaa | bbb |\n技能文件大小直接影响\n',
  'mixed 10/90': '| a |\n技能文件大小直接影响上下文窗口占用程度不可忽视\n',
  'astral han': '\u{20000}\u{2A700}\u{2F800}',
}
let floorViolations = 0
for (const [label, unit] of Object.entries(FLOOR_FIXTURES)) {
  // Sweep sizes: the ceil correction only shows up at particular remainders, so
  // a single length can pass while a neighbouring one fails.
  for (const target of [1000, 8000, 33000, 120000]) {
    let text = ''
    while (Buffer.byteLength(text) < target) text += unit
    const bound = Math.ceil(Buffer.byteLength(text) / BYTES_PER_TOKEN_FLOOR)
    const { tokens } = estimateTokens(text)
    if (bound < tokens) {
      floorViolations++
      console.log(`      floor under-bounds ${label} @${target}B: bound ${bound} < tokens ${tokens}`)
    }
  }
}
check('byte bound is never below the real estimate', floorViolations, 0)

// --- window resolution ---
// The percentage is only useful if its denominator is the room a skill actually
// competes for. These assert the denominator, which is the bug the window
// module exists to fix: a hardcoded 200k mis-reported every session whose real
// budget differed.
import { resolveWindow, usableBudget, modelCeiling } from '../hooks/window.mjs'

const noEnv = () => {
  for (const k of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL']) delete process.env[k]
}

noEnv()
check('bare env falls back to base tier', resolveWindow(null), 200000)
check('explicit config wins', resolveWindow(64000), 64000)
check('zero config is not a window', resolveWindow(0), 200000)
check('garbage config is ignored', resolveWindow('lots'), 200000)

process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '120000'
check('CLI cap is honoured', resolveWindow(null), 120000)
check('config outranks CLI cap', resolveWindow(50000), 50000)
noEnv()

process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '150000'
check('auto-compact window is honoured', resolveWindow(null), 150000)
noEnv()

// Measured 2026-08-10 (CLI 2.1.226), one variable per run: a default
// claude-sonnet-5 session reports a ~1M window; the same container with
// CLAUDE_CODE_DISABLE_1M_CONTEXT=1 reports 200k; claude-opus-5 reports 1m;
// claude-haiku-4-5 reports 200k. The predecessor of these tests asserted
// 200000 on both sides of the flag, so `return 200000` passed them — the
// inequality check below makes any single-value implementation fail.
const flagOff = resolveWindow(null, 'claude-opus-5')
process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
const flagOn = resolveWindow(null, 'claude-opus-5')
noEnv()
check('1M model reports its ceiling', flagOff, 1000000)
check('disable flag clamps a 1M model to base tier', flagOn, 200000)
check('the flag changes the window', flagOff !== flagOn, true)

check('base-tier model stays at base tier', resolveWindow(null, 'claude-haiku-4-5-20251001'), 200000)
check('unknown model falls back to base tier', resolveWindow(null, 'claude-not-a-model'), 200000)

// A 1M CEILING is not a 1M DEFAULT. opus-4-6, sonnet-4-6 and sonnet-4-5 are
// all 1M-capable and all measured at 200k by default (2026-08-10, headless
// and — for opus-4-6 — interactively, same answer). Only the models measured
// or documented as always-1M report their ceiling.
check('opus-4-6 is 1M-capable but defaults to base tier', resolveWindow(null, 'claude-opus-4-6'), 200000)
check('sonnet-4-6 defaults to base tier', resolveWindow(null, 'claude-sonnet-4-6'), 200000)
check('sonnet-4-5 defaults to base tier', resolveWindow(null, 'claude-sonnet-4-5-20250929'), 200000)
check('opt-in model with [1m] suffix gets its ceiling', resolveWindow(null, 'claude-sonnet-4-6[1m]'), 1000000)
check('dated variant of a default-1M model matches by prefix', resolveWindow(null, 'claude-fable-5-20260101'), 1000000)

// The [1m] suffix is the CLI's marker for an explicitly selected 1M variant.
// For a known id the prefix matcher would already resolve it; for an id the
// table has not caught up with, the suffix is the sole 1M signal.
check('[1m] suffix on a known id resolves', resolveWindow(null, 'claude-opus-4-8[1m]'), 1000000)
check('[1m] suffix alone marks an unknown id as 1M', resolveWindow(null, 'claude-zeta-9[1m]'), 1000000)
process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
check('disable flag outranks the [1m] suffix', resolveWindow(null, 'claude-opus-4-8[1m]'), 200000)
noEnv()

// Behind an LLM gateway Claude Code can't verify 1M support and budgets 200K,
// unless the user explicitly selects a [1m] variant.
process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example/v1'
check('gateway clamps to base tier', resolveWindow(null, 'claude-opus-5'), 200000)
check('[1m] suffix overrides the gateway clamp', resolveWindow(null, 'claude-sonnet-5[1m]'), 1000000)
noEnv()
process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
check('first-party base URL does not clamp', resolveWindow(null, 'claude-opus-5'), 1000000)
noEnv()

// Dated transcript ids must match the bare table keys and vice versa, or every
// legacy session silently falls through to the default.
check('dated id matches bare key', modelCeiling('claude-opus-5-20260101'), 1000000)
check('bare id matches dated key', modelCeiling('claude-haiku-4-5'), 200000)
check('[1m] suffix is stripped before lookup', modelCeiling('claude-haiku-4-5-20251001[1m]'), 200000)
check('unknown model has no ceiling', modelCeiling('claude-not-a-model'), null)
check('empty model has no ceiling', modelCeiling(''), null)

// The usable budget is the nominal window less a FLAT 33k auto-compact
// reserve. Measured 2026-08-10 via /context (CLI 2.1.226): 33k on a 200k
// window and 33k on a 967k sonnet-5 window. The fraction this replaced
// (0.835 = 1 - 33000/200000) was fitted at the base tier and predicted a 165k
// buffer at 1M against a real 33k.
noEnv()
check('usable budget discounts the compact reserve', usableBudget(200000), 167000)
check('the reserve is flat, not a fraction of the window', usableBudget(1000000), 967000)
// Both env vars were measured to have no effect on the CLI's accounting —
// byte-identical /context output with them set or unset — so the budget must
// not move with them. The predecessors of these checks asserted the opposite
// (119000 and 72000).
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '48000'
check('reserved output is not deducted', usableBudget(200000), 167000)
process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '60'
check('pct override is inert', usableBudget(200000), 167000)
noEnv()
// A configured window smaller than the reserve must not report negative.
check('window below the reserve clamps at zero', usableBudget(20000), 0)

// The reason text must quote the usable budget, not the nominal window — the
// whole point of the change.
const budgetReason = reasonOf(run(skillCall('huge')))
check('reason quotes usable context', /167k usable context/.test(budgetReason), true)
check('reason names the nominal window', /200k window/.test(budgetReason), true)
// An explicitly configured window is used verbatim — no reserve deducted, no
// buffer wording (issue #9). The predecessor of this check expected 84k, the
// configured 100k scaled by the old fraction, contradicting the README.
const configuredReason = reasonOf(run(skillCall('huge'), { contextWindowSize: 100000 }))
check('configured window omits buffer wording', /auto-compact buffer/.test(configuredReason), false)
check('configured window is used verbatim', /100k usable context/.test(configuredReason), true)

// --- active-model detection from the transcript tail ---
// $ANTHROPIC_MODEL is stamped at session start and survives, stale, across a
// mid-session /model switch (observed live: a fable-5 session whose hook env
// still said claude-sonnet-4-6 — a 5x window difference). The transcript
// stamps every assistant message with the producing model, so its LAST stamp
// is the active model and must outrank the env var.
const transcriptOf = lines => {
  const p = join(sandbox, `transcript-${configSeq++}.jsonl`)
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return p
}
const withTranscript = path => ({ ...skillCall('huge'), transcript_path: path })

const switched = transcriptOf([
  { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001' } },
  { type: 'assistant', message: { model: 'claude-fable-5' } },
])
// The env var names a 200k model in EVERY era of this code, so this check can
// only pass by actually reading the transcript's later 1M stamp.
const switchedReason = reasonOf(run(withTranscript(switched), {}, { ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001' }))
check('transcript model outranks the stale env var', /1000k window/.test(switchedReason), true)

// Error records are stamped "<synthetic>"; only real claude-* stamps count.
const synthetic = transcriptOf([
  { type: 'assistant', message: { model: 'claude-opus-5' } },
  { type: 'assistant', message: { model: '<synthetic>' } },
])
check('synthetic stamps are skipped', /1000k window/.test(reasonOf(run(withTranscript(synthetic), {}))), true)

// No transcript, or an unreadable one, falls back to the env var; env var
// absent falls back to the base tier. Fail-open at every step.
const envOnly = reasonOf(run(skillCall('huge'), {}, { ANTHROPIC_MODEL: 'claude-opus-5' }))
check('env model is the fallback without a transcript', /1000k window/.test(envOnly), true)
const missing = reasonOf(run(withTranscript(join(sandbox, 'does-not-exist.jsonl')), {}, { ANTHROPIC_MODEL: 'claude-opus-5' }))
check('unreadable transcript falls back to the env var', /1000k window/.test(missing), true)

// --- logging: opting in must capture cheap skills too, not just expensive ones,
// or the log is useless for choosing a threshold ---
const logPath = join(sandbox, 'decisions.jsonl')
run(skillCall('tiny'), { logPath })
run(skillCall('huge'), { logPath })
const logged = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse)
check('log captures below-threshold skill', logged[0]?.skill, 'tiny')
check('below-threshold skill still allowed', logged[0]?.decision, 'allow')
check('log captures above-threshold skill', logged[1]?.decision, 'ask')
// Without a time field the log cannot be sliced by session or date, which is the
// only thing it is for.
check('log records carry a timestamp', typeof logged[0]?.ts, 'string')
check('timestamp is a valid ISO instant', new Date(logged[0]?.ts).toISOString(), logged[0]?.ts)

// --- overhead ---
const t0 = process.hrtime.bigint()
for (let i = 0; i < 20; i++) run(skillCall('tiny'))
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20
console.log(`\nmean wall time per invocation (incl. node cold start): ${ms.toFixed(1)} ms`)

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
