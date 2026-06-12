import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { IsNumberString, IsOptional, IsString } from "class-validator";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, Roles } from "../common/auth";
import { DomainException } from "../common/errors";
import { AuditService } from "../platform/audit.service";

class CreateSupplierDto {
  @IsString() name!: string;
  @IsOptional() @IsString() phone?: string;
}
class UpdateSupplierDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
}

/** Procurement bounded context (MVP slice): supplier registry feeding GRN + AP dimension. */
@Controller("suppliers")
export class SuppliersController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  @Roles("ASSISTANT", "PHARMACIST", "CASHIER")
  async list(@CurrentActor() actor: Actor, @Query("search") search?: string) {
    return this.prisma.supplier.findMany({
      where: {
        pharmacyId: actor.pharmacyId,
        archivedAt: null,
        ...(search && { name: { contains: search, mode: "insensitive" } }),
      },
      orderBy: { name: "asc" },
      take: 100,
    });
  }

  /** GET /suppliers/:id/intelligence — ذكاء المورد (قراءة فقط من بيانات GRN):
   *  تاريخ التوريد · أكثر الأصناف · آخر سعر شراء + الاتجاه · تنبيه شذوذ سعري. لا سكيما جديدة. */
  @Get(":id/intelligence")
  @Roles("PHARMACIST")
  async intelligence(@CurrentActor() actor: Actor, @Param("id") id: string) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!supplier) throw new DomainException("NOT_FOUND", "Supplier not found", 404);

    const grns = await this.prisma.grn.findMany({
      where: { pharmacyId: actor.pharmacyId, supplierId: id },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    // تاريخ التوريد
    const invoiceCount = grns.length;
    const invoiceTotals = grns.map((g) => g.lines.reduce((a, l) => a + l.quantity * Number(l.unitCost), 0));
    const totalPurchased = invoiceTotals.reduce((a, b) => a + b, 0);
    const avgInvoice = invoiceCount ? totalPurchased / invoiceCount : 0;
    const lastInvoiceDate = grns[0]?.createdAt ?? null;

    // تجميع لكل صنف: الكمية الكلية + تاريخ الأسعار (الأحدث أولًا)
    const medIds = [...new Set(grns.flatMap((g) => g.lines.map((l) => l.medicineId)))];
    const meds = await this.prisma.medicine.findMany({ where: { id: { in: medIds } }, select: { id: true, tradeNameAr: true } });
    const mName = new Map(meds.map((m) => [m.id, m.tradeNameAr]));

    type Hist = { qty: number; prices: { cost: number; at: Date }[] };
    const byMed = new Map<string, Hist>();
    for (const g of grns) {
      for (const l of g.lines) {
        const h = byMed.get(l.medicineId) ?? { qty: 0, prices: [] };
        h.qty += l.quantity;
        h.prices.push({ cost: Number(l.unitCost), at: g.createdAt });
        byMed.set(l.medicineId, h);
      }
    }

    const items = [...byMed.entries()].map(([medId, h]) => {
      const sorted = h.prices.sort((a, b) => b.at.getTime() - a.at.getTime());
      const lastPrice = sorted[0]?.cost ?? 0;
      const prevPrice = sorted[1]?.cost ?? null;
      const changePct = prevPrice && prevPrice !== 0 ? ((lastPrice - prevPrice) / prevPrice) * 100 : null;
      // شذوذ: ارتفاع آخر سعر أكثر من 20% عن السابق
      const anomaly = changePct !== null && changePct > 20;
      return {
        medicine: mName.get(medId) ?? "—",
        totalQty: h.qty,
        lastPrice: lastPrice.toFixed(2),
        prevPrice: prevPrice !== null ? prevPrice.toFixed(2) : null,
        changePct: changePct !== null ? changePct.toFixed(1) : null,
        anomaly,
        purchases: sorted.length,
      };
    });

    const topItems = [...items].sort((a, b) => b.totalQty - a.totalQty).slice(0, 10);
    const anomalies = items.filter((i) => i.anomaly).sort((a, b) => Number(b.changePct) - Number(a.changePct));

    // سلسلة المشتريات الشهرية (للرسم العمودي) — إجمالي كل شهر
    const monthly = new Map<string, number>();
    for (const g of grns) {
      const key = `${g.createdAt.getFullYear()}-${String(g.createdAt.getMonth() + 1).padStart(2, "0")}`;
      const total = g.lines.reduce((a, l) => a + l.quantity * Number(l.unitCost), 0);
      monthly.set(key, (monthly.get(key) ?? 0) + total);
    }
    const purchaseSeries = [...monthly.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
      .map(([month, total]) => ({ month, total: total.toFixed(2) }));

    // سلسلة سعر أكثر صنف توريدًا (للرسم الخطي) — تطوّر تكلفة الوحدة عبر الزمن
    const topMedId = topItems[0] ? [...byMed.entries()].find(([mid]) => mName.get(mid) === topItems[0].medicine)?.[0] : null;
    const priceSeries = topMedId
      ? (byMed.get(topMedId)?.prices ?? [])
          .slice()
          .sort((a, b) => a.at.getTime() - b.at.getTime())
          .map((p) => ({ at: p.at, cost: p.cost.toFixed(2) }))
      : [];

    return {
      supplier: supplier.name,
      history: {
        invoiceCount,
        totalPurchased: totalPurchased.toFixed(2),
        avgInvoice: avgInvoice.toFixed(2),
        lastInvoiceDate,
      },
      topItems,
      anomalies,
      itemsTracked: items.length,
      purchaseSeries,
      priceSeries,
      priceSeriesItem: topItems[0]?.medicine ?? null,
    };
  }

  /** balance is the cached AP projection (read-only; truth = AP journal lines). */
  @Get(":id")
  @Roles("ASSISTANT", "PHARMACIST")
  async detail(@CurrentActor() actor: Actor, @Param("id") id: string) {
    const s = await this.prisma.supplier.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!s) throw new DomainException("NOT_FOUND", "Supplier not found", 404);
    const { balanceCached, ...rest } = s;
    return { ...rest, balance: balanceCached };
  }

  @Post()
  @Roles("ASSISTANT", "PHARMACIST")
  async create(@CurrentActor() actor: Actor, @Body() dto: CreateSupplierDto) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.create({ data: { pharmacyId: actor.pharmacyId, ...dto } });
      await this.audit.record(tx, actor, "SUPPLIER_CREATED", "Supplier", supplier.id);
      return supplier;
    });
  }

  @Patch(":id")
  @Roles("PHARMACIST")
  async update(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: UpdateSupplierDto) {
    const existing = await this.prisma.supplier.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!existing) throw new DomainException("NOT_FOUND", "Supplier not found", 404);
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.update({ where: { id }, data: dto as Prisma.SupplierUpdateInput });
      await this.audit.record(tx, actor, "SUPPLIER_UPDATED", "Supplier", id, { ...dto });
      return supplier;
    });
  }
}
