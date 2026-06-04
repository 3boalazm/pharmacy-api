import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../common/prisma.service';
import { DomainException } from '../common/errors';
import { Actor } from '../common/auth';
import { OutboxService } from '../platform/outbox.service';
import { AuditService } from '../platform/audit.service';
import { EVENTS } from '../platform/events';
import { ACCOUNTS, LedgerService } from '../finance/ledger.service';
import { BatchRepository } from './repositories/batch.repository';

export interface Allocation {
  batchId: string;
  batchNumber: string;
  quantity: number;
  unitCost: Prisma.Decimal;
}

/**
 * Inventory bounded context — the single owner of quantity truth (Architecture §3).
 * FEFO + row locks + append-only movements + no-negative-stock (Architecture §4.2, BINDING).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly batchRepo: BatchRepository,
  ) {}

  /**
   * FEFO allocation INSIDE the caller's transaction.
   * SELECT ... FOR UPDATE on candidate batches ordered by expiry — expired/quarantined
   * batches are structurally excluded, so the "no expired dispensing" rule cannot be bypassed.
   * Concurrent sales of the same medicine serialize on the batch rows.
   */
  async allocateFefo(tx: Tx, pharmacyId: string, medicineId: string, quantity: number): Promise<Allocation[]> {
    const candidates = await this.batchRepo.lockFefoCandidates(tx, pharmacyId, medicineId);

    const allocations: Allocation[] = [];
    let remaining = quantity;
    for (const b of candidates) {
      if (remaining === 0) break;
      const take = Math.min(remaining, b.quantityOnHand);
      allocations.push({ batchId: b.id, batchNumber: b.batchNumber, quantity: take, unitCost: new Prisma.Decimal(b.unitCost) });
      remaining -= take;
    }
    if (remaining > 0) {
      const available = quantity - remaining;
      throw new DomainException(
        'INSUFFICIENT_STOCK',
        `Insufficient stock for medicine ${medicineId}: requested ${quantity}, available ${available}`,
        409,
        [{ medicineId, requested: quantity, available }],
      );
    }

    for (const a of allocations) {
      const updated = await tx.batch.update({
        where: { id: a.batchId },
        data: { quantityOnHand: { decrement: a.quantity } },
      });
      if (updated.quantityOnHand === 0) {
        await tx.batch.update({ where: { id: a.batchId }, data: { status: 'DEPLETED' } });
      }
    }
    return allocations;
  }

  /** Append a movement row (the perpetual ledger) for each allocation. */
  async writeMovements(
    tx: Tx,
    actor: Actor,
    medicineId: string,
    allocations: Allocation[],
    type: 'SALE' | 'RETURN_IN' | 'GRN' | 'ADJUSTMENT' | 'WRITE_OFF',
    sign: 1 | -1,
    referenceType: string,
    referenceId: string,
  ) {
    for (const a of allocations) {
      await tx.inventoryTransaction.create({
        data: {
          pharmacyId: actor.pharmacyId,
          medicineId,
          batchId: a.batchId,
          type,
          quantity: sign * a.quantity,
          unitCost: a.unitCost,
          referenceType,
          referenceId,
          actorUserId: actor.userId,
        },
      });
    }
  }

  /** After a sale: detect threshold breach and publish LowStockDetected (sub-event chain, Architecture §2). */
  async detectLowStock(tx: Tx, pharmacyId: string, medicineId: string) {
    const med = await tx.medicine.findFirst({ where: { id: medicineId, pharmacyId } });
    if (!med) return;
    const agg = await tx.batch.aggregate({
      where: { pharmacyId, medicineId, status: 'ACTIVE' },
      _sum: { quantityOnHand: true },
    });
    const onHand = agg._sum.quantityOnHand ?? 0;
    if (onHand <= med.minStockLevel) {
      await this.outbox.publish(tx, pharmacyId, EVENTS.LowStockDetected, {
        medicineId,
        nameAr: med.tradeNameAr,
        onHand,
        minStockLevel: med.minStockLevel,
      });
    }
  }

  /**
   * GRN — the ONLY way stock enters (Contract §4). One ACID transaction:
   * batches + movements + AP/cash journal entry. Stock fact and financial fact born together.
   */
  async createGrn(
    actor: Actor,
    input: {
      supplierId: string;
      supplierInvoiceNo: string;
      receivedAt: string;
      paymentTerms: 'CASH' | 'CREDIT';
      lines: { medicineId: string; batchNumber: string; expiryDate: string; quantity: number; unitCost: string; bonusQuantity?: number }[];
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, pharmacyId: actor.pharmacyId } });
      if (!supplier) throw new DomainException('NOT_FOUND', 'Supplier not found', 404);
      if (input.lines.length === 0) throw new DomainException('VALIDATION_ERROR', 'GRN requires at least one line', 422);

      let totalCost = new Prisma.Decimal(0);
      const createdLines: { medicineId: string; batchId: string; quantity: number; bonusQty: number; unitCost: Prisma.Decimal }[] = [];

      for (const line of input.lines) {
        if (new Date(line.expiryDate) <= new Date()) {
          throw new DomainException('EXPIRED_BATCH_BLOCKED', `Batch ${line.batchNumber} is already expired`, 409);
        }
        const unitCost = new Prisma.Decimal(line.unitCost);
        const totalQty = line.quantity + (line.bonusQuantity ?? 0);
        const batch = await tx.batch.create({
          data: {
            pharmacyId: actor.pharmacyId,
            medicineId: line.medicineId,
            batchNumber: line.batchNumber,
            expiryDate: new Date(line.expiryDate),
            quantityOnHand: totalQty,
            unitCost,
          },
        });
        totalCost = totalCost.add(unitCost.mul(line.quantity)); // bonus units carry zero invoice cost
        createdLines.push({ medicineId: line.medicineId, batchId: batch.id, quantity: line.quantity, bonusQty: line.bonusQuantity ?? 0, unitCost });
      }

      // Financial fact: Inventory asset debit / AP (or cash) credit
      const { entryId } = await this.ledger.postEntry(tx, actor, {
        sourceType: 'GRN',
        memo: `استلام شحنة ${input.supplierInvoiceNo} — ${supplier.name}`,
        lines: [
          { account: ACCOUNTS.INVENTORY, debit: totalCost },
          input.paymentTerms === 'CREDIT'
            ? { account: ACCOUNTS.AP, credit: totalCost, supplierId: supplier.id }
            : { account: ACCOUNTS.CASH, credit: totalCost },
        ],
      });

      const grn = await tx.grn.create({
        data: {
          pharmacyId: actor.pharmacyId,
          supplierId: supplier.id,
          supplierInvoiceNo: input.supplierInvoiceNo,
          paymentTerms: input.paymentTerms,
          journalEntryId: entryId,
          receivedAt: new Date(input.receivedAt),
          createdByUserId: actor.userId,
          lines: { create: createdLines },
        },
        include: { lines: true },
      });

      for (const l of grn.lines) {
        await tx.inventoryTransaction.create({
          data: {
            pharmacyId: actor.pharmacyId,
            medicineId: l.medicineId,
            batchId: l.batchId,
            type: 'GRN',
            quantity: l.quantity + l.bonusQty,
            unitCost: l.unitCost,
            referenceType: 'GRN',
            referenceId: grn.id,
            actorUserId: actor.userId,
          },
        });
      }

      if (input.paymentTerms === 'CREDIT') {
        await tx.supplier.update({ where: { id: supplier.id }, data: { balanceCached: { increment: totalCost } } });
      }

      await this.audit.record(tx, actor, 'GRN_POSTED', 'Grn', grn.id, { supplierInvoiceNo: input.supplierInvoiceNo, totalCost: totalCost.toFixed(4) });
      await this.outbox.publish(tx, actor.pharmacyId, EVENTS.StockReceived, {
        grnId: grn.id, supplierId: supplier.id, totalCost: totalCost.toFixed(4),
      });

      return { grnId: grn.id, journalEntryId: entryId, lines: grn.lines.map((l) => ({ batchId: l.batchId })) };
    });
  }

  /** On-hand projection per medicine (Contract §4 GET /stock). */
  async stock(pharmacyId: string, filter: { search?: string; belowMin?: boolean; expiringWithinDays?: number }) {
    const rows = await this.batchRepo.stockProjection(pharmacyId, filter.search ?? '');

    return rows
      .map((r) => {
        const onHand = Number(r.onHand ?? 0);
        return {
          medicineId: r.medicineId,
          tradeNameAr: r.tradeNameAr,
          scientificName: r.scientificName,
          onHand,
          minStockLevel: r.minStockLevel,
          nearestExpiry: r.nearestExpiry,
          batchCount: Number(r.batchCount),
          status: onHand === 0 ? 'OUT' : onHand <= r.minStockLevel ? 'LOW' : 'OK',
        };
      })
      .filter((r) => (filter.belowMin ? r.onHand <= r.minStockLevel : true))
      .filter((r) =>
        filter.expiringWithinDays && r.nearestExpiry
          ? r.nearestExpiry.getTime() - Date.now() <= filter.expiringWithinDays * 86_400_000
          : !filter.expiringWithinDays,
      );
  }


  /**
   * Manual adjustment / write-off (WF-4, BR-1.5): one ACID transaction —
   * batch quantity change + signed ADJUSTMENT/WRITE_OFF movement + balanced journal
   * (loss → DR 5100 Write-off / CR 1200 Inventory; gain → DR 1200 / CR 5900 Over/Short).
   * Reason is mandatory and audited. CHECK qty >= 0 still guards removals.
   */
  async adjust(actor: Actor, input: AdjustInput) {
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findFirst({ where: { id: input.batchId, pharmacyId: actor.pharmacyId } });
      if (!batch) throw new DomainException('NOT_FOUND', 'Batch not found', 404);
      if (input.quantity === 0) throw new DomainException('VALIDATION_ERROR', 'Quantity cannot be zero', 422);
      if (input.quantity < 0 && batch.quantityOnHand + input.quantity < 0) {
        throw new DomainException('INSUFFICIENT_STOCK', `Batch has ${batch.quantityOnHand}; cannot remove ${-input.quantity}`, 409,
          [{ batchId: batch.id, available: batch.quantityOnHand }]);
      }

      const updated = await tx.batch.update({
        where: { id: batch.id },
        data: { quantityOnHand: { increment: input.quantity } },
      });
      if (updated.quantityOnHand === 0 && batch.status === 'ACTIVE') {
        await tx.batch.update({ where: { id: batch.id }, data: { status: 'DEPLETED' } });
      }
      if (updated.quantityOnHand > 0 && batch.status === 'DEPLETED') {
        await tx.batch.update({ where: { id: batch.id }, data: { status: 'ACTIVE' } });
      }

      const movementType = input.reason === 'EXPIRY_WRITE_OFF' || input.reason === 'DAMAGE' || input.reason === 'THEFT' ? 'WRITE_OFF' : 'ADJUSTMENT';
      await tx.inventoryTransaction.create({
        data: {
          pharmacyId: actor.pharmacyId,
          medicineId: batch.medicineId,
          batchId: batch.id,
          type: movementType,
          quantity: input.quantity,
          unitCost: batch.unitCost,
          referenceType: 'ADJUSTMENT',
          referenceId: batch.id,
          actorUserId: actor.userId,
        },
      });

      const value = new Prisma.Decimal(batch.unitCost).mul(Math.abs(input.quantity));
      const { entryId } = await this.ledger.postEntry(tx, actor, {
        sourceType: 'ADJUSTMENT',
        memo: `تسوية مخزون (${input.reason})${input.note ? ' — ' + input.note : ''}`,
        lines:
          input.quantity < 0
            ? [
                { account: ACCOUNTS.WRITE_OFF, debit: value },
                { account: ACCOUNTS.INVENTORY, credit: value },
              ]
            : [
                { account: ACCOUNTS.INVENTORY, debit: value },
                { account: ACCOUNTS.OVER_SHORT, credit: value },
              ],
      });

      await this.audit.record(tx, actor, 'STOCK_ADJUSTED', 'Batch', batch.id, {
        quantity: input.quantity, reason: input.reason, note: input.note, journalEntryId: entryId,
      });
      await this.outbox.publish(tx, actor.pharmacyId, EVENTS.StockAdjusted, {
        batchId: batch.id, medicineId: batch.medicineId, quantity: input.quantity, reason: input.reason,
      });
      await this.detectLowStock(tx, actor.pharmacyId, batch.medicineId);

      return { batchId: batch.id, newQuantity: updated.quantityOnHand, journalEntryId: entryId };
    });
  }

  async batches(pharmacyId: string, medicineId: string) {
    const rows = await this.prisma.batch.findMany({
      where: { pharmacyId, medicineId },
      orderBy: [{ status: 'asc' }, { expiryDate: 'asc' }],
    });
    let order = 0;
    return rows.map((b) => ({
      id: b.id,
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      quantity: b.quantityOnHand,
      unitCost: b.unitCost,
      status: b.status,
      fefoOrder: b.status === 'ACTIVE' && b.quantityOnHand > 0 ? ++order : 0,
    }));
  }
}

/* ───────── Stock Adjustments (WF-4): count corrections, damage, expiry write-off ───────── */
export type AdjustmentReason = "COUNT_CORRECTION" | "DAMAGE" | "EXPIRY_WRITE_OFF" | "THEFT" | "OTHER";

export interface AdjustInput {
  batchId: string;
  quantity: number; // signed: negative = remove stock, positive = add back
  reason: AdjustmentReason;
  note?: string;
}
