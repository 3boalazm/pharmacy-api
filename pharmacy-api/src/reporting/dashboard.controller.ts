import { Controller, Get } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { CacheService } from "../platform/cache.service";
import { Actor, CurrentActor, Roles } from "../common/auth";

/** GET /dashboard — KPI read model (Contract §10). Reads aggregates; writes nothing. */
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService) {}

  @Get()
  @Roles("PHARMACIST")
  async kpis(@CurrentActor() actor: Actor) {
    // R-3 read-through cache (30s); invalidated by SaleCompleted/PaymentRecorded consumers.
    const cacheKey = `dash:${actor.pharmacyId}`;
    const cached = await this.cache.get<Record<string, string>>(cacheKey);
    if (cached) return cached;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [todayAgg, monthAgg, receivables] = await Promise.all([
      this.prisma.salesInvoice.aggregate({
        where: { pharmacyId: actor.pharmacyId, createdAt: { gte: today } },
        _sum: { total: true },
      }),
      this.prisma.salesInvoice.aggregate({
        where: { pharmacyId: actor.pharmacyId, createdAt: { gte: monthStart } },
        _sum: { total: true, totalCost: true, totalDiscount: true },
      }),
      this.prisma.customer.aggregate({
        where: { pharmacyId: actor.pharmacyId },
        _sum: { balanceCached: true },
      }),
    ]);

    const cash = await this.prisma.$queryRaw<{ balance: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,4) AS balance
      FROM journal_lines jl JOIN accounts a ON a.id = jl."accountId"
      WHERE jl."pharmacyId" = ${actor.pharmacyId}::uuid AND a.code = '1000'`;

    const overdue = await this.prisma.installment.aggregate({
      where: { pharmacyId: actor.pharmacyId, paidAt: null, dueDate: { lt: new Date() } },
      _sum: { amount: true },
    });

    const zero = new Prisma.Decimal(0);
    const sales = monthAgg._sum.total ?? zero;
    const cost = monthAgg._sum.totalCost ?? zero;
    const result = {
      todaySales: todayAgg._sum.total ?? zero,
      cashInDrawer: cash[0]?.balance ?? zero,
      totalReceivables: receivables._sum.balanceCached ?? zero,
      overduePayments: overdue._sum.amount ?? zero,
      profitMtd: sales.sub(cost),
    };
    await this.cache.set(cacheKey, {
      todaySales: result.todaySales.toFixed(4),
      cashInDrawer: result.cashInDrawer.toFixed(4),
      totalReceivables: result.totalReceivables.toFixed(4),
      overduePayments: result.overduePayments.toFixed(4),
      profitMtd: result.profitMtd.toFixed(4),
    }, 30);
    return result;
  }
}
