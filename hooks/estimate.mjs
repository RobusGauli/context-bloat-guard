// Token estimator. Lives in its own module so scripts/calibrate.mjs measures the
// exact code the hook runs, not a copy that can drift from it.
//
// No imports, no side effects: importing this must stay free on the hot path.

// Chars-per-token divisors, biased to OVER-estimate (under-estimating is the
// failure mode that hurts the user — they find out by degrading, too late).
// Note code is LESS efficient than prose, not more: punctuation and
// indentation fragment into many short tokens.
// Calibrate with scripts/calibrate.mjs; do not hand-tune.
//
// Measured 2026-08-05 against POST /v1/messages/count_tokens on claude-opus-5:
// 74 fixtures (8 synthetic + 66 real SKILL.md files). Each divisor is the worst
// (smallest) chars/token observed in its class, less a 3% margin, so no fixture
// under-counts. The seeded values these replaced (3.8 / 3.2 / 2.9) under-counted
// 68 of 74 fixtures, worst -36.7%.
export const RATIO = {
  prose: 2.33,
  code: 2.16,
  table: 2.10,
}
// Tokens per character, by script: the worst rate solved from any single-script
// fixture, plus a 3% margin. One shared constant could not fit all three — the
// measured rates span 0.94 (kana) to 1.30 (spaced Hangul), and a value tuned for
// one under-counted the others.
//
// Hangul is the outlier because word spacing costs real tokens: the same Korean
// text measures 1.11 tok/char unspaced and 1.30 spaced. Real Korean is spaced, so
// the constant follows the spaced figure.
export const CJK_TOKENS_PER_CHAR = {
  han: 1.12,
  kana: 0.97,
  hangul: 1.34,
}

// Upper bound on tokens for any UTF-8 input: worst realistic case is the densest
// script above at 3 bytes/char. Used to skip reading the file at all.
export const BYTES_PER_TOKEN_FLOOR = 3 / Math.max(...Object.values(CJK_TOKENS_PER_CHAR))

// Written as \u escapes, not literal characters: a literal class is unreadable
// in a diff and silently mis-orders (an early draft threw "Range out of order").
//
// The three classes must stay DISJOINT — every character billed exactly once, and
// the non-CJK remainder computed by subtraction. Note the full-width block is
// split around U+FF66-FF9D so half-width katakana lands in KANA, not HAN.
//
// Han ideographs, CJK punctuation, and full-width forms. Punctuation and
// full-width forms appear in all three scripts and tokenize near the Han rate.
const HAN = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFF65\uFF9E-\uFFEF]/g
// Hiragana, katakana, katakana phonetic extensions, half-width katakana.
const KANA = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/g
// Conjoining jamo, compatibility jamo, precomposed syllables.
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/g

// A file is *labelled* cjk only when CJK is the bulk of it. The label drives
// reporting and per-class calibration, never the arithmetic — see below.
const CJK_DOMINANT = 0.5

// Structural shape of the non-CJK remainder.
function structuralKind (text) {
  if ((text.match(/^\|.*\|$/gm) || []).length >= 3) return 'table'
  if ((text.match(/^```/gm) || []).length >= 2) return 'code'
  return 'prose'
}

// Per-script character counts. Ranges are disjoint, so no character is billed
// twice and the remainder is exactly the non-CJK population.
export function scriptCounts (text) {
  const han = (text.match(HAN) || []).length
  const kana = (text.match(KANA) || []).length
  const hangul = (text.match(HANGUL) || []).length
  return { han, kana, hangul, cjk: han + kana + hangul }
}

export function classify (text) {
  const chars = [...text].length
  if (!chars) return 'prose'
  if (scriptCounts(text).cjk / chars > CJK_DOMINANT) return 'cjk'
  return structuralKind(text)
}

export function estimateTokens (text) {
  // Count code points, not UTF-16 units, or astral chars double-count.
  const chars = [...text].length
  if (!chars) return { tokens: 0, kind: 'prose' }
  const { han, kana, hangul, cjk } = scriptCounts(text)
  const kind = cjk / chars > CJK_DOMINANT ? 'cjk' : structuralKind(text)

  // Price each population separately and add. Treating one CJK character as
  // proof the whole file is CJK over-charged an English skill containing a
  // single Chinese example by 180% (measured; see Appendix A). A share-weighted
  // sum has no such cliff: an all-CJK file still prices as pure CJK, and a
  // mostly-English file pays the CJK rate only on the characters that earn it.
  const tokens = Math.ceil(
    han * CJK_TOKENS_PER_CHAR.han +
    kana * CJK_TOKENS_PER_CHAR.kana +
    hangul * CJK_TOKENS_PER_CHAR.hangul +
    (chars - cjk) / RATIO[kind === 'cjk' ? 'prose' : kind]
  )
  return { tokens, kind }
}
