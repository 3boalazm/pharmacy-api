import { Controller, Get, Query } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, Roles } from "../common/auth";

/**
 * طبقة رؤى تحليلية — قراءة فقط بحتة (Architecture: read-only، لا تمسّ قيودًا ولا مخزونًا).
 * كل endpoint يشتق من بيانات موجودة دون أي جدول أو عمود جديد.
 */
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  /** F1 — إشارة فرق الدرج: الورديات المقفلة بفروقها وتصنيف شدتها + اتجاه آخر 30. */
  @Get("cash-variance")
  @Roles("PHARMACIST")
  async cashVariance(@CurrentActor() actor: Actor) {
    const shifts = await this.prisma.shift.findMany({
      where: { pharmacyId: actor.pharmacyId, status: "CLOSED", overShort: { not: null } },
      include: { user: { select: { name: true } } },
      orderBy: { closedAt: "desc" },
      take: 30,
    });
    const rows = shifts.map((s) => {
      const expected = Number(s.expectedCash ?? 0);
      const counted = Number(s.countedCash ?? 0);
      const variance = Number(s.overShort ?? 0);
      const pct = expected !== 0 ? Math.abs(variance / expected) * 100 : 0;
      const severity = pct < 1 ? "NORMAL" : pct <= 3 ? "WARNING" : "CRITICAL";
      return {
        shiftId: s.id,
        user: s.user?.name ?? "—",
        closedAt: s.closedAt,
        expected: expected.toFixed(2),
        counted: counted.toFixed(2),
        variance: variance.toFixed(2),
        variancePct: pct.toFixed(2),
        severity,
      };
    });
    const variances = rows.map((r) => Math.abs(Number(r.variance)));
    const avgVariance = variances.length ? variances.reduce((a, b) => a + b, 0) / variances.length : 0;
    const maxVariance = variances.length ? Math.max(...variances) : 0;
    return { rows, summary: { avgVariance: avgVariance.toFixed(2), maxVariance: maxVariance.toFixed(2), count: rows.length } };
  }

  /** F2 — كشف الخصومات الشاذة: فواتير بخصم فوق العتبة + أعلى المستخدمين بإجمالي الخصم. */
  @Get("discounts")
  @Roles("PHARMACIST")
  async discounts(@CurrentActor() actor: Actor, @Query("thresholdPct") thresholdPct = "15") {
    const threshold = Number(thresholdPct) || 15;
    const since = new Date(Date.now() - 90 * 86_400_000);
    const invoices = await this.prisma.salesInvoice.findMany({
      where: { pharmacyId: actor.pharmacyId, createdAt: { gte: since }, totalDiscount: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const userIds = [...new Set(invoices.map((i) => i.cashierUserId))];
    const custIds = [...new Set(invoices.map((i) => i.customerId).filter(Boolean))] as string[];
    const [users, customers] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      custIds.length ? this.prisma.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ]);
    const uName = new Map(users.map((u) => [u.id, u.name]));
    const cName = new Map(customers.map((c) => [c.id, c.name]));

    const flagged = invoices
      .map((i) => {
        const subtotal = Number(i.subtotal);
        const disc = Number(i.totalDiscount);
        const pct = subtotal !== 0 ? (disc / subtotal) * 100 : 0;
        return {
          invoiceNo: i.invoiceNo,
          cashier: uName.get(i.cashierUserId) ?? "—",
          customer: i.customerId ? cName.get(i.customerId) ?? "—" : "نقدي",
          discount: disc.toFixed(2),
          discountPct: pct.toFixed(1),
          createdAt: i.createdAt,
          flagged: pct >= threshold,
        };
      })
      .filter((r) => r.flagged)
      .sort((a, b) => Number(b.discount) - Number(a.discount));

    // أعلى المستخدمين بإجمالي الخصم
    const byUser = new Map<string, number>();
    for (const i of invoices) {
      byUser.set(i.cashierUserId, (byUser.get(i.cashierUserId) ?? 0) + Number(i.totalDiscount));
    }
    const topUsers = [...byUser.entries()]
      .map(([id, total]) => ({ user: uName.get(id) ?? "—", totalDiscount: total.toFixed(2) }))
      .sort((a, b) => Number(b.totalDiscount) - Number(a.totalDiscount))
      .slice(0, 5);

    return { threshold, flagged, topUsers, scanned: invoices.length };
  }

  /** F3 — درجة خطر الانتهاء: التشغيلات القريبة مرتبة بقيمة الخسارة المحتملة (كمية×تكلفة). */
  @Get("expiry-loss")
  @Roles("ASSISTANT", "PHARMACIST")
  async expiryLoss(@CurrentActor() actor: Actor, @Query("withinDays") withinDays = "90") {
    const days = Math.min(Number(withinDays) || 90, 365);
    const horizon = new Date(Date.now() + days * 86_400_000);
    const batches = await this.prisma.batch.findMany({
      where: {
        pharmacyId: actor.pharmacyId,
        status: "ACTIVE",
        quantityOnHand: { gt: 0 },
        expiryDate: { lte: horizon, gt: new Date() },
      },
      orderBy: { expiryDate: "asc" },
      take: 500,
    });
    const medIds = [...new Set(batches.map((b) => b.medicineId))];
    const meds = await this.prisma.medicine.findMany({ where: { id: { in: medIds } }, select: { id: true, tradeNameAr: true } });
    const mName = new Map(meds.map((m) => [m.id, m.tradeNameAr]));

    const rows = batches
      .map((b) => {
        const qty = b.quantityOnHand;
        const cost = Number(b.unitCost);
        const potentialLoss = qty * cost;
        const daysLeft = Math.ceil((b.expiryDate.getTime() - Date.now()) / 86_400_000);
        return {
          medicine: mName.get(b.medicineId) ?? "—",
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate,
          daysLeft,
          quantity: qty,
          costPrice: cost.toFixed(2),
          potentialLoss: potentialLoss.toFixed(2),
        };
      })
      .sort((a, b) => Number(b.potentialLoss) - Number(a.potentialLoss));

    const totalAtRisk = rows.reduce((a, r) => a + Number(r.potentialLoss), 0);
    return { rows, summary: { totalAtRisk: totalAtRisk.toFixed(2), batches: rows.length, withinDays: days } };
  }

  /** F4 — البضاعة الراكدة: أصناف بمخزون بلا حركة بيع منذ N يومًا، مرتبة بقيمة المخزون. */
  @Get("dead-stock")
  @Roles("ASSISTANT", "PHARMACIST")
  async deadStock(@CurrentActor() actor: Actor, @Query("inactiveDays") inactiveDays = "60") {
    const days = Number(inactiveDays) || 60;
    const cutoff = new Date(Date.now() - days * 86_400_000);

    // آخر تاريخ بيع لكل صنف (حركة SALE)
    const lastSales = await this.prisma.inventoryTransaction.groupBy({
      by: ["medicineId"],
      where: { pharmacyId: actor.pharmacyId, type: "SALE" },
      _max: { createdAt: true },
    });
    const lastSaleByMed = new Map(lastSales.map((s) => [s.medicineId, s._max.createdAt]));

    // المخزون الحالي لكل صنف بقيمته
    const batches = await this.prisma.batch.groupBy({
      by: ["medicineId"],
      where: { pharmacyId: actor.pharmacyId, status: "ACTIVE", quantityOnHand: { gt: 0 } },
      _sum: { quantityOnHand: true },
    });
    const medIds = batches.map((b) => b.medicineId);
    const [meds, costs] = await Promise.all([
      this.prisma.medicine.findMany({ where: { id: { in: medIds } }, select: { id: true, tradeNameAr: true } }),
      this.prisma.batch.findMany({
        where: { pharmacyId: actor.pharmacyId, medicineId: { in: medIds }, status: "ACTIVE", quantityOnHand: { gt: 0 } },
        select: { medicineId: true, quantityOnHand: true, unitCost: true },
      }),
    ]);
    const mName = new Map(meds.map((m) => [m.id, m.tradeNameAr]));
    const valueByMed = new Map<string, number>();
    for (const b of costs) {
      valueByMed.set(b.medicineId, (valueByMed.get(b.medicineId) ?? 0) + b.quantityOnHand * Number(b.unitCost));
    }

    const rows = batches
      .map((b) => {
        const lastSale = lastSaleByMed.get(b.medicineId) ?? null;
        const inactive = !lastSale || lastSale < cutoff;
        if (!inactive) return null;
        const daysInactive = lastSale ? Math.floor((Date.now() - lastSale.getTime()) / 86_400_000) : null;
        return {
          medicine: mName.get(b.medicineId) ?? "—",
          quantity: b._sum.quantityOnHand ?? 0,
          inventoryValue: (valueByMed.get(b.medicineId) ?? 0).toFixed(2),
          lastSale,
          daysInactive,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => Number(b.inventoryValue) - Number(a.inventoryValue));

    const frozenValue = rows.reduce((a, r) => a + Number(r.inventoryValue), 0);
    return { rows, summary: { frozenValue: frozenValue.toFixed(2), items: rows.length, inactiveDays: days } };
  }

  /** F5 — تحليل ABC: تصنيف الأصناف حسب مساهمتها في الإيراد (A=أعلى 80% تراكمي، B حتى 95%، C الباقي). */
  @Get("abc")
  @Roles("PHARMACIST")
  async abc(@CurrentActor() actor: Actor, @Query("days") days = "90") {
    const since = new Date(Date.now() - (Number(days) || 90) * 86_400_000);
    const items = await this.prisma.salesItem.groupBy({
      by: ["medicineId"],
      where: { invoice: { pharmacyId: actor.pharmacyId, createdAt: { gte: since } } },
      _sum: { lineTotal: true, quantity: true },
    });
    const medIds = items.map((i) => i.medicineId);
    const meds = await this.prisma.medicine.findMany({ where: { id: { in: medIds } }, select: { id: true, tradeNameAr: true } });
    const mName = new Map(meds.map((m) => [m.id, m.tradeNameAr]));

    const sorted = items
      .map((i) => ({ medicineId: i.medicineId, revenue: Number(i._sum?.lineTotal ?? 0), qty: i._sum?.quantity ?? 0 }))
      .sort((a, b) => b.revenue - a.revenue);
    const totalRevenue = sorted.reduce((a, r) => a + r.revenue, 0);

    let cumulative = 0;
    const rows = sorted.map((r) => {
      cumulative += r.revenue;
      const cumPct = totalRevenue ? (cumulative / totalRevenue) * 100 : 0;
      const cls = cumPct <= 80 ? "A" : cumPct <= 95 ? "B" : "C";
      return {
        medicine: mName.get(r.medicineId) ?? "—",
        revenue: r.revenue.toFixed(2),
        qty: r.qty,
        revenuePct: totalRevenue ? ((r.revenue / totalRevenue) * 100).toFixed(1) : "0",
        cumulativePct: cumPct.toFixed(1),
        class: cls,
      };
    });
    const counts = { A: rows.filter((r) => r.class === "A").length, B: rows.filter((r) => r.class === "B").length, C: rows.filter((r) => r.class === "C").length };
    return { rows, summary: { totalRevenue: totalRevenue.toFixed(2), counts, days: Number(days) || 90 } };
  }

  /** F6 — تقسيم العملاء: شرائح بسيطة من تكرار الشراء وآخر فاتورة (دائم/متكرر/جديد/خامل). */
  @Get("customer-segments")
  @Roles("PHARMACIST")
  async customerSegments(@CurrentActor() actor: Actor) {
    const customers = await this.prisma.customer.findMany({
      where: { pharmacyId: actor.pharmacyId, archivedAt: null },
      select: { id: true, name: true, balanceCached: true, loyaltyPoints: true },
    });
    const invoices = await this.prisma.salesInvoice.groupBy({
      by: ["customerId"],
      where: { pharmacyId: actor.pharmacyId, customerId: { not: null } },
      _count: { _all: true },
      _max: { createdAt: true },
      _sum: { total: true },
    });
    const byCust = new Map(invoices.map((i) => [i.customerId!, i]));
    const now = Date.now();
    const DORMANT_DAYS = 60;

    const rows = customers.map((c) => {
      const inv = byCust.get(c.id);
      const count = inv?._count._all ?? 0;
      const lastAt = inv?._max.createdAt ?? null;
      const totalSpent = Number(inv?._sum.total ?? 0);
      const daysSince = lastAt ? Math.floor((now - lastAt.getTime()) / 86_400_000) : null;
      let segment: string;
      if (count === 0) segment = "بلا مشتريات";
      else if (daysSince !== null && daysSince > DORMANT_DAYS) segment = "خامل";
      else if (count >= 5) segment = "دائم";
      else if (count >= 2) segment = "متكرر";
      else segment = "جديد";
      return { customer: c.name, invoices: count, totalSpent: totalSpent.toFixed(2), balance: Number(c.balanceCached).toFixed(2), lastPurchase: lastAt, daysSince, segment };
    }).sort((a, b) => Number(b.totalSpent) - Number(a.totalSpent));

    const segCounts: Record<string, number> = {};
    for (const r of rows) segCounts[r.segment] = (segCounts[r.segment] ?? 0) + 1;
    return { rows, summary: { total: rows.length, segments: segCounts } };
  }

  /** F7 — تنبؤ النفاد: لكل صنف، سرعة بيع 30 يومًا → أيام حتى النفاد عند المعدل الحالي. */
  @Get("stockout-forecast")
  @Roles("ASSISTANT", "PHARMACIST")
  async stockoutForecast(@CurrentActor() actor: Actor, @Query("withinDays") withinDays = "14") {
    const alertWithin = Number(withinDays) || 14;
    const since = new Date(Date.now() - 30 * 86_400_000);

    // كمية مباعة آخر 30 يومًا لكل صنف (حركات SALE — الكمية سالبة)
    const sales = await this.prisma.inventoryTransaction.groupBy({
      by: ["medicineId"],
      where: { pharmacyId: actor.pharmacyId, type: "SALE", createdAt: { gte: since } },
      _sum: { quantity: true },
    });
    const soldByMed = new Map(sales.map((s) => [s.medicineId, Math.abs(s._sum.quantity ?? 0)]));

    // المخزون الحالي لكل صنف
    const stock = await this.prisma.batch.groupBy({
      by: ["medicineId"],
      where: { pharmacyId: actor.pharmacyId, status: "ACTIVE", quantityOnHand: { gt: 0 }, expiryDate: { gt: new Date() } },
      _sum: { quantityOnHand: true },
    });
    const medIds = stock.map((s) => s.medicineId);
    const meds = await this.prisma.medicine.findMany({ where: { id: { in: medIds } }, select: { id: true, tradeNameAr: true, minStockLevel: true } });
    const mInfo = new Map(meds.map((m) => [m.id, m]));

    const rows = stock.map((s) => {
      const onHand = s._sum.quantityOnHand ?? 0;
      const sold30 = soldByMed.get(s.medicineId) ?? 0;
      const dailyRate = sold30 / 30;
      const daysToStockout = dailyRate > 0 ? Math.floor(onHand / dailyRate) : null;
      const info = mInfo.get(s.medicineId);
      return {
        medicine: info?.tradeNameAr ?? "—",
        onHand,
        sold30,
        dailyRate: dailyRate.toFixed(2),
        daysToStockout,
        minStockLevel: info?.minStockLevel ?? 0,
      };
    })
      .filter((r) => r.daysToStockout !== null && r.daysToStockout <= alertWithin)
      .sort((a, b) => (a.daysToStockout ?? 0) - (b.daysToStockout ?? 0));

    return { rows, summary: { atRisk: rows.length, withinDays: alertWithin } };
  }
}
