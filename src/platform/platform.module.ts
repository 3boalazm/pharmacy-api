import { Global, Module } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { IdempotencyService } from "../common/idempotency.service";
import { OutboxService } from "./outbox.service";
import { AuditService } from "./audit.service";
import { CacheService } from "./cache.service";
import { PlatformConsumers } from "./consumers";
import { AlertsController, AuditLogsController, HealthController } from "./alerts.controller";

/** Platform bounded context: outbox, audit, idempotency, alerts (Architecture §3). */
@Global()
@Module({
  controllers: [AlertsController, AuditLogsController, HealthController],
  providers: [PrismaService, IdempotencyService, OutboxService, AuditService, CacheService, PlatformConsumers],
  exports: [PrismaService, IdempotencyService, OutboxService, AuditService, CacheService],
})
export class PlatformModule {}
