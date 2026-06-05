import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { FinanceModule } from "../finance/finance.module";
import { PharmacyOpsModule } from "../pharmacy-ops/pharmacy-ops.module";
import { IdentityModule } from "../identity/identity.module";
import { SalesService } from "./sales.service";
import { SalesSyncService } from "./sales-sync.service";
import { SalesReturnService } from "./sales-return.service";
import { InvoiceRepository } from "./repositories/invoice.repository";
import { SalesController } from "./sales.controller";

/**
 * Sales bounded context. Consumes Inventory / Finance / PharmacyOps ONLY through
 * their module facades, inside its own transaction — never their tables directly.
 */
@Module({
  imports: [InventoryModule, FinanceModule, PharmacyOpsModule, IdentityModule],
  controllers: [SalesController],
  providers: [SalesService, SalesSyncService, SalesReturnService, InvoiceRepository],
  exports: [SalesService],
})
export class SalesModule {}
