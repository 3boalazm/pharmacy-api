import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { SalesService } from "./sales.service";
import { SalesSyncService } from "./sales-sync.service";
import { SalesReturnService } from "./sales-return.service";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { CreateReturnDto } from "./dto/return.dto";
import { SyncDto } from "./dto/sync.dto";
import { InvoiceRepository } from "./repositories/invoice.repository";
import { IdempotencyService } from "../common/idempotency.service";
import { Actor, CurrentActor, IdemKey, Roles } from "../common/auth";
import { DomainException } from "../common/errors";



@Controller("sales")
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly sync: SalesSyncService,
    private readonly returns: SalesReturnService,
    private readonly invoices: InvoiceRepository,
    private readonly idem: IdempotencyService,
  ) {}

  /** POST /sales — THE atomic transaction (Contract §5.1). Idempotency-Key mandatory. */
  @Post()
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async create(@CurrentActor() actor: Actor, @IdemKey() key: string, @Body() dto: CreateSaleDto) {
    return this.idem.run(actor.pharmacyId, key, "POST /sales", () =>
      this.sales.createSale(actor, { ...dto, customerId: dto.customerId ?? null, prescriptionId: dto.prescriptionId ?? null }),
    );
  }

  /** POST /sales/returns — WF-3 return: restock + contra journal (Idempotency-Key mandatory). */
  @Post("returns")
  @Roles("ASSISTANT", "PHARMACIST")
  async createReturn(@CurrentActor() actor: Actor, @IdemKey() key: string, @Body() dto: CreateReturnDto) {
    return this.idem.run(actor.pharmacyId, key, "POST /sales/returns", () => this.returns.createReturn(actor, dto));
  }

  /** POST /sales/sync — offline replay batch, server-authoritative (Contract §5.3). */
  @Post("sync")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async syncBatch(@CurrentActor() actor: Actor, @Body() dto: SyncDto) {
    return this.sync.replay(actor, dto.commands);
  }

  @Get()
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async list(@CurrentActor() actor: Actor, @Query("customerId") customerId?: string) {
    return this.invoices.list(actor.pharmacyId, customerId);
  }

  @Get("last-for-customer/:customerId")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async lastForCustomer(@CurrentActor() actor: Actor, @Param("customerId") customerId: string) {
    const list = await this.invoices.list(actor.pharmacyId, customerId);
    if (!list.length) throw new DomainException("NOT_FOUND", "لا فواتير سابقة لهذا العميل", 404);
    const invoice = await this.invoices.findWithLines(actor.pharmacyId, list[0].id);
    if (!invoice) throw new DomainException("NOT_FOUND", "تعذّر قراءة الفاتورة", 404);
    return {
      invoiceNo: invoice.invoiceNo,
      createdAt: invoice.createdAt,
      lines: invoice.lines.map((l) => ({
        medicineId: l.medicineId,
        nameAr: l.medicine.tradeNameAr,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
      })),
    };
  }

  @Get(":id")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async detail(@CurrentActor() actor: Actor, @Param("id") id: string) {
    const invoice = await this.invoices.findWithLines(actor.pharmacyId, id);
    if (invoice) {
      const returned = await this.invoices.returnedByItem(actor.pharmacyId, invoice.lines.map((l) => l.id));
      return {
        ...invoice,
        lines: invoice.lines.map((l) => ({ ...l, nameAr: l.medicine.tradeNameAr, form: l.medicine.form, returnedQty: returned[l.id] ?? 0 })),
      };
    }
    if (!invoice) throw new DomainException("NOT_FOUND", "Invoice not found", 404);
    return invoice;
  }
}
