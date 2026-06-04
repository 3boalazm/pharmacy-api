import { Type } from "class-transformer";
import { IsArray, IsIn, IsObject, IsString, IsUUID, ValidateNested } from "class-validator";
import { CreateSaleDto } from "./create-sale.dto";

export class SyncCommandDto {
  @IsIn(["SALE"]) type!: "SALE";
  @IsUUID() idempotencyKey!: string;
  @IsObject() payload!: CreateSaleDto;
}

export class SyncDto {
  @IsString() deviceId!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => SyncCommandDto) commands!: SyncCommandDto[];
}
