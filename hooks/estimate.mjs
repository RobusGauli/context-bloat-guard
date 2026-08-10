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
// 77 fixtures (11 synthetic + 66 real SKILL.md files) — the corpus SYNTHETIC in
// scripts/calibrate.mjs actually holds, and the count README.md and
// ESTIMATION.md both record. Each divisor is the worst (smallest) chars/token
// observed in its class, less a 3% margin, so no fixture under-counts. The
// seeded values these replaced (3.8 / 3.2 / 2.9) under-counted 68 of 74 — that
// tally is against the 74-fixture corpus of the time, before the three pure
// single-script CJK samples were added — worst -36.7%.
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

// Fewest bytes any single token can be made of, across every population priced
// above. Dividing a file's byte size by this bounds its token count from above,
// which is what lets the guard skip reading small files entirely.
//
// Must be the MINIMUM over ALL populations, not just the CJK ones. Deriving it
// from CJK alone gave 3/1.34 = 2.239, but ASCII is denser: 1 byte/char at the
// table divisor is 2.10 bytes/token. Files between the two rates were declared
// unable to reach the threshold and never measured — a silent dead band sitting
// directly above every warnThreshold. CJK characters cost more tokens each, but
// they also cost 3x the bytes, and the bytes win.
//
// Keeping both terms makes this self-maintaining: recalibrating RATIO or
// CJK_TOKENS_PER_CHAR flows straight through, so neither can silently invalidate
// the floor again. The CJK term is not the binding one today — it only becomes
// so if a CJK rate is ever recalibrated above 3/2.10 = 1.43.
//
// The bound holds for mixed-script files because the estimator prices each
// population separately and sums them: if every population needs at least this
// many bytes per token, so does any mixture of them.
//
// NOTE: estimateTokens ends in Math.ceil, so a pure-ASCII file can land up to
// one token above size/FLOOR. Callers must ceil the bound before comparing —
// ceil(bound) >= ceil(exact) = tokens holds unconditionally.
export const BYTES_PER_TOKEN_FLOOR = Math.min(
  ...Object.values(RATIO),
  3 / Math.max(...Object.values(CJK_TOKENS_PER_CHAR)),
)

// Written as \u escapes, not literal characters: a literal class is unreadable
// in a diff and silently mis-orders (an early draft threw "Range out of order").
//
// The three classes must stay DISJOINT — every character billed exactly once, and
// the non-CJK remainder computed by subtraction. Note the full-width block is
// split around U+FF66-FF9D so half-width katakana lands in KANA, not HAN.
//
// Han ideographs, CJK punctuation, and full-width forms. Punctuation and
// full-width forms appear in all three scripts and tokenize near the Han rate.
//
// The astral ranges are not optional. Covering only the BMP left CJK Extension B
// and later (U+20000+) outside all three classes, so they fell into the non-CJK
// remainder and were priced at RATIO.prose: 100 such characters estimated 43
// tokens against ~112 real. Under-counting is the one failure mode this
// estimator exists to avoid, so the classes must span every assigned Han block.
//
// The `u` flag is required for the astral ranges to mean code points rather than
// surrogate halves, and is applied to all three so `[...text].length` and the
// match counts agree on what one character is.
const HAN = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFF65\uFF9E-\uFFEF\u{20000}-\u{2FA1F}\u{30000}-\u{323AF}]/gu
// Hiragana, katakana, katakana phonetic extensions, half-width katakana.
const KANA = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/gu
// Conjoining jamo, compatibility jamo, precomposed syllables.
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/gu

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
