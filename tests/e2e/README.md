# End-to-end tests

This directory contains the end-to-end (e2e) suite for mux-frontend. These tests
exercise the critical wallet, account-abstraction, and payment paths against a
running stack.

## Running the suite

```bash
# from the repo root
pnpm test:e2e
```

See the root `README.md` for environment setup and required services.

## Flake triage process

E2e tests are the most flake-prone layer because they depend on RPC/Horizon,
network timing, and shared fixtures. Flakes must be triaged, not ignored.

### Invariants (fail-closed)

- A flaky test MUST NOT be silently skipped, `.skip`-ed, or deleted to make CI
  green. Skipping without a quarantine record is a review blocker.
- CI for this package stays **required**. Quarantining a test does not remove
  the required check; it only moves the test out of the blocking set.
- Every quarantined test MUST have an owner, a tracking issue, and an expiry.
  Quarantine without all three is invalid and must be reverted.
- Deny-by-default: only the roles below may quarantine or un-quarantine a test.

### Detection

A test is a flake candidate when it fails intermittently on the same commit
(passes on retry) or fails only in CI, not locally. Capture the failing run,
commit SHA, and a correlation id (the CI run id) in the tracking issue.

### Classification

| Class | Signal | Action |
| --- | --- | --- |
| Infra flake | RPC/Horizon/DB outage, timeout | Retry; if persistent, file infra issue |
| Test flake | Non-deterministic assertion, shared state, timing | Quarantine with owner + expiry |
| Product bug | Deterministic failure on the same commit | Do NOT quarantine; fix the bug |

### Quarantine

1. Open a tracking issue titled `flake: <test name>` with the correlation id
   (CI run id), commit SHA, and observed failure rate.
2. Assign an **owner** (the role that owns the affected path).
3. Add the test to the quarantine list with an **expiry** (default 14 days).
4. Keep the test running in a non-blocking job so it is still observed.

### Ownership and roles

- **Owner**: the engineer/team responsible for the affected path. Can request
  quarantine and is accountable for resolution before expiry.
- **Delegate**: a designated maintainer who can approve quarantine and
  un-quarantine on the owner's behalf.
- **Guardian**: security/availability reviewer who can veto a quarantine that
  would hide a money-path or authz failure, and can force un-quarantine.

New privileged surfaces (quarantine tooling, CI overrides) are deny-by-default
and require an explicit role grant.

### SLAs

- Triage a new flake within **1 business day** of detection.
- Resolve or renew a quarantine before its **expiry** (default 14 days).
- Expired quarantine with no resolution is escalated to the guardian and the
test is re-enabled (fail-closed) or the tracking issue is closed with a fix.

### Resolution workflow

1. Reproduce locally or via repeated CI runs using the correlation id.
2. Fix the root cause (test or product) and remove the quarantine entry.
3. Confirm the test passes on the required check before closing the issue.
4. If the flake was a product bug, link the fix PR and note the invariant it
   violated.

### Observability

- Flake reports MUST include a correlation id (CI run id) so runs can be
  traced end to end.
- Error messages must be actionable: name the test, the failing step, and the
  correlation id.
- Logs and metrics MUST NOT leak secrets, JWTs, API keys, or raw key material.
  Redact tokens and webhook secrets before logging.

## References

- `README.md`
- `docs/security-ux-guards.md`
