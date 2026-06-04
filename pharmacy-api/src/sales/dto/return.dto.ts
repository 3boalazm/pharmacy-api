import { Type } from "class-transformer";
import { IsArray, IsInt, IsString, IsUUID, Min, ValidateNested } from "class-validator";

export class ReturnLineDto {
  @IsUUID() salesItemId!: string;
  @IsInt() @Min(1) quantity!: number;
}

export class CreateReturnDto {
  @IsUUID() invoiceId!: string;
  @IsString() reason!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReturnLineDto) lines!: ReturnLineDto[];
}
