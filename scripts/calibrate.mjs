#!/usr/bin/env node
// DEV-TIME ONLY. Never runs in the hook path — it makes network calls.
//
// Calibrates hooks/estimate.mjs against the only authoritative tokenizer for
// Claude: POST /v1/messages/count_tokens. It imports the real estimator rather
// than a copy, so what is measured is what ships.
//
// Do NOT substitute tiktoken. That is OpenAI's tokenizer; it undercounts Claude
// tokens by ~15-20%, and far more on code and non-English text — which is
// precisely the content this guard exists to measure.
//
//   ANTHROPIC_API_KEY=... node scripts/calibrate.mjs
//
// Fixtures = synthetic per-class samples + every real SKILL.md on this machine,
// because real skills are the distribution that matters, not clean samples.

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { estimateTokens, scriptCounts, RATIO, CJK_TOKENS_PER_CHAR } from '../hooks/estimate.mjs'

const MODEL = 'claude-opus-5'

const SYNTHETIC = [
  ['prose/plain', 'The guard measures a skill before its body enters the context window. It does not interpret the file; it counts it. When the count crosses a threshold the user is offered delegation to a subagent instead of an inline load. '.repeat(40)],
  ['prose/markdown', '## Heading\n\nSome explanation here with `inline code` and a [link](https://example.com).\n\n- bullet one\n- bullet two\n\n> a blockquote line\n\n'.repeat(40)],
  ['code/js', 'export function resolve (name, cwd) {\n  const roots = [join(cwd, ".claude", "skills", name)]\n  for (const root of roots) {\n    try { return statSync(join(root, "SKILL.md")).size } catch { /* next */ }\n  }\n  return null\n}\n'.repeat(40)],
  ['code/fenced', '# Doc\n\n```bash\nnpx skills add owner/repo@skill -g -y\n```\n\n```python\nclient.messages.count_tokens(model="claude-opus-5", messages=msgs)\n```\n\n'.repeat(40)],
  ['table/md', '| Column A | Column B | Column C |\n|---|---|---|\n| value one | 12,345 | yes |\n| value two | 6,789 | no |\n| value three | 42 | maybe |\n'.repeat(40)],
  // Mixed-script realism: these carry ASCII spaces and punctuation, so they
  // validate the share-weighted sum rather than isolating a per-script rate.
  ['cjk/zh', '这是一个很长的中文文档，需要很多标记来表示。技能文件的大小会直接影响上下文窗口的占用。'.repeat(40)],
  ['cjk/ja', 'これは日本語のドキュメントです。スキルファイルはコンテキストウィンドウを消費します。'.repeat(40)],
  ['cjk/ko', '이것은 한국어 문서입니다. 스킬 파일은 컨텍스트 창을 소비합니다.'.repeat(40)],
  // Single-script, zero non-CJK characters. A per-script tokens/char rate can
  // only be read off a fixture where nothing else contributes to the count.
  ['cjk/pure-han', '技能文件大小直接影响上下文窗口占用程度不可忽视'.repeat(60)],
  ['cjk/pure-kana', 'これはにほんごのぶんしょうですスキルファイルはコンテキストウィンドウ'.repeat(60)],
  ['cjk/pure-hangul', '이것은한국어문서입니다스킬파일은컨텍스트창을소비합니다'.repeat(60)],
]

// Fixtures that contain exactly ONE CJK script, so a per-script tokens/char rate
// can be solved for. Spaced variants must be included, not just the space-free
// ones: word-spacing changes the rate materially — Korean measures 1.11 tok/char
// unspaced and 1.30 spaced, and fitting only the unspaced form under-counted real
// Korean by 11%. The Japanese mixed fixture is deliberately absent: it carries
// both kana and kanji, so it cannot isolate either.
const SINGLE_SCRIPT = {
  'cjk/pure-han': 'han',
  'cjk/zh': 'han',
  'cjk/pure-kana': 'kana',
  'cjk/pure-hangul': 'hangul',
  'cjk/ko': 'hangul',
}

function safeReaddir (dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name)
  } catch {
    return []
  }
}

// Walk for real SKILL.md files: user skills plus the plugin cache, where the
// genuinely large ones live.
function realFixtures () {
  const home = homedir()
  const dirs = []
  const userSkills = join(home, '.claude', 'skills')
  for (const name of safeReaddir(userSkills)) dirs.push([`real/${name}`, join(userSkills, name)])

  const cache = join(home, '.claude', 'plugins', 'cache')
  for (const marketplace of safeReaddir(cache)) {
    for (const plugin of safeReaddir(join(cache, marketplace))) {
      for (const version of safeReaddir(join(cache, marketplace, plugin))) {
        const skillsDir = join(cache, marketplace, plugin, version, 'skills')
        for (const name of safeReaddir(skillsDir)) dirs.push([`real/${plugin}:${name}`, join(skillsDir, name)])
      }
    }
  }

  const out = []
  for (const [label, dir] of dirs) {
    for (const file of ['SKILL.md', 'skill.md']) {
      const path = join(dir, file)
      try {
        if (!statSync(path).isFile()) continue
        out.push([label, readFileSync(path, 'utf8')])
        break
      } catch { /* next */ }
    }
  }
  return out
}

