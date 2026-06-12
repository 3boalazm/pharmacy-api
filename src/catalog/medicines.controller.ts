import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { IsBoolean, IsInt, IsNumberString, IsOptional, IsString, Min } from "class-validator";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, Roles } from "../common/auth";
import { DomainException } from "../common/errors";
import { AuditService } from "../platform/audit.service";

class UpdateMedicineDto {
  @IsOptional() @IsString() tradeNameAr?: string;
  @IsOptional() @IsString() tradeName?: string;
  @IsOptional() @IsString() company?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsNumberString() sellPrice?: string;
  @IsOptional() @IsInt() @Min(0) minStockLevel?: number;
  @IsOptional() @IsBoolean() requiresPrescription?: boolean;
  @IsOptional() @IsBoolean() isControlled?: boolean;
  @IsOptional() @IsBoolean() archived?: boolean;
}

class CreateMedicineDto {
  @IsString() tradeName!: string;
  @IsString() tradeNameAr!: string;
  @IsString() scientificName!: string;
  @IsString() form!: string;
  @IsOptional() @IsString() company?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsString() internalCode!: string;
  @IsNumberString() sellPrice!: string;
  @IsOptional() @IsBoolean() isControlled?: boolean;
  @IsOptional() @IsBoolean() requiresPrescription?: boolean;
  @IsOptional() @IsInt() @Min(0) minStockLevel?: number;
}

