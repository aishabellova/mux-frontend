import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

/**
 * Archive restore confirmations
 *
 * Typed entrypoint for confirming an archive restore of a wallet.
 *
 * Invariants:
 *  - Deny-by-default: only the wallet owner, an active delegate, or a guardian
 *    may confirm a restore. API-key/JWT callers must present a matching subject.
 *  - Idempotent: a confirmation is keyed by (walletId, restoreId). Replays of the
 *    same confirmation return the original result and never re-apply state.
 *  - Fail-closed: if the backing store / RPC / Horizon is unavailable, writes are
 *    rejected with a retryable error rather than silently succeeding.
 *  - No secrets are logged; correlation ids are surfaced for ops tracing.
 */

export const runtime = 'nodejs';

// Stable error codes for clients and ops dashboards.
export const ArchiveRestoreErrorCode = {
  INVALID_REQUEST: 'ARCHIVE_RESTORE_INVALID_REQUEST',
  UNAUTHORIZED: 'ARCHIVE_RESTORE_UNAUTHORIZED',
  FORBIDDEN: 'ARCHIVE_RESTORE_FORBIDDEN',
  NOT_FOUND: 'ARCHIVE_RESTORE_NOT_FOUND',
  CONFLICT: 'ARCHIVE_RESTORE_CONFLICT',
  DEPENDENCY_UNAVAILABLE: 'ARCHIVE_RESTORE_DEPENDENCY_UNAVAILABLE',
  INTERNAL: 'ARCHIVE_RESTORE_INTERNAL',
} as const;

export type ArchiveRestoreErrorCodeValue =
  (typeof ArchiveRestoreErrorCode)[keyof typeof ArchiveRestoreErrorCode];

export type ArchiveRestoreRole = 'owner' | 'delegate' | 'guardian' | 'api-key' | 'jwt';

export interface ArchiveRestoreConfirmationRequest {
  /** Stable id for this restore attempt; used for idempotency. */
  restoreId: string;
  /** Caller-supplied confirmation token issued when the restore was initiated. */
  confirmationToken: string;
  /** Optional client idempotency key; defaults to restoreId. */
  idempotencyKey?: string;
}

export interface ArchiveRestoreConfirmationResult {
  walletId: string;
  restoreId: string;
  status: 'confirmed' | 'already_confirmed';
  confirmedAt: string;
  correlationId: string;
}

export interface ArchiveRestoreErrorBody {
  error: {
    code: ArchiveRestoreErrorCodeValue;
    message: string;
    correlationId: string;
    retryable: boolean;
  };
}

interface AuthContext {
  subject: string;
  role: ArchiveRestoreRole;
  walletId: string;
}

interface RestoreRecord {
  walletId: string;
  restoreId: string;
  ownerId: string;
  delegateIds: string[];
  guardianIds: string[];
  confirmationToken: string;
  status: 'pending' | 'confirmed';
  confirmedAt?: string;
}

/**
 * Backing store abstraction. In production this is wired to the DB/RPC layer.
 * Kept injectable so tests can exercise authz, idempotency and fail-closed paths.
 */
export interface ArchiveRestoreStore {
  getRestore(walletId: string, restoreId: string): Promise<RestoreRecord | null>;
  confirmRestore(
    walletId: string,
    restoreId: string,
    confirmedAt: string,
  ): Promise<RestoreRecord>;
}

/** Thrown by the store when a dependency (DB/RPC/Horizon) is unavailable. */
export class DependencyUnavailableError extends Error {
  constructor(message = 'dependency unavailable') {
    super(message);
    this.name = 'DependencyUnavailableError';
  }
}

let store: ArchiveRestoreStore | null = null;

/** Wire the production store at app bootstrap. */
export function setArchiveRestoreStore(next: ArchiveRestoreStore): void {
  store = next;
}

function getStore(): ArchiveRestoreStore {
  if (!store) {
    throw new DependencyUnavailableError('archive restore store not configured');
  }
  return store;
}

function errorResponse(
  code: ArchiveRestoreErrorCodeValue,
  message: string,
  correlationId: string,
  status: number,
  retryable = false,
): NextResponse<ArchiveRestoreErrorBody> {
  return NextResponse.json(
    { error: { code, message, correlationId, retryable } },
    { status },
  );
}

/**
 * Resolve the caller identity from headers. Deny-by-default: absence of a
 * recognized credential yields no auth context.
 */
