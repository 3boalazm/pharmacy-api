import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Tx } from "../common/prisma.service";
import { Actor } from "../common/auth";

/** Audit rows are written INSIDE the same transaction as the mutation (Architecture §4.3). */
@Injectable()
export class AuditService {
  async record(tx: Tx, actor: Actor, action: string, entityType: string, entityId?: string, detail?: Record<string, unknown>) {
    await tx.auditLog.create({
      data: {
        pharmacyId: actor.pharmacyId,
        actorUserId: actor.userId,
        action,
        entityType,
        entityId,
        detail: detail as Prisma.InputJsonValue,
      },
    });
  }
}
