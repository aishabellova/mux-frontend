# E2E testing against a real backend

Companion doc to `tests/e2e/real-backend/README.md`, which has the full
test-by-test breakdown. This page covers why the suite exists, the env
vars it reads, and how it fits alongside the mock-only smoke suite.

## Why this exists

`tests/e2e/` (the default `pnpm run test:e2e`) is deliberately mock-only:
`playwright.config.ts` forces `NEXT_PUBLIC_API_URL=""` in its dev-server
env so `login.spec.ts` and `wallets.spec.ts` run the same way in every
environment, without needing a live `mux-backend`. That's the right
default for a fast, deterministic smoke suite — but it means those specs
hardcode mock-only assumptions (any well-formed login credentials
succeed; `/api/wallets` accepts the literal bearer token
`mock-access-token`) that do not hold against a real backend. Without a
separate suite exercising the real contract, a developer console that
passes `test:e2e` could still ship broken auth or wallet-fetching against
production — mock wallets, fake analytics, or an unauthenticated session
reaching a real deployment undetected.

`tests/e2e/real-backend/` is that separate suite. It never stubs
`/api/auth/login` or `/api/wallets`, never asserts the mock's hardcoded
credentials/tokens, and never assumes the mock fixture data in
`src/mock-data/wallets.ts`.

## Env vars

These are test-runner-only vars, read by
`tests/e2e/real-backend/helpers.ts`. They are not part of the app's
runtime schema in `src/lib/env.ts` (see `docs/frontend-env-vars.md`) and
should never be baked into `.env.local`/build config — they're supplied
at test-run time only, ideally from CI secrets.

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Same var the app itself reads (`src/lib/api/config.ts::getApiBaseUrl`). Must point at a real, reachable `mux-backend` (typically a testnet/staging deployment) for this suite to run. |
| `E2E_TEST_EMAIL` | Email for a real, low-privilege QA account on that backend. |
| `E2E_TEST_PASSWORD` | Password for the same account. |
| `PLAYWRIGHT_BASE_URL` (optional) | Points the suite at an already-running frontend (e.g. a deployed preview) instead of spawning a local `next dev` — same convention as the default suite. |

If any of `NEXT_PUBLIC_API_URL`, `E2E_TEST_EMAIL`, or `E2E_TEST_PASSWORD`
is unset, every test in the suite skips itself with an explanation
instead of running — see `REAL_BACKEND_SKIP_REASON` in `helpers.ts`. This
means the suite is safe to wire into CI unconditionally: it's a no-op
until those secrets are actually provisioned for a given environment.

## Config honesty: `playwright.real-backend.config.ts`

The real-backend suite is only meaningful if its Playwright config
actually points at the real-backend specs and wires the env through. The
config is validated by `tests/e2e-real-backend.config.test.ts`, which
asserts the real invariants below rather than trivially passing. If you
change the config, keep these true or the test will (correctly) fail:

- **`testDir` targets the real-backend suite.** It must resolve to
  `tests/e2e/real-backend` — not the mock-only `tests/e2e/` directory.
  Pointing it at the mock suite would silently re-run mock specs under a
  "real backend" name.
- **`baseURL` / env wiring.** The config must forward
  `NEXT_PUBLIC_API_URL` (and `PLAYWRIGHT_BASE_URL` when set) into the
  dev-server / browser env so the app under test talks to the real
  backend, not the mock default.
- **Retries and timeouts.** Real-backend runs are slower and flakier than
  the mock suite (network, cold starts), so the config sets explicit
  `retries` and `timeout` values; the test pins them so a future edit
  can't quietly drop them to zero.
- **Reporter.** The config declares its reporter explicitly so CI output
  is stable and parseable.
- **Fail-closed guard.** When the required real-backend env
  (`NEXT_PUBLIC_API_URL`, `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD`) is
  absent, the config must fail closed — it throws (or the suite skips
  with `REAL_BACKEND_SKIP_REASON`) rather than silently running against
  a mock or an empty base URL. The test covers this negative path: a
  missing/misconfigured env must not produce a green run that never
  touched a real backend.

## Running

```bash
NEXT_PUBLIC_API_URL=https://staging-api.muxprotocol.com \
E2E_TEST_EMAIL=qa@muxprotocol.com \
E2E_TEST_PASSWORD='...' \
pnpm exec playwright test --config=playwright.real-backend.config.ts
```

See `tests/e2e/real-backend/README.md` for the preview-frontend variant
and the full list of what each spec covers.

## Security

- Test credentials are a real (if low-privilege) account on a real
  backend — treat `E2E_TEST_PASSWORD` like any other secret: CI secret
  store only, never committed, never logged.
- Same rule as the rest of the app (`docs/frontend-env-vars.md`,
  `docs/auth-local-setup.md`): no custody secret — `MUX_API_KEY`,
  `MUX_API_SECRET`, or a session token — is ever read from a
  `NEXT_PUBLIC_*` variable or written to `localStorage`. The
  real-backend specs don't introduce any new storage path; they exercise
  the existing HttpOnly `mux_auth_token` cookie flow end-to-end.
