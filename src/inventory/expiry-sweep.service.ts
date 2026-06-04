import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma.service";
import { BatchRepository } from "./repositories/batch.repository";
import { OutboxService } from "../platform/outbox.service";
import { EVENTS } from "../platform/events";

/**
 * Expiry Tracking — WF-6 nightly sweep (02:30):
 *  1. ACTIVE batches past expiry → status EXPIRED (FEFO already excludes them by date;
 *     the status flip makes the state visible and reportable). Stock leaves only via
 *     WF-4 write-off afterwards — never silently.
 *  2. Early warnings at T-30: BatchExpiringSoon outbox event → deduped EXPIRY alert.
 */
@Injectable()
export class ExpirySweepService {
  private readonly log = new Logger(ExpirySweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly batches: BatchRepository,
    private readonly outbox: OutboxService,
  ) {}

  @Cron("30 2 * * *")
  async sweep(): Promise<void> {
    // 1. Flip newly-expired batches
    const expired = await this.batches.findNewlyExpired();
    for (const b of expired) {
      await this.prisma.$transaction(async (tx) => {
        await tx.batch.update({ where: { id: b.id }, data: { status: "EXPIRED" } });
        await this.outbox.publish(tx, b.pharmacyId, EVENTS.BatchExpiringSoon, {
          batchId: b.id,
          medicineId: b.medicineId,
          nameAr: b.medicine.tradeNameAr,
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate.toISOString(),
          quantity: b.quantityOnHand,
          phase: "EXPIRED",
        });
      });
    }
    if (expired.length) this.log.warn(`Marked ${expired.length} batches EXPIRED`);

    // 2. T-30 early warnings
    const soon = await this.batches.findExpiringWithin(30);
    for (const b of soon) {
      const dup = await this.prisma.alert.findFirst({
        where: { pharmacyId: b.pharmacyId, type: "EXPIRY", refId: b.id, status: "UNREAD" },
      });
      if (dup) continue;
      await this.prisma.$transaction(async (tx) => {
        await this.outbox.publish(tx, b.pharmacyId, EVENTS.BatchExpiringSoon, {
          batchId: b.id,
          medicineId: b.medicineId,
          nameAr: b.medicine.tradeNameAr,
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate.toISOString(),
          quantity: b.quantityOnHand,
          phase: "T30",
        });
      });
    }
  }
}
