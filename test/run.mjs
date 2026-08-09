#!/usr/bin/env node
// Integration tests: drive guard.mjs the way the hook runtime does — real
// payload on stdin, assert on stdout. No mocking of the contract under test.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { estimateTokens, BYTES_PER_TOKEN_FLOOR } from '../hooks/estimate.mjs'

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
function run (payload, config) {
  const configPath = join(sandbox, `config-${configSeq++}.json`)
  writeFileSync(configPath, JSON.stringify(config ?? {}))
  const out = execFileSync('node', [GUARD], {
    input: JSON.stringify(payload),
    env: { ...process.env, CCG_CONFIG: configPath },
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

// lowercase skill.md is used by real skills (brain, google, slack)
makeSkill('lower', '# lower\n' + 'prose here. '.repeat(6000), 'skill.md')
check('lowercase skill.md resolves', decision(run(skillCall('lower'))), 'ask')

// --- fail-open cases: every one of these must allow ---
check('non-Skill tool ignored', decision(run({ tool_name: 'Bash', tool_input: { command: 'ls' } })), 'allow')
check('missing skill on disk', decision(run(skillCall('does-not-exist'))), 'allow')
check('missing tool_input', decision(run({ tool_name: 'Skill', cwd: sandbox })), 'allow')

const empty = execFileSync('node', [GUARD], { input: 'not json at all', encoding: 'utf8' })
check('malformed stdin exits clean', empty, '')

// path traversal in the skill name must not escape into an arbitrary read
check('traversal name is inert', decision(run(skillCall('../../../../etc'))), 'allow')

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
  for (const k of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'ANTHROPIC_MODEL']) delete process.env[k]
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

// A 1M model must never be reported as 1M while Claude Code runs it at 200k —
// measured live: claude-opus-5 (1M on the API) in a 200k auto-compact window.
check('1M model clamps to base tier', resolveWindow(null, 'claude-opus-5'), 200000)
process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
check('1M model clamps with 1M disabled', resolveWindow(null, 'claude-opus-5'), 200000)
noEnv()

// Dated transcript ids must match the bare table keys and vice versa, or every
// legacy session silently falls through to the default.
check('dated id matches bare key', modelCeiling('claude-opus-5-20260101'), 1000000)
check('bare id matches dated key', modelCeiling('claude-haiku-4-5'), 200000)
check('unknown model has no ceiling', modelCeiling('claude-not-a-model'), null)
check('empty model has no ceiling', modelCeiling(''), null)

// The usable budget is the number the user cares about: nominal window less the
// auto-compact buffer and whatever output is reserved.
noEnv()
check('usable budget discounts the compact buffer', usableBudget(200000), 167000)
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '48000'
check('reserved output is subtracted', usableBudget(200000), 119000)
process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '60'
check('pct override wins over the measured default', usableBudget(200000), 72000)
noEnv()
// A setup reserving more output than the window allows must not report negative.
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '999999'
check('over-reservation clamps at zero', usableBudget(200000), 0)
noEnv()

// The reason text must quote the usable budget, not the nominal window — the
// whole point of the change.
const budgetReason = reasonOf(run(skillCall('huge')))
check('reason quotes usable context', /167k usable context/.test(budgetReason), true)
check('reason names the nominal window', /200k window/.test(budgetReason), true)
// An explicitly configured window is taken at face value, so the buffer
// explanation would be a lie.
const configuredReason = reasonOf(run(skillCall('huge'), { contextWindowSize: 100000 }))
check('configured window omits buffer wording', /auto-compact buffer/.test(configuredReason), false)
check('configured window is used as the basis', /84k usable context/.test(configuredReason), true)

// --- logging: opting in must capture cheap skills too, not just expensive ones,
// or the log is useless for choosing a threshold ---
const logPath = join(sandbox, 'decisions.jsonl')
run(skillCall('tiny'), { logPath })
run(skillCall('huge'), { logPath })
const logged = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse)
check('log captures below-threshold skill', logged[0]?.skill, 'tiny')
check('below-threshold skill still allowed', logged[0]?.decision, 'allow')
check('log captures above-threshold skill', logged[1]?.decision, 'ask')

// --- overhead ---
const t0 = process.hrtime.bigint()
for (let i = 0; i < 20; i++) run(skillCall('tiny'))
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20
console.log(`\nmean wall time per invocation (incl. node cold start): ${ms.toFixed(1)} ms`)

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
