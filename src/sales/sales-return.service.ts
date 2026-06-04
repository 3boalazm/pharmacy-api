import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { DomainException } from '../common/errors';
import { Actor } from '../common/auth';
import { ACCOUNTS, LedgerService } from '../finance/ledger.service';
import { OutboxService } from '../platform/outbox.service';
import { AuditService } from '../platform/audit.service';
import { EVENTS } from '../platform/events';
import { InvoiceRepository } from './repositories/invoice.repository';

const d = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);

export interface CreateReturnInput {
  invoiceId: string;
  reason: string;
  lines: { salesItemId: string; quantity: number }[];
}

/**
 * Sale Returns — WF-3, posting template 09 §"Sale return". ONE ACID transaction:
 *   validate (qty ≤ sold − already returned) → restock RETURN_IN into the ORIGINAL
 *   batches (units 1..Q map deterministically onto the item's allocations in order,
 *   so repeated partial returns restock the exact lots that were drawn) → contra
 *   journal: DR Sales gross_r · CR Discount disc_r · CR Cash|AR net_r (+ DR Inventory /
 *   CR COGS at original cost) → balanceCached refresh → audit → SaleReturned.
 * Money is proportional; the entry balances by construction (net_r = gross_r − disc_r).
 */
@Injectable()
export class SalesReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly invoices: InvoiceRepository,
  ) {}

  async createReturn(actor: Actor, input: CreateReturnInput) {
    if (input.lines.length === 0) throw new DomainException('VALIDATION_ERROR', 'Return requires at least one line', 422);

    return this.prisma.$transaction(async (tx) => {
      const invoice = await tx.salesInvoice.findFirst({
        where: { id: input.invoiceId, pharmacyId: actor.pharmacyId },
        include: { lines: { include: { allocations: true } } },
      });
      if (!invoice) throw new DomainException('NOT_FOUND', 'Invoice not found', 404);

      let grossR = d(0);
      let discR = d(0);
      let costR = d(0);
      const lineFacts: { salesItemId: string; quantity: number; refund: Prisma.Decimal; cost: Prisma.Decimal }[] = [];
      const restocks: { batchId: string; medicineId: string; units: number; unitCost: Prisma.Decimal }[] = [];

      for (const reqLine of input.lines) {
        const item = invoice.lines.find((l) => l.id === reqLine.salesItemId);
        if (!item) throw new DomainException('NOT_FOUND', `Sales item ${reqLine.salesItemId} not on invoice`, 404);
        if (reqLine.quantity < 1) throw new DomainException('VALIDATION_ERROR', 'Return quantity must be ≥ 1', 422);

        const alreadyReturned = await this.invoices.returnedQuantity(tx, actor.pharmacyId, item.id);
        if (alreadyReturned + reqLine.quantity > item.quantity) {
          throw new DomainException(
            'VALIDATION_ERROR',
            `Cannot return ${reqLine.quantity}: sold ${item.quantity}, already returned ${alreadyReturned}`,
            422,
            [{ salesItemId: item.id, sold: item.quantity, alreadyReturned }],
          );
        }

        // Proportional money for this slice of the line
        const lineGross = d(item.unitPrice).mul(reqLine.quantity);
        const lineDisc = d(item.discount).mul(reqLine.quantity).div(item.quantity).toDecimalPlaces(4);
        grossR = grossR.add(lineGross);
        discR = discR.add(lineDisc);

        // Deterministic unit→allocation mapping: this return covers sold units
        // [alreadyReturned+1 .. alreadyReturned+qty] laid over allocations in order.
        let cursor = 0;
        let lineCost = d(0);
        const from = alreadyReturned;
        const to = alreadyReturned + reqLine.quantity;
        for (const alloc of item.allocations) {
          const allocStart = cursor;
          const allocEnd = cursor + alloc.quantity;
          const take = Math.max(0, Math.min(to, allocEnd) - Math.max(from, allocStart));
          if (take > 0) {
            restocks.push({ batchId: alloc.batchId, medicineId: item.medicineId, units: take, unitCost: d(alloc.unitCost) });
            lineCost = lineCost.add(d(alloc.unitCost).mul(take));
          }
          cursor = allocEnd;
        }
        costR = costR.add(lineCost);
        lineFacts.push({ salesItemId: item.id, quantity: reqLine.quantity, refund: lineGross.sub(lineDisc), cost: lineCost });
      }
      const netR = grossR.sub(discR);

      // Restock into original batches; expired/depleted lots come back quarantined, never silently sellable (WF-3).
      for (const r of restocks) {
        const batch = await tx.batch.findUniqueOrThrow({ where: { id: r.batchId } });
        const expired = batch.expiryDate <= new Date();
        const nextStatus =
          expired ? 'EXPIRED'
          : batch.status === 'ACTIVE' ? 'ACTIVE'
          : 'QUARANTINED';
        await tx.batch.update({
          where: { id: r.batchId },
          data: { quantityOnHand: { increment: r.units }, status: nextStatus },
        });
        await tx.inventoryTransaction.create({
          data: {
            pharmacyId: actor.pharmacyId,
            medicineId: r.medicineId,
            batchId: r.batchId,
            type: 'RETURN_IN',
            quantity: r.units,
            unitCost: r.unitCost,
            referenceType: 'RETURN',
            referenceId: invoice.id,
            actorUserId: actor.userId,
          },
        });
      }

      // Contra journal — template 09: revenue reversal + cost restoration.
      const refundAccount = invoice.paymentMethod === 'CREDIT' ? ACCOUNTS.AR : ACCOUNTS.CASH;
      const { entryId } = await this.ledger.postEntry(tx, actor, {
        sourceType: 'RETURN',
        sourceId: invoice.id,
        memo: `مرتجع فاتورة ${invoice.invoiceNo} — ${input.reason}`,
        lines: [
          { account: ACCOUNTS.SALES, debit: grossR },
          ...(discR.gt(0) ? [{ account: ACCOUNTS.SALES_DISCOUNT, credit: discR }] : []),
          {
            account: refundAccount,
            credit: netR,
            customerId: invoice.paymentMethod === 'CREDIT' ? invoice.customerId ?? undefined : undefined,
          },
          ...(costR.gt(0)
            ? [
                { account: ACCOUNTS.INVENTORY, debit: costR },
                { account: ACCOUNTS.COGS, credit: costR },
              ]
            : []),
        ],
      });

      const ret = await tx.saleReturn.create({
        data: {
          pharmacyId: actor.pharmacyId,
          invoiceId: invoice.id,
          reason: input.reason,
          journalEntryId: entryId,
          createdByUserId: actor.userId,
          lines: { create: lineFacts.map((f) => ({ pharmacyId: actor.pharmacyId, ...f })) },
        },
        include: { lines: true },
      });

      let customerBalanceAfter: Prisma.Decimal | null = null;
      if (invoice.paymentMethod === 'CREDIT' && invoice.customerId) {
        customerBalanceAfter = await this.ledger.customerBalance(tx, actor.pharmacyId, invoice.customerId);
        await tx.customer.update({ where: { id: invoice.customerId }, data: { balanceCached: customerBalanceAfter } });
      }

      await this.audit.record(tx, actor, 'SALE_RETURNED', 'SaleReturn', ret.id, {
        invoiceNo: invoice.invoiceNo, refund: netR.toFixed(4), reason: input.reason,
      });
      await this.outbox.publish(tx, actor.pharmacyId, EVENTS.SaleReturned, {
        returnId: ret.id,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        refund: netR.toFixed(4),
        lines: lineFacts.map((f) => ({ salesItemId: f.salesItemId, quantity: f.quantity })),
      });

      return {
        returnId: ret.id,
        journalEntryId: entryId,
        refundTotal: netR,
        refundMethod: invoice.paymentMethod === 'CREDIT' ? 'AR_CREDIT' : 'CASH',
        customerBalanceAfter,
        restocked: restocks.map((r) => ({ batchId: r.batchId, units: r.units })),
      };
    });
  }
}
