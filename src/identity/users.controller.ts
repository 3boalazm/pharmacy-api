import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, Roles } from "../common/auth";
import { DomainException } from "../common/errors";
import { AuditService } from "../platform/audit.service";
import { CreateUserDto, UpdateUserDto } from "./dto/users.dto";

const safe = { id: true, name: true, phone: true, role: true, archivedAt: true, createdAt: true } as const;

/** User management — OWNER only. Hashes never leave the database. */
@Controller("users")
export class UsersController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  @Roles() // OWNER only (Roles() with empty list = OWNER passes via guard rule)
  async list(@CurrentActor() actor: Actor) {
    return this.prisma.user.findMany({
      where: { pharmacyId: actor.pharmacyId },
      select: safe,
      orderBy: { createdAt: "asc" },
    });
  }

  @Post()
  @Roles()
  async create(@CurrentActor() actor: Actor, @Body() dto: CreateUserDto) {
    const exists = await this.prisma.user.findFirst({ where: { pharmacyId: actor.pharmacyId, phone: dto.phone } });
    if (exists) throw new DomainException("CONFLICT", "رقم الهاتف مسجل لمستخدم آخر", 409);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          pharmacyId: actor.pharmacyId,
          name: dto.name,
          phone: dto.phone,
          role: dto.role,
          passwordHash: await bcrypt.hash(dto.password, 10),
          pinHash: dto.pin ? await bcrypt.hash(dto.pin, 10) : null,
        },
        select: safe,
      });
      await this.audit.record(tx, actor, "USER_CREATED", "User", user.id, { role: dto.role });
      return user;
    });
  }

  @Patch(":id")
  @Roles()
  async update(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: UpdateUserDto) {
    const target = await this.prisma.user.findFirst({ where: { id, pharmacyId: actor.pharmacyId } });
    if (!target) throw new DomainException("NOT_FOUND", "المستخدم غير موجود", 404);
    if (id === actor.userId && (dto.archived || (dto.role && dto.role !== "OWNER"))) {
      throw new DomainException("VALIDATION_ERROR", "لا يمكنك تعطيل حسابك أو تخفيض دورك بنفسك", 422);
    }
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: {
          ...(dto.name && { name: dto.name }),
          ...(dto.role && { role: dto.role }),
          ...(dto.password && { passwordHash: await bcrypt.hash(dto.password, 10) }),
          ...(dto.pin && { pinHash: await bcrypt.hash(dto.pin, 10) }),
          ...(dto.archived !== undefined && { archivedAt: dto.archived ? new Date() : null }),
        },
        select: safe,
      });
      await this.audit.record(tx, actor, "USER_UPDATED", "User", id, {
        fields: Object.keys(dto), passwordReset: !!dto.password,
      });
      return user;
    });
  }
}
