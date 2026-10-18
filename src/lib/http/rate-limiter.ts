/**
 * Fixed-window rate limiter used by public API routes.
 *
 * The limiter key must be derived from something the caller cannot freely
 * rotate. Prefer the authenticated subject (the same value the route already
 * resolves for authz); only fall back to a request header when no subject is
 * available, since headers are attacker-controlled on public routes.
 */

export interface RateLimitDecision {
	allowed: boolean;
	retryAfterMs: number;
}

export interface FixedWindowLimiter {
	check(key: string): RateLimitDecision;
}

/**
 * Derive the limiter key for a request.
 *
 * When `subject` is provided (a verified credential subject), the key is
 * derived from it so a caller cannot obtain a fresh window by rotating
 * spoofable headers. Only when no subject is available do we fall back to a
 * header — this fallback is best-effort and documented here because headers
 * are fully attacker-controlled on public routes.
 */
export function callerKey(request: Request, subject?: string | null): string {
	if (typeof subject === "string" && subject.length > 0) {
		return `subject:${subject}`;
	}
	// Fallback: no verified subject. Headers are spoofable, so this only
	// provides coarse protection for unauthenticated callers.
	const forwarded = request.headers.get("x-forwarded-for");
	const ip = forwarded?.split(",")[0]?.trim();
	if (ip) return `ip:${ip}`;
	return `ip:${request.headers.get("x-real-ip") ?? "unknown"}`;
}

export function createFixedWindowLimiter(
	limit: number,
	windowMs: number,
): FixedWindowLimiter {
	const windows = new Map<string, { count: number; resetAt: number }>();

	return {
		check(key: string): RateLimitDecision {
			const now = Date.now();
			const existing = windows.get(key);
			if (existing === undefined || now >= existing.resetAt) {
				windows.set(key, { count: 1, resetAt: now + windowMs });
				return { allowed: true, retryAfterMs: 0 };
			}
			if (existing.count >= limit) {
				return { allowed: false, retryAfterMs: existing.resetAt - now };
			}
			existing.count += 1;
			return { allowed: true, retryAfterMs: 0 };
		},
	};
}
