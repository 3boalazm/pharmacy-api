import { Injectable } from "@nestjs/common";
import { PrismaService, Tx } from "../../common/prisma.service";

/** Invoice repository — query surface for the sales aggregate (header + lines + allocations). */
@Injectable()
export class InvoiceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Sequential per-tenant invoice number (gap-tolerant; uniqueness enforced by DB). */
  async nextInvoiceNo(tx: Tx, pharmacyId: string): Promise<string> {
    const count = await tx.salesInvoice.count({ where: { pharmacyId } });
    return `INV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`;
  }

  async findWithLines(pharmacyId: string, id: string) {
    return this.prisma.salesInvoice.findFirst({
      where: { id, pharmacyId },
      include: { lines: { include: { allocations: true, medicine: { select: { tradeNameAr: true, form: true } } } } },
    });
  }

  async list(pharmacyId: string, customerId?: string) {
    return this.prisma.salesInvoice.findMany({
      where: { pharmacyId, customerId: customerId || undefined },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  /** Σ quantity already returned per sales item (over-return guard, WF-3). */
  async returnedQuantity(tx: Tx, pharmacyId: string, salesItemId: string): Promise<number> {
    const agg = await tx.saleReturnLine.aggregate({
      where: { pharmacyId, salesItemId },
      _sum: { quantity: true },
    });
    return agg._sum.quantity ?? 0;
  }

  /** الكميات المرتجعة سابقًا لكل سطر في الفاتورة (لواجهة المرتجعات). */
  async returnedByItem(pharmacyId: string, salesItemIds: string[]): Promise<Record<string, number>> {
    if (salesItemIds.length === 0) return {};
    const rows = await this.prisma.saleReturnLine.groupBy({
      by: ["salesItemId"],
      where: { pharmacyId, salesItemId: { in: salesItemIds } },
      _sum: { quantity: true },
    });
    return Object.fromEntries(rows.map((r) => [r.salesItemId, r._sum.quantity ?? 0]));
  }
}
