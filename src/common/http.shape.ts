import {
  ArgumentsHost, CallHandler, Catch, ExceptionFilter, ExecutionContext,
  HttpException, Injectable, NestInterceptor,
} from "@nestjs/common";
import { Observable, map } from "rxjs";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { Response } from "express";

/** Money serialization rule (Contract §0.5): Decimal → string with 4dp. Recursive. */
export function serialize(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toFixed(4);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serialize(v)]));
  }
  return value;
}

/** Success envelope { data, meta } per Contract §0.3. */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const requestId: string =
      (ctx.switchToHttp().getRequest<{ requestId?: string }>().requestId) ?? randomUUID();
    return next.handle().pipe(
      map((body) => {
        if (body && typeof body === "object" && "data" in (body as object)) {
          const b = body as { data: unknown; meta?: Record<string, unknown> };
          return { data: serialize(b.data), meta: { requestId, ...(b.meta ?? {}) } };
        }
        return { data: serialize(body), meta: { requestId } };
      }),
    );
  }
}

/** Error envelope { error: { code, message, details, requestId } } per Contract §0.4. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId =
      host.switchToHttp().getRequest<{ requestId?: string }>().requestId ?? randomUUID();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse() as Record<string, unknown> | string;
      const body = typeof r === "string" ? { code: "ERROR", message: r } : r;
      return res.status(status).json({
        error: {
          code: (body as { code?: string }).code ?? (status === 422 ? "VALIDATION_ERROR" : "ERROR"),
          message: (body as { message?: string | string[] }).message ?? exception.message,
          details: (body as { details?: unknown[] }).details,
          requestId,
        },
      });
    }
    const msg = exception instanceof Error ? exception.message : "Internal error";
    if (msg.includes("append-only")) {
      return res.status(409).json({ error: { code: "CONFLICT", message: "Record is immutable; post a contra entry instead.", requestId } });
    }
    if (msg.includes("period") && msg.includes("closed")) {
      return res.status(409).json({ error: { code: "PERIOD_CLOSED", message: "Accounting period is closed.", requestId } });
    }
    return res.status(500).json({ error: { code: "INTERNAL", message: "Unexpected error", requestId } });
  }
}