function resolveAuth(req: NextRequest, walletId: string): AuthContext | null {
  const role = req.headers.get('x-mux-role') as ArchiveRestoreRole | null;
  const subject = req.headers.get('x-mux-subject');
  if (!role || !subject) return null;
  if (!['owner', 'delegate', 'guardian', 'api-key', 'jwt'].includes(role)) return null;
  return { subject, role, walletId };
}

function isAuthorized(auth: AuthContext, record: RestoreRecord): boolean {
  switch (auth.role) {
    case 'owner':
      return auth.subject === record.ownerId;
    case 'delegate':
      return record.delegateIds.includes(auth.subject);
    case 'guardian':
      return record.guardianIds.includes(auth.subject);
    case 'api-key':
    case 'jwt':
      // Service credentials must still map to an owner/delegate/guardian subject.
      return (
        auth.subject === record.ownerId ||
        record.delegateIds.includes(auth.subject) ||
        record.guardianIds.includes(auth.subject)
      );
    default:
      return false;
  }
}

function parseBody(raw: unknown): ArchiveRestoreConfirmationRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const restoreId = body.restoreId;
  const confirmationToken = body.confirmationToken;
  const idempotencyKey = body.idempotencyKey;
  if (typeof restoreId !== 'string' || restoreId.length === 0 || restoreId.length > 128) {
    return null;
  }
  if (
    typeof confirmationToken !== 'string' ||
    confirmationToken.length === 0 ||
    confirmationToken.length > 512
  ) {
    return null;
  }
  if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') return null;
  return { restoreId, confirmationToken, idempotencyKey };
}

/**
 * POST /api/wallets/[id]/restore-confirmations
 *
 * Confirms an archive restore for the given wallet. Idempotent on restoreId.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse<ArchiveRestoreConfirmationResult | ArchiveRestoreErrorBody>> {
  const correlationId = req.headers.get('x-correlation-id') ?? randomUUID();
  const walletId = ctx?.params?.id;

  if (!walletId || typeof walletId !== 'string') {
    return errorResponse(
      ArchiveRestoreErrorCode.INVALID_REQUEST,
      'wallet id is required',
      correlationId,
      400,
    );
  }

  const auth = resolveAuth(req, walletId);
  if (!auth) {
    return errorResponse(
      ArchiveRestoreErrorCode.UNAUTHORIZED,
      'missing or invalid credentials',
      correlationId,
      401,
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(
      ArchiveRestoreErrorCode.INVALID_REQUEST,
      'malformed JSON body',
      correlationId,
      400,
    );
  }

  const body = parseBody(raw);
  if (!body) {
    return errorResponse(
      ArchiveRestoreErrorCode.INVALID_REQUEST,
      'invalid restore confirmation payload',
      correlationId,
      400,
    );
  }

  try {
    const activeStore = getStore();
    const record = await activeStore.getRestore(walletId, body.restoreId);

    if (!record) {
      return errorResponse(
        ArchiveRestoreErrorCode.NOT_FOUND,
        'restore not found',
        correlationId,
        404,
      );
    }

    if (!isAuthorized(auth, record)) {
      return errorResponse(
        ArchiveRestoreErrorCode.FORBIDDEN,
        'caller is not authorized to confirm this restore',
        correlationId,
        403,
      );
    }

    if (record.confirmationToken !== body.confirmationToken) {
      return errorResponse(
        ArchiveRestoreErrorCode.FORBIDDEN,
        'confirmation token mismatch',
        correlationId,
        403,
      );
    }

    // Idempotency: replays of an already-confirmed restore return the original
    // result without re-applying state.
    if (record.status === 'confirmed') {
      return NextResponse.json(
        {
          walletId,
          restoreId: record.restoreId,
          status: 'already_confirmed',
          confirmedAt: record.confirmedAt ?? new Date().toISOString(),
          correlationId,
        },
        { status: 200 },
      );
    }

    const confirmedAt = new Date().toISOString();
    const updated = await activeStore.confirmRestore(walletId, body.restoreId, confirmedAt);

    return NextResponse.json(
      {
        walletId,
        restoreId: updated.restoreId,
        status: 'confirmed',
        confirmedAt: updated.confirmedAt ?? confirmedAt,
        correlationId,
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof DependencyUnavailableError) {
      // Fail-closed on dependency outage for writes.
      return errorResponse(
        ArchiveRestoreErrorCode.DEPENDENCY_UNAVAILABLE,
        'archive restore backend unavailable',
        correlationId,
        503,
        true,
      );
    }
    return errorResponse(
      ArchiveRestoreErrorCode.INTERNAL,
      'unexpected error confirming restore',
      correlationId,
      500,
      true,
    );
  }
}
