# context-bloat-guard

A Claude Code plugin that tells you what a skill costs **before** its body lands in your context window — and offers you the cheaper option.

## The problem

Only a skill's frontmatter `description` is preloaded. The moment you invoke it, the **entire SKILL.md body is injected into the main-loop context and stays there for the rest of the session.** Some real skills in the wild are 90 KB. One of them measures 32,362 tokens — 16% of a 200k window — spent silently, before any work happens.

There is no built-in signal for this. You find out when the session starts degrading.

## What it does

A `PreToolUse` hook on the `Skill` tool measures the SKILL.md that is about to load. Under the threshold it says nothing. Over it, you get a permission prompt:

```
Skill "compound-engineering:ce-code-review" will inject ~42,900 tokens = 26% of
your 167k usable context (200k window, less the auto-compact buffer) into
this context, permanently for the rest of the session.

Cheaper alternative: delegate it. Spawn a subagent (Agent tool) that invokes
this skill in its own isolated context and returns only the conclusion — the
main window pays for the summary, not the whole SKILL.md.

Approve to load it inline anyway.
```

Approve and it loads as normal. Decline and the delegation route is already in front of the model.

## Install

Add the plugin's repository as a marketplace, then install:

```
/plugin marketplace add RobusGauli/context-bloat-guard
/plugin install context-bloat-guard
```

To use a local clone instead:

```
/plugin marketplace add /path/to/context-bloat-guard
/plugin install context-bloat-guard
```

