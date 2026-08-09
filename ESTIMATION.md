# How the token estimate works

The guard has to decide whether a SKILL.md is expensive *before* it loads, in the
few milliseconds a `PreToolUse` hook is allowed. It cannot call an API to find
out. So it estimates, from the bytes on disk, and it is honest about the error
that estimating introduces.

This document is the whole method and its measured accuracy. If you want to
disagree with a number here, `scripts/calibrate.mjs` will re-derive all of them
against the real tokenizer.

## The method

Count characters, classify the content, divide by a chars-per-token divisor for
that class. That is the entire algorithm — see `hooks/estimate.mjs`, ~100 lines.

### Classification

Structural, not semantic. The file is scanned once for three signals:

| Class | Detected by | Divisor (chars per token) |
|---|---|---|
| `table` | 3 or more lines matching `^\|.*\|$` | 2.10 |
| `code` | 2 or more lines starting with ` ``` ` | 2.16 |
| `prose` | neither of the above | 2.33 |

**Code is less token-efficient than prose, not more.** Punctuation, operators and
indentation fragment into many short tokens, so code yields *fewer* characters
per token. Tables are worse still — delimiters and padding. Getting this
backwards is an easy and expensive mistake.

Only fenced code is recognized as code. A raw `.md` file that is mostly unfenced
source will be priced as prose, which over-estimates it. That is left alone on
purpose: detecting code by content would mean interpreting the file rather than
measuring it, and the error lands in the safe direction.

### CJK

Chinese, Japanese and Korean characters do not go through a chars-per-token
divisor at all — they are billed per character, at a rate that differs by script:

| Script | Unicode ranges | Tokens per character |
|---|---|---|
| Han | ideographs, CJK punctuation, full-width forms | 1.12 |
| Kana | hiragana, katakana, half-width katakana | 0.97 |
| Hangul | jamo, compatibility jamo, precomposed syllables | 1.34 |

Three rates, not one, because one cannot fit all three: a constant that covered
Hangul over-charged Japanese by 34%, and a constant that covered kana
under-charged Korean by 13%.

Hangul is the outlier because **word spacing costs real tokens**. The same Korean
text measures 1.111 tok/char written without spaces and 1.301 with them. Real
Korean is spaced, so the shipped constant follows the spaced figure.

Each script's characters are counted and billed separately, and the non-CJK
remainder is priced with its structural divisor. This matters more than it
sounds. An earlier version classified a *whole file* as CJK once CJK crossed a
share threshold, which priced a 3,519-character English skill containing one
Chinese example — 58 CJK characters, 1.6% of the file — at the Han rate, for a
**+180.3%** over-estimate. Billing per population has no such cliff: an all-CJK
file still prices as CJK, and a mostly-English file pays the CJK rate only on the
characters that earn it.

The three character classes are kept strictly disjoint so nothing is billed
twice. The full-width block `U+FF00–FFEF` contains half-width katakana at
`U+FF66–FF9D`, so the Han class is split around it.

### The fast path

Most skills are small and cannot possibly cross the threshold. For those the
guard never reads the file: one `stat()`, and if `ceil(size / 2.10)` is still
below the threshold it returns silently. It is a floor, so it can only over-state
a file's ceiling, never let an expensive one through.

2.10 bytes/token is the densest input the estimator can be handed, and it is
**ASCII, not CJK** — the minimum over every population priced above:

| Population | bytes/char | tokens/char | bytes/token |
|---|---|---|---|
| ASCII table | 1 | 1 / 2.10 | **2.10** |
| ASCII code | 1 | 1 / 2.16 | 2.16 |
| ASCII prose | 1 | 1 / 2.33 | 2.33 |
| Hangul (worst CJK) | 3 | 1.34 | 2.239 |
| Han | 3 | 1.12 | 2.679 |
| Kana | 3 | 0.97 | 3.093 |

CJK characters cost more tokens each, but they also cost three times the bytes,
and the bytes win. Deriving the floor from the CJK rates alone gave 2.239, which
is not a floor at all: a 33 KB ASCII table bounds to 14,740 tokens under it while
really costing 15,715, so it was declared unable to reach the default threshold
and never measured. That dead band ran from `warnThreshold` to roughly
`warnThreshold × 1.066` — sitting directly above every configured threshold.

The floor is computed from `RATIO` and `CJK_TOKENS_PER_CHAR` rather than written
down, so recalibrating either flows straight through and neither can silently
invalidate it again. The CJK term is not the binding one today; it becomes so
only if a CJK rate is ever recalibrated above `3 / 2.10 = 1.43`.

The bound holds for mixed-script files because the estimator prices each
population separately and sums them: if every population needs at least 2.10
bytes per token, so does any mixture.

The `ceil` is load-bearing. `estimateTokens` ends in `Math.ceil`, so a pure-ASCII
file can land up to one token above the raw quotient — a 33,000-byte table bounds
to 15,714.28 against a real 15,715. Rounding the bound up restores the strict
inequality, since `ceil(bound) >= ceil(exact) = tokens` unconditionally.

Setting `logPath` disables this fast path deliberately. A log that omits cheap
skills cannot tell you where your threshold belongs.

## Calibration

The constants are not guesses. They are fitted against
`POST /v1/messages/count_tokens` on `claude-opus-5` — the only authoritative
tokenizer for Claude.

```
npm install
ANTHROPIC_API_KEY=... npm run calibrate
```

Dev-time only. Nothing in the hook path makes a network call, and the SDK is a
devDependency — the constants ship as numeric literals. `calibrate.mjs` imports
the shipping estimator rather than a copy of it, so what is measured is what
runs. It exits 1 if any fixture is under-estimated, 2 if it cannot reach the API.

**`tiktoken` is not used and must not be.** It is OpenAI's tokenizer. It
undercounts Claude by 15–20%, and far more on code and non-English text — which
is precisely the content this estimate exists to price.

The fixture corpus is 77 files: 11 synthetic (five per-class ASCII/markdown
samples, three mixed-script CJK, three pure single-script CJK) plus **every real
SKILL.md on the machine** — 66 of them, from `~/.claude/skills` and the plugin
cache. Real skills are the distribution that matters; clean samples are only
there to isolate a single variable.

Each divisor is the *worst* value observed in its class, less a 3% margin. Each
CJK rate is the worst observed, plus 3%.

| Constant | Worst observed | Shipped | n |
|---|---|---|---|
| `RATIO.prose` | 2.403 chars/tok | 2.33 | 13 |
| `RATIO.code` | 2.223 chars/tok | 2.16 | 18 |
| `RATIO.table` | 2.162 chars/tok | 2.10 | 40 |
| `han` | 1.087 tok/char | 1.12 | — |
| `kana` | 0.941 tok/char | 0.97 | — |
| `hangul` | 1.301 tok/char | 1.34 | — |

## The drift, honestly

**The estimate is biased. It over-counts, on purpose, and by a wide margin on
some files.**

Measured 2026-08-05, all 77 fixtures:

- **Under-estimates: 0.** This is the release gate. The estimator is not allowed
  to tell you a skill is cheaper than it is.
- Real SKILL.md files (n=66), all over-estimates: **min +4.3%, median +23.3%,
  max +45.4%.** 35 of 66 land within +25%.
- Worst over-estimate across everything: **+54.4%**, on synthetic highly
  repetitive English prose — the most token-efficient text in the set, and not
  representative of a real skill.

Five largest real files:

| Skill | Chars | Actual tokens | Estimated | Error |
|---|---|---|---|---|
| `ce-code-review` | 90,117 | 32,362 | 42,913 | +32.6% |
| `ce-plan` | 71,507 | 24,769 | 33,116 | +33.7% |
| `ce-compound-refresh` | 46,837 | 15,335 | 22,299 | +45.4% |
| `ce-ideate` | 45,746 | 16,077 | 21,788 | +35.5% |
| `ce-compound` | 37,139 | 12,728 | 17,707 | +39.0% |

### Why the bias is there and not centered

Because the two failure modes are not symmetric.

An over-estimate costs you a permission prompt on a skill that was somewhat below
your threshold. Mildly annoying; you press approve.

An under-estimate lets an expensive skill load silently. You find out when the
window is full and answers start degrading, which is exactly the problem this
plugin exists to prevent, and by then it is too late — the body is in the context
for the rest of the session.

So the divisors are set to the worst-case content in each class, and the cost of
that choice is over-estimating the typical case.

### Why it cannot currently be tighter

One divisor per class, and real content within a class varies. Prose alone spans
roughly 2.4 to 3.6 chars/token across those 66 real files. A single divisor
pinned at 2.4 to protect the worst case necessarily over-estimates the efficient
end by 30–50%. There is no value that is both never-low and always-close.

The residual spread comes mostly from **mixed** files — a skill that is prose with
several fenced blocks and a couple of tables gets priced entirely at whichever
class its detector fired on. Per-segment pricing (bill fenced regions at the code
rate, table rows at the table rate, the rest at prose) would tighten the band
substantially and is the obvious next improvement. Accepting under-counts to
center the estimate is not on the table.

### What this means when you read a warning

The token figure in the prompt is an upper bound, not a measurement. Treat it as
"no more than this, probably 20–35% less." The percentage-of-window figure
inherits the same skew.

If the inflation bothers you in practice, raise `warnThreshold` rather than
hoping for a tighter estimate — and set `logPath` for a while first, so you pick
the new threshold from your own skills rather than from these numbers.

## Also not measured

- **CLI-bundled skills.** Their SKILL.md is embedded in the Claude Code binary;
  only resource subdirectories are unpacked to disk. There is nothing to stat, so
  the guard fails open and says nothing.
- **Files a skill reads after it loads.** What is measured is the SKILL.md body,
  because that is what gets injected on invoke. Progressive-disclosure reads are
  separate later tool calls with their own costs.
- **Value.** Size is not worth. A 40k-token skill may be exactly the right thing
  to load; only you know that. Hence `ask` by default, not `deny`.
