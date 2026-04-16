## Summary

<!-- One or two sentences: what this PR changes and why. -->

## Type of change

<!-- Mark with [x]. Must match the PR title's conventional-commits prefix. -->

- [ ] `feat` — new user-facing functionality
- [ ] `fix` — bug fix
- [ ] `refactor` — internal restructure, no behavior change
- [ ] `test` — tests only
- [ ] `docs` — documentation only
- [ ] `ci` — CI / tooling
- [ ] `chore` — everything else (deps, config, etc.)

## Checklist

- [ ] New production code ships with tests in this same PR (AGENTS.md → "Every new tool, worker, repository, and middleware ships with tests in the same commit").
- [ ] `npm run lint`, `npm run typecheck`, `npm run test:coverage` pass locally.
- [ ] Coverage stays above the gate (95 lines / 95 functions / 90 branches).
- [ ] No new runtime or dev dependencies — or, if there are, they were approved in a prior conversation and are reflected in `docs/ARCHITECTURE.md`.
- [ ] No schema change — or migration is added with a working `Down` section.

## Security checklist

<!-- Mirrors docs/SECURITY.md "Security checklist". Tick what applies. -->

- [ ] No `===` / `==` on credentials; `crypto.timingSafeEqual` used where needed.
- [ ] No secrets, tokens, or full keys in log output — prefixes only.
- [ ] `Origin` and `Host` validated for any new endpoint.
- [ ] Every new string input has Zod `.min()` / `.max()` bounds.
- [ ] All SQL is parameterized (`$1`, `$2` — never string concatenation).
- [ ] Rate limit applies to any new endpoint.
- [ ] URL-fetching tools call `assertPublicHostname()` before issuing requests.
- [ ] Tests cover missing, invalid, blacklisted, and deleted key paths where applicable.

## Notes for reviewer

<!-- Anything the reviewer needs to know: trade-offs, known limitations,
  follow-up work, or intentional deviations from docs/ conventions. -->
