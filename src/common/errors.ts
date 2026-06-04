import { HttpException, HttpStatus } from "@nestjs/common";

/** Error model per API Contract §0.4 — { error: { code, message, details } } */
export class DomainException extends HttpException {
  constructor(
    public readonly code:
      | "VALIDATION_ERROR" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT"
      | "INSUFFICIENT_STOCK" | "EXPIRED_BATCH_BLOCKED" | "PERIOD_CLOSED"
      | "CREDIT_LIMIT_EXCEEDED" | "DUR_BLOCK" | "IDEMPOTENT_IN_PROGRESS" | "RATE_LIMITED",
    message: string,
    status: HttpStatus = HttpStatus.CONFLICT,
    public readonly details?: unknown[],
  ) {
    super({ code, message, details }, status);
  }
}
