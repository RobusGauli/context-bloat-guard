# How the context window is detected

A percentage is only as good as its denominator, and a hardcoded `200000` was wrong for most sessions. This documents how `hooks/window.mjs` and the guard resolve the window a warning's percentage — and a percent threshold — is computed against.

## Resolution order

The window is resolved in this order — no network, and the only I/O is the bounded transcript-tail read in step 4:

1. **`contextWindowSize`** from your config, if you set a number. Taken verbatim, no buffer deducted — someone who set a number has already decided what the denominator is.
2. **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** — a hard cap set by the CLI.
3. **`CLAUDE_CODE_AUTO_COMPACT_WINDOW`** — the figure `/context` displays.
4. **The model's default window.** The active model is read from the transcript's tail (every assistant message is stamped with the model that produced it, so this survives a mid-session `/model` switch), falling back to `$ANTHROPIC_MODEL`. Models measured or documented as 1M-by-default (Fable 5, Sonnet 5, Opus 5/4.8/4.7) report their ceiling; 1M-capable models whose 1M is opt-in (Opus 4.6, Sonnet 4.6, Sonnet 4.5) report the 200k base tier unless the id carries the explicit `[1m]` suffix. Off-switches clamp everything to the base tier: `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, or `ANTHROPIC_BASE_URL` pointing at an LLM gateway (where the CLI can't verify 1M support — unless the `[1m]` variant is selected).

## The auto-compact buffer

Then the buffer comes off. The nominal window is not what a skill competes for: the CLI holds back a **flat 33k auto-compact reserve** regardless of window size — measured via `/context` (2026-08-10, CLI 2.1.226): a 200k window reports 167k available, a 1M sonnet-5 window reports 967k, the same 33k at both. Two env vars this plugin used to honour were measured to have no effect on the CLI's accounting and are no longer read: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (byte-identical output whether unset, 50, or 80) and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (not deducted from input-side accounting).

An explicitly configured `contextWindowSize` skips the buffer entirely and is used verbatim.

## Two things worth knowing about step 4

**A 1M ceiling is not a 1M default** — measured 2026-08-10 per model via `/context` (CLI 2.1.226): `opus-4-6`, `sonnet-4-6` and `sonnet-4-5` are all 1M-capable and all report 200k by default (opus-4-6 verified both headless and interactively), while `fable-5`, `sonnet-5`, `opus-5` and `opus-4-8` report 1M.

**`$ANTHROPIC_MODEL` lies after a `/model` switch** — it is stamped at session start; a live Fable 5 session was observed with `ANTHROPIC_MODEL=claude-sonnet-4-6` in its hook environment, a 5x window difference. That is why the transcript tail is the primary signal: a bounded 64KB read that only happens when a warning is actually being composed (or, with a percent threshold, once per measured invocation — the percent cannot be resolved without the window), failing open to the env var and then the base tier.

## Caveats

Every one of these variables is the CLI's private, undocumented surface — found by dumping a real hook process's environment, not from documentation. They can be renamed between versions, so every read is optional and falls through silently.

## The model window table

Per-model API ceilings live in `MODEL_WINDOWS` in `hooks/window.mjs`, generated — never hand-written — by:

```
ANTHROPIC_API_KEY=... npm run models
```

It reads `max_input_tokens` from `GET /v1/models` and prints the literal to paste in, so the constants always land in a reviewed diff. Don't write that table from memory — doing so got three of twelve rows wrong, including a 1M model recorded as 200k and two models that don't exist. A model absent from the table falls back safely to the 200k base tier.
