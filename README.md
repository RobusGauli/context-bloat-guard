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

Requires `node` on `PATH` (any version with ESM — v14+). No other dependencies at runtime; nothing is installed into your project. macOS and Linux; Windows is not supported. (Installing the hook by hand instead of as a plugin is covered in [docs/manual-install.md](docs/manual-install.md).)

## Configuration

Optional. `~/.claude/context-bloat-guard.json`, all keys optional:

```json
{
  "enabled": true,
  "warnThreshold": "7%",
  "denyThreshold": null,
  "contextWindowSize": null,
  "alwaysAllow": ["my-big-but-essential-skill"],
  "logPath": null
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master off switch. |
| `warnThreshold` | `"7%"` | Cost at or above which you get asked. A string like `"7%"` is a share of the usable budget, resolved against the live window each invocation (~11.7k tokens at the 200k base tier, ~67.7k at 1M); a number is absolute tokens. Set `null` to turn the prompt off entirely — a `denyThreshold`, if set, still applies. |
| `denyThreshold` | `null` | Cost at or above which the load is refused outright — same two forms as `warnThreshold`. Off by default — see below. |
| `contextWindowSize` | `null` | Only used to express the cost as a percentage. `null` detects it from the environment — see below. Set a number to override, and it is used verbatim with no buffer deducted. |
| `alwaysAllow` | `[]` | Skill names to never prompt on. Use the invoked name, including any `plugin:skill` prefix. |
| `logPath` | `null` | Opt-in JSONL of every skill invocation, for tuning your own threshold. `~` is expanded. Setting it disables the stat-only fast path — cheap skills get read and recorded too, otherwise the log couldn't tell you where your threshold belongs. |

The default threshold is a *percent* because windows differ 5x by model: a fixed token count either nags a 1M session or under-protects a 200k one, while `"7%"` means the same share everywhere. Malformed values never bite: a bad string, negative number, or wrong type falls back to its default, and a missing or corrupt config file just means defaults apply. Set `CCG_CONFIG` to point at a different config path.

### How the window is detected

The denominator behind every percentage — and every percent threshold — is resolved per session: explicit config first, then the CLI's own env vars, then the active model's default window (read from the transcript's tail, so it survives a mid-session `/model` switch), less the CLI's flat 33k auto-compact reserve. Every constant in that chain was measured against a live CLI, not copied from docs. The full resolution order, the measurements, and the caveats: **[docs/window-detection.md](docs/window-detection.md)**.

### `ask` vs `deny`

The default is `ask`, not `deny`, on purpose. The guard measures **size**, not **value** — a 40k-token skill may be exactly the right thing to load. Only you know that. `deny` removes your ability to say yes, and a hard block on a judgment call is worse than a prompt. `denyThreshold` exists for the case where you have decided in advance that some size is never acceptable; it ships off.

## Token estimation

Heuristic, deliberately biased to **over**-estimate — under-estimating is the failure mode that hurts, because you'd find out the truth by degrading. Content is classified (CJK, table, code, prose), each class priced at a divisor calibrated against `POST /v1/messages/count_tokens`, the only authoritative tokenizer for Claude. Zero under-estimates across the 77-fixture calibration corpus; real files over-estimate +4% to +45%, median +23%. Treat the number in a warning as an upper bound.

The whole method, every constant with the measurement it came from, and the drift honestly: **[ESTIMATION.md](ESTIMATION.md)**.

## What it cannot measure

- **CLI-bundled skills** (`claude-api`, etc.). Their SKILL.md is embedded in the Claude Code binary; only their resource subdirectories are unpacked to disk. Nothing to stat, so the guard fails open.
- **Files a skill reads after loading.** The hook measures the SKILL.md body, which is what gets injected on invoke. Progressive-disclosure reads that happen later are separate tool calls with their own costs.
- **Value.** See "ask vs deny."

## Design

Three invariants — fail open, measure never interpret, cheap hot path — govern every line; violating any one makes the plugin worse than not having it. Details, plus the test suite and portability notes: **[docs/design.md](docs/design.md)**.

## Releases

Every version bump on `main` is tagged and published to [GitHub Releases](https://github.com/RobusGauli/context-bloat-guard/releases) automatically — check there before `/plugin update` to see what changed. Cutting a release: [RELEASE.md](RELEASE.md).

## License

MIT
