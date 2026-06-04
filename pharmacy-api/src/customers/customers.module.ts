import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { CustomersController } from "./customers.controller";

/** Customers/CRM bounded context. Balance is a Finance projection (Architecture §3). */
@Module({ imports: [FinanceModule], controllers: [CustomersController] })
export class CustomersModule {}