const client = new Anthropic() // picks up ANTHROPIC_API_KEY or an `ant auth login` profile

async function count (text) {
  const r = await client.messages.countTokens({ model: MODEL, messages: [{ role: 'user', content: text }] })
  return r.input_tokens
}

// count_tokens counts the whole request, so a fixed per-message wrapper cost is
// included. Measure it once and subtract, or short fixtures skew badly. This is
// also the auth smoke test — fail here with something actionable, not a stack.
let overhead
try {
  overhead = (await count('x')) - 1
} catch (err) {
  console.error(`calibration cannot reach count_tokens: ${err.message}\n`)
  console.error('Set ANTHROPIC_API_KEY, or run `ant auth login` (the zero-arg client picks up either).')
  process.exit(2)
}

const results = []
for (const [label, text] of [...SYNTHETIC, ...realFixtures()]) {
  const actual = (await count(text)) - overhead
  const { tokens: est, kind } = estimateTokens(text)
  const chars = [...text].length
  const error = (est - actual) / actual

  // Isolate the non-CJK population so a fixture with a few Chinese characters
  // does not drag its class's chars/token fit. Subtract what the CJK characters
  // are believed to cost; what remains is attributable to the rest.
  const sc = scriptCounts(text)
  const cjkTokens = sc.han * CJK_TOKENS_PER_CHAR.han +
    sc.kana * CJK_TOKENS_PER_CHAR.kana +
    sc.hangul * CJK_TOKENS_PER_CHAR.hangul
  const plainChars = chars - sc.cjk
  const plainTokens = actual - cjkTokens
  results.push({ label, kind, chars, actual, est, error, plainChars, plainTokens })
  console.log(
    `${label.padEnd(34)} ${kind.padEnd(6)} chars=${String(chars).padStart(7)} actual=${String(actual).padStart(6)}` +
    ` est=${String(est).padStart(6)} err=${(error * 100).toFixed(1).padStart(6)}%` +
    ` ${kind === 'cjk' ? `tok/char=${(actual / chars).toFixed(3)}` : `chars/tok=${(chars / actual).toFixed(2)}`}`
  )
}

// Suggested constants. The estimator must never UNDER-count, so take the
// worst-case observation per class (smallest chars/token, largest tokens/char)
// and add a 3% margin.
console.log('\n--- suggested constants ---')
for (const kind of ['prose', 'code', 'table']) {
  const rows = results.filter(r => r.kind === kind && r.plainTokens > 0)
  if (!rows.length) continue
  const worst = Math.min(...rows.map(r => r.plainChars / r.plainTokens))
  console.log(`RATIO.${kind.padEnd(6)} current=${RATIO[kind]}  worst observed chars/tok=${worst.toFixed(3)}  suggested=${(worst * 0.97).toFixed(2)}  (n=${rows.length})`)
}
// Per-script CJK rates. For each single-script fixture, attribute the ASCII
// characters at the prose divisor and credit the remainder to the CJK script:
//
//   rate = (actual - plainChars / RATIO.prose) / scriptChars
//
// Never read actual/chars directly off a mixed fixture — that blends the two
// populations and under-states the CJK rate. Take the worst (largest) rate per
// script so the shipped constant covers spaced and unspaced text alike.
const byScript = new Map()
for (const [label, script] of Object.entries(SINGLE_SCRIPT)) {
  const row = results.find(r => r.label === label)
  if (!row) continue
  const scriptChars = row.chars - row.plainChars
  if (!scriptChars) continue
  const rate = (row.actual - row.plainChars / RATIO.prose) / scriptChars
  const prev = byScript.get(script)
  if (!prev || rate > prev.rate) byScript.set(script, { rate, label })
  console.log(`  ${label.padEnd(20)} implied ${script} tok/char=${rate.toFixed(3)}`)
}
for (const [script, { rate, label }] of byScript) {
  console.log(
    `CJK_TOKENS_PER_CHAR.${script.padEnd(6)} current=${CJK_TOKENS_PER_CHAR[script]}` +
    `  worst observed tok/char=${rate.toFixed(3)} (${label})  suggested=${(rate * 1.03).toFixed(2)}`
  )
}

const under = results.filter(r => r.error < 0)
const worstOver = Math.max(...results.map(r => r.error))
console.log(`\n${results.length} fixtures | under-estimates: ${under.length} | worst over-estimate: ${(worstOver * 100).toFixed(1)}%`)
if (under.length) {
  console.log('UNDER-ESTIMATED (must be zero — see "Token estimation" in the README):')
  for (const r of under) console.log(`  ${r.label} ${(r.error * 100).toFixed(1)}%`)
}
process.exit(under.length ? 1 : 0)
