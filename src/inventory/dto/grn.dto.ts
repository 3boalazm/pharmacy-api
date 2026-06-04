import { Type } from "class-transformer";
import {
  IsArray, IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Min, ValidateNested,
} from "class-validator";

export class GrnLineDto {
  @IsUUID() medicineId!: string;
  @IsString() batchNumber!: string;
  @IsDateString() expiryDate!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsInt() @Min(0) bonusQuantity?: number;
  @IsNumberString() unitCost!: string;
}

export class CreateGrnDto {
  @IsUUID() supplierId!: string;
  @IsString() supplierInvoiceNo!: string;
  @IsDateString() receivedAt!: string;
  @IsIn(["CASH", "CREDIT"]) paymentTerms!: "CASH" | "CREDIT";
  @IsArray() @ValidateNested({ each: true }) @Type(() => GrnLineDto) lines!: GrnLineDto[];
}
