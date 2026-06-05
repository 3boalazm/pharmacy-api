import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { IsIn, IsNumberString, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import { Prisma } from "@prisma/client";
import { PrismaService, Tx } from "../common/prisma.service";
import { Actor, CurrentActor, IdemKey, Roles } from "../common/auth";
import { DomainException } from "../common/errors";
import { IdempotencyService } from "../common/idempotency.service";
import { AuditService } from "../platform/audit.service";
import { ACCOUNTS, LedgerService } from "./ledger.service";

const D = (v: string | Prisma.Decimal) => new Prisma.Decimal(v);

/** سقف مصروف الكاشير/المساعد بالجنيه — TODO-settings: يُنقل لإعدادات الصيدلية (ISS-7.1.1). */
const EXPENSE_CAP_NON_PHARMACIST = D("500");

const DEFAULT_CATEGORIES: { name: string; kind: "EXPENSE" | "INCOME" }[] = [
  { name: "كهرباء ومياه", kind: "EXPENSE" },
  { name: "نظافة", kind: "EXPENSE" },
  { name: "مشال/انتقالات", kind: "EXPENSE" },
  { name: "اتصالات وإنترنت", kind: "EXPENSE" },
  { name: "مستلزمات تشغيل", kind: "EXPENSE" },
  { name: "أخرى", kind: "EXPENSE" },
  { name: "إيراد متفرق", kind: "INCOME" },
];

class CreateCashEntryDto {
  @IsIn(["EXPENSE", "INCOME", "DEPOSIT", "WITHDRAW"]) type!: "EXPENSE" | "INCOME" | "DEPOSIT" | "WITHDRAW";
  @IsNumberString() amount!: string;
  @IsString() @MinLength(3, { message: "اكتب بيانًا واضحًا (3 أحرف على الأقل)" }) memo!: string;
  @IsOptional() @IsUUID() categoryId?: string;
}
class CreateCategoryDto {
  @IsString() @MinLength(2) name!: string;
  @IsIn(["EXPENSE", "INCOME"]) kind!: "EXPENSE" | "INCOME";
}

/**
 * الخزينة (Cashbox) — WF-8: كل حركة نقدية خارج البيع تمر من هنا وتُقيَّد فورًا:
 *   مصروف:  مدين 5800 مصروفات تشغيل / دائن 1000 نقدية
 *   إيراد:  مدين 1000 / دائن 4900 إيرادات أخرى
 *   إيداع بنكي: مدين 1010 بنك / دائن 1000   ·   سحب من البنك: العكس
 * السجل Append-only: التصحيح بقيد عكسي مرتبط، لا تعديل ولا حذف (مدعوم بقادح SQL 004).
 * رصيد الخزينة المعروض يُشتق من دفتر الأستاذ (حساب 1000) لا من عدّاد.
 */
@Controller("cash")
export class CashboxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idem: IdempotencyService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  /** أرصدة لحظية من الدفتر: الخزينة (1000) والبنك (1010). */
  @Get("summary")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async summary(@CurrentActor() actor: Actor) {
    const balances = await this.prisma.$queryRaw<{ code: string; balance: Prisma.Decimal }[]>`
      SELECT a.code, COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,4) AS balance
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl."accountId" = a.id
      WHERE a."pharmacyId" = ${actor.pharmacyId}::uuid AND a.code IN (${ACCOUNTS.CASH}, ${ACCOUNTS.BANK})
      GROUP BY a.code`;
    const get = (code: string) => balances.find((b) => b.code === code)?.balance ?? D("0");
    const today = await this.prisma.cashEntry.aggregate({
      where: {
        pharmacyId: actor.pharmacyId,
        type: "EXPENSE",
        reversedById: null,
        createdAt: { gte: new Date(new Date().toDateString()) },
      },
      _sum: { amount: true },
    });
    return { cash: get(ACCOUNTS.CASH), bank: get(ACCOUNTS.BANK), todayExpenses: today._sum.amount ?? D("0") };
  }

  @Get("entries")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async list(
    @CurrentActor() actor: Actor,
    @Query("type") type?: string,
    @Query("categoryId") categoryId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("skip") skip = "0",
    @Query("take") take = "50",
  ) {
    const where: Prisma.CashEntryWhereInput = {
      pharmacyId: actor.pharmacyId,
      ...(type && { type }),
      ...(categoryId && { categoryId }),
      ...(from || to
        ? { createdAt: { ...(from && { gte: new Date(`${from}T00:00:00`) }), ...(to && { lte: new Date(`${to}T23:59:59.999`) }) } }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.cashEntry.findMany({
        where,
        include: { category: { select: { name: true } }, createdBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        skip: Math.max(Number(skip) || 0, 0),
        take: Math.min(Number(take) || 50, 100),
      }),
      this.prisma.cashEntry.count({ where }),
    ]);
    return { rows, total };
  }

  /** تسجيل حركة خزينة + قيدها المتوازن داخل معاملة واحدة. */
  @Post("entries")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async create(@CurrentActor() actor: Actor, @IdemKey() key: string, @Body() dto: CreateCashEntryDto) {
    const amount = D(dto.amount);
    if (amount.lte(0)) throw new DomainException("VALIDATION_ERROR", "المبلغ يجب أن يكون موجبًا", 422);

    const privileged = actor.role === "PHARMACIST" || actor.role === "OWNER";
    if (!privileged && dto.type !== "EXPENSE") {
      throw new DomainException("FORBIDDEN", "الإيرادات والإيداع/السحب تتطلب صيدليًا أو المالك", 403);
    }
    if (!privileged && amount.gt(EXPENSE_CAP_NON_PHARMACIST)) {
      throw new DomainException(
        "FORBIDDEN",
        `مصروف فوق ${EXPENSE_CAP_NON_PHARMACIST.toFixed(0)} ج.م يتطلب صيدليًا أو المالك`,
        403,
      );
    }
    if (dto.type === "EXPENSE" && !dto.categoryId) {
      throw new DomainException("VALIDATION_ERROR", "اختر فئة المصروف", 422);
    }

    return this.idem.run(actor.pharmacyId, key, "POST /cash/entries", () =>
      this.prisma.$transaction(async (tx) => {
        await this.ensureAccounts(tx, actor.pharmacyId);
        if (dto.categoryId) {
          const cat = await tx.cashCategory.findFirst({ where: { id: dto.categoryId, pharmacyId: actor.pharmacyId } });
          if (!cat) throw new DomainException("NOT_FOUND", "الفئة غير موجودة", 404);
        }

        const lines = this.linesFor(dto.type, amount);
        const { entryId } = await this.ledger.postEntry(tx, actor, {
          sourceType: "CASH_ENTRY",
          memo: `${this.typeAr(dto.type)}: ${dto.memo}`,
          lines,
        });

        const openShift = await tx.shift.findFirst({
          where: { pharmacyId: actor.pharmacyId, userId: actor.userId, closedAt: null },
          select: { id: true },
        });

        const entry = await tx.cashEntry.create({
          data: {
            pharmacyId: actor.pharmacyId,
            type: dto.type,
            amount,
            memo: dto.memo,
            categoryId: dto.categoryId,
            shiftId: openShift?.id ?? null,
            journalEntryId: entryId,
            createdById: actor.userId,
          },
          include: { category: { select: { name: true } }, createdBy: { select: { name: true } } },
        });
        await this.audit.record(tx, actor, "CASH_ENTRY_CREATED", "CashEntry", entry.id, {
          type: dto.type, amount: dto.amount, memo: dto.memo, offShift: !openShift,
        });
        return entry;
      }),
    );
  }

  /** عكس حركة: قيد عكسي مرتبط — السجل لا يُمس. */
  @Post("entries/:id/reverse")
  @Roles("PHARMACIST")
  async reverse(@CurrentActor() actor: Actor, @IdemKey() key: string, @Param("id") id: string, @Body() body: { reason?: string }) {
    return this.idem.run(actor.pharmacyId, key, "POST /cash/entries/reverse", () =>
      this.prisma.$transaction(async (tx) => {
        const original = await tx.cashEntry.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
        if (!original) throw new DomainException("NOT_FOUND", "الحركة غير موجودة", 404);
        if (original.reversedById) throw new DomainException("CONFLICT", "الحركة معكوسة بالفعل", 409);
        if (original.reversesId) throw new DomainException("VALIDATION_ERROR", "لا يُعكس قيد عكسي", 422);

        const opposite: Record<string, "EXPENSE" | "INCOME" | "DEPOSIT" | "WITHDRAW"> = {
          EXPENSE: "INCOME", INCOME: "EXPENSE", DEPOSIT: "WITHDRAW", WITHDRAW: "DEPOSIT",
        };
        const revType = opposite[original.type];
        const amount = D(original.amount);
        const { entryId } = await this.ledger.postEntry(tx, actor, {
          sourceType: "CASH_ENTRY",
          memo: `عكس ${this.typeAr(original.type)}: ${original.memo}${body.reason ? ` — ${body.reason}` : ""}`,
          lines: this.linesFor(revType, amount),
        });
        const reversal = await tx.cashEntry.create({
          data: {
            pharmacyId: actor.pharmacyId,
            type: revType,
            amount,
            memo: `عكس: ${original.memo}`,
            categoryId: original.categoryId,
            shiftId: null,
            journalEntryId: entryId,
            createdById: actor.userId,
            reversesId: original.id,
          },
        });
        await tx.cashEntry.update({ where: { id: original.id }, data: { reversedById: reversal.id } });
        await this.audit.record(tx, actor, "CASH_ENTRY_REVERSED", "CashEntry", original.id, {
          reversalId: reversal.id, reason: body.reason,
        });
        return reversal;
      }),
    );
  }

  /** الفئات — تُزرع الافتراضية تلقائيًا أول مرة. */
  @Get("categories")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async categories(@CurrentActor() actor: Actor) {
    const count = await this.prisma.cashCategory.count({ where: { pharmacyId: actor.pharmacyId } });
    if (count === 0) {
      await this.prisma.cashCategory.createMany({
        data: DEFAULT_CATEGORIES.map((c) => ({ pharmacyId: actor.pharmacyId, ...c })),
        skipDuplicates: true,
      });
    }
    return this.prisma.cashCategory.findMany({
      where: { pharmacyId: actor.pharmacyId, archivedAt: null },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    });
  }

  @Post("categories")
  @Roles("PHARMACIST")
  async createCategory(@CurrentActor() actor: Actor, @Body() dto: CreateCategoryDto) {
    return this.prisma.cashCategory.create({ data: { pharmacyId: actor.pharmacyId, name: dto.name, kind: dto.kind } });
  }

  // ───────────────────────── helpers ─────────────────────────

  private linesFor(type: string, amount: Prisma.Decimal) {
    switch (type) {
      case "EXPENSE":
        return [{ account: ACCOUNTS.OP_EXPENSE, debit: amount }, { account: ACCOUNTS.CASH, credit: amount }];
      case "INCOME":
        return [{ account: ACCOUNTS.CASH, debit: amount }, { account: ACCOUNTS.OTHER_INCOME, credit: amount }];
      case "DEPOSIT": // من الخزينة إلى البنك
        return [{ account: ACCOUNTS.BANK, debit: amount }, { account: ACCOUNTS.CASH, credit: amount }];
      case "WITHDRAW": // من البنك إلى الخزينة
        return [{ account: ACCOUNTS.CASH, debit: amount }, { account: ACCOUNTS.BANK, credit: amount }];
      default:
        throw new DomainException("VALIDATION_ERROR", "نوع غير معروف", 422);
    }
  }

  private typeAr(type: string) {
    return { EXPENSE: "مصروف", INCOME: "إيراد", DEPOSIT: "إيداع بنكي", WITHDRAW: "سحب من البنك" }[type] ?? type;
  }

  /** حسابات الخزينة المساندة تُنشأ عند أول استخدام — صيدليات قائمة قبل هذه الميزة لا تحتاج هجرة بيانات. */
  private async ensureAccounts(tx: Tx, pharmacyId: string) {
    const needed: [string, string][] = [
      [ACCOUNTS.BANK, "البنك"],
      [ACCOUNTS.OP_EXPENSE, "مصروفات تشغيل"],
      [ACCOUNTS.OTHER_INCOME, "إيرادات أخرى"],
    ];
    for (const [code, nameAr] of needed) {
      const exists = await tx.account.findFirst({ where: { pharmacyId, code } });
      if (!exists) await tx.account.create({ data: { pharmacyId, code, name: nameAr } });
    }
  }
}
