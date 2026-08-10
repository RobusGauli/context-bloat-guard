---
description: Show context-bloat-guard status — effective config, resolved thresholds and window, and the costliest installed skills
allowed-tools: Bash(node:*)
---

## context-bloat-guard status

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs" --status`

The report above was produced by the guard itself — if it printed at all, the
hook is installed and executable (node on PATH, guard.mjs runs).

Present the report to the user verbatim in a code block, then add at most one
short line calling out anything unusual: the guard disabled, a denyThreshold
active, or no config files present (defaults in effect).

One correction to apply first: the report's window may be resolved from a stale
`$ANTHROPIC_MODEL`. If the model named in the report's `window:` line is not
the model you are currently running as, re-run with your actual model id and
present that output instead:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs" --status --model <your-model-id>
```
