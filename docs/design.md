# Design invariants

These are not stylistic preferences. Violating any one of them makes the plugin worse than not having it.

## Fail open

Every error path — unparseable payload, unreadable file, corrupt config, unresolvable skill — produces empty stdout and exit 0, which the hook protocol reads as "no opinion." A guard that can crash into a block would make skills unusable. The test suite asserts this for malformed stdin, missing files, path-traversal names, and missing input fields.

The same principle shapes edge cases: a percent threshold in a session with no usable budget turns off rather than firing on everything, and a skill the resolver cannot find is allowed silently rather than blocked.

## Measure, never interpret

SKILL.md is untrusted content — it may come from any marketplace. It is opened, read as bytes, and counted. It is never evaluated, never passed to a shell, never interpolated into a command. `realpathSync` pins a single inode for the stat-then-read pair, which also resolves symlinked skill directories.

The skill *name* is also untrusted — it arrives from the tool call and is interpolated into a path. Containment is checked lexically, so a traversal sequence like `../../../../etc` is rejected before any filesystem access, while a legitimately symlinked skill directory (the common dotfiles pattern) still resolves.

## The hot path is cheap

No network calls. With an absolute (number) threshold the common case is a single `stat()`: if a file cannot reach the threshold even at the worst possible byte-to-token ratio (see [ESTIMATION.md](../ESTIMATION.md), "The fast path"), it is never read. A percent threshold — including the default — additionally pays the bounded 64KB transcript tail read (~1ms) to learn the window the percent is a share of.

Measured mean wall time is 25–31 ms per invocation, and node's cold start is essentially all of it — the guard's own work is 1–3 ms. If you want that back, the only lever is not spawning a process at all.

# Tests

```
npm test
```

100+ integration checks that drive the real hook binary with real payloads on stdin and assert on stdout — the contract under test is never mocked. Includes a timing loop so overhead regressions show up, and a manifest-consistency check so the three manifests (package.json, plugin.json, marketplace.json) cannot drift.

# Portability

Supported on macOS and Linux. Windows is not supported and not tested.

The implementation uses pure node with `node:path` joins throughout, no shell invocation, and no POSIX-only syscalls. The only external requirement is `node` on `PATH` for the hook command.
