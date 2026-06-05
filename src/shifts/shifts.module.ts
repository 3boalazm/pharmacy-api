import { Module } from "@nestjs/common";
import { ShiftsController } from "./shifts.controller";
import { FinanceModule } from "../finance/finance.module";

/** Shifts bounded context — WF-5 cash drawer accountability. */
@Module({ imports: [FinanceModule], controllers: [ShiftsController] })
export class ShiftsModule {}
