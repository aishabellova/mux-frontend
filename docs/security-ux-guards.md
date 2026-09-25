# Security & UX Guards — Issues #701–704, #757, #758, #759, #834

This document covers security and UX correctness fixes shipped together.
Each section describes the failure mode, what was fixed, and what the
automated tests verify.

---

## #834 Archive restore confirmations

**Scope:** archive restore confirmation flow in `mux-frontend`  
**Related:** `README.md`, `docs/security-ux-guards.md`, `tests/e2e/`

### Failure mode

Restoring an archived account/wallet is a privileged, money-path action:
it can re-enable spends, recovery, and admin surfaces that were previously
frozen. If restore confirmations are not authorized, not idempotent, or not
fail-closed, an attacker (or a replayed/duplicated request) can resurrect an
archived account, double-apply a restore, or complete a restore against a
stale/outage backend and assume success. This is an account-takeover and
availability gap, so the invariants below are **requirements**, not
suggestions.

### Restore confirmation invariants

- **Server is the source of truth.** The frontend never marks an archive as
  restored locally; it only reflects the server's confirmed state after a
  successful, authorized confirmation round-trip.
- **Deny-by-default authz.** A restore confirmation is only accepted when the
  caller is the **owner**, an **explicitly delegated** delegate, or a
  **guardian** acting under policy. API-key/JWT callers must carry a scope
  that permits archive restore; a missing/expired/revoked credential fails
  closed. There is no anonymous or implicit-owner path.
- **Idempotency.** Every restore confirmation carries a client-generated
  idempotency key (correlation id). Concurrent or replayed confirmations with
  the same key resolve to the same result and never double-apply a restore.
- **Fail-closed on dependency outage.** If the RPC/DB/Horizon dependency is
  unavailable, the confirmation write fails closed and the UI shows a
  retryable error — it never optimistically assumes the restore succeeded.
- **No secrets in logs.** Confirmation logs/metrics carry the correlation id
  and stable error code only; cookie values, JWTs, API keys, and key material
  are redacted.

### Typed entrypoint & stable error codes

Restore confirmations go through a typed entrypoint that returns a stable
`code` and a `correlationId` on every outcome:

| Condition | Code |
|---|---|
| Caller not owner/delegate/guardian/authorized API key | `RESTORE_UNAUTHORIZED` |
| Credential expired or delegate revoked | `RESTORE_CREDENTIAL_REVOKED` |
| Missing/blank idempotency key | `RESTORE_MISSING_IDEMPOTENCY_KEY` |
| Replayed confirmation (same key, already applied) | `RESTORE_ALREADY_APPLIED` |
| Archive not found / not in restorable state | `RESTORE_NOT_RESTORABLE` |
| RPC/DB/Horizon outage on write | `RESTORE_DEPENDENCY_UNAVAILABLE` |

```ts
// server-only: route handler / server action / server utility
const result = await confirmArchiveRestore({
  archiveId,
  idempotencyKey, // client-generated correlation id
});
// result: { ok: true, correlationId } | { ok: false, code, correlationId }
```

### Fail-closed behavior

- **Unauthorized / wrong role / revoked delegate** → reject before any write;
  surface `RESTORE_UNAUTHORIZED` / `RESTORE_CREDENTIAL_REVOKED`.
- **Missing idempotency key** → abort client-side before the request leaves
  the client.
- **Replayed confirmation** → return the original result
  (`RESTORE_ALREADY_APPLIED`), never a second restore.
- **Dependency outage (RPC/DB/Horizon)** → write fails closed; UI shows a
  retryable error rather than assuming success.
- **Testnet vs mainnet misconfig** → reject; a restore confirmation must not
  cross networks.

Errors use stable codes and correlation ids, and never log cookie values,
JWTs, API keys, or key material.

### Tests

The e2e suite (`tests/e2e/`) covers the critical path:

- Owner/delegate/guardian confirmation succeeds; anonymous and wrong-role
  callers are rejected.
