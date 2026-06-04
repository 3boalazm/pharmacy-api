import { IsIn, IsNumberString, IsString, IsUUID } from "class-validator";

export class RecordPaymentDto {
  @IsUUID() customerId!: string;
  @IsNumberString() amount!: string;
  @IsIn(["CASH", "CARD"]) method!: "CASH" | "CARD";
  @IsIn(["OLDEST", "INVOICE"]) allocateTo!: "OLDEST" | "INVOICE";
}

export class SupplierPaymentDto {
  @IsUUID() supplierId!: string;
  @IsNumberString() amount!: string;
}

export class ReverseDto {
  @IsString() reason!: string;
}
