# Flake Triage Process

This document defines how the Mux Dashboard team detects, classifies,
quarantines, and resolves flaky tests. It exists so that a flaky test can
never be silently skipped, and so that every quarantine has an owner, a
tracking issue, and an expiry.

## Invariants (fail-closed)

1. **No silent skips.** A flaky test must never be disabled with a bare
   `skip`/`todo`/`only` or commented out. The only sanctioned way to
   neutralize a flaky test is a *quarantine* (see below), which is
   tracked, owned, and time-boxed.
2. **Quarantine requires an owner, a tracking issue, and an expiry.** A
   quarantine entry missing any of the three is invalid and must be
   reverted.
3. **CI stays required for the package.** Quarantining a test does not
   remove the required CI check for the package. The check must remain
   green; a quarantined test is reported as a known-flake, not as a pass
   that hides a real failure.
4. **Deny-by-default for new privileged surfaces.** Any new mechanism
   that can disable, skip, or bypass a test is privileged and denied by
   default until it is documented here and reviewed.

## Detection

Flakes are surfaced by:

- CI runs that fail on a test which passes on re-run without a code
  change.
- Repeated failures of the same test across unrelated PRs.
- Local runs that fail intermittently for a contributor.

When a flake is suspected, open a flake report (see *Reporting* below)
before touching the test.

## Classification

Classify the flake before acting:

| Class | Signal | Action |
| --- | --- | --- |
| **Timing / async** | Fails under load, passes in isolation | Quarantine + fix race |
| **Order dependence** | Fails only in full-suite runs | Quarantine + isolate state |
| **Environment** | Fails only on CI or only locally | Quarantine + pin env |
| **External dependency** | RPC/Horizon/DB outage | Fail-closed; do not quarantine as flake |
| **Genuine bug** | Reproducible failure | Fix the code, not the test |

External-dependency failures are **not** flakes. Writes must fail closed
when a dependency is unavailable; do not mask an outage by quarantining a
test.

## Quarantine

A quarantine is the only sanctioned way to neutralize a flaky test. Each
quarantine entry must record:

- **Owner** — a named maintainer responsible for resolution.
- **Tracking issue** — a link to the issue that will resolve the flake.
- **Expiry** — a date by which the quarantine must be resolved or
  renewed with justification.

Quarantines are recorded in the test file next to the affected test and
in the tracking issue. When the expiry passes without resolution, the
quarantine is invalid and the test must be re-enabled or the tracking
issue escalated.

## Ownership and roles

Quarantine and un-quarantine are privileged actions:

- **Owner** — the maintainer who owns the affected package. May
  quarantine and un-quarantine tests in that package.
- **Delegate** — a contributor explicitly delegated by an owner for a
  specific tracking issue. May act only within that issue's scope.
- **Guardian** — a maintainer with cross-package authority. May override
  or revoke any quarantine.

Any actor without one of these roles is denied by default. A revoked or
expired delegate loses access immediately.

## SLAs

| Stage | SLA |
| --- | --- |
| Flake report acknowledged | 2 business days |
| Quarantine opened with owner + issue + expiry | 3 business days |
| Quarantine resolved or renewed | by expiry (default 30 days) |
| Escalation to guardian on missed expiry | 1 business day after expiry |

## Resolution workflow

1. **Report** the flake with a correlation id (see *Observability*).
2. **Classify** it using the table above.
3. **Quarantine** if it cannot be fixed immediately — with owner,
   tracking issue, and expiry.
4. **Fix** the root cause; do not weaken assertions to make it pass.
5. **Un-quarantine** once the test is stable across repeated CI runs.
6. **Close** the tracking issue and remove the quarantine entry.

## Observability

- Flake reports carry a **correlation id** so a report can be traced
  across CI runs and the tracking issue.
- Error messages must be **actionable**: name the test, the class, and
  the next step.
- Metrics and logs must **never leak secrets** — no API keys, JWTs,
  webhook secrets, or raw key material. Redact credentials before
  logging.

## References

- `README.md`
- `docs/security-ux-guards.md`
- `tests/e2e/`
