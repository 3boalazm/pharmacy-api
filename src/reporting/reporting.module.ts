import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { AnalyticsController } from "./analytics.controller";
import { DashboardController } from "./dashboard.controller";
import { ReportsController } from "./reports.controller";

/** Reporting bounded context — read models only, rebuildable from ledgers (Architecture §3). */
@Module({ imports: [FinanceModule], controllers: [AnalyticsController, DashboardController, ReportsController] })
export class ReportingModule {}
