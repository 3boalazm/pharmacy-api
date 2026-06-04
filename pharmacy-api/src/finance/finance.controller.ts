import { Body, Controller, Get, Param, Post } from "@nestjs/common";
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
    return e;
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
}
