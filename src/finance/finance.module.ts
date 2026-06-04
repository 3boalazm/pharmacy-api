import { Module } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { FinanceController } from "./finance.controller";
import { JournalRepository } from "./repositories/journal.repository";

/** Finance bounded context — owns money truth (Architecture §3). */
@Module({
  controllers: [FinanceController],
  providers: [LedgerService, JournalRepository],
  exports: [LedgerService], // facade consumed by Sales & Inventory inside their transactions
})
export class FinanceModule {}
