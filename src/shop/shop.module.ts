import { Module } from "@nestjs/common";
import { ShopController } from "./shop.controller";
import { OrdersAdminController } from "./orders-admin.controller";
import { CustomerGuard } from "./customer.guard";
import { FinanceModule } from "../finance/finance.module";
import { SalesModule } from "../sales/sales.module";

/** Shop bounded context: customer portal (separate trust domain) + staff orders screen. */
@Module({
  imports: [FinanceModule, SalesModule],
  controllers: [ShopController, OrdersAdminController],
  providers: [CustomerGuard],
})
export class ShopModule {}
