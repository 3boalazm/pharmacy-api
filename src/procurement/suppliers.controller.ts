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
