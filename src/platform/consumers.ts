import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { CacheService } from "./cache.service";
import { DomainEvent, EVENTS, SaleCompletedPayload } from "./events";

/**
 * Async consumers — REACTIONS to committed facts (Architecture §2):
 * projections, loyalty, alerts. Never stock truth, never ledger truth.
 * All handlers are idempotent (keyed on event id where it matters).
 */
@Injectable()
export class PlatformConsumers {
  private readonly log = new Logger(PlatformConsumers.name);
  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService) {}

  /** Loyalty + customer projections (cached values; ledger remains the truth). */
  @OnEvent(EVENTS.SaleCompleted)
  async onSaleCompleted(event: DomainEvent<SaleCompletedPayload>) {
    // R-3: a sale changes stock + KPIs → drop both caches (event-driven invalidation).
    await this.cache.del(`dash:${event.pharmacyId}`, `stock:${event.pharmacyId}`);
    const { customerId, total, invoiceId } = event.payload;
    if (!customerId) return;
    const points = Math.floor(Number(total) / 10); // 1 pt / 10 EGP (configurable later)
    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        loyaltyPoints: { increment: points },
        totalPurchases: { increment: new Prisma.Decimal(total) },
        lastVisit: new Date(),
      },
    });
    this.log.debug(`Loyalty +${points} for customer ${customerId} (invoice ${invoiceId})`);
  }

  @OnEvent(EVENTS.LowStockDetected)
  async onLowStock(event: DomainEvent<{ medicineId: string; nameAr: string; onHand: number; minStockLevel: number }>) {
    const { medicineId, nameAr, onHand, minStockLevel } = event.payload;
    const dup = await this.prisma.alert.findFirst({
      where: { pharmacyId: event.pharmacyId, type: "LOW_STOCK", refId: medicineId, status: "UNREAD" },
    });
    if (dup) return; // idempotent: one open alert per medicine
    await this.prisma.alert.create({
      data: {
        pharmacyId: event.pharmacyId,
        type: "LOW_STOCK",
        refId: medicineId,
        message: `الصنف «${nameAr}» وصل إلى ${onHand} (حد الأمان ${minStockLevel})`,
      },
    });
  }

  @OnEvent(EVENTS.CreditLimitBreached)
  async onCreditLimitBreached(event: DomainEvent<{ customerId: string; customerName: string; balance: string; creditLimit: string }>) {
    await this.prisma.alert.create({
      data: {
        pharmacyId: event.pharmacyId,
        type: "CREDIT_LIMIT",
        refId: event.payload.customerId,
        message: `العميل «${event.payload.customerName}» تجاوز حد الائتمان (${event.payload.balance} / ${event.payload.creditLimit})`,
      },
    });
  }

  @OnEvent(EVENTS.PaymentRecorded)
  async onPaymentRecorded(event: DomainEvent<{ customerId?: string; amount: string }>) {
    await this.cache.del(`dash:${event.pharmacyId}`);
    if (!event.payload.customerId) return;
    await this.prisma.customer.update({
      where: { id: event.payload.customerId },
      data: { totalPaid: { increment: new Prisma.Decimal(event.payload.amount) } },
    });
  }

  @OnEvent(EVENTS.StockReceived)
  async onStockReceived(event: DomainEvent) {
    await this.cache.del(`stock:${event.pharmacyId}`, `dash:${event.pharmacyId}`);
  }

  @OnEvent(EVENTS.StockAdjusted)
  async onStockAdjusted(event: DomainEvent) {
    await this.cache.del(`stock:${event.pharmacyId}`, `dash:${event.pharmacyId}`);
  }

  @OnEvent(EVENTS.SaleReturned)
  async onSaleReturned(event: DomainEvent) {
    await this.cache.del(`stock:${event.pharmacyId}`, `dash:${event.pharmacyId}`);
  }

  @OnEvent(EVENTS.BatchExpiringSoon)
  async onBatchExpiringSoon(
    event: DomainEvent<{ batchId: string; nameAr: string; batchNumber: string; expiryDate: string; quantity: number; phase: "T30" | "EXPIRED" }>,
  ) {
    const { batchId, nameAr, batchNumber, expiryDate, quantity, phase } = event.payload;
    const dup = await this.prisma.alert.findFirst({
      where: { pharmacyId: event.pharmacyId, type: "EXPIRY", refId: batchId, status: "UNREAD" },
    });
    if (dup) return;
    const date = new Date(expiryDate).toLocaleDateString("ar-EG");
    await this.prisma.alert.create({
      data: {
        pharmacyId: event.pharmacyId,
        type: "EXPIRY",
        refId: batchId,
        message:
          phase === "EXPIRED"
            ? `انتهت صلاحية تشغيلة ${batchNumber} — «${nameAr}» (${quantity} وحدة) — مطلوب إعدام (WF-4)`
            : `تشغيلة ${batchNumber} — «${nameAr}» تنتهي في ${date} (${quantity} وحدة)`,
      },
    });
    await this.cache.del(`stock:${event.pharmacyId}`);
  }

  @OnEvent(EVENTS.OrderPlaced)
  async onOrderPlaced(event: DomainEvent<{ orderId: string; total: string; fulfillment: string }>) {
    await this.prisma.alert.create({
      data: {
        pharmacyId: event.pharmacyId,
        type: "ORDER",
        refId: event.payload.orderId,
        message: `طلب أونلاين جديد بقيمة ${event.payload.total} ج.م (${event.payload.fulfillment === "DELIVERY" ? "توصيل" : "استلام من الصيدلية"})`,
      },
    });
  }
}
