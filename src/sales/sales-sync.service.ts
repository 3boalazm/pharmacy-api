import { Injectable, Logger } from "@nestjs/common";
import { SalesService, CreateSaleInput } from "./sales.service";
import { IdempotencyService } from "../common/idempotency.service";
import { DomainException } from "../common/errors";
import { Actor } from "../common/auth";
import { serialize } from "../common/http.shape";

/**
 * Offline replay (Architecture §4.4, BINDING policy):
 * server-authoritative — FEFO is re-allocated silently (goods already left the counter;
 * which lot they came from is corrected to reality). Money is never altered.
 * Commands replay in order; duplicates resolve via the idempotency store.
 */
@Injectable()
export class SalesSyncService {
  private readonly log = new Logger(SalesSyncService.name);

  constructor(
    private readonly sales: SalesService,
    private readonly idem: IdempotencyService,
  ) {}

  async replay(actor: Actor, commands: { type: "SALE"; idempotencyKey: string; payload: unknown }[]) {
    const results: Record<string, unknown>[] = [];
    for (const cmd of commands) {
      try {
        let replayed = true;
        const result = await this.idem.run(actor.pharmacyId, cmd.idempotencyKey, "POST /sales/sync", async () => {
          replayed = false;
          return this.sales.createSale(actor, cmd.payload as CreateSaleInput);
        });
        results.push({
          idempotencyKey: cmd.idempotencyKey,
          status: replayed ? "DUPLICATE" : "POSTED",
          ...(serialize(result) as Record<string, unknown>),
        });
      } catch (err) {
        if (err instanceof DomainException) {
          results.push({
            idempotencyKey: cmd.idempotencyKey,
            status: "REJECTED",
            error: { code: err.code, message: err.message, details: err.details },
          });
        } else {
          this.log.error(`Sync replay failed: ${(err as Error).message}`);
          results.push({ idempotencyKey: cmd.idempotencyKey, status: "REJECTED", error: { code: "INTERNAL", message: "Replay failed" } });
        }
      }
    }
    return { results };
  }
}
