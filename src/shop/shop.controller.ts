import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Min, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import * as bcrypt from "bcryptjs";
import { JwtService } from "@nestjs/jwt";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { DomainException } from "../common/errors";
import { Public } from "../common/auth";
import { CurrentCustomer, CustomerGuard, PortalPublic, type PortalActor } from "./customer.guard";
import { LedgerService } from "../finance/ledger.service";
import { OutboxService } from "../platform/outbox.service";
import { EVENTS } from "../platform/events";

class RegisterDto {
  @IsString() @MinLength(3) name!: string;
  @IsString() @Matches(/^01\d{9}$/, { message: "رقم موبايل مصري صحيح" }) phone!: string;
  @IsString() @MinLength(8, { message: "كلمة المرور 8 أحرف على الأقل" }) password!: string;
}
class PortalLoginDto {
  @IsString() phone!: string;
  @IsString() password!: string;
}
class OrderLineDto {
  @IsUUID() medicineId!: string;
  @IsInt() @Min(1) quantity!: number;
}
class PlaceOrderDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => OrderLineDto) lines!: OrderLineDto[];
  @IsIn(["PICKUP", "DELIVERY"]) fulfillment!: "PICKUP" | "DELIVERY";
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() note?: string;
}

/**
 * بوابة العميل (الستور) — Contract: the portal NEVER writes money or stock.
 * It reads the customer's own ledger projections and creates ORDER intents;
 * the only path that moves stock/money remains the atomic sale, executed by
 * staff at delivery. @Public exempts these routes from the staff guard, and
 * CustomerGuard establishes the separate portal trust domain.
 */
