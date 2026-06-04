import { Module } from "@nestjs/common";
import { DurService } from "./dur.service";

/** Pharmacy-Ops bounded context — clinical gates (Architecture §3). */
@Module({
  providers: [DurService],
  exports: [DurService], // facade consumed by Sales inside the sale transaction
})
export class PharmacyOpsModule {}
