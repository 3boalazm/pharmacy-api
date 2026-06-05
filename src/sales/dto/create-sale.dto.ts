import { Type } from "class-transformer";
import {
  IsArray, IsDateString, IsIn, IsInt, IsNumberString, IsObject, IsOptional, IsString, IsUUID, Min, ValidateNested,
} from "class-validator";

export class DiscountDto {
  @IsIn(["PERCENT", "AMOUNT"]) type!: "PERCENT" | "AMOUNT";
  @IsNumberString() value!: string;
}

export class SaleLineDto {
  @IsUUID() medicineId!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsNumberString() unitPrice!: string;
  @IsOptional() @ValidateNested() @Type(() => DiscountDto) discount?: DiscountDto;
}

export class PaymentSplitDto {
  @IsIn(["CASH", "CARD", "CREDIT"]) method!: "CASH" | "CARD" | "CREDIT";
  @IsNumberString() amount!: string;
}

export class PaymentDto {
  @IsIn(["CASH", "CARD", "CREDIT", "SPLIT"]) method!: "CASH" | "CARD" | "CREDIT" | "SPLIT";
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PaymentSplitDto) splits?: PaymentSplitDto[];
}

export class LoyaltyRedeemDto {
  @IsInt() @Min(1) points!: number;
}

export class DurOverrideDto {
  @IsArray() alertIds!: string[];
  @IsString() overrideToken!: string;
}

export class CreateSaleDto {
  @IsUUID() clientSaleId!: string;
  @IsDateString() clientTimestamp!: string;
  @IsOptional() @IsUUID() customerId!: string | null;
  @IsOptional() @IsUUID() prescriptionId!: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => SaleLineDto) lines!: SaleLineDto[];
  @IsOptional() @ValidateNested() @Type(() => DiscountDto) invoiceDiscount?: DiscountDto;
  @IsObject() @ValidateNested() @Type(() => PaymentDto) payment!: PaymentDto;
  @IsOptional() @ValidateNested() @Type(() => DurOverrideDto) durOverride?: DurOverrideDto;
  @IsOptional() @ValidateNested() @Type(() => LoyaltyRedeemDto) loyaltyRedeem?: LoyaltyRedeemDto;
}
