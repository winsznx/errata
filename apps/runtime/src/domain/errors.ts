export type DomainErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "STALE_EVIDENCE"
  | "INELIGIBLE_SOURCE"
  | "INVALID_INPUT"
  | "UNVERIFIED_CLAIM"
  | "APPROVAL_EXPIRED"
  | "SELF_VERIFICATION"
  | "IDEMPOTENCY_MISMATCH"
  | "QUOTA_EXCEEDED"
  | "REPLAY_FINISHED"
  | "BLOCKED";

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  STALE_EVIDENCE: 409,
  INELIGIBLE_SOURCE: 422,
  INVALID_INPUT: 400,
  UNVERIFIED_CLAIM: 422,
  APPROVAL_EXPIRED: 409,
  SELF_VERIFICATION: 422,
  IDEMPOTENCY_MISMATCH: 409,
  QUOTA_EXCEEDED: 429,
  REPLAY_FINISHED: 409,
  BLOCKED: 422,
};

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryable = false,
  ) {
    super(message);
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

export function assert(condition: unknown, code: DomainErrorCode, message: string, details: Record<string, unknown> = {}): asserts condition {
  if (!condition) throw new DomainError(code, message, details);
}
