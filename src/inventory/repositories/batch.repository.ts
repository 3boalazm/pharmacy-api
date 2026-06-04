import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService, Tx } from "../../common/prisma.service";

export interface LockedBatch {
  id: string;
  batchNumber: string;
  quantityOnHand: number;
  unitCost: Prisma.Decimal;
}
export interface StockProjectionRow {
  medicineId: string;
  tradeNameAr: string;
  scientificName: string;
  minStockLevel: number;
  onHand: bigint | null;
  nearestExpiry: Date | null;
  batchCount: bigint;
}

/**
 * Batch repository — the ONLY place raw SQL touches the batches table.
 * Owns the FEFO lock scan (index: pharmacyId, medicineId, status, expiryDate)
 * and the stock projection. Services express intent; SQL lives here.
 */
@Injectable()
export class BatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** FEFO candidates, row-locked, expired/quarantined structurally excluded (BR-1.2/1.3). */
  async lockFefoCandidates(tx: Tx, pharmacyId: string, medicineId: string): Promise<LockedBatch[]> {
    return tx.$queryRaw<LockedBatch[]>`
      SELECT id, "batchNumber", "quantityOnHand", "unitCost"
      FROM batches
      WHERE "pharmacyId" = ${pharmacyId}::uuid
        AND "medicineId" = ${medicineId}::uuid
        AND status = 'ACTIVE'
        AND "expiryDate" > CURRENT_DATE
        AND "quantityOnHand" > 0
      ORDER BY "expiryDate" ASC, "receivedAt" ASC
      FOR UPDATE`;
  }

  /** On-hand projection grouped per medicine (Contract §4 GET /stock). */
  async stockProjection(pharmacyId: string, search: string): Promise<StockProjectionRow[]> {
    return this.prisma.$queryRaw<StockProjectionRow[]>`
      SELECT m.id AS "medicineId", m."tradeNameAr", m."scientificName", m."minStockLevel",
             COALESCE(SUM(b."quantityOnHand") FILTER (WHERE b.status = 'ACTIVE'), 0) AS "onHand",
             MIN(b."expiryDate") FILTER (WHERE b.status = 'ACTIVE' AND b."quantityOnHand" > 0) AS "nearestExpiry",
             COUNT(b.id) FILTER (WHERE b.status = 'ACTIVE' AND b."quantityOnHand" > 0) AS "batchCount"
      FROM medicines m
      LEFT JOIN batches b ON b."medicineId" = m.id
      WHERE m."pharmacyId" = ${pharmacyId}::uuid AND m."archivedAt" IS NULL
        AND (${search} = '' OR m."tradeNameAr" ILIKE '%' || ${search} || '%' OR m."scientificName" ILIKE '%' || ${search} || '%')
      GROUP BY m.id
      ORDER BY m."tradeNameAr"
      LIMIT 200`;
  }

  /** Batches that crossed their expiry date but are still marked sellable (WF-6 sweep input). */
  async findNewlyExpired(pharmacyId?: string) {
    return this.prisma.batch.findMany({
      where: {
        status: "ACTIVE",
        expiryDate: { lte: new Date() },
        ...(pharmacyId && { pharmacyId }),
      },
      include: { medicine: { select: { tradeNameAr: true } } },
    });
  }

  /** Active batches expiring within `days`, for T-90/T-30 early warnings (WF-6). */
  async findExpiringWithin(days: number) {
    const until = new Date(Date.now() + days * 86_400_000);
    return this.prisma.batch.findMany({
      where: { status: "ACTIVE", quantityOnHand: { gt: 0 }, expiryDate: { gt: new Date(), lte: until } },
      include: { medicine: { select: { tradeNameAr: true } } },
    });
  }
}
