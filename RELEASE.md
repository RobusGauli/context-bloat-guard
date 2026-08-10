# Releasing a new version

Releases are automated. A release is a **version bump merged to `main`** — everything after that is machinery.

## The short version

1. On your feature branch, bump the version in **both** manifests:
   - `.claude-plugin/plugin.json` — the source of truth
   - `package.json` — restates it only because npm requires the field
2. `npm test` — the manifest check fails the suite if the two disagree, or if `marketplace.json` grew a version field or a drifted description.
3. Open a PR, merge to `main`.
4. Done. The [`release` workflow](.github/workflows/release.yml) runs the test suite, tags `vX.Y.Z` at the merge commit, and publishes a [GitHub Release](https://github.com/RobusGauli/context-bloat-guard/releases) with notes generated from the merged PRs since the previous tag.

There is no publish step beyond the merge. Claude Code never reads tags or releases — `/plugin update` pulls the default branch and reads `plugin.json` — so users get the new version the moment it lands on `main`. The release exists so they can see **what changed before they update**.

## Picking the number

Semver, honestly applied:

| Bump | When |
|---|---|
| **patch** | Fixes and doc corrections. No behavior change under default config. |
| **minor** | New capability, config keys gaining forms, **default behavior changes** (e.g. 1.3.0 changed the default `warnThreshold` from `15000` to `"7%"`). Call out a behavior change loudly in the PR body — it becomes the release notes. |
| **major** | A config that worked before now means something else, or a documented invariant (fail-open, measure-never-interpret) changes shape. None so far; think hard before the first one. |

## What makes good release notes

The workflow uses `--generate-notes`, which lists merged PR titles. That means **the PR title and body are the changelog** — write them for the user deciding whether to update, not for the reviewer:

- Lead with what changes for a default, no-config user.
- A behavior change gets an explicit opt-out line (e.g. *"set `"warnThreshold": 15000` to keep the old behavior"*).
- One PR per release is the norm here; if several PRs ship in one bump, the version-bump PR's body should summarize.

To replace generated notes with hand-written ones after the fact:

```
gh release edit vX.Y.Z --notes "…"
```

## Failure modes

- **Workflow didn't fire.** It triggers only on pushes to `main` that touch `.claude-plugin/plugin.json`. A merge that bumps only `package.json` won't trigger — and won't pass `npm test` either, so this shouldn't survive review.
- **Tests fail in the workflow.** No tag, no release. Fix on `main`; the next push touching `plugin.json` retries.
- **Tag already exists.** The workflow is idempotent — it exits cleanly without touching the existing release. A re-run or a doc-only edit to `plugin.json` releases nothing.
- **Release needed by hand** (backfill, workflow outage):

  ```
  git tag -a vX.Y.Z <commit> -m "context-bloat-guard X.Y.Z"
  git push origin vX.Y.Z
  gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
  ```

## History

v1.0.0–v1.3.0 were tagged and released retroactively (2026-08-10) at their merge commits, with hand-written notes. Every version from 1.4.0 onward should come from the workflow.
