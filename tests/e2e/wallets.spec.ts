import { test, expect } from '@playwright/test';

/**
 * E2E coverage for archive restore confirmations (issue #834).
 *
 * Invariants exercised here:
 *  - Restore confirmations are deny-by-default: unauthenticated callers are rejected.
 *  - A confirmation is idempotent: replaying the same correlation id does not
 *    double-apply the restore.
 *  - Writes fail closed when the backend dependency (RPC/DB/Horizon) is down.
 *  - Errors surface stable error codes plus a correlation id for ops triage.
 */

const RESTORE_CONFIRM_ENDPOINT = '/api/wallets/archive/restore/confirm';

// Stable error codes the backend must return for the restore-confirmation path.
const ERROR_CODES = {
  UNAUTHORIZED: 'ARCHIVE_RESTORE_UNAUTHORIZED',
  FORBIDDEN: 'ARCHIVE_RESTORE_FORBIDDEN',
  DEPENDENCY_UNAVAILABLE: 'ARCHIVE_RESTORE_DEPENDENCY_UNAVAILABLE',
} as const;

function newCorrelationId(): string {
  return `e2e-restore-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

test.describe('archive restore confirmations', () => {
  test('rejects unauthenticated restore confirmations (deny-by-default)', async ({ request }) => {
    const correlationId = newCorrelationId();
    const response = await request.post(RESTORE_CONFIRM_ENDPOINT, {
      headers: { 'x-correlation-id': correlationId },
      data: { archiveId: 'archive-e2e-1', correlationId },
    });

    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error).toBe(ERROR_CODES.UNAUTHORIZED);
    expect(body.correlationId).toBe(correlationId);
  });

  test('rejects a caller without owner/delegate/guardian role', async ({ request }) => {
    const correlationId = newCorrelationId();
    const response = await request.post(RESTORE_CONFIRM_ENDPOINT, {
      headers: {
        'x-correlation-id': correlationId,
        // A valid but under-privileged session must not bypass policy.
        authorization: 'Bearer e2e-underprivileged-token',
      },
      data: { archiveId: 'archive-e2e-1', correlationId },
    });

    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error).toBe(ERROR_CODES.FORBIDDEN);
    expect(body.correlationId).toBe(correlationId);
  });

  test('is idempotent for replayed restore confirmations', async ({ request }) => {
    const correlationId = newCorrelationId();
    const payload = { archiveId: 'archive-e2e-idempotent', correlationId };
    const headers = {
      'x-correlation-id': correlationId,
      authorization: 'Bearer e2e-owner-token',
    };

    const first = await request.post(RESTORE_CONFIRM_ENDPOINT, { headers, data: payload });
    expect(first.ok()).toBeTruthy();
    const firstBody = await first.json();
    expect(firstBody.correlationId).toBe(correlationId);

    // Replaying the same correlation id must not double-apply the restore.
    const replay = await request.post(RESTORE_CONFIRM_ENDPOINT, { headers, data: payload });
    expect(replay.ok()).toBeTruthy();
    const replayBody = await replay.json();
    expect(replayBody.correlationId).toBe(correlationId);
    expect(replayBody.restoreId).toBe(firstBody.restoreId);
    expect(replayBody.applied).toBe(false);
  });

  test('fails closed when the backend dependency is unavailable', async ({ request }) => {
    const correlationId = newCorrelationId();
    const response = await request.post(RESTORE_CONFIRM_ENDPOINT, {
      headers: {
        'x-correlation-id': correlationId,
        authorization: 'Bearer e2e-owner-token',
        // Simulates an RPC/DB/Horizon outage so the write path must fail closed.
        'x-e2e-simulate-dependency-outage': 'true',
      },
      data: { archiveId: 'archive-e2e-outage', correlationId },
    });

    expect(response.status()).toBe(503);
    const body = await response.json();
    expect(body.error).toBe(ERROR_CODES.DEPENDENCY_UNAVAILABLE);
    expect(body.correlationId).toBe(correlationId);
    // No partial restore should be reported on a failed-closed write.
    expect(body.applied).not.toBe(true);
  });
});
