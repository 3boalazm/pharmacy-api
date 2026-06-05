import { Controller, Get, Query } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, Roles } from "../common/auth";

function range(from?: string, to?: string) {
  const end = to ? new Date(`${to}T23:59:59.999`) : new Date();
  const start = from ? new Date(`${from}T00:00:00`) : new Date(end.getTime() - 29 * 86_400_000);
  return { start, end };
}

/**
 * شاشة التقارير (الاستبيان §التقارير المطلوبة): مبيعات يومية/شهرية، أرباح،
 * الأكثر مبيعًا — كلها مشتقة من فواتير ومرتجعات حقيقية (لا عدّادات موازية).
 */
@Controller("reports")
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  /** ملخص فترة: مبيعات/خصومات/تكلفة/ربح/مرتجعات/عدد فواتير. */
  @Get("summary")
  @Roles("PHARMACIST")
  async summary(@CurrentActor() actor: Actor, @Query("from") from?: string, @Query("to") to?: string) {
    const { start, end } = range(from, to);
    const sales = await this.prisma.salesInvoice.aggregate({
      where: { pharmacyId: actor.pharmacyId, createdAt: { gte: start, lte: end } },
      _sum: { total: true, totalDiscount: true, totalCost: true },
      _count: true,
    });
    const returns = await this.prisma.$queryRaw<{ refund: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(l.refund), 0)::numeric(19,4) AS refund
      FROM sale_return_lines l JOIN sale_returns r ON r.id = l."returnId"
      WHERE r."pharmacyId" = ${actor.pharmacyId}::uuid AND r."createdAt" BETWEEN ${start} AND ${end}`;
    const zero = new Prisma.Decimal(0);
    const total = sales._sum.total ?? zero;
    const cost = sales._sum.totalCost ?? zero;
    return {
      from: start, to: end,
      invoices: sales._count,
      salesTotal: total,
      discounts: sales._sum.totalDiscount ?? zero,
      cogs: cost,
      grossProfit: total.sub(cost),
      returnsTotal: returns[0]?.refund ?? zero,
    };
  }

  /** المبيعات يومًا بيوم (للرسم/الجدول والتصدير). */
  @Get("daily")
  @Roles("PHARMACIST")
  async daily(@CurrentActor() actor: Actor, @Query("from") from?: string, @Query("to") to?: string) {
    const { start, end } = range(from, to);
    return this.prisma.$queryRaw<{ day: Date; invoices: bigint; total: Prisma.Decimal; profit: Prisma.Decimal }[]>`
      SELECT date_trunc('day', "createdAt")::date AS day,
             COUNT(*) AS invoices,
             COALESCE(SUM(total), 0)::numeric(19,4) AS total,
             COALESCE(SUM(total - "totalCost"), 0)::numeric(19,4) AS profit
      FROM sales_invoices
      WHERE "pharmacyId" = ${actor.pharmacyId}::uuid AND "createdAt" BETWEEN ${start} AND ${end}
      GROUP BY 1 ORDER BY 1 DESC`;
  }

  /** الأدوية الأكثر مبيعًا في الفترة (كمية وإيرادًا). */
  @Get("top-medicines")
  @Roles("PHARMACIST")
  async topMedicines(
    @CurrentActor() actor: Actor,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit = "15",
  ) {
    const { start, end } = range(from, to);
    const take = Math.min(Number(limit) || 15, 50);
    return this.prisma.$queryRaw<{ medicineId: string; nameAr: string; form: string; quantity: bigint; revenue: Prisma.Decimal }[]>`
      SELECT si."medicineId", m."tradeNameAr" AS "nameAr", m.form,
             SUM(si.quantity) AS quantity,
             COALESCE(SUM(si."lineTotal"), 0)::numeric(19,4) AS revenue
      FROM sales_items si
      JOIN sales_invoices inv ON inv.id = si."invoiceId"
      JOIN medicines m ON m.id = si."medicineId"
      WHERE inv."pharmacyId" = ${actor.pharmacyId}::uuid AND inv."createdAt" BETWEEN ${start} AND ${end}
      GROUP BY si."medicineId", m."tradeNameAr", m.form
      ORDER BY quantity DESC
      LIMIT ${take}`;
  }
}
