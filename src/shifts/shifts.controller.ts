import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { IsNumberString } from "class-validator";
import { Prisma } from "@prisma/client";
import { PrismaService, Tx } from "../common/prisma.service";
import { Actor, CurrentActor, IdemKey, Roles } from "../common/auth";
import { DomainException } from "../common/errors";
import { IdempotencyService } from "../common/idempotency.service";
import { AuditService } from "../platform/audit.service";
import { ACCOUNTS, LedgerService } from "../finance/ledger.service";

const d = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);

class OpenShiftDto {
  @IsNumberString() openingFloat!: string;
}
class CloseShiftDto {
  @IsNumberString() countedCash!: string;
}

/**
 * الورديات ودرج الكاشير — WF-5:
 * المتوقع = الرصيد الافتتاحي + مبيعات نقدية الوردية + تحصيلات نقدية − مرتجعات نقدية.
 * فرق الجرد يُرحَّل قيدًا فور الإقفال: عجز ⟶ مدين 5900 / دائن 1000، زيادة ⟶ العكس —
 * فالدرج لا "يضبط" يدويًا أبدًا؛ الفرق حقيقة محاسبية مُدقَّقة.
 */
@Controller("shifts")
export class ShiftsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idem: IdempotencyService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  /** نقدية الوردية المحسوبة من الحقائق (فواتير/تحصيلات/مرتجعات) منذ الفتح. */
  private async cashSince(tx: Tx, pharmacyId: string, since: Date) {
    const sales = await tx.salesInvoice.aggregate({
      where: { pharmacyId, paymentMethod: "CASH", createdAt: { gte: since } },
      _sum: { total: true },
    });
    const arCash = await tx.$queryRaw<{ amount: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(jl.debit), 0)::numeric(19,4) AS amount
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl."entryId"
      JOIN accounts a ON a.id = jl."accountId"
      WHERE jl."pharmacyId" = ${pharmacyId}::uuid AND a.code = ${ACCOUNTS.CASH}
        AND je."sourceType" = 'PAYMENT' AND je."createdAt" >= ${since}`;
    const cashRefunds = await tx.$queryRaw<{ amount: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(jl.credit), 0)::numeric(19,4) AS amount
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl."entryId"
      JOIN accounts a ON a.id = jl."accountId"
      WHERE jl."pharmacyId" = ${pharmacyId}::uuid AND a.code = ${ACCOUNTS.CASH}
        AND je."sourceType" = 'RETURN' AND je."createdAt" >= ${since}`;
    return d(sales._sum.total ?? 0).add(d(arCash[0]?.amount ?? 0)).sub(d(cashRefunds[0]?.amount ?? 0));
  }

  /** ورديتي المفتوحة + المتوقع لحظيًا. */
  @Get("current")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async current(@CurrentActor() actor: Actor) {
    const shift = await this.prisma.shift.findFirst({
      where: { pharmacyId: actor.pharmacyId, userId: actor.userId, status: "OPEN" },
    });
    if (!shift) return { open: false as const };
    const movement = await this.prisma.$transaction((tx) => this.cashSince(tx, actor.pharmacyId, shift.openedAt));
    return { open: true as const, shift, liveExpected: d(shift.openingFloat).add(movement) };
  }

  @Post("open")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async open(@CurrentActor() actor: Actor, @Body() dto: OpenShiftDto) {
    const existing = await this.prisma.shift.findFirst({
      where: { pharmacyId: actor.pharmacyId, userId: actor.userId, status: "OPEN" },
    });
    if (existing) throw new DomainException("CONFLICT", "لديك وردية مفتوحة بالفعل — أقفلها أولًا", 409);
    return this.prisma.$transaction(async (tx) => {
      const shift = await tx.shift.create({
        data: { pharmacyId: actor.pharmacyId, userId: actor.userId, openingFloat: d(dto.openingFloat) },
      });
      await this.audit.record(tx, actor, "SHIFT_OPENED", "Shift", shift.id, { openingFloat: dto.openingFloat });
      return shift;
    });
  }

  /** الإقفال: جرد فعلي ⟶ فرق ⟶ قيد فوري لو ≠ صفر. */
  @Post(":id/close")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async close(@CurrentActor() actor: Actor, @IdemKey() key: string, @Param("id") id: string, @Body() dto: CloseShiftDto) {
    return this.idem.run(actor.pharmacyId, key, "POST /shifts/close", () =>
      this.prisma.$transaction(async (tx) => {
        const shift = await tx.shift.findFirst({ where: { id, pharmacyId: actor.pharmacyId, status: "OPEN" } });
        if (!shift) throw new DomainException("NOT_FOUND", "لا توجد وردية مفتوحة بهذا المعرف", 404);
        if (shift.userId !== actor.userId && actor.role !== "OWNER" && actor.role !== "PHARMACIST") {
          throw new DomainException("FORBIDDEN", "إقفال وردية غيرك يتطلب صيدليًا أو المالك", 403);
        }

        const expected = d(shift.openingFloat).add(await this.cashSince(tx, actor.pharmacyId, shift.openedAt));
        const counted = d(dto.countedCash);
        const overShort = counted.sub(expected);

        let journalEntryId: string | null = null;
        if (!overShort.isZero()) {
          const value = overShort.abs();
          const { entryId } = await this.ledger.postEntry(tx, actor, {
            sourceType: "SHIFT_CLOSE",
            sourceId: shift.id,
            memo: overShort.isNegative() ? `عجز درج وردية` : `زيادة درج وردية`,
            lines: overShort.isNegative()
              ? [{ account: ACCOUNTS.OVER_SHORT, debit: value }, { account: ACCOUNTS.CASH, credit: value }]
              : [{ account: ACCOUNTS.CASH, debit: value }, { account: ACCOUNTS.OVER_SHORT, credit: value }],
          });
          journalEntryId = entryId;
        }

        const closed = await tx.shift.update({
          where: { id: shift.id },
          data: { status: "CLOSED", closedAt: new Date(), expectedCash: expected, countedCash: counted, overShort, journalEntryId },
        });
        await this.audit.record(tx, actor, "SHIFT_CLOSED", "Shift", shift.id, {
          expected: expected.toFixed(4), counted: counted.toFixed(4), overShort: overShort.toFixed(4), journalEntryId,
        });
        return closed;
      }),
    );
  }

  /** سجل الورديات (صيدلي/مالك). */
  @Get()
  @Roles("PHARMACIST")
  async list(@CurrentActor() actor: Actor) {
    return this.prisma.shift.findMany({
      where: { pharmacyId: actor.pharmacyId },
      include: { user: { select: { name: true } } },
      orderBy: { openedAt: "desc" },
      take: 30,
    });
  }
}
