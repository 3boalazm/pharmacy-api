import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { IsIn, IsOptional, IsString } from "class-validator";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, IdemKey, Roles } from "../common/auth";
import { DomainException } from "../common/errors";
import { IdempotencyService } from "../common/idempotency.service";
import { AuditService } from "../platform/audit.service";
import { OutboxService } from "../platform/outbox.service";
import { EVENTS } from "../platform/events";
import { SalesService } from "../sales/sales.service";
import { randomUUID } from "crypto";

const FLOW: Record<string, string[]> = {
  PENDING: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["DELIVERED", "CANCELLED"],
};

class StatusDto {
  @IsIn(["ACCEPTED", "PREPARING", "READY", "CANCELLED"]) status!: "ACCEPTED" | "PREPARING" | "READY" | "CANCELLED";
  @IsOptional() @IsString() reason?: string;
}
class DeliverDto {
  @IsIn(["CASH", "CARD", "CREDIT"]) payment!: "CASH" | "CARD" | "CREDIT";
}

/**
 * شاشة الطلبات (طرف الصيدلية): الطلب نية فقط حتى التسليم — POST /orders/:id/deliver
 * هو لحظة الحقيقة الوحيدة: يستدعي نفس البيع الذري (DUR ⟶ تسعير الخادم ⟶ بوابة
 * الائتمان ⟶ FEFO ⟶ فاتورة + قيود). لو رفض البيع (نقص/تعارض دوائي/حد ائتمان)
 * يظل الطلب READY ويُحل على الكاونتر — لا تجاوزات صامتة أونلاين.
 */
@Controller("orders")
export class OrdersAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idem: IdempotencyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sales: SalesService,
  ) {}

  @Get()
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async list(@CurrentActor() actor: Actor, @Query("status") status?: string) {
    return this.prisma.onlineOrder.findMany({
      where: { pharmacyId: actor.pharmacyId, status: status || undefined },
      include: { lines: true, customer: { select: { name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  @Patch(":id/status")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async setStatus(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: StatusDto) {
    const order = await this.prisma.onlineOrder.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!order) throw new DomainException("NOT_FOUND", "الطلب غير موجود", 404);
    if (!FLOW[order.status]?.includes(dto.status)) {
      throw new DomainException("VALIDATION_ERROR", `لا يمكن الانتقال من ${order.status} إلى ${dto.status}`, 422);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.onlineOrder.update({ where: { id }, data: { status: dto.status } });
      await this.audit.record(tx, actor, "ORDER_STATUS_CHANGED", "OnlineOrder", id, {
        from: order.status, to: dto.status, reason: dto.reason,
      });
      await this.outbox.publish(tx, actor.pharmacyId, EVENTS.OrderStatusChanged, {
        orderId: id, customerId: order.customerId, status: dto.status,
      });
      return updated;
    });
  }

  /** READY → DELIVERED: التحويل لفاتورة حقيقية عبر مسار البيع الذري نفسه. */
  @Post(":id/deliver")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async deliver(@CurrentActor() actor: Actor, @IdemKey() key: string, @Param("id") id: string, @Body() dto: DeliverDto) {
    return this.idem.run(actor.pharmacyId, key, "POST /orders/deliver", async () => {
      const order = await this.prisma.onlineOrder.findFirst({
        where: { id, pharmacyId: actor.pharmacyId },
        include: { lines: true },
      });
      if (!order) throw new DomainException("NOT_FOUND", "الطلب غير موجود", 404);
      if (order.status !== "READY") throw new DomainException("VALIDATION_ERROR", "جهّز الطلب أولًا (READY) قبل التسليم", 422);

      const sale = await this.sales.createSale(actor, {
        clientSaleId: randomUUID(),
        clientTimestamp: new Date().toISOString(),
        customerId: order.customerId,
        prescriptionId: null,
        lines: order.lines.map((l) => ({
          medicineId: l.medicineId,
          quantity: l.quantity,
          unitPrice: l.unitPrice.toFixed(4),
        })),
        payment: { method: dto.payment },
      });

      await this.prisma.$transaction(async (tx) => {
        await tx.onlineOrder.update({ where: { id }, data: { status: "DELIVERED", invoiceId: sale.invoiceId } });
        await this.audit.record(tx, actor, "ORDER_DELIVERED", "OnlineOrder", id, {
          invoiceId: sale.invoiceId, payment: dto.payment,
        });
        await this.outbox.publish(tx, actor.pharmacyId, EVENTS.OrderStatusChanged, {
          orderId: id, customerId: order.customerId, status: "DELIVERED", invoiceId: sale.invoiceId,
        });
      });
      return { orderId: id, invoiceId: sale.invoiceId, invoiceNo: sale.invoiceNo, total: sale.total };
    });
  }
}
