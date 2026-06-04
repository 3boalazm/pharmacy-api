import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
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

  /** GET /medicines?search=&include=stock — POS instant search (Contract §3). */
  @Get()
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async search(
    @CurrentActor() actor: Actor,
    @Query("search") search = "",
    @Query("include") include?: string,
    @Query("limit") limit = "12",
  ) {
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
      orderBy: { tradeNameAr: "asc" },
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
    return meds.map((m) => ({
      ...m,
      stock: {
        onHand: byMed.get(m.id)?._sum.quantityOnHand ?? 0,
        nearestExpiry: byMed.get(m.id)?._min.expiryDate ?? null,
      },
    }));
  }

  @Get(":id")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async detail(@CurrentActor() actor: Actor, @Param("id") id: string) {
    const med = await this.prisma.medicine.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!med) throw new DomainException("NOT_FOUND", "Medicine not found", 404);
    return med;
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
}
