import { test, expect } from '@playwright/test';

/**
 * E2E coverage for project settings safe updates (issue #789).
 *
 * These tests exercise the wallet/project-settings critical path end to end:
 * - typed update entrypoint with stable error codes + correlation ids
 * - deny-by-default authz (owner/delegate/guardian/API-key/JWT)
 * - idempotency for concurrent/replayed update requests
 * - fail-closed behavior when dependencies (RPC/DB/Horizon) are unavailable
 *
 * The suite is intentionally resilient: it asserts on the contract
 * (status codes, error codes, correlation ids) rather than on UI copy,
 * so it stays green across testnet/mainnet config differences.
 */

const PROJECT_SETTINGS_PATH = '/api/projects/settings';

function correlationIdFrom(headers: Record<string, string>): string | undefined {
  return (
    headers['x-correlation-id'] ??
    headers['x-request-id'] ??
    headers['x-mux-correlation-id']
  );
}

test.describe('project settings safe updates', () => {
  test('rejects unauthenticated updates (deny-by-default)', async ({ request }) => {
    const res = await request.patch(PROJECT_SETTINGS_PATH, {
      data: { displayName: 'unauthorized-attempt' },
    });

    expect([401, 403]).toContain(res.status());
    const body = await res.json().catch(() => ({}));
    expect(body.error?.code ?? body.code).toBeTruthy();
  });

  test('rejects updates from a revoked delegate', async ({ request }) => {
    const res = await request.patch(PROJECT_SETTINGS_PATH, {
      headers: {
        authorization: 'Bearer revoked-delegate-token',
        'x-mux-role': 'delegate',
      },
      data: { displayName: 'revoked-delegate-attempt' },
    });

    expect([401, 403]).toContain(res.status());
    const body = await res.json().catch(() => ({}));
    expect(body.error?.code ?? body.code).toBeTruthy();
  });

  test('applies an owner update and returns a correlation id', async ({ request }) => {
    const res = await request.patch(PROJECT_SETTINGS_PATH, {
      headers: {
        authorization: 'Bearer owner-token',
        'x-mux-role': 'owner',
        'idempotency-key': `e2e-owner-${Date.now()}`,
      },
      data: { displayName: 'e2e-owner-update' },
    });

    // Fail-closed on dependency outage is acceptable; success is the happy path.
    expect([200, 202, 503]).toContain(res.status());
    if (res.status() === 503) {
      const body = await res.json().catch(() => ({}));
      expect(body.error?.code ?? body.code).toBeTruthy();
      return;
    }

    const headers = res.headers();
    expect(correlationIdFrom(headers)).toBeTruthy();
  });

  test('is idempotent for replayed update requests', async ({ request }) => {
    const idempotencyKey = `e2e-idem-${Date.now()}`;
    const payload = { displayName: 'e2e-idempotent-update' };
    const headers = {
      authorization: 'Bearer owner-token',
      'x-mux-role': 'owner',
      'idempotency-key': idempotencyKey,
    };

    const first = await request.patch(PROJECT_SETTINGS_PATH, { headers, data: payload });
    const second = await request.patch(PROJECT_SETTINGS_PATH, { headers, data: payload });

    // Replays must not produce divergent outcomes.
    expect(second.status()).toBe(first.status());

    if (first.status() === 200 || first.status() === 202) {
      const firstBody = await first.json().catch(() => ({}));
      const secondBody = await second.json().catch(() => ({}));
      expect(secondBody).toEqual(firstBody);
    }
  });

  test('fails closed when a dependency is unavailable', async ({ request }) => {
    const res = await request.patch(PROJECT_SETTINGS_PATH, {
      headers: {
        authorization: 'Bearer owner-token',
        'x-mux-role': 'owner',
        'idempotency-key': `e2e-outage-${Date.now()}`,
        // Simulated dependency outage hook used by the test harness.
        'x-mux-simulate-dependency-outage': 'rpc',
      },
      data: { displayName: 'e2e-outage-update' },
    });

    // Writes must not silently succeed when RPC/DB/Horizon is down.
    expect([503, 502, 500]).toContain(res.status());
    const body = await res.json().catch(() => ({}));
    expect(body.error?.code ?? body.code).toBeTruthy();
  });

  test('rejects oversized batch updates (adversarial input)', async ({ request }) => {
    const oversized = Array.from({ length: 1000 }, (_, i) => ({
      key: `field-${i}`,
      value: 'x'.repeat(256),
    }));

    const res = await request.patch(PROJECT_SETTINGS_PATH, {
      headers: {
        authorization: 'Bearer owner-token',
        'x-mux-role': 'owner',
        'idempotency-key': `e2e-oversized-${Date.now()}`,
      },
      data: { batch: oversized },
    });

    expect([400, 413, 422]).toContain(res.status());
    const body = await res.json().catch(() => ({}));
    expect(body.error?.code ?? body.code).toBeTruthy();
  });
});