- A replayed confirmation with the same idempotency key does not double-apply.
- A confirmation without an idempotency key is rejected client-side.
- A dependency outage fails the write closed and surfaces a retryable error.

### Production vs demo/mock split

Authz, idempotency, and fail-closed behavior are enforced identically in dev
and production. There is no mock path that bypasses the restore-confirmation
invariants, and any money-path/mainnet-affecting change lands behind a
feature flag with a documented rollback.

---

## #825 SameSite cookie assumptions

**Scope:** auth/session cookie flows in `mux-frontend`  
**Related:** `README.md`, `docs/auth-local-setup.md`, `tests/e2e/`

### Failure mode

Session and auth cookies are set by the Mux backend and consumed by the
frontend. If the frontend assumes the wrong `SameSite`/`Secure`/`HttpOnly`
attributes — or assumes a cookie is present when the browser has rejected
it — the app can silently lose the session, mis-route AA/wallet/payment
calls, or (worse) treat an unauthenticated request as authenticated. This
is a money-path and account-takeover gap, so the assumptions below are
**invariants**, not suggestions.

### Cookie invariants

| Cookie | Purpose | `SameSite` | `Secure` | `HttpOnly` | `Path` | `Domain` |
|---|---|---|---|---|---|---|
| `mux_session` | Authenticated session | `Lax` | required in prod | yes | `/` | app host only (no wildcard) |
| `mux_csrf` | CSRF double-submit token | `Lax` | required in prod | no (JS must read it) | `/` | app host only |
| `mux_oauth_state` | OAuth/AA redirect state | `Lax` | required in prod | yes | `/` | app host only |

- **`SameSite=Lax` is the default and the only supported value** for the
  session, CSRF, and OAuth-state cookies. `Lax` allows top-level GET
  navigations (needed for OAuth/AA redirects back into the app) while
  blocking cross-site subresource and POST requests.
- **`SameSite=None` is not used.** If a deployment ever requires it, it
  **must** be paired with `Secure` and called out in the PR design note;
  the frontend must not assume `None` works on non-HTTPS origins.
- **`SameSite=Strict` is not used** for these cookies because it would drop
  the session on the OAuth/AA redirect back from the identity provider.
- **`Secure` is required in production.** Cookies without `Secure` are
  rejected by the frontend in production (see fail-closed behavior below).
- **`HttpOnly`** is set on `mux_session` and `mux_oauth_state` so JS cannot
  read them. `mux_csrf` is intentionally readable by JS for the
  double-submit pattern.
- **`Path=/`** and **host-only domain** (no leading-dot wildcard) so the
  cookie is not shared with sibling subdomains.

### Frontend assumptions

- The frontend **never** sets the session cookie itself; it is set by the
  backend `Set-Cookie` response. The frontend only reads `mux_csrf`.
- Auth state is derived from a server round-trip (session endpoint), **not**
  from the mere presence of a cookie in `document.cookie`.
- Cross-site requests that carry credentials use `credentials: 'include'`
  and are only issued to the configured Mux API origin.
- The CSRF token from `mux_csrf` is echoed in the `X-CSRF-Token` header on
  state-changing requests; a missing token fails the request client-side.

### Fail-closed behavior

When a SameSite assumption is violated, or a required cookie is missing or
rejected, the frontend fails closed:

- **Missing/rejected session cookie** → treat as unauthenticated; redirect
  to sign-in. Never fall back to a cached or optimistic authenticated state.
- **Missing CSRF cookie** on a state-changing request → abort the request
  before it leaves the client; surface an actionable error.
- **Cookie present but `Secure` missing in production** → reject and treat
  as unauthenticated (do not trust the cookie).
- **OAuth/AA redirect returns without `mux_oauth_state`** → abort the flow
  and restart; do not complete the exchange.
- **Dependency outage (RPC/DB/Horizon)** → writes fail closed; the UI shows
  a retryable error rather than assuming success.

Errors use stable codes and correlation ids, and never log cookie values,
JWTs, or key material.

### Tests

The e2e suite (`tests/e2e/`) covers the critical path:

