# 0025. Publish from CI with trusted publishing and provenance, starting at 1.0.0

- **Status:** Proposed
- **Date:** 2026-11-08
- **Milestone:** 5

## Context

The package goes on npm for the first time in milestone 5. Publishing from a laptop needs a long-lived npm token or an interactive login there, and nothing ties the published tarball to a commit: a reader of the npm page has to trust that `dist/` was built from what's on GitHub, with the tests passing. Most supply chain attacks on npm packages come from a stolen publish token or a tarball that differs from its source.

## Decision

- **`.github/workflows/release.yml` publishes when a `v*` tag is pushed, and only then.** It runs CI's whole workflow (`ci.yml`, as a reusable workflow) on the tagged commit first, the Docker stack checks included. The publish job waits for all of it.
- **It refuses a tag that doesn't name exactly the version in `package.json`** (`v1.0.0` for `1.0.0`), with `scripts/check-release-tag.ts`. It also refuses a prerelease version, since it publishes to the `latest` dist-tag, and a tagged commit that isn't on `main`.
- **Trusted publishing, with no npm token anywhere.** npm trusts this repository's `release.yml`, run in the `npm` GitHub environment, and nothing else. The job gets a short-lived OIDC token from GitHub (`id-token: write`, on the publish job only) and npm exchanges it for a publish. The `npm` environment only accepts deployments from `v*` tags, so a branch can't publish even by editing the workflow.
- **Provenance comes with it.** Publishing through OIDC from a public repository makes npm attach a signed provenance statement on its own: which commit, which workflow and which run built the tarball. The npm page shows it, and `npm audit signatures` checks it.
- **Node 24 publishes.** Trusted publishing needs npm 11.5.1 or later, and Node 22 ships npm 10. The job checks npm's version before it tries.
- **The first version is 1.0.0.** The API was reviewed for 1.0 in T3, every export is listed and checked against `dist/`, and nothing was ever published as 0.x, so there are no users to break. Starting at 1.0.0 says the API is meant to be stable, and semver then protects anyone who installs it.
- **A placeholder creates the package by hand.** npm sets up a trusted publisher in an existing package's settings, so `0.0.0-placeholder.0`, an empty package, is published once from a laptop under the `placeholder` dist-tag, then deprecated. Every real version comes from CI.
- **No GitHub Release.** `CHANGELOG.md` ships in the package and is on GitHub. A release page would only repeat it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Publish by hand with `npm publish` | Needs a login or token on a laptop, runs whatever is in the working tree, and gives no provenance. |
| An npm automation token in a GitHub secret | A long-lived secret that can publish from anywhere if it leaks. Trusted publishing replaces it. |
| Publish 1.0.0 by hand, then CI from 1.0.1 | 1.0.0, the version most people see first, would have no provenance. The placeholder costs one throwaway version instead. |
| Publish on every push to `main` (semantic-release, changesets) | More machinery than a solo project needs, and every release should be a decision, not a side effect of a merge. |
| Start at 0.1.0 | Semver gives 0.x no compatibility promise, and the API is already reviewed and locked down by tests. |
| A GitHub Release per tag | It would repeat the changelog, with one more thing to keep in step. |

## Evidence

Proposed until 1.0.0 is published. What will prove it, in T4:

- The release run for `v1.0.0` passes every CI job before the publish job starts.
- npm shows provenance for 1.0.0, linked to the tagged commit and the release run, and `npm audit signatures` verifies it.
- The workflow and repository hold no npm token.
- `scripts/check-release-tag.ts` has unit tests for matching, mismatched and prerelease tags.

## Consequences

- Releasing is: bump `version`, date the changelog, commit, tag `vX.Y.Z` on `main`, push the tag. A wrong tag fails before anything is published.
- A release takes as long as CI with the stack checks, about 10 minutes.
- The trusted publisher's settings on npmjs.com must match exactly: owner `Fours`, repository `rate-limiter`, workflow `release.yml`, environment `npm`. Renaming any of them stops publishing until it's set up again.
- Prereleases need a change to the workflow first, to publish them under another dist-tag.
- The `0.0.0-placeholder.0` version stays on npm, deprecated, and never under `latest`, so nobody installs it by accident.
