#!/usr/bin/env node
// Integration tests: drive guard.mjs the way the hook runtime does — real
// payload on stdin, assert on stdout. No mocking of the contract under test.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { estimateTokens } from '../hooks/estimate.mjs'

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