- Authenticated flow succeeds with `SameSite=Lax` + `Secure` cookies.
- A request with the session cookie stripped is treated as unauthenticated.
- A state-changing request without the CSRF token is rejected client-side.
- OAuth/AA redirect without `mux_oauth_state` aborts instead of completing.

### Production vs demo/mock split

Cookie attributes are enforced identically in dev and production, except
that `Secure` is only *required* in production (local dev over `http://`
would otherwise be unable to set the cookie). There is no mock path that
bypasses the cookie invariants.

---

## #756 MUX_API_KEY / MUX_API_SECRET never client-bundled

**Guard:** `src/lib/serverEnv.ts`  
**Tests:** `src/lib/__tests__/serverEnv.test.ts`

### Failure mode

`MUX_API_KEY` and `MUX_API_SECRET` authenticate the frontend to the Mux
backend. If either is read from a module that is imported by a client
component, Next.js inlines the value into the client bundle and it is
shipped to every browser. A leaked `MUX_API_SECRET` lets an attacker mint
sessions, sign spends, or impersonate the app against the Mux API — a
money-path and account-takeover gap.

### What the implementation does

- The secrets are read **only** in server-only modules (route handlers,
  server actions, server utilities). They are never referenced from client
  components or from shared modules that the client imports.
- They are **never** exposed via `NEXT_PUBLIC_*` and are not passed through
  any public-env passthrough in `next.config.ts`.
- `src/lib/serverEnv.ts` is marked server-only and exposes a fail-closed
  accessor. Accessing the secret from a client context, or with the required
  server env missing, throws a typed `ServerEnvError` with a stable `code`
  and a secret-free `message`:

| Condition | Code |
|---|---|
| Secret accessed from a client context | `CLIENT_SECRET_ACCESS` |
| Required server env missing | `MISSING_SERVER_ENV` |

```ts
import { getMuxApiCredentials } from '@/lib/serverEnv';

// server-only: route handler / server action / server utility
const { apiKey, apiSecret } = getMuxApiCredentials();
```

### Tests

The test suite (`serverEnv.test.ts`) fails if:

- The secret is read from a client context without throwing.
- Missing required server env does not throw `MISSING_SERVER_ENV`.
- Error messages leak the key or secret value.
- The secret is re-exported from a client-importable module.

### Production vs demo/mock split

There is no mock path for credentials. The guard behaves identically in dev
and production; in production a missing secret fails closed rather than
falling back to a mock or empty value.

---

## #754 Env validation never serves mocks in production

**File:** `src/lib/envValidation.ts`  
**Tests:** `src/lib/__tests__/envValidation.test.ts`

### Failure mode

If a production build is misconfigured — a mock flag left on, a mock API
base URL, or a testnet endpoint in mainnet mode — the app could silently
serve mock wallet/AA/payment data. That is a money-path correctness and
security gap: users would see fabricated balances or route real actions
against mock backends.

### What the implementation does

`validateEnv` is **fail-closed**: in production it throws a typed
`EnvValidationError` (stable `code`, secret-free `message`) for any
configuration that would enable mocks. Mock providers/data are gated behind
non-production checks, so mocks can never be served in production.

| Condition | Code |
|---|---|
| Mock flag enabled in production | `MOCK_IN_PRODUCTION` |
| Mock API base URL in production | `MOCK_URL_IN_PRODUCTION` |
| Testnet endpoint in mainnet mode | `NETWORK_MISMATCH` |
| Missing required production var | `MISSING_REQUIRED` |

### Tests

The test suite (`envValidation.test.ts`) fails if:

- Production + mock flag does not throw.
- Production + mock API base URL does not throw.
- Mainnet mode + testnet endpoint does not throw.
- Non-production environments are incorrectly rejected.
- Error messages leak secret values.

### Production vs demo/mock split

Mock data paths are only enabled outside production and are rejected by
`validateEnv` in production, so a misconfigured production build fails
closed instead of serving fabricated wallet/AA/payment data.