@Controller("medicines")
export class MedicinesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** GET /medicines?search=&include=stock&sort=&stockStatus= — بحث + ترتيب + فلتر حالة المخزون (قراءة فقط). */
  @Get()
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async search(
    @CurrentActor() actor: Actor,
    @Query("search") search = "",
    @Query("include") include?: string,
    @Query("limit") limit = "12",
    @Query("sort") sort?: string,
    @Query("stockStatus") stockStatus?: string,
  ) {
    // الترتيب المسموح فقط (قائمة بيضاء — لا حقن)
    const orderBy: Prisma.MedicineOrderByWithRelationInput =
      sort === "name-desc" ? { tradeNameAr: "desc" }
      : sort === "price-asc" ? { sellPrice: "asc" }
      : sort === "price-desc" ? { sellPrice: "desc" }
      : sort === "newest" ? { createdAt: "desc" }
      : { tradeNameAr: "asc" };

    const meds = await this.prisma.medicine.findMany({
      where: {
        pharmacyId: actor.pharmacyId,
        archivedAt: null,
        OR: [
          { tradeNameAr: { contains: search, mode: "insensitive" } },
          { tradeName: { contains: search, mode: "insensitive" } },
          { scientificName: { contains: search, mode: "insensitive" } },
          { internalCode: { contains: search, mode: "insensitive" } },
          { barcode: search || undefined },
        ],
      },
      take: Math.min(Number(limit) || 12, 100),
      orderBy,
    });

    if (include !== "stock" || meds.length === 0) return meds;

    // Stock is an Inventory projection joined read-only — Catalog never writes quantities.
    const stock = await this.prisma.batch.groupBy({
      by: ["medicineId"],
      where: { pharmacyId: actor.pharmacyId, medicineId: { in: meds.map((m) => m.id) }, status: "ACTIVE" },
      _sum: { quantityOnHand: true },
      _min: { expiryDate: true },
    });
    const byMed = new Map(stock.map((s) => [s.medicineId, s]));
    const enriched = meds.map((m) => ({
      ...m,
      stock: {
        onHand: byMed.get(m.id)?._sum.quantityOnHand ?? 0,
        nearestExpiry: byMed.get(m.id)?._min.expiryDate ?? null,
      },
    }));

    // فلتر حالة المخزون (بعد إثراء المخزون — قراءة فقط، لا يمسّ قواعد المخزون)
    if (stockStatus === "out") return enriched.filter((m) => m.stock.onHand <= 0);
    if (stockStatus === "low") return enriched.filter((m) => m.stock.onHand > 0 && m.stock.onHand <= m.minStockLevel);
    if (stockStatus === "in") return enriched.filter((m) => m.stock.onHand > 0);
    return enriched;
  }

  /** GET /medicines/by-barcode/:code — بحث مباشر بالباركود (أو الكود الداخلي) لمسار المسح الفوري.
   *  يرجّع صنفًا واحدًا بمخزونه، أو 404 — دون الاعتماد على نتائج بحث مؤجلة (يتفادى سباق القارئ السريع). */
  @Get("by-barcode/:code")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async byBarcode(@CurrentActor() actor: Actor, @Param("code") code: string) {
    const value = code.trim();
    const med = await this.prisma.medicine.findFirst({
      where: {
        pharmacyId: actor.pharmacyId,
        archivedAt: null,
        OR: [{ barcode: value }, { internalCode: value }],
      },
    });
    if (!med) throw new DomainException("NOT_FOUND", "لا صنف بهذا الباركود", 404);
    const stock = await this.prisma.batch.aggregate({
      where: { pharmacyId: actor.pharmacyId, medicineId: med.id, status: "ACTIVE", expiryDate: { gt: new Date() } },
      _sum: { quantityOnHand: true },
      _min: { expiryDate: true },
    });
    return {
      ...med,
      stock: { onHand: stock._sum.quantityOnHand ?? 0, nearestExpiry: stock._min.expiryDate ?? null },
    };
  }

  @Get(":id")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async detail(@CurrentActor() actor: Actor, @Param("id") id: string, @Query("include") include?: string) {
    const med = await this.prisma.medicine.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!med) throw new DomainException("NOT_FOUND", "Medicine not found", 404);
    if (include !== "stock") return med;
    const stock = await this.prisma.batch.aggregate({
      where: { pharmacyId: actor.pharmacyId, medicineId: med.id, status: "ACTIVE", expiryDate: { gt: new Date() } },
      _sum: { quantityOnHand: true },
      _min: { expiryDate: true },
    });
    return { ...med, stock: { onHand: stock._sum.quantityOnHand ?? 0, nearestExpiry: stock._min.expiryDate ?? null } };
  }

  @Post()
  @Roles("PHARMACIST")
  async create(@CurrentActor() actor: Actor, @Body() dto: CreateMedicineDto) {
    return this.prisma.$transaction(async (tx) => {
      const med = await tx.medicine.create({
        data: { ...dto, sellPrice: new Prisma.Decimal(dto.sellPrice), pharmacyId: actor.pharmacyId },
      });
      await this.audit.record(tx, actor, "MEDICINE_CREATED", "Medicine", med.id, { internalCode: med.internalCode });
      return med;
    });
  }

  /** PATCH /medicines/:id — descriptive fields + soft archive. Scientific identity is immutable
   *  (it feeds DUR rules and historical traceability); a different molecule is a new product. */
  @Patch(":id")
  @Roles("PHARMACIST")
  async update(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: UpdateMedicineDto) {
    const existing = await this.prisma.medicine.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!existing) throw new DomainException("NOT_FOUND", "Medicine not found", 404);
    return this.prisma.$transaction(async (tx) => {
      const { archived, sellPrice, ...fields } = dto;
      const med = await tx.medicine.update({
        where: { id },
        data: {
          ...fields,
          ...(sellPrice !== undefined && { sellPrice: new Prisma.Decimal(sellPrice) }),
          ...(archived !== undefined && { archivedAt: archived ? new Date() : null }),
        },
      });
      await this.audit.record(tx, actor, "MEDICINE_UPDATED", "Medicine", id, { ...dto });
      return med;
    });
  }

  /** POST /medicines/import-base — استيراد كتالوج الأدوية المجهز (1,951 صنفًا) من داخل النظام:
   *  كتالوج فقط بكميات صفر وبدون صلاحية (المخزون الفعلي يدخل من GRN). Idempotent بالكامل. */
  @Post("import-base")
  @Roles()
  async importBase(@CurrentActor() actor: Actor) {
    const file = path.join(process.cwd(), "prisma", "data", "items.json");
    if (!fs.existsSync(file)) throw new DomainException("NOT_FOUND", "ملف الأصناف غير موجود في الخادم", 404);
    const items: { tradeNameAr: string; form: string; sellPrice: string }[] = JSON.parse(fs.readFileSync(file, "utf-8"));

    const existing = await this.prisma.medicine.findMany({
      where: { pharmacyId: actor.pharmacyId },
      select: { tradeNameAr: true, form: true, internalCode: true },
    });
    const have = new Set(existing.map((m) => `${m.tradeNameAr}|${m.form}`));
    let seq = existing.map((m) => Number(m.internalCode.replace(/\D/g, "")) || 0).reduce((a, b) => Math.max(a, b), 0);
    const fresh = items.filter((i) => !have.has(`${i.tradeNameAr}|${i.form}`));

    for (let i = 0; i < fresh.length; i += 500) {
      await this.prisma.medicine.createMany({
        data: fresh.slice(i, i + 500).map((it) => ({
          pharmacyId: actor.pharmacyId,
          tradeNameAr: it.tradeNameAr,
          tradeName: it.tradeNameAr,
          scientificName: "غير مسجل",
          form: it.form,
          internalCode: `MED-${String(++seq).padStart(6, "0")}`,
          sellPrice: new Prisma.Decimal(it.sellPrice),
          minStockLevel: 0,
        })),
        skipDuplicates: true,
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await this.audit.record(tx, actor, "CATALOG_IMPORTED", "Medicine", actor.pharmacyId, {
        fileItems: items.length, inserted: fresh.length, skipped: items.length - fresh.length,
      });
    });
    return { fileItems: items.length, inserted: fresh.length, alreadyExisted: items.length - fresh.length };
  }
}
