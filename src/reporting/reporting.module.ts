import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { DashboardController } from "./dashboard.controller";

/** Reporting bounded context — read models only, rebuildable from ledgers (Architecture §3). */
@Module({ imports: [FinanceModule], controllers: [DashboardController] })
export class ReportingModule {}
