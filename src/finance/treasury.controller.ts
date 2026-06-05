import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { IsIn, IsNumberString, IsOptional, IsString, MinLength } from "class-validator";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, IdemKey, Roles } from "../common/auth";
import { IdempotencyService } from "../common/idempotency.service";
import { DomainException } from "../common/errors";
import { AuditService } from "../platform/audit.service";
import { LedgerService, ACCOUNTS } from "./ledger.service";

/** حسابات الخزينة اليدوية — تُنشأ عند أول استخدام للصيدليات القائمة. */
const TREASURY_ACCOUNTS = {
  OP_EXPENSE: { code: "5800", name: "مصاريف تشغيلية" },
  OTHER_INCOME: { code: "4900", name: "إيرادات أخرى" },
} as const;

class TreasuryEntryDto {
  @IsIn(["EXPENSE", "INCOME"]) type!: "EXPENSE" | "INCOME";
  @IsNumberString() amount!: string;
  @IsString() @MinLength(3, { message: "اكتب بيانًا واضحًا (٣ أحرف فأكثر)" }) description!: string;
  @IsOptional() @IsString() category?: string; // كهرباء/إيجار/رواتب/نثرية…
}

/**
 * الخزينة (Cash Management): مصروفات وإيرادات يدوية بقيود مزدوجة متوازنة
 * على نفس دفتر الأستاذ — لا عدّاد نقدية موازٍ؛ رصيد الخزينة هو فولد حساب 1000.
 */
@Controller("finance/treasury")
export class TreasuryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly idem: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  /** قيد مصروف (مدين 5800 / دائن 1000) أو إيراد آخر (مدين 1000 / دائن 4900). */
  @Post("entries")
  @Roles("PHARMACIST")
  async addEntry(@CurrentActor() actor: Actor, @IdemKey() key: string, @Body() dto: TreasuryEntryDto) {
    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lte(0)) throw new DomainException("VALIDATION_ERROR", "المبلغ يجب أن يكون أكبر من صفر", 422);

    return this.idem.run(actor.pharmacyId, key, "POST /finance/treasury/entries", () =>
      this.prisma.$transaction(async (tx) => {
        // create-if-missing للحسابين (الصيدليات المنشأة قبل هذه الميزة)
        for (const acc of Object.values(TREASURY_ACCOUNTS)) {
          await tx.account.upsert({
            where: { pharmacyId_code: { pharmacyId: actor.pharmacyId, code: acc.code } },
            update: {},
            create: { pharmacyId: actor.pharmacyId, code: acc.code, name: acc.name },
          });
        }
        const memo = `${dto.type === "EXPENSE" ? "مصروف" : "إيراد"}${dto.category ? ` (${dto.category})` : ""}: ${dto.description}`;
        const { entryId } = await this.ledger.postEntry(tx, actor, {
          sourceType: "TREASURY",
          sourceId: actor.userId,
          memo,
          lines:
            dto.type === "EXPENSE"
              ? [{ account: ACCOUNTS.OP_EXPENSE, debit: amount }, { account: ACCOUNTS.CASH, credit: amount }]
              : [{ account: ACCOUNTS.CASH, debit: amount }, { account: ACCOUNTS.OTHER_INCOME, credit: amount }],
        });
        await this.audit.record(tx, actor, "TREASURY_ENTRY", "JournalEntry", entryId, {
          type: dto.type, amount: amount.toFixed(4), category: dto.category, description: dto.description,
        });
        return { entryId, type: dto.type, amount: amount.toFixed(4), memo };
      }),
    );
  }

  /** كشف حركة النقدية: رصيد الخزينة الكلي + حركات حساب 1000 في الفترة (من واقع القيود). */
  @Get()
  @Roles("PHARMACIST")
  async statement(@CurrentActor() actor: Actor, @Query("from") from?: string, @Query("to") to?: string) {
    const end = to ? new Date(`${to}T23:59:59.999`) : new Date();
    const start = from ? new Date(`${from}T00:00:00`) : new Date(end.getTime() - 13 * 86_400_000);

    const [bal] = await this.prisma.$queryRaw<{ balance: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,4) AS balance
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl."entryId"
      JOIN accounts a ON a.id = jl."accountId"
      WHERE je."pharmacyId" = ${actor.pharmacyId}::uuid AND a.code = '1000'`;

    const rows = await this.prisma.$queryRaw<
      { id: string; date: Date; memo: string; sourceType: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[]
    >`
      SELECT je.id, je."createdAt" AS date, je.memo, je."sourceType", jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl."entryId"
      JOIN accounts a ON a.id = jl."accountId"
      WHERE je."pharmacyId" = ${actor.pharmacyId}::uuid AND a.code = '1000'
        AND je."createdAt" BETWEEN ${start} AND ${end}
      ORDER BY je."createdAt" DESC
      LIMIT 200`;

    return { balance: bal?.balance ?? "0", from: start, to: end, rows };
  }
}
