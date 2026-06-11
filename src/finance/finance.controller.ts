import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { RecordPaymentDto, ReverseDto, SupplierPaymentDto } from "./dto/payment.dto";
import { JournalRepository } from "./repositories/journal.repository";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { IdempotencyService } from "../common/idempotency.service";
import { Actor, CurrentActor, IdemKey, Roles } from "../common/auth";
import { DomainException } from "../common/errors";
import { OutboxService } from "../platform/outbox.service";
import { AuditService } from "../platform/audit.service";
import { EVENTS } from "../platform/events";
import { ACCOUNTS, LedgerService } from "./ledger.service";


@Controller("finance")
export class FinanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly idem: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly journal: JournalRepository,
  ) {}

  /** POST /finance/payments — customer payment: AR credit + cash debit (Contract §6). */
  @Post("payments")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async recordPayment(@CurrentActor() actor: Actor, @IdemKey() key: string, @Body() dto: RecordPaymentDto) {
    return this.idem.run(actor.pharmacyId, key, "POST /finance/payments", () =>
      this.prisma.$transaction(async (tx) => {
        const customer = await tx.customer.findFirst({ where: { id: dto.customerId, pharmacyId: actor.pharmacyId } });
        if (!customer) throw new DomainException("NOT_FOUND", "Customer not found", 404);

        const amount = new Prisma.Decimal(dto.amount);
        if (amount.lte(0)) throw new DomainException("VALIDATION_ERROR", "Amount must be positive", 422);

        const { entryId } = await this.ledger.postEntry(tx, actor, {
          sourceType: "PAYMENT_AR",
          memo: `سداد من ${customer.name}`,
          lines: [
            { account: ACCOUNTS.CASH, debit: amount },
            { account: ACCOUNTS.AR, credit: amount, customerId: customer.id },
          ],
        });

        // Settle oldest unpaid installments first (allocateTo OLDEST)
        let remaining = amount;
        const due = await tx.installment.findMany({
          where: { pharmacyId: actor.pharmacyId, customerId: customer.id, paidAt: null },
          orderBy: { dueDate: "asc" },
        });
        for (const inst of due) {
          if (remaining.lt(inst.amount)) break;
          remaining = remaining.sub(inst.amount);
          await tx.installment.update({ where: { id: inst.id }, data: { paidAt: new Date() } });
        }

        const balanceAfter = await this.ledger.customerBalance(tx, actor.pharmacyId, customer.id);
        await tx.customer.update({ where: { id: customer.id }, data: { balanceCached: balanceAfter } });

        await this.audit.record(tx, actor, "PAYMENT_RECORDED", "Customer", customer.id, { amount: dto.amount });
        await this.outbox.publish(tx, actor.pharmacyId, EVENTS.PaymentRecorded, {
          customerId: customer.id, amount: dto.amount, method: dto.method, journalEntryId: entryId,
        });

        return { paymentId: entryId, customerBalanceAfter: balanceAfter };
      }),
    );
  }

  /** GET /finance/ar/:customerId/statement — كشف حساب العميل (flagship). */
  @Get("ar/:customerId/statement")
  @Roles("ASSISTANT", "PHARMACIST", "CASHIER")
  async statement(@CurrentActor() actor: Actor, @Param("customerId") customerId: string) {
    return this.ledger.customerStatement(actor.pharmacyId, customerId);
  }

  /** GET /finance/journal/:id */
  @Get("journal/:id")
  @Roles("PHARMACIST")
  async entry(@CurrentActor() actor: Actor, @Param("id") id: string) {
    const e = await this.prisma.journalEntry.findFirst({
      where: { id, pharmacyId: actor.pharmacyId },
      include: { lines: true },
    });
    if (!e) throw new DomainException("NOT_FOUND", "Entry not found", 404);
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: e.lines.map((l) => l.accountId) } },
      select: { id: true, code: true, name: true },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return { ...e, lines: e.lines.map((l) => ({ ...l, account: byId.get(l.accountId) ?? null })) };
  }

  /** POST /finance/journal/:id/reverse — contra entry, the only correction path. */
  @Post("journal/:id/reverse")
  @Roles("OWNER")
  async reverse(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: ReverseDto) {
    return this.ledger.reverse(actor, id, dto.reason);
  }

  /** POST /finance/periods/:yyyymm/close — period lock (Contract §6). */
  @Post("periods/:yearMonth/close")
  @Roles("OWNER")
  async closePeriod(@CurrentActor() actor: Actor, @Param("yearMonth") yearMonth: string) {
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) throw new DomainException("VALIDATION_ERROR", "Use YYYY-MM", 422);
    return this.prisma.$transaction(async (tx) => {
      const period = await tx.closedPeriod.create({
        data: { pharmacyId: actor.pharmacyId, yearMonth, closedByUserId: actor.userId },
      });
      await this.audit.record(tx, actor, "PERIOD_CLOSED", "ClosedPeriod", period.id, { yearMonth });
      await this.outbox.publish(tx, actor.pharmacyId, EVENTS.AccountingPeriodClosed, { yearMonth });
      return { closed: yearMonth };
    });
  }

  /** GET /finance/reconciliation/daily — trial balance + cache-drift assertions (Architecture §4.1). */
  @Get("reconciliation/daily")
  @Roles("OWNER")
  async reconcile(@CurrentActor() actor: Actor) {
    const trialBalanceDiff = await this.ledger.trialBalanceDiff(actor.pharmacyId);
    const drift = await this.journal.customerDrift(actor.pharmacyId);
    return {
      trialBalanceDiff,
      trialBalanceOk: trialBalanceDiff.isZero(),
      customerBalanceDrift: drift,
    };
  }

  /** GET /finance/accounts — per-account balances (trial balance report). */
  @Get("accounts")
  @Roles("PHARMACIST")
  async accounts(@CurrentActor() actor: Actor) {
    return this.ledger.accountBalances(actor.pharmacyId);
  }

  /** GET /finance/ap/:supplierId/statement — supplier subledger fold (Contract §6 /finance/ap). */
  @Get("ap/:supplierId/statement")
  @Roles("ASSISTANT", "PHARMACIST")
  async supplierStatement(@CurrentActor() actor: Actor, @Param("supplierId") supplierId: string) {
    return this.ledger.supplierStatement(actor.pharmacyId, supplierId);
  }

  /** POST /finance/ap/payments — pay a supplier: DR AP[supplier] / CR Cash (Idempotency-Key). */
  @Post("ap/payments")
  @Roles("PHARMACIST")
  async paySupplier(@CurrentActor() actor: Actor, @IdemKey() key: string, @Body() dto: SupplierPaymentDto) {
    return this.idem.run(actor.pharmacyId, key, "POST /finance/ap/payments", () =>
      this.prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, pharmacyId: actor.pharmacyId } });
        if (!supplier) throw new DomainException("NOT_FOUND", "Supplier not found", 404);
        const amount = new Prisma.Decimal(dto.amount);
        if (amount.lte(0)) throw new DomainException("VALIDATION_ERROR", "Amount must be positive", 422);

        const { entryId } = await this.ledger.postEntry(tx, actor, {
          sourceType: "PAYMENT_AP",
          memo: `سداد للمورد ${supplier.name}`,
          lines: [
            { account: ACCOUNTS.AP, debit: amount, supplierId: supplier.id },
            { account: ACCOUNTS.CASH, credit: amount },
          ],
        });

        const balanceAfter = await this.ledger.supplierBalance(tx, actor.pharmacyId, supplier.id);
        await tx.supplier.update({ where: { id: supplier.id }, data: { balanceCached: balanceAfter } });
        await this.audit.record(tx, actor, "SUPPLIER_PAYMENT", "Supplier", supplier.id, { amount: dto.amount });
        await this.outbox.publish(tx, actor.pharmacyId, EVENTS.PaymentRecorded, {
          supplierId: supplier.id, amount: dto.amount, journalEntryId: entryId,
        });
        return { paymentId: entryId, supplierBalanceAfter: balanceAfter };
      }),
    );
  }

  /** GET /finance/installments — الشاشة المجمعة: متأخر / مستحق اليوم / قادم 7 أيام (ISS-015). */
  @Get("installments")
  @Roles("ASSISTANT", "PHARMACIST")
  async installmentsOverview(@CurrentActor() actor: Actor, @Query("bucket") bucket = "overdue") {
    const now = new Date();
    const startToday = new Date(now.toDateString());
    const endToday = new Date(startToday.getTime() + 86_400_000 - 1);
    const in7 = new Date(startToday.getTime() + 7 * 86_400_000);
    const range =
      bucket === "today" ? { gte: startToday, lte: endToday }
      : bucket === "upcoming" ? { gt: endToday, lte: in7 }
      : { lt: startToday }; // overdue
    const plain = await this.prisma.installment.findMany({
      where: { pharmacyId: actor.pharmacyId, paidAt: null, dueDate: range },
      orderBy: { dueDate: "asc" },
      take: 200,
    });
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: [...new Set(plain.map((i) => i.customerId))] } },
      select: { id: true, name: true, phone: true, balanceCached: true },
    });
    const byId = new Map(customers.map((c) => [c.id, c]));
    const rows = plain.map((i) => ({ ...i, customer: byId.get(i.customerId) ?? null }));
    const totals = await this.prisma.installment.aggregate({
      where: { pharmacyId: actor.pharmacyId, paidAt: null, dueDate: range },
      _sum: { amount: true }, _count: true,
    });
    return { rows, total: totals._sum.amount ?? new Prisma.Decimal(0), count: totals._count };
  }

  /** GET /finance/cash-flow — حركة النقدية اليومية من دفتر حساب 1000 + مطابقة فروق الورديات (ISS-013). */
  @Get("cash-flow")
  @Roles("PHARMACIST")
  async cashFlow(@CurrentActor() actor: Actor, @Query("from") from?: string, @Query("to") to?: string) {
    const end = to ? new Date(`${to}T23:59:59.999`) : new Date();
    const start = from ? new Date(`${from}T00:00:00`) : new Date(end.getTime() - 29 * 86_400_000);
    const opening = await this.prisma.$queryRaw<{ bal: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,4) AS bal
      FROM journal_lines jl JOIN accounts a ON a.id = jl."accountId" JOIN journal_entries je ON je.id = jl."entryId"
      WHERE jl."pharmacyId" = ${actor.pharmacyId}::uuid AND a.code = '1000' AND je."createdAt" < ${start}`;
    const days = await this.prisma.$queryRaw<{ day: Date; inflow: Prisma.Decimal; outflow: Prisma.Decimal; overshort: Prisma.Decimal }[]>`
      SELECT date_trunc('day', je."createdAt")::date AS day,
             COALESCE(SUM(jl.debit), 0)::numeric(19,4)  AS inflow,
             COALESCE(SUM(jl.credit), 0)::numeric(19,4) AS outflow,
             COALESCE(SUM(CASE WHEN je."sourceType" = 'SHIFT_CLOSE' THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric(19,4) AS overshort
      FROM journal_lines jl JOIN accounts a ON a.id = jl."accountId" JOIN journal_entries je ON je.id = jl."entryId"
      WHERE jl."pharmacyId" = ${actor.pharmacyId}::uuid AND a.code = '1000' AND je."createdAt" BETWEEN ${start} AND ${end}
      GROUP BY 1 ORDER BY 1 DESC`;
    return { from: start, to: end, opening: opening[0]?.bal ?? new Prisma.Decimal(0), days };
  }

  /** GET /finance/ar/aging — أعمار ديون العملاء: حالي/1-30/31-60/61-90/+90 من الأقساط المعلقة، و«غير مجدول» للباقي. */
  @Get("ar/aging")
  @Roles("PHARMACIST")
  async arAging(@CurrentActor() actor: Actor) {
    const customers = await this.prisma.customer.findMany({
      where: { pharmacyId: actor.pharmacyId, archivedAt: null, balanceCached: { gt: 0 } },
      select: { id: true, name: true, phone: true, balanceCached: true },
      orderBy: { balanceCached: "desc" },
    });
    if (customers.length === 0) return { rows: [], totals: null };
    const pending = await this.prisma.installment.findMany({
      where: { pharmacyId: actor.pharmacyId, paidAt: null, customerId: { in: customers.map((c) => c.id) } },
      select: { customerId: true, amount: true, dueDate: true },
    });
    const now = Date.now();
    const zero = new Prisma.Decimal(0);
    const bucketOf = (due: Date) => {
      const days = Math.floor((now - due.getTime()) / 86_400_000);
      if (days <= 0) return "current";
      if (days <= 30) return "d30";
      if (days <= 60) return "d60";
      if (days <= 90) return "d90";
      return "d90p";
    };
    const rows = customers.map((c) => {
      const buckets: Record<"current" | "d30" | "d60" | "d90" | "d90p", Prisma.Decimal> = {
        current: zero, d30: zero, d60: zero, d90: zero, d90p: zero,
      };
      let scheduled = zero;
      for (const i of pending.filter((p) => p.customerId === c.id)) {
        const b = bucketOf(i.dueDate);
        buckets[b] = buckets[b].add(i.amount);
        scheduled = scheduled.add(i.amount);
      }
      const unscheduled = new Prisma.Decimal(c.balanceCached).sub(scheduled);
      return {
        customerId: c.id, name: c.name, phone: c.phone, balance: c.balanceCached,
        ...buckets, unscheduled: unscheduled.gt(0) ? unscheduled : zero,
      };
    });
    const keys = ["balance", "current", "d30", "d60", "d90", "d90p", "unscheduled"] as const;
    const totals = Object.fromEntries(
      keys.map((k) => [k, rows.reduce((a, r) => a.add(r[k]), zero)]),
    );
    return { rows, totals };
  }

  /** GET /finance/journal — تصفح دفتر الأستاذ: قراءة فقط، فلاتر فترة/مصدر/حساب، ترقيم 50 (ISS US-4.2.3). */
  @Get("journal")
  @Roles("PHARMACIST")
  async journalBrowse(
    @CurrentActor() actor: Actor,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("sourceType") sourceType?: string,
    @Query("accountCode") accountCode?: string,
    @Query("skip") skip = "0",
  ) {
    const accountIds = accountCode
      ? (await this.prisma.account.findMany({ where: { pharmacyId: actor.pharmacyId, code: accountCode }, select: { id: true } })).map((a) => a.id)
      : null;
    const where: Prisma.JournalEntryWhereInput = {
      pharmacyId: actor.pharmacyId,
      ...(sourceType && { sourceType }),
      ...(from || to
        ? { createdAt: { ...(from && { gte: new Date(`${from}T00:00:00`) }), ...(to && { lte: new Date(`${to}T23:59:59.999`) }) } }
        : {}),
      ...(accountIds && { lines: { some: { accountId: { in: accountIds } } } }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.journalEntry.findMany({
        where,
        select: { id: true, memo: true, sourceType: true, createdAt: true, lines: { select: { debit: true } } },
        orderBy: { createdAt: "desc" },
        skip: Math.max(Number(skip) || 0, 0),
        take: 50,
      }),
      this.prisma.journalEntry.count({ where }),
    ]);
    return {
      rows: rows.map((r) => ({
        id: r.id, memo: r.memo, sourceType: r.sourceType, createdAt: r.createdAt,
        amount: r.lines.reduce((a, l) => a.add(l.debit), new Prisma.Decimal(0)),
      })),
      total,
    };
  }
}
