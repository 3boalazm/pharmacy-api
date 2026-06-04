import { Controller, Get, Post, Param, Query } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { Actor, CurrentActor, Roles } from "../common/auth";

@Controller("alerts")
export class AlertsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles("ASSISTANT", "PHARMACIST", "CASHIER")
  async list(@CurrentActor() actor: Actor, @Query("status") status = "UNREAD") {
    return this.prisma.alert.findMany({
      where: { pharmacyId: actor.pharmacyId, status },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  @Post(":id/ack")
  @Roles("ASSISTANT", "PHARMACIST")
  async ack(@CurrentActor() actor: Actor, @Param("id") id: string) {
    await this.prisma.alert.updateMany({
      where: { id, pharmacyId: actor.pharmacyId },
      data: { status: "ACK" },
    });
    return { ok: true };
  }
}

@Controller("audit-logs")
export class AuditLogsController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /audit-logs — append-only trail viewer (OWNER). */
  @Get()
  @Roles("OWNER")
  async list(
    @CurrentActor() actor: Actor,
    @Query("action") action?: string,
    @Query("entityType") entityType?: string,
  ) {
    return this.prisma.auditLog.findMany({
      where: { pharmacyId: actor.pharmacyId, action: action || undefined, entityType: entityType || undefined },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }
}
