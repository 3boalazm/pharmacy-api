import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";
import { PrismaService, Tx } from "../common/prisma.service";
import { DomainEvent, EventType } from "./events";

/**
 * Transactional Outbox (Architecture §2, BINDING):
 * events are written in the SAME transaction as the business change, then relayed.
 * Relay target is in-process EventEmitter2 today; swapping to NATS/RabbitMQ later
 * changes ONLY the dispatch() body — producers never change.
 */
@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** Called by domain services INSIDE their transaction. */
  async publish(tx: Tx, pharmacyId: string, eventType: EventType, payload: Record<string, unknown>): Promise<void> {
    await tx.outboxEvent.create({
      data: { pharmacyId, eventType, payload: payload as Prisma.InputJsonValue },
    });
  }

  /** Relay loop: claim → dispatch → mark. At-least-once; consumers are idempotent. */
  @Interval(1000)
  async dispatch(): Promise<void> {
    const batch = await this.prisma.$queryRaw<
      { id: string; pharmacyId: string; eventType: EventType; payload: Record<string, unknown> }[]
    >`SELECT id, "pharmacyId", "eventType", payload
      FROM outbox_events
      WHERE "processedAt" IS NULL AND attempts < 10
      ORDER BY "createdAt"
      LIMIT 50
      FOR UPDATE SKIP LOCKED`;

    for (const row of batch) {
      const event: DomainEvent = { id: row.id, pharmacyId: row.pharmacyId, eventType: row.eventType, payload: row.payload };
      try {
        await this.emitter.emitAsync(row.eventType, event);
        await this.prisma.outboxEvent.update({ where: { id: row.id }, data: { processedAt: new Date() } });
      } catch (err) {
        this.log.error(`Outbox dispatch failed for ${row.eventType} ${row.id}: ${(err as Error).message}`);
        await this.prisma.outboxEvent.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      }
    }
  }

  /** Outbox lag is a primary SLO (Architecture §5). */
  async lag(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { processedAt: null } });
  }
}