Alternatively, add the hook directly to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "timeout": 5,
            "command": "node \"<path-to-repo>/hooks/guard.mjs\""
          }
        ]
      }
    ]
  }
}
```

Requires `node` on `PATH` (any version with ESM — v14+). No other dependencies at runtime; nothing is installed into your project.

## Configuration

Optional. `~/.claude/context-bloat-guard.json`, all keys optional:

```json
{
  "enabled": true,
  "warnThreshold": "9%",
  "denyThreshold": null,
  "contextWindowSize": null,
  "alwaysAllow": ["my-big-but-essential-skill"],
  "logPath": null
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master off switch. |
| `warnThreshold` | `15000` | Cost at or above which you get asked. A number is absolute tokens; a string like `"9%"` is a share of the usable budget, resolved against the live window each invocation. Set `null` to turn the prompt off entirely — a `denyThreshold`, if set, still applies. |
| `denyThreshold` | `null` | Cost at or above which the load is refused outright — same two forms as `warnThreshold`. Off by default — see below. |
| `contextWindowSize` | `null` | Only used to express the cost as a percentage. `null` detects it from the environment — see below. Set a number to override, and it is used verbatim with no buffer deducted. |
| `alwaysAllow` | `[]` | Skill names to never prompt on. Use the invoked name, including any `plugin:skill` prefix. |
| `logPath` | `null` | Opt-in JSONL of every skill invocation, for tuning your own threshold. `~` is expanded. Setting it disables the stat-only fast path — cheap skills get read and recorded too, otherwise the log couldn't tell you where your threshold belongs. |

**Why percent thresholds exist.** Windows differ 5x by model: 15,000 tokens is 9% of a 200k window's usable budget but 1.5% of a 1M one, so a fixed number either nags a 1M session or under-protects a 200k one. `"9%"` means the same *share* everywhere. Only the `"N%"` string form is accepted (0 < N ≤ 100) — a bare fraction like `0.09` would be indistinguishable from a token count. One trade-off: resolving a percent requires the window *before* the decision, so the bounded 64KB transcript read (see below) runs on every measured invocation rather than only when a warning fires. If the detected window has no usable budget at all (capped below the auto-compact reserve), a percent threshold turns off rather than firing on everything — fail open, as everywhere else.

A missing or corrupt config file is not an error — defaults apply. So is an
individual value of the wrong type: a threshold set to a malformed string, a negative
number, or an object falls back to its default rather than reaching a comparison.

Set `CCG_CONFIG` to point at a different config path (used by the test suite).

### How the window is detected

A percentage is only as good as its denominator, and a hardcoded `200000` was wrong for most sessions. `hooks/window.mjs` resolves it in this order, all from environment variables — no I/O, no network, nothing that could slow the hot path:

1. **`contextWindowSize`** from your config, if you set a number. Taken verbatim.
2. **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** — a hard cap set by the CLI.
3. **`CLAUDE_CODE_AUTO_COMPACT_WINDOW`** — the figure `/context` displays.
4. **The model's default window.** The active model is read from the transcript's tail (every assistant message is stamped with the model that produced it, so this survives a mid-session `/model` switch), falling back to `$ANTHROPIC_MODEL`. Models measured or documented as 1M-by-default (Fable 5, Sonnet 5, Opus 5/4.8/4.7) report their ceiling; 1M-capable models whose 1M is opt-in (Opus 4.6, Sonnet 4.6, Sonnet 4.5) report the 200k base tier unless the id carries the explicit `[1m]` suffix. Off-switches clamp everything to the base tier: `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, or `ANTHROPIC_BASE_URL` pointing at an LLM gateway (where the CLI can't verify 1M support — unless the `[1m]` variant is selected).

Then the buffer comes off. The nominal window is not what a skill competes for: the CLI holds back a **flat 33k auto-compact reserve** regardless of window size — measured via `/context` (2026-08-10, CLI 2.1.226): a 200k window reports 167k available, a 1M sonnet-5 window reports 967k, the same 33k at both. Two env vars this plugin used to honour were measured to have no effect on the CLI's accounting and are no longer read: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (byte-identical output whether unset, 50, or 80) and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (not deducted from input-side accounting).

Two things worth knowing about step 4. **A 1M ceiling is not a 1M default** — measured 2026-08-10 per model via `/context` (CLI 2.1.226): `opus-4-6`, `sonnet-4-6` and `sonnet-4-5` are all 1M-capable and all report 200k by default (opus-4-6 verified both headless and interactively), while `fable-5`, `sonnet-5`, `opus-5` and `opus-4-8` report 1M. And **`$ANTHROPIC_MODEL` lies after a `/model` switch** — it is stamped at session start; a live Fable 5 session was observed with `ANTHROPIC_MODEL=claude-sonnet-4-6` in its hook environment, a 5x window difference. That is why the transcript tail is the primary signal: a bounded 64KB read that only happens when a warning is actually being composed (or, with a percent threshold, once per measured invocation — the percent cannot be resolved without the window), failing open to the env var and then the base tier.

Every one of these variables is the CLI's private, undocumented surface — found by dumping a real hook process's environment, not from documentation. They can be renamed between versions, so every read is optional and falls through silently.

### `ask` vs `deny`

The default is `ask`, not `deny`, on purpose. The guard measures **size**, not **value** — a 40k-token skill may be exactly the right thing to load. Only you know that. `deny` removes your ability to say yes, and a hard block on a judgment call is worse than a prompt. `denyThreshold` exists for the case where you have decided in advance that some size is never acceptable; it ships off.

## Design invariants

These are not stylistic preferences. Violating any one of them makes the plugin worse than not having it.

**Fail open.** Every error path — unparseable payload, unreadable file, corrupt config, unresolvable skill — produces empty stdout and exit 0, which the hook protocol reads as "no opinion." A guard that can crash into a block would make skills unusable. The test suite asserts this for malformed stdin, missing files, path-traversal names, and missing input fields.

**Measure, never interpret.** SKILL.md is untrusted content — it may come from any marketplace. It is opened, read as bytes, and counted. It is never evaluated, never passed to a shell, never interpolated into a command. `realpathSync` pins a single inode for the stat-then-read pair, which also resolves symlinked skill directories.

**The hot path is cheap.** No network calls. No transcript parsing. The common case is a single `stat()`: if a file cannot reach the threshold even at the worst possible byte-to-token ratio (3 bytes/token, i.e. dense CJK), it is never read. Measured mean wall time is 25–31 ms per invocation, and node's cold start is essentially all of it — the guard's own work is 1–3 ms. If you want that back, the only lever is not spawning a process at all.

## Token estimation

Heuristic, deliberately biased to **over**-estimate. Under-estimating is the failure mode that hurts: you get told a skill is cheap, and find out otherwise by degrading.

Content is classified — CJK, table, code, prose — and each class gets its own divisor, because they tokenize very differently. Note that **code is less token-efficient than prose**, not more: punctuation and indentation fragment into many short tokens.

`scripts/calibrate.mjs` validates and tunes those constants against `POST /v1/messages/count_tokens`, the only authoritative tokenizer for Claude. It imports the shipping estimator directly, so the calibrated code is the running code. Fixtures are synthetic per-class samples **plus every real SKILL.md on the machine**, since real skills are the distribution that matters. It exits non-zero if any fixture is under-estimated.

```
npm install
ANTHROPIC_API_KEY=... npm run calibrate
```

Dev-only — it makes network calls and is never reachable from the hook. `tiktoken` is not used and must not be: it is OpenAI's tokenizer and undercounts Claude by 15–20%, worse on code.

Calibrated 2026-08-05 against 77 fixtures (11 synthetic, 66 real SKILL.md files). Zero under-estimates; real files over-estimated +4.3% to +45.4%, median +23.3%.

`scripts/models.mjs` is the same idea for the model window table in `hooks/window.mjs`: it reads `max_input_tokens` from `GET /v1/models` and prints the literal to paste in, so the constants always land in a reviewed diff.

```
ANTHROPIC_API_KEY=... npm run models
```

Also dev-only. Don't hand-write that table — writing it from memory got three of twelve rows wrong, including a 1M model recorded as 200k and two models that don't exist.

The estimate is an upper bound, not a measurement, and the inflation is deliberate. **[ESTIMATION.md](ESTIMATION.md)** documents the whole method, every constant with the measurement it came from, and the drift honestly — read that before trusting a number in a warning.

## What it cannot measure

- **CLI-bundled skills** (`claude-api`, etc.). Their SKILL.md is embedded in the Claude Code binary; only their resource subdirectories are unpacked to disk. Nothing to stat, so the guard fails open.
- **Files a skill reads after loading.** The hook measures the SKILL.md body, which is what gets injected on invoke. Progressive-disclosure reads that happen later are separate tool calls with their own costs.
- **Value.** See "ask vs deny."

## Tests

```
npm test
```

100+ integration checks that drive the real hook binary with real payloads on stdin and assert on stdout — the contract under test is never mocked. Includes a timing loop so overhead regressions show up.

## Portability

Supported on macOS and Linux. Windows is not supported and not tested.

The implementation uses pure node with `node:path` joins throughout, no shell invocation, and no POSIX-only syscalls. The only external requirement is `node` on `PATH` for the hook command.

## License

MIT
