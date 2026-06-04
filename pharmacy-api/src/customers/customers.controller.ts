import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { IsArray, IsBoolean, IsNumberString, IsOptional, IsString } from "class-validator";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, Roles } from "../common/auth";
import { DomainException } from "../common/errors";
import { AuditService } from "../platform/audit.service";
import { LedgerService } from "../finance/ledger.service";

class CreateCustomerDto {
  @IsString() name!: string;
  @IsString() phone!: string;
  @IsNumberString() creditLimit!: string;
  @IsOptional() @IsArray() allergies?: string[];
}


class UpdateCustomerDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsNumberString() creditLimit?: string;
  @IsOptional() @IsArray() allergies?: string[];
  @IsOptional() @IsBoolean() archived?: boolean;
}

@Controller("customers")
export class CustomersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  @Get()
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async list(@CurrentActor() actor: Actor, @Query("search") search?: string, @Query("hasDebt") hasDebt?: string) {
    return this.prisma.customer.findMany({
      where: {
        pharmacyId: actor.pharmacyId,
        archivedAt: null,
        ...(search && {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { phone: { contains: search } },
          ],
        }),
        ...(hasDebt === "true" && { balanceCached: { gt: 0 } }),
      },
      orderBy: { balanceCached: "desc" },
      take: 100,
    });
  }

  /** balance in the response is the cached AR projection — never writable via API (Contract §7). */
  @Get(":id")
  @Roles("CASHIER", "ASSISTANT", "PHARMACIST")
  async detail(@CurrentActor() actor: Actor, @Param("id") id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!c) throw new DomainException("NOT_FOUND", "Customer not found", 404);
    const { balanceCached, ...rest } = c;
    return { ...rest, balance: balanceCached };
  }

  @Post()
  @Roles("ASSISTANT", "PHARMACIST", "CASHIER")
  async create(@CurrentActor() actor: Actor, @Body() dto: CreateCustomerDto) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          pharmacyId: actor.pharmacyId,
          name: dto.name,
          phone: dto.phone,
          creditLimit: new Prisma.Decimal(dto.creditLimit),
          allergies: dto.allergies ?? [],
        },
      });
      await this.audit.record(tx, actor, "CUSTOMER_CREATED", "Customer", customer.id);
      return customer;
    });
  }

  /** PATCH /customers/:id — profile fields + soft archive. Balance is NEVER writable (Contract §7). */
  @Patch(":id")
  @Roles("ASSISTANT", "PHARMACIST")
  async update(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: UpdateCustomerDto) {
    const existing = await this.prisma.customer.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!existing) throw new DomainException("NOT_FOUND", "Customer not found", 404);
    return this.prisma.$transaction(async (tx) => {
      const { archived, creditLimit, ...fields } = dto;
      const customer = await tx.customer.update({
        where: { id },
        data: {
          ...fields,
          ...(creditLimit !== undefined && { creditLimit: new Prisma.Decimal(creditLimit) }),
          ...(archived !== undefined && { archivedAt: archived ? new Date() : null }),
        },
      });
      await this.audit.record(tx, actor, "CUSTOMER_UPDATED", "Customer", id, { ...dto });
      const { balanceCached, ...rest } = customer;
      return { ...rest, balance: balanceCached };
    });
  }
}