@Public()
@UseGuards(CustomerGuard)
@Controller("shop")
export class ShopController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
  ) {}

  private async tenant() {
    const pharmacy = await this.prisma.pharmacy.findFirst();
    if (!pharmacy) throw new DomainException("NOT_FOUND", "النظام غير مُعدّ بعد", 404);
    return pharmacy;
  }

  /** تسجيل عميل: رقم جديد → حساب نشط برصيد صفر؛ رقم له دفتر قائم → بانتظار تفعيل الصيدلية (حماية كشف الحساب). */
  @PortalPublic()
  @Post("auth/register")
  async register(@Body() dto: RegisterDto) {
    const pharmacy = await this.tenant();
    const existing = await this.prisma.customer.findFirst({ where: { pharmacyId: pharmacy.id, phone: dto.phone } });
    const hash = await bcrypt.hash(dto.password, 10);

    if (existing) {
      if (existing.portalPasswordHash && existing.portalStatus === "ACTIVE") {
        throw new DomainException("CONFLICT", "هذا الرقم مسجل بالفعل — سجّل الدخول", 409);
      }
      await this.prisma.customer.update({
        where: { id: existing.id },
        data: { portalPasswordHash: hash, portalStatus: "PENDING" },
      });
      return { status: "PENDING", message: "رقمك له حساب دفتري بالصيدلية — سيُفعَّل الدخول بعد تأكيد الصيدلية لحماية بياناتك" };
    }

    const customer = await this.prisma.customer.create({
      data: {
        pharmacyId: pharmacy.id,
        name: dto.name,
        phone: dto.phone,
        creditLimit: new Prisma.Decimal(0),
        allergies: [],
        portalPasswordHash: hash,
        portalStatus: "ACTIVE",
      },
    });
    return this.issue(customer.id, pharmacy.id, customer.name);
  }

  @PortalPublic()
  @Post("auth/login")
  async login(@Body() dto: PortalLoginDto) {
    const pharmacy = await this.tenant();
    const customer = await this.prisma.customer.findFirst({
      where: { pharmacyId: pharmacy.id, phone: dto.phone, archivedAt: null },
    });
    if (!customer?.portalPasswordHash || !(await bcrypt.compare(dto.password, customer.portalPasswordHash))) {
      throw new DomainException("UNAUTHORIZED", "بيانات الدخول غير صحيحة", 401);
    }
    if (customer.portalStatus !== "ACTIVE") {
      throw new DomainException("FORBIDDEN", "حسابك بانتظار تفعيل الصيدلية", 403);
    }
    return this.issue(customer.id, pharmacy.id, customer.name);
  }

  private async issue(customerId: string, pharmacyId: string, name: string) {
    const accessToken = await this.jwt.signAsync({ sub: customerId, pharmacyId, scope: "portal" }, { expiresIn: "30d" });
    return { accessToken, customer: { id: customerId, name } };
  }

  /** كتالوج عام: اسم وسعر وتوافر فقط — لا كميات ولا تشغيلات (معلومات داخلية). */
  @PortalPublic()
  @Get("catalog")
  async catalog(@Query("search") search?: string) {
    const pharmacy = await this.tenant();
    const rows = await this.prisma.$queryRaw<
      { id: string; tradeNameAr: string; scientificName: string; form: string; sellPrice: Prisma.Decimal; requiresPrescription: boolean; available: boolean }[]
    >`
      SELECT m.id, m."tradeNameAr", m."scientificName", m.form, m."sellPrice", m."requiresPrescription",
             COALESCE(SUM(b."quantityOnHand") FILTER (WHERE b.status = 'ACTIVE' AND b."expiryDate" > CURRENT_DATE), 0) > 0 AS available
      FROM medicines m
      LEFT JOIN batches b ON b."medicineId" = m.id
      WHERE m."pharmacyId" = ${pharmacy.id}::uuid AND m."archivedAt" IS NULL
        AND (${search ?? ""} = '' OR m."tradeNameAr" ILIKE '%' || ${search ?? ""} || '%' OR m."scientificName" ILIKE '%' || ${search ?? ""} || '%')
      GROUP BY m.id ORDER BY m."tradeNameAr" LIMIT 60`;
    return rows;
  }

  /** صفحة العميل: بياناته + رصيده وأقساطه — نفس إسقاطات الدفتر، للقراءة فقط. */
  @Get("me")
  async me(@CurrentCustomer() actor: PortalActor) {
    const c = await this.prisma.customer.findFirstOrThrow({ where: { id: actor.customerId, pharmacyId: actor.pharmacyId } });
    const installments = await this.prisma.installment.findMany({
      where: { pharmacyId: actor.pharmacyId, customerId: actor.customerId, paidAt: null },
      orderBy: { dueDate: "asc" },
      take: 12,
    });
    return {
      id: c.id, name: c.name, phone: c.phone,
      balance: c.balanceCached, creditLimit: c.creditLimit,
      totalPurchases: c.totalPurchases, loyaltyPoints: c.loyaltyPoints,
      installments,
    };
  }

  /** كشف حسابي — نفس فولد القيود المستخدم داخل النظام. */
  @Get("me/statement")
  async statement(@CurrentCustomer() actor: PortalActor) {
    return this.ledger.customerStatement(actor.pharmacyId, actor.customerId);
  }

  /** إنشاء طلب: نية شراء بأسعار الخادم — بدون أي حجز مخزون أو قيد مالي حتى التسليم. */
  @Post("orders")
  async placeOrder(@CurrentCustomer() actor: PortalActor, @Body() dto: PlaceOrderDto) {
    if (dto.lines.length === 0) throw new DomainException("VALIDATION_ERROR", "السلة فارغة", 422);
    if (dto.fulfillment === "DELIVERY" && !dto.address?.trim()) {
      throw new DomainException("VALIDATION_ERROR", "أدخل عنوان التوصيل", 422);
    }
    return this.prisma.$transaction(async (tx) => {
      let total = new Prisma.Decimal(0);
      const lines: { medicineId: string; nameAr: string; quantity: number; unitPrice: Prisma.Decimal }[] = [];
      for (const l of dto.lines) {
        const med = await tx.medicine.findFirst({ where: { id: l.medicineId, pharmacyId: actor.pharmacyId, archivedAt: null } });
        if (!med) throw new DomainException("NOT_FOUND", "صنف غير متاح", 404);
        total = total.add(new Prisma.Decimal(med.sellPrice).mul(l.quantity));
        lines.push({ medicineId: med.id, nameAr: med.tradeNameAr, quantity: l.quantity, unitPrice: med.sellPrice });
      }
      const order = await tx.onlineOrder.create({
        data: {
          pharmacyId: actor.pharmacyId,
          customerId: actor.customerId,
          fulfillment: dto.fulfillment,
          address: dto.address,
          note: dto.note,
          total,
          lines: { create: lines.map((l) => ({ pharmacyId: actor.pharmacyId, ...l })) },
        },
        include: { lines: true },
      });
      await this.outbox.publish(tx, actor.pharmacyId, EVENTS.OrderPlaced, {
        orderId: order.id, customerId: actor.customerId, total: total.toFixed(4), fulfillment: dto.fulfillment,
      });
      return order;
    });
  }

  /** طلباتي. */
  @Get("orders")
  async myOrders(@CurrentCustomer() actor: PortalActor) {
    return this.prisma.onlineOrder.findMany({
      where: { pharmacyId: actor.pharmacyId, customerId: actor.customerId },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
  }

  @Get("orders/:id")
  async myOrder(@CurrentCustomer() actor: PortalActor, @Param("id") id: string) {
    const order = await this.prisma.onlineOrder.findFirst({
      where: { id, pharmacyId: actor.pharmacyId, customerId: actor.customerId },
      include: { lines: true },
    });
    if (!order) throw new DomainException("NOT_FOUND", "الطلب غير موجود", 404);
    return order;
  }
}
