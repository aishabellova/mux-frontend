# Security & UX Guards — Issues #701–704, #757, #758, #759

This document covers security and UX correctness fixes shipped together.
Each section describes the failure mode, what was fixed, and what the
automated tests verify.

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

Mock data paths are only reachable when `NODE_ENV !== 'production'` **and**
the mock flag is explicitly set. Production validation rejects both, so the
mock path is unreachable in production.

---

## #701 Balance visibility toggle — DOM leak guard

**File:** `src/hooks/useBalanceVisibility.ts`  
**Component:** `src/components/wallet/WalletBalance.tsx`  
**Tests:** `src/hooks/__tests__/useBalanceVisibility.dom-leak.test.ts`

### Failure mode

A balance visibility toggle that renders the real formatted amount in DOM
text (even behind CSS `display:none` or `opacity:0`) leaks the amount to:

- Screen readers via the accessibility tree
- Browser extensions (password managers, page scrapers) that read DOM text
- The Clipboard API if a copy handler does not check the visibility state
  before writing to the clipboard

### What the implementation does

`useBalanceVisibility` exposes an `isInitialized` flag. Consumers **must**
gate their amount render on this flag to avoid a flash of the real value
before the persisted preference is read from `localStorage`:

```tsx
if (isLoading || !isInitialized) {
  // render a loading skeleton — not the real amount
  return <LoadingSkeleton />;
}
```

`WalletBalance` renders `••••••` (not the formatted amount) in the
`data-testid="balance-display"` span when `isVisible` is false, so the
real amount is never present in the DOM text when hidden.

**Clipboard contract.** Copy handlers must check `isVisible` before writing
the amount to the clipboard:

```ts
if (isVisible) {
  copyToClipboard(formattedBalance);
}
```

### Tests

The test suite (`useBalanceVisibility.dom-leak.test.ts`) fails if:

- `isInitialized` is removed (pre-hydration exposure).
- The toggle returns the wrong value after an even number of flips.
- `localStorage` and in-memory state diverge.
- A caller ignores `isVisible` and copies the amount while hidden.
- `localStorage` errors unexpectedly flip the balance to visible.

### Production vs demo/mock split

`useBalanceVisibility` is purely client-side state — no backend call
involved. The `localStorage` key is `mux_balance_visibility`. There is no
mock mode for this hook; it behaves identically in dev and production.

---

## #702 Copy-to-clipboard — no silent failure

**File:** `src/utils/copyToClipboardUx.ts`  
**Hook:** `src/hooks/useCopyToClipboardUx.ts`  
**Tests:** `src/hooks/__tests__/useCopyToClipboardUx.test.ts`

### Failure mode

If the Clipboard API throws (e.g. `NotAllowedError` when the user has
denied clipboard permission, or when `navigator.clipboard` is absent in an
embedded WebView), a silent failure means:

- The user believes the wallet address was copied but it was not.
- Sending funds to a manually-typed address increases the error rate.

### What the implementation does

`useCopyToClipboardUx` catches all Clipboard errors and sets a non-null,
non-empty `error` string. The `copy()` function returns `false` on failure.
Callers (e.g. `CopyButton`) use the `error` field to show a visible toast:

```tsx
const { copy, error, copied } = useCopyToClipboardUx();

// in JSX:
{error && <Toast variant="error">{error}</Toast>}
{copied && <Toast variant="success">Copied!</Toast>}
```

`copyToClipboardWithFallback` tries the modern `navigator.clipboard.writeText`
API first and falls back to `document.execCommand('copy')` for older
browsers. Both paths throw on failure so `useCopyToClipboardUx` always
surfaces the error.

### Tests

The test suite (`useCopyToClipboardUx.test.ts`) fails if:

- The `catch` block sets `error` to `null` or `""` on a Clipboard failure.
- `copied` is set to `true` after a failed write.
- The error is swallowed silently.
- `reset()` does not clear the error state.

### Production vs demo/mock split

No mock path exists for clipboard operations. The same code runs in dev and
production. `copyToClipboardWithFallback` never calls a backend route.

---

## #703 Keyboard commands — command palette conflict guard

**File:** `src/utils/keyboardCommands.ts`  
**Hook:** `src/hooks/useCommandPalette.ts`  
**Tests:** `src/hooks/__tests__/useCommandPalette.test.ts`

### Failure mode

Two independent keyboard handler systems exist:

1. `useCommandPalette` — opens the palette on `Ctrl+K` / `Cmd+K` and
   handles `Escape`, `ArrowUp/Down`, `Enter` while open.
2. `useCommandShortcut` / 
