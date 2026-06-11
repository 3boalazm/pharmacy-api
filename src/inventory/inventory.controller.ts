import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CreateGrnDto } from "./dto/grn.dto";
import { DomainException } from "../common/errors";
import { PrismaService, Tx } from "../common/prisma.service";
import { AuditService } from "../platform/audit.service";
import { AdjustDto } from "./dto/adjust.dto";
import { InventoryService } from "./inventory.service";
import { IdempotencyService } from "../common/idempotency.service";
import { CacheService } from "../platform/cache.service";
import { Actor, CurrentActor, IdemKey, Roles } from "../common/auth";




@Controller()
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly idem: IdempotencyService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  /** GET /stock — on-hand projection (Contract §4). */
  @Get("stock")
  @Roles("ASSISTANT", "PHARMACIST", "CASHIER")
  async stock(
    @CurrentActor() actor: Actor,
    @Query("search") search?: string,
    @Query("belowMin") belowMin?: string,
    @Query("expiringWithinDays") expiring?: string,
  ) {
    const filters = { search, belowMin: belowMin === "true", expiringWithinDays: expiring ? Number(expiring) : undefined };
    const cacheable = !filters.search && !filters.belowMin && !filters.expiringWithinDays;
    if (cacheable) {
      const cached = await this.cache.get<unknown[]>(`stock:${actor.pharmacyId}`);
      if (cached) return cached;
    }
    const rows = await this.inventory.stock(actor.pharmacyId, filters);
    if (cacheable) {
      await this.cache.set(`stock:${actor.pharmacyId}`, rows.map((r) => ({ ...r, nearestExpiry: r.nearestExpiry?.toISOString() ?? null })), 30);
    }
    return rows;
  }

  /** GET /stock/:medicineId/batches — FEFO-ordered batches. */
  @Get("stock/:medicineId/batches")
  @Roles("ASSISTANT", "PHARMACIST")
  async batches(@CurrentActor() actor: Actor, @Param("medicineId") medicineId: string) {
    return this.inventory.batches(actor.pharmacyId, medicineId);
  }

  /** POST /inventory/grn — the only door for stock to enter (Idempotency-Key mandatory). */
  @Post("inventory/grn")
  @Roles("ASSISTANT", "PHARMACIST")
  async grn(@CurrentActor() actor: Actor, @IdemKey() key: string, @Body() dto: CreateGrnDto) {
    return this.idem.run(actor.pharmacyId, key, "POST /inventory/grn", () => this.inventory.createGrn(actor, dto));
  }

  /** POST /inventory/adjustments — WF-4 count correction / damage / write-off (Idempotency-Key mandatory). */
  @Post("inventory/adjustments")
  @Roles("ASSISTANT", "PHARMACIST")
  async adjust(@CurrentActor() actor: Actor, @IdemKey() key: string, @Body() dto: AdjustDto) {
    return this.idem.run(actor.pharmacyId, key, "POST /inventory/adjustments", () => this.inventory.adjust(actor, dto));
  }

  /** POST /batches/:id/quarantine — حجر تشغيلة عن البيع (قرار صيدلي، مُدقَّق). كان زرها بلا مسار — أُصلح. */
  @Post("batches/:id/quarantine")
  @Roles("PHARMACIST")
  async quarantine(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: { reason?: string }) {
    const batch = await this.prisma.batch.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!batch) throw new DomainException("NOT_FOUND", "التشغيلة غير موجودة", 404);
    return this.prisma.$transaction(async (tx: Tx) => {
      const updated = await tx.batch.update({
        where: { id },
        data: { status: batch.status === "QUARANTINED" ? "ACTIVE" : "QUARANTINED" },
      });
      await this.audit.record(tx, actor, "BATCH_QUARANTINE_TOGGLED", "Batch", id, {
        to: updated.status, reason: body.reason,
      });
      await this.cache.del(`stock:${actor.pharmacyId}`);
      return updated;
    });
  }

  /** GET /movements — سجل حركات المخزون الدائم (append-only): استلام/بيع/مرتجع/تسوية/إعدام. */
  @Get("movements")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async movements(
    @CurrentActor() actor: Actor,
    @Query("medicineId") medicineId?: string,
    @Query("type") type?: string,
  ) {
    const rows = await this.prisma.inventoryTransaction.findMany({
      where: {
        pharmacyId: actor.pharmacyId,
        ...(medicineId && { medicineId }),
        ...(type && { type: type as never }),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const medIds = [...new Set(rows.map((r) => r.medicineId))];
    const batchIds = [...new Set(rows.map((r) => r.batchId))];
    const [meds, batches] = await Promise.all([
      this.prisma.medicine.findMany({ where: { id: { in: medIds } }, select: { id: true, tradeNameAr: true, form: true } }),
      this.prisma.batch.findMany({ where: { id: { in: batchIds } }, select: { id: true, batchNumber: true } }),
    ]);
    const medMap = new Map(meds.map((m) => [m.id, m]));
    const batchMap = new Map(batches.map((b) => [b.id, b.batchNumber]));
    return rows.map((r) => ({
      id: r.id, type: r.type, quantity: r.quantity, unitCost: r.unitCost,
      referenceType: r.referenceType, createdAt: r.createdAt,
      medicine: medMap.get(r.medicineId) ?? null, batchNumber: batchMap.get(r.batchId) ?? null,
    }));
  }

  /** GET /reorder-suggestions — قائمة شراء مقترحة: تحت حد الأمان + سرعة بيع 28 يومًا لتغطية 14 يومًا. */
  @Get("reorder-suggestions")
  @Roles("ASSISTANT", "PHARMACIST")
  async reorderSuggestions(@CurrentActor() actor: Actor) {
    const rows = await this.prisma.$queryRaw<
      { id: string; name: string; stock: number; minLevel: number; sold28: number }[]
    >`
      SELECT m.id, m."tradeNameAr" AS name, m."minStockLevel" AS "minLevel",
             COALESCE(SUM(b."quantityOnHand") FILTER (WHERE b.status = 'ACTIVE' AND b."expiryDate" > now()), 0)::int AS stock,
             COALESCE((SELECT SUM(si.quantity)::int FROM sales_items si
                       JOIN sales_invoices inv ON inv.id = si."invoiceId"
                       WHERE si."medicineId" = m.id AND inv."createdAt" > now() - interval '28 days'), 0) AS sold28
      FROM medicines m
      LEFT JOIN batches b ON b."medicineId" = m.id
      WHERE m."pharmacyId" = ${actor.pharmacyId}::uuid AND m."archivedAt" IS NULL
      GROUP BY m.id
      HAVING COALESCE(SUM(b."quantityOnHand") FILTER (WHERE b.status = 'ACTIVE' AND b."expiryDate" > now()), 0)
             <= GREATEST(m."minStockLevel", 0)
         OR (COALESCE((SELECT SUM(si.quantity) FROM sales_items si
                       JOIN sales_invoices inv ON inv.id = si."invoiceId"
                       WHERE si."medicineId" = m.id AND inv."createdAt" > now() - interval '28 days'), 0) / 28.0 * 7)
            > COALESCE(SUM(b."quantityOnHand") FILTER (WHERE b.status = 'ACTIVE' AND b."expiryDate" > now()), 0)
      ORDER BY stock ASC
      LIMIT 100`;
    return rows.map((r) => {
      const dailyVelocity = r.sold28 / 28;
      const daysLeft = dailyVelocity > 0 ? Math.floor(r.stock / dailyVelocity) : null;
      const suggested = Math.max(Math.ceil(dailyVelocity * 14) - r.stock, r.minLevel > 0 ? r.minLevel * 2 - r.stock : 0, 0);
      return { ...r, dailyVelocity: dailyVelocity.toFixed(2), daysLeft, suggestedQty: suggested };
    }).filter((r) => r.suggestedQty > 0);
  }
}
