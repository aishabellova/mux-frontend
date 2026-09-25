# Mux Frontend

Mux Protocol provides invisible wallets and account abstraction on Stellar/Soroban.
This repository contains the Mux frontend.

## Copy address clipboard UX

Copying a wallet address must be reliable and fail-closed: the UI never reports
success unless the address actually reached the clipboard.

- Use the shared `useCopyAddress` hook (or `copyAddress` helper) instead of
  calling `navigator.clipboard` directly. It returns a typed result with stable
error codes so callers can render actionable messages and correlate failures.
- Stable error codes:
  - `CLIPBOARD_UNAVAILABLE` — the Clipboard API is missing (insecure context,
    unsupported browser, or blocked by policy).
  - `CLIPBOARD_PERMISSION_DENIED` — the user or browser denied clipboard write.
  - `CLIPBOARD_WRITE_FAILED` — the write was attempted but rejected/failed.
- On any failure the UI must surface the error and offer a manual-copy fallback
  (a selectable, read-only address field) rather than silently succeeding.
- Never log or emit raw address/key material to telemetry; redact addresses in
  logs and metrics.

See `docs/security-ux-guards.md` for the broader security/UX guardrails.

## References

- `docs/security-ux-guards.md`
- `tests/e2e/`
