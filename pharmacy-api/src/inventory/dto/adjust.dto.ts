import { IsIn, IsInt, IsOptional, IsString, IsUUID } from "class-validator";

export const ADJUSTMENT_REASONS = ["COUNT_CORRECTION", "DAMAGE", "EXPIRY_WRITE_OFF", "THEFT", "OTHER"] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export class AdjustDto {
  @IsUUID() batchId!: string;
  @IsInt() quantity!: number; // signed: negative = remove, positive = add back
  @IsIn(ADJUSTMENT_REASONS) reason!: AdjustmentReason;
  @IsOptional() @IsString() note?: string;
}
