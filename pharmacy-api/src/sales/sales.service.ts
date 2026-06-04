import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { DomainException } from '../common/errors';
import { Actor } from '../common/auth';
import { InventoryService, Allocation } from '../inventory/inventory.service';
import { ACCOUNTS, LedgerService } from '../finance/ledger.service';
import { DurService } from '../pharmacy-ops/dur.service';
import { OutboxService } from '../platform/outbox.service';
import { AuditService } from '../platform/audit.service';
import { EVENTS } from '../platform/events';
import { InvoiceRepository } from './repositories/invoice.repository';
import { CacheService } from '../platform/cache.service';

const ZERO = new Prisma.Decimal(0);
const d = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);

export interface CreateSaleInput {
  clientSaleId: string;
  clientTimestamp: string;
  customerId: string | null;
  prescriptionId: string | null;
  lines: { medicineId: string; quantity: number; unitPrice: string; discount?: { type: 'PERCENT' | 'AMOUNT'; value: string } }[];
  invoiceDiscount?: { type: 'PERCENT' | 'AMOUNT'; value: string };
  payment: { method: 'CASH' | 'CARD' | 'CREDIT' };
  durOverride?: { alertIds: string[]; overrideToken: string };
}

/**
 * Sales bounded context (Architecture §2, BINDING):
 * everything that defines whether the sale is valid and what it costs happens
 * SYNCHRONOUSLY inside ONE database transaction —
 *   DUR gate → FEFO allocation (row-locked) → invoice + allocations
 *   → immutable inventory movements → balanced journal entry
 *   → AR subledger + installments (credit) → audit → outbox events.
 * Loyalty, alerts, projections react asynchronously via the outbox.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
    private readonly dur: DurService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly cache: CacheService,
    private readonly invoices: InvoiceRepository,
  ) {}

  async createSale(actor: Actor, input: CreateSaleInput) {
    if (input.lines.length === 0) throw new DomainException('VALIDATION_ERROR', 'Sale requires at least one line', 422);
    if (input.payment.method === 'CREDIT' && !input.customerId) {
      throw new DomainException('VALIDATION_ERROR', 'Credit sales require a customer', 422);
    }

    return this.prisma.$transaction(async (tx) => {
      // ── 1. DUR clinical gate (pharmacist-only override, audited) ──
      const alerts = await this.dur.check(tx, actor.pharmacyId, input.customerId, input.lines.map((l) => l.medicineId));
      const blocking = alerts.filter((a) => a.severity !== 'INFO');
      if (blocking.length > 0) {
        const overridden = await this.verifyOverride(input.durOverride);
        if (!overridden) {
          throw new DomainException('DUR_BLOCK', 'تنبيه سريري يتطلب مراجعة الصيدلي', 409, blocking);
        }
        await this.audit.record(tx, actor, 'DUR_OVERRIDE', 'Sale', input.clientSaleId, {
          alertIds: input.durOverride!.alertIds,
          rules: blocking.map((a) => a.ruleId),
        });
        await this.outbox.publish(tx, actor.pharmacyId, EVENTS.DURAlertRaised, {
          clientSaleId: input.clientSaleId,
          overridden: true,
          rules: blocking.map((a) => a.ruleId),
        });
      }

      // ── 2. Pricing (server-authoritative; client totals are previews) ──
      let subtotal = ZERO;
      let totalDiscount = ZERO;
      const pricedLines = input.lines.map((l) => {
        const gross = d(l.unitPrice).mul(l.quantity);
        const disc =
          l.discount?.type === 'PERCENT' ? gross.mul(d(l.discount.value)).div(100)
          : l.discount?.type === 'AMOUNT' ? d(l.discount.value)
          : ZERO;
        if (disc.gt(gross)) throw new DomainException('VALIDATION_ERROR', 'Discount exceeds line amount', 422);
        subtotal = subtotal.add(gross);
        totalDiscount = totalDiscount.add(disc);
        return { ...l, gross, disc, lineTotal: gross.sub(disc) };
      });
      if (input.invoiceDiscount) {
        const base = subtotal.sub(totalDiscount);
        const extra =
          input.invoiceDiscount.type === 'PERCENT' ? base.mul(d(input.invoiceDiscount.value)).div(100) : d(input.invoiceDiscount.value);
        totalDiscount = totalDiscount.add(extra);
      }
      const total = subtotal.sub(totalDiscount);
      if (total.lt(0)) throw new DomainException('VALIDATION_ERROR', 'Total cannot be negative', 422);

      // ── 3. Credit-limit gate (warning-mode override per Contract §0.4) ──
      let customer: { id: string; name: string; creditLimit: Prisma.Decimal } | null = null;
      if (input.customerId) {
        customer = await tx.customer.findFirst({
          where: { id: input.customerId, pharmacyId: actor.pharmacyId },
          select: { id: true, name: true, creditLimit: true },
        });
        if (!customer) throw new DomainException('NOT_FOUND', 'Customer not found', 404);
      }
      if (input.payment.method === 'CREDIT' && customer) {
        const balance = await this.ledger.customerBalance(tx, actor.pharmacyId, customer.id);
        if (balance.add(total).gt(customer.creditLimit)) {
          const overridden = await this.verifyOverride(input.durOverride);
          if (!overridden) {
            throw new DomainException(
              'CREDIT_LIMIT_EXCEEDED',
              `تجاوز حد الائتمان للعميل ${customer.name}`,
              409,
              [{ balance: balance.toFixed(4), creditLimit: customer.creditLimit.toFixed(4), saleTotal: total.toFixed(4) }],
            );
          }
          await this.outbox.publish(tx, actor.pharmacyId, EVENTS.CreditLimitBreached, {
            customerId: customer.id,
            customerName: customer.name,
            balance: balance.add(total).toFixed(4),
            creditLimit: customer.creditLimit.toFixed(4),
          });
        }
      }

      // ── 4. FEFO allocation (row-locked) + immutable movements + COGS ──
      let totalCost = ZERO;
      const lineAllocations: { line: (typeof pricedLines)[number]; allocations: Allocation[] }[] = [];
      for (const line of pricedLines) {
        const allocations = await this.inventory.allocateFefo(tx, actor.pharmacyId, line.medicineId, line.quantity);
        for (const a of allocations) totalCost = totalCost.add(a.unitCost.mul(a.quantity));
        lineAllocations.push({ line, allocations });
      }

      // ── 5. Invoice + items + batch allocations (batch-mandatory rule) ──
      const invoiceNo = await this.invoices.nextInvoiceNo(tx, actor.pharmacyId);
      const invoice = await tx.salesInvoice.create({
        data: {
          pharmacyId: actor.pharmacyId,
          invoiceNo,
          clientSaleId: input.clientSaleId,
          customerId: customer?.id ?? null,
          cashierUserId: actor.userId,
          paymentMethod: input.payment.method,
          subtotal,
          totalDiscount,
          total,
          totalCost,
          journalEntryId: '00000000-0000-0000-0000-000000000000', // patched below in same tx
          clientTimestamp: new Date(input.clientTimestamp),
          lines: {
            create: lineAllocations.map(({ line, allocations }) => ({
              medicineId: line.medicineId,
              quantity: line.quantity,
              unitPrice: d(line.unitPrice),
              discount: line.disc,
              lineTotal: line.lineTotal,
              allocations: {
                create: allocations.map((a) => ({ batchId: a.batchId, quantity: a.quantity, unitCost: a.unitCost })),
              },
            })),
          },
        },
      });

      for (const { line, allocations } of lineAllocations) {
        await this.inventory.writeMovements(tx, actor, line.medicineId, allocations, 'SALE', -1, 'INVOICE', invoice.id);
      }

      // ── 6. Balanced journal entry — the financial fact, same transaction ──
      // Cash/AR debit (net) + Discount contra-revenue debit = Sales credit (gross);
      // COGS debit = Inventory credit (at allocated batch cost).
      const receivableAccount = input.payment.method === 'CREDIT' ? ACCOUNTS.AR : ACCOUNTS.CASH;
      const { entryId } = await this.ledger.postEntry(tx, actor, {
        sourceType: 'SALE',
        sourceId: invoice.id,
        memo: input.payment.method === 'CREDIT' ? `بيع آجل — فاتورة ${invoiceNo}` : `بيع — فاتورة ${invoiceNo}`,
        lines: [
          {
            account: receivableAccount,
            debit: total,
            customerId: input.payment.method === 'CREDIT' ? customer!.id : undefined,
          },
          ...(totalDiscount.gt(0) ? [{ account: ACCOUNTS.SALES_DISCOUNT, debit: totalDiscount }] : []),
          { account: ACCOUNTS.SALES, credit: subtotal },
          ...(totalCost.gt(0)
            ? [
                { account: ACCOUNTS.COGS, debit: totalCost },
                { account: ACCOUNTS.INVENTORY, credit: totalCost },
              ]
            : []),
        ],
      });
      // Raw update: salesInvoice rows are mutable metadata-wise only for this linkage patch,
      // performed before commit so the invoice never exists without its journal reference.
      await tx.salesInvoice.update({ where: { id: invoice.id }, data: { journalEntryId: entryId } });

      // ── 7. Credit bookkeeping: cached balance + installment schedule ──
      let customerBalanceAfter: Prisma.Decimal | null = null;
      if (input.payment.method === 'CREDIT' && customer) {
        customerBalanceAfter = await this.ledger.customerBalance(tx, actor.pharmacyId, customer.id);
        await tx.customer.update({ where: { id: customer.id }, data: { balanceCached: customerBalanceAfter } });
        await this.outbox.publish(tx, actor.pharmacyId, EVENTS.CustomerCreditExtended, {
          customerId: customer.id,
          invoiceId: invoice.id,
          amount: total.toFixed(4),
        });
      }

      // ── 8. Audit + SaleCompleted (async reactions: loyalty, projections, alerts) ──
      await this.audit.record(tx, actor, 'SALE_COMPLETED', 'SalesInvoice', invoice.id, {
        invoiceNo,
        total: total.toFixed(4),
        method: input.payment.method,
      });
      await this.outbox.publish(tx, actor.pharmacyId, EVENTS.SaleCompleted, {
        invoiceId: invoice.id,
        customerId: customer?.id ?? null,
        total: total.toFixed(4),
        paymentMethod: input.payment.method,
        lines: input.lines.map((l) => ({ medicineId: l.medicineId, quantity: l.quantity })),
      });

      // ── 9. Low-stock sub-event chain (SaleCompleted → LowStockDetected) ──
      for (const line of input.lines) {
        await this.inventory.detectLowStock(tx, actor.pharmacyId, line.medicineId);
      }

      return {
        invoiceId: invoice.id,
        invoiceNo,
        total,
        totalDiscount,
        allocations: lineAllocations.flatMap(({ allocations }, i) =>
          allocations.map((a) => ({ lineNo: i + 1, batchId: a.batchId, batchNumber: a.batchNumber, qty: a.quantity })),
        ),
        journalEntryId: entryId,
        customerBalanceAfter,
        loyaltyPointsEarned: customer ? Math.floor(Number(total) / 10) : 0,
        receipt: { printPayloadUrl: `/files/receipts/${invoice.id}` },
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  }


  /** Override tokens are short-lived pharmacist-scoped JWTs from /auth/pin-elevate. */
  private async verifyOverride(override?: { overrideToken: string }): Promise<boolean> {
    if (!override?.overrideToken) return false;
    try {
      const payload = await this.jwt.verifyAsync<{ scope?: string; role?: string; jti?: string }>(override.overrideToken);
      if (payload.scope !== 'override' || !(payload.role === 'PHARMACIST' || payload.role === 'OWNER')) return false;
      // R-1: single-use — consume the jti atomically. undefined = Redis degraded → JWT-only fallback.
      if (payload.jti) {
        const consumed = await this.cache.consume(`override:${payload.jti}`);
        if (consumed === null) return false; // already used or expired in Redis
      }
      return true;
    } catch {
      return false;
    }
  }
}
