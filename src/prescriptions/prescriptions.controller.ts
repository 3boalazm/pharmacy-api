import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, IdemKey, Roles } from "../common/auth";
import { DomainException } from "../common/errors";
import { IdempotencyService } from "../common/idempotency.service";
import { AuditService } from "../platform/audit.service";

class RxLineDto {
  @IsUUID() medicineId!: string;
  @IsInt() @Min(1) @Max(999) quantity!: number;
  @IsOptional() @IsString() note?: string;
}
class CreatePrescriptionDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() @MinLength(2) doctorName?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RxLineDto) lines!: RxLineDto[];
}

/**
 * الروشتات v1 (EP-08) — يدوي أولًا وجاهز للـ OCR:
 * الصيدلي يسجل أصناف الروشتة سريعًا ← «إرسال للسلة» في الواجهة ← POS يبيع بنفس
 * المسار الذري حاملًا prescriptionId ← البيع يوسم الروشتة DISPENSED ويربط الفاتورة.
 * بوابة الروشتة في POS (RX_REQUIRED) تتحقق تلقائيًا بوجود prescriptionId — اكتملت الحلقة.
 * لا تخزين صور في v1 (يتطلب مزود تخزين خارجي — قرار لاحق)؛ حقل notes جاهز لنص الـ OCR.
 */
@Controller("prescriptions")
export class PrescriptionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idem: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @Roles("ASSISTANT", "PHARMACIST")
  async create(@CurrentActor() actor: Actor, @IdemKey() key: string, @Body() dto: CreatePrescriptionDto) {
    if (!dto.lines.length) throw new DomainException("VALIDATION_ERROR", "أضف صنفًا واحدًا على الأقل", 422);
    return this.idem.run(actor.pharmacyId, key, "POST /prescriptions", () =>
      this.prisma.$transaction(async (tx) => {
        const meds = await tx.medicine.findMany({
          where: { id: { in: dto.lines.map((l) => l.medicineId) }, pharmacyId: actor.pharmacyId },
          select: { id: true },
        });
        if (meds.length !== new Set(dto.lines.map((l) => l.medicineId)).size) {
          throw new DomainException("NOT_FOUND", "صنف غير موجود بالكتالوج", 404);
        }
        if (dto.customerId) {
          const c = await tx.customer.findFirst({ where: { id: dto.customerId, pharmacyId: actor.pharmacyId } });
          if (!c) throw new DomainException("NOT_FOUND", "العميل غير موجود", 404);
        }
        const rx = await tx.prescription.create({
          data: {
            pharmacyId: actor.pharmacyId,
            customerId: dto.customerId,
            doctorName: dto.doctorName,
            notes: dto.notes,
            createdById: actor.userId,
            lines: {
              create: dto.lines.map((l) => ({
                pharmacyId: actor.pharmacyId, medicineId: l.medicineId, quantity: l.quantity, note: l.note,
              })),
            },
          },
          include: { lines: true },
        });
        await this.audit.record(tx, actor, "PRESCRIPTION_CREATED", "Prescription", rx.id, {
          items: dto.lines.length, customerId: dto.customerId ?? null,
        });
        return rx;
      }),
    );
  }

  @Get()
  @Roles("ASSISTANT", "PHARMACIST", "CASHIER")
  async list(
    @CurrentActor() actor: Actor,
    @Query("status") status?: string,
    @Query("customerId") customerId?: string,
    @Query("skip") skip = "0",
  ) {
    const where = {
      pharmacyId: actor.pharmacyId,
      ...(status && { status }),
      ...(customerId && { customerId }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.prescription.findMany({
        where,
        include: { lines: true },
        orderBy: { createdAt: "desc" },
        skip: Math.max(Number(skip) || 0, 0),
        take: 50,
      }),
      this.prisma.prescription.count({ where }),
    ]);
    // أسماء العملاء والأدوية — دمج يدوي (نمط المشروع مع غياب العلاقات العابرة)
    const customerIds = [...new Set(rows.map((r) => r.customerId).filter(Boolean))] as string[];
    const medIds = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.medicineId)))];
    const [customers, meds] = await Promise.all([
      customerIds.length
        ? this.prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      medIds.length
        ? this.prisma.medicine.findMany({
            where: { id: { in: medIds } },
            select: { id: true, tradeNameAr: true, sellPrice: true, barcode: true, requiresPrescription: true },
          })
        : Promise.resolve([]),
    ]);
    const cById = new Map(customers.map((c) => [c.id, c]));
    const mById = new Map(meds.map((m) => [m.id, m]));
    return {
      rows: rows.map((r) => ({
        ...r,
        customer: r.customerId ? cById.get(r.customerId) ?? null : null,
        lines: r.lines.map((l) => ({ ...l, medicine: mById.get(l.medicineId) ?? null })),
      })),
      total,
    };
  }

  @Post(":id/cancel")
  @Roles("PHARMACIST")
  async cancel(@CurrentActor() actor: Actor, @Param("id") id: string) {
    const rx = await this.prisma.prescription.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!rx) throw new DomainException("NOT_FOUND", "الروشتة غير موجودة", 404);
    if (rx.status !== "READY") throw new DomainException("CONFLICT", "لا تُلغى روشتة مصروفة أو ملغاة", 409);
    const updated = await this.prisma.prescription.update({ where: { id }, data: { status: "CANCELLED" } });
    await this.audit.record(this.prisma, actor, "PRESCRIPTION_CANCELLED", "Prescription", id, {});
    return updated;
  }
}
