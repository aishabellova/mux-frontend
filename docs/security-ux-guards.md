# Security & UX Guards

This document describes the security and UX guardrails enforced across the Mux
frontend. It is the canonical reference for contributors working on privileged
surfaces (wallets, account abstraction, payments, activity feeds, notification
preferences).

## Principles

- **Server/contract is the source of truth.** The frontend never decides spends,
  recovery, or admin actions on its own; it only reflects and requests them.
- **Deny by default.** New privileged surfaces must explicitly authorize every
  caller before returning data or performing a write.
- **Fail closed on writes.** If a dependency (RPC, DB, Horizon) is unavailable,
  write paths must reject rather than silently succeed.
- **No secrets in the repo or logs.** Redact keys, JWTs, and webhook secrets.

## Activity feed pagination

The activity feed is a privileged read surface: it exposes wallet, payment, and
account-abstraction history. Pagination must be cursor-based and authorized.

### Request contract

- `limit` — integer, `1..100` (default `25`). Values outside the range are
  rejected with `ACTIVITY_INVALID_LIMIT`; oversized batches are never silently
  truncated.
- `cursor` — opaque, server-issued token. Clients must treat it as opaque and
  must not construct or mutate it. Malformed cursors are rejected with
  `ACTIVITY_INVALID_CURSOR`.

### Response contract

- `items` — array of activity entries for the requested page.
- `nextCursor` — opaque token for the next page, or `null` when exhausted.
- `hasMore` — boolean mirror of `nextCursor !== null`.

Cursors are stable and monotonic: a cursor issued for a page continues to
resolve to the same position even as new activity is appended, so clients never
skip or duplicate entries across concurrent requests.

### Authorization

Every activity feed request is authorized before any data is read. The caller
must present a valid session (JWT) and hold one of the following roles for the
requested account:

- **owner** — full access to their own activity.
- **delegate** — access only while the delegation is active and not revoked.
- **guardian** — access only for accounts they guard.
- **API key** — scoped to the accounts and actions granted to the key.

Requests with an expired session, wrong role, or revoked delegate are rejected
with `ACTIVITY_UNAUTHORIZED` (deny by default). Authorization is re-evaluated on
every page request; a cursor does not carry or extend authorization.

### Error codes

| Code | Meaning |
| --- | --- |
| `ACTIVITY_INVALID_LIMIT` | `limit` missing, non-integer, or out of range. |
| `ACTIVITY_INVALID_CURSOR` | Cursor malformed, tampered, or expired. |
| `ACTIVITY_UNAUTHORIZED` | Missing/expired session, wrong role, or revoked delegate. |
| `ACTIVITY_DEPENDENCY_UNAVAILABLE` | Upstream RPC/DB/Horizon outage; fail closed. |

Errors are actionable and never include raw key material, JWTs, or webhook
secrets. Each response carries a correlation id for support and tracing.

### Idempotency & concurrency

- Read requests are safe to retry; a repeated request with the same cursor
  returns the same page.
- Concurrent requests with the same cursor do not advance shared state.
- Writes triggered from the feed (e.g. retry/claim actions) require an
  idempotency key and are rejected on replay.

### Observability

- Emit metrics for request count, latency, and error code on the activity feed
  path.
- Log correlation ids and error codes only; never log cursors, tokens, keys, or
  full request bodies.

### Environment safety

- Testnet and mainnet configurations are distinct; a mainnet-affecting change to
  the feed must be gated behind a feature flag or kill-switch with a documented
  rollback.
- Misconfigured environments fail closed rather than serving cross-environment
  data.

## Notification preferences

The notification preferences page is a privileged surface: it reads and writes
per-account delivery settings (channels and event subscriptions). Reads and
writes must be authorized and fail closed.

### Request contract

- `channels` — object keyed by channel (`email`, `push`, `webhook`), each with a
  boolean `enabled` flag. Unknown channels are rejected with
  `NOTIFICATIONS_INVALID_CHANNEL`.
- `events` — object keyed by event type (e.g. `payment.received`,
  `recovery.initiated`), each with a boolean `enabled` flag. Unknown event types
  are rejected with `NOTIFICATIONS_INVALID_EVENT`.
- `idempotencyKey` — required on writes. Replayed keys return the original
  result and never apply the update twice.

### Response contract

- `preferences` — the persisted channel/event map for the account.
- `updatedAt` — server timestamp of the last accepted write.

### Authorization

Every read and write is authorized before any data is touched. The caller must
present a valid session (JWT) and hold one of the following roles for the
requested account:

- **owner** — full read/write of their own preferences.
- **delegate** — read/write only while the delegation is active and not revoked.
- **guardian** — read/write only for accounts they guard.
- **API key** — scoped to the accounts and actions granted to the key.

Requests with an expired session, wrong role, or revoked delegate are rejected
with `NOTIFICATIONS_UNAUTHORIZED` (deny by default). Privileged surfaces are
deny-by-default: absence of an explicit grant is a rejection, not a default
allow.

### Error codes

| Code | Meaning |
| --- | --- |
| `NOTIFICATIONS_INVALID_CHANNEL` | Unknown or malformed channel in the payload. |
| `NOTIFICATIONS_INVALID_EVENT` | Unknown or malformed event type in the payload. |
| `NOTIFICATIONS_UNAUTHORIZED` | Missing/expired session, wrong role, or revoked delegate. |
| `NOTIFICATIONS_DEPENDENCY_UNAVAILABLE` | Upstream RPC/DB outage; fail closed on writes. |
| `NOTIFICATIONS_REPLAYED` | Idempotency key already applied; original result returned. |

Errors are actionable and never include raw key material, JWTs, or webhook
secrets. Each response carries a correlation id for support and tracing.

### Idempotency & concurrency

- Reads are safe to retry and return the persisted preferences.
- Writes require an idempotency key; concurrent or replayed updates with the
  same key are collapsed to a single applied write.
- A write that cannot reach the backing store fails closed with
  `NOTIFICATIONS_DEPENDENCY_UNAVAILABLE` rather than reporting success.

### Observability

- Emit metrics for request count, latency, and error code on the notification
  preferences path.
- Log correlation ids and error codes only; never log tokens, keys, or full
  request bodies.

### Environment safety

- Testnet and mainnet configurations are distinct; a mainnet-affecting change to
  notification delivery must be gated behind a feature flag or kill-switch with
  a documented rollback.
- Misconfigured environments fail closed rather than serving cross-environment
  preferences.

## References

- `README.md`
- `tests/e2e/`
