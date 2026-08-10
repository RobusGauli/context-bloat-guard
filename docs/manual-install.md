# Installing the hook by hand

The plugin route (`/plugin marketplace add` + `/plugin install`) is the supported path. If you'd rather wire the hook directly — e.g. to run from a clone you hack on — add this to `~/.claude/settings.json`:

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

Replace `<path-to-repo>` with the absolute path to your clone. Everything else — config file location, thresholds, behavior — is identical to the plugin install.

One difference worth knowing: without `CLAUDE_PLUGIN_ROOT` (which only a plugin install sets), the guard cannot resolve skills that live under the plugin's own `skills/` directory. User (`~/.claude/skills`), project (`.claude/skills`), and marketplace plugin-cache skills all still resolve.
