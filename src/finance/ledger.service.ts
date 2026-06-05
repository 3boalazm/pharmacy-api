import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../common/prisma.service';
import { DomainException } from '../common/errors';
import { Actor } from '../common/auth';
import { JournalRepository } from './repositories/journal.repository';

/** Seeded chart of accounts (Architecture §6.2 / Contract §6). */
export const ACCOUNTS = {
  CASH: '1000',
  BANK: '1010',
  AR: '1100',
  INVENTORY: '1200',
  AP: '2000',
  SALES: '4000',
  SALES_DISCOUNT: '4100', // contra-revenue
  COGS: '5000',
  WRITE_OFF: '5100',
  OVER_SHORT: '5900',
  OP_EXPENSE: '5800',
  OTHER_INCOME: '4900',
} as const;

export type AccountCode = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];

export interface PostLine {
  account: AccountCode;
  debit?: Prisma.Decimal;
  credit?: Prisma.Decimal;
  customerId?: string; // AR subledger dimension
  supplierId?: string; // AP subledger dimension
}

const ZERO = new Prisma.Decimal(0);

/**
 * The accounting brain (Architecture §4.1, BINDING):
 *  - every posting goes through postEntry, INSIDE the caller's transaction
 *  - Σdebit must equal Σcredit (checked here AND by the deferred DB trigger)
 *  - entries are append-only; corrections are contra entries (reverse())
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalRepository,
  ) {}

  /** Resolve account ids for a tenant (cached per call-site; small table). */
  async accountMap(tx: Tx, pharmacyId: string): Promise<Record<AccountCode, string>> {
    const rows = await tx.account.findMany({ where: { pharmacyId } });
    const map = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    return map as Record<AccountCode, string>;
  }

  async postEntry(
    tx: Tx,
    actor: Actor,
    input: { sourceType: string; sourceId?: string; memo?: string; entryDate?: Date; reversesEntryId?: string; lines: PostLine[] },
  ): Promise<{ entryId: string }> {
    const debits = input.lines.reduce((a, l) => a.add(l.debit ?? ZERO), ZERO);
    const credits = input.lines.reduce((a, l) => a.add(l.credit ?? ZERO), ZERO);
    if (!debits.equals(credits)) {
      throw new DomainException('VALIDATION_ERROR', `Unbalanced entry: Σdebit ${debits} ≠ Σcredit ${credits}`, 422);
    }
    if (debits.lte(0)) {
      throw new DomainException('VALIDATION_ERROR', 'Journal entry must move a positive amount', 422);
    }

    const accounts = await this.accountMap(tx, actor.pharmacyId);
    const entry = await tx.journalEntry.create({
      data: {
        pharmacyId: actor.pharmacyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        memo: input.memo,
        entryDate: input.entryDate ?? new Date(),
        reversesEntryId: input.reversesEntryId,
        createdByUserId: actor.userId,
        lines: {
          create: input.lines.map((l) => ({
            pharmacyId: actor.pharmacyId,
            accountId: accounts[l.account],
            debit: l.debit ?? ZERO,
            credit: l.credit ?? ZERO,
            customerId: l.customerId,
            supplierId: l.supplierId,
          })),
        },
      },
    });
    return { entryId: entry.id };
  }

  /** Contra entry — the ONLY correction mechanism (Architecture §4.1). */
  async reverse(actor: Actor, entryId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const original = await tx.journalEntry.findFirst({
        where: { id: entryId, pharmacyId: actor.pharmacyId },
        include: { lines: true },
      });
      if (!original) throw new DomainException('NOT_FOUND', 'Journal entry not found', 404);

      const accounts = await tx.account.findMany({ where: { pharmacyId: actor.pharmacyId } });
      const codeById = Object.fromEntries(accounts.map((a) => [a.id, a.code]));

      return this.postEntry(tx, actor, {
        sourceType: 'REVERSAL',
        sourceId: original.id,
        memo: `قيد عكسي: ${reason}`,
        reversesEntryId: original.id,
        lines: original.lines.map((l) => ({
          account: codeById[l.accountId] as AccountCode,
          debit: l.credit, // swap sides
          credit: l.debit,
          customerId: l.customerId ?? undefined,
          supplierId: l.supplierId ?? undefined,
        })),
      });
    });
  }

  /** AR subledger balance — delegated to the journal repository (truth = dimensioned lines). */
  async customerBalance(tx: Tx, pharmacyId: string, customerId: string): Promise<Prisma.Decimal> {
    return this.journal.customerBalance(tx, pharmacyId, customerId);
  }

  /** AP subledger balance (liability normal side: Σcredit−Σdebit). */
  async supplierBalance(tx: Tx, pharmacyId: string, supplierId: string): Promise<Prisma.Decimal> {
    return this.journal.supplierBalance(tx, pharmacyId, supplierId);
  }

  /** كشف حساب العميل — running-balance fold over AR lines (Contract §6). */
  async customerStatement(pharmacyId: string, customerId: string, range?: { from?: Date; to?: Date }) {
    const lines = await this.journal.subledgerLines(pharmacyId, { customerId });
    const full = this.foldStatement(lines, { debitMeans: 'بيع آجل', creditMeans: 'سداد', normalSide: 'debit' });
    if (!range?.from && !range?.to) return full;
    // الفترة لا تغيّر الحقيقة: الافتتاحي = آخر رصيد جارٍ قبل بداية الفترة (الفولد كاملًا يظل المصدر)
    const fromT = range.from?.getTime() ?? -Infinity;
    const toT = range.to?.getTime() ?? Infinity;
    let opening: Prisma.Decimal = new Prisma.Decimal(0);
    const rows = [] as typeof full.rows;
    for (const r of full.rows) {
      const t = new Date(r.date).getTime();
      if (t < fromT) opening = r.runningBalance;
      else if (t <= toT) rows.push(r);
    }
    return { rows, openingBalance: opening, closingBalance: rows.length ? rows[rows.length - 1].runningBalance : opening };
  }

  /** كشف حساب المورد — running-balance fold over AP lines (credit-normal). */
  async supplierStatement(pharmacyId: string, supplierId: string) {
    const lines = await this.journal.subledgerLines(pharmacyId, { supplierId });
    return this.foldStatement(lines, { debitMeans: 'سداد للمورد', creditMeans: 'استلام بضاعة', normalSide: 'credit' });
  }

  private foldStatement(
    lines: { date: Date; memo: string | null; sourceType: string; debit: Prisma.Decimal; credit: Prisma.Decimal; entryId: string }[],
    opts: { debitMeans: string; creditMeans: string; normalSide: 'debit' | 'credit' },
  ) {
    let running = new Prisma.Decimal(0);
    const rows = lines.map((l) => {
      running = opts.normalSide === 'debit' ? running.add(l.debit).sub(l.credit) : running.add(l.credit).sub(l.debit);
      return {
        date: l.date,
        description: l.memo ?? (l.debit.gt(0) ? opts.debitMeans : opts.creditMeans),
        debit: l.debit.gt(0) ? l.debit : null,
        credit: l.credit.gt(0) ? l.credit : null,
        runningBalance: running,
        journalEntryId: l.entryId,
      };
    });
    return { openingBalance: new Prisma.Decimal(0), closingBalance: running, rows };
  }

  /** Per-account trial balance report. */
  async accountBalances(pharmacyId: string) {
    return this.journal.accountBalances(pharmacyId);
  }

  /** Trial-balance assertion used by the reconciliation endpoint (Architecture §4.1). */
  async trialBalanceDiff(pharmacyId: string): Promise<Prisma.Decimal> {
    return this.journal.trialBalanceDiff(pharmacyId);
  }
}
