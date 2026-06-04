import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { DomainException } from "./errors";
import { serialize } from "./http.shape";

/**
 * Idempotency per Contract §0.5: financial/inventory POSTs require Idempotency-Key.
 * Duplicate key with a stored response → replay (200, original body).
 */
@Injectable()
export class IdempotencyService {
  private readonly log = new Logger(IdempotencyService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Audit remediation R7: purge replay keys older than 90 days (nightly, 03:10). */
  @Cron("10 3 * * *")
  async purgeExpired() {
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const { count } = await this.prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (count > 0) this.log.log(`Purged ${count} idempotency keys older than 90d`);
  }

  async run<T>(pharmacyId: string, key: string, endpoint: string, work: () => Promise<T>): Promise<T> {
    try {
      await this.prisma.idempotencyKey.create({ data: { pharmacyId, key, endpoint } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const existing = await this.prisma.idempotencyKey.findUnique({
          where: { pharmacyId_key: { pharmacyId, key } },
        });
        if (existing?.status === "DONE") return existing.response as T;
        throw new DomainException("IDEMPOTENT_IN_PROGRESS", "Request with this key is still processing; retry shortly.");
      }
      throw e;
    }

    const result = await work();
    await this.prisma.idempotencyKey.update({
      where: { pharmacyId_key: { pharmacyId, key } },
      data: { status: "DONE", response: serialize(result) as Prisma.InputJsonValue },
    });
    return result;
  }
}
