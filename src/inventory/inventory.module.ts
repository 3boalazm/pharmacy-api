import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { InventoryService } from "./inventory.service";
import { InventoryController } from "./inventory.controller";
import { BatchRepository } from "./repositories/batch.repository";
import { ExpirySweepService } from "./expiry-sweep.service";

/** Inventory bounded context — owns quantity truth (Architecture §3). */
@Module({
  imports: [FinanceModule],
  controllers: [InventoryController],
  providers: [InventoryService, BatchRepository, ExpirySweepService],
  exports: [InventoryService], // facade consumed by Sales inside its transaction
})
export class InventoryModule {}
