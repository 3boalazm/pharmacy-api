import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CreateGrnDto } from "./dto/grn.dto";
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
}
