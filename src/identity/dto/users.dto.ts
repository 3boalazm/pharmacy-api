import { IsBoolean, IsIn, IsOptional, IsString, Matches, MinLength } from "class-validator";

const ROLES = ["OWNER", "PHARMACIST", "ASSISTANT", "CASHIER"] as const;

export class BootstrapDto {
  @IsString() @MinLength(3) pharmacyName!: string;
  @IsString() @MinLength(3) ownerName!: string;
  @IsString() @Matches(/^01\d{9}$/, { message: "رقم موبايل مصري صحيح (11 رقمًا يبدأ بـ 01)" }) phone!: string;
  @IsString() @MinLength(8, { message: "كلمة المرور 8 أحرف على الأقل" }) password!: string;
  @IsString() @Matches(/^\d{4,6}$/, { message: "رمز PIN من 4 إلى 6 أرقام" }) pin!: string;
}

export class CreateUserDto {
  @IsString() @MinLength(3) name!: string;
  @IsString() @Matches(/^01\d{9}$/) phone!: string;
  @IsString() @MinLength(8) password!: string;
  @IsIn(ROLES) role!: (typeof ROLES)[number];
  @IsOptional() @Matches(/^\d{4,6}$/) pin?: string;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(3) name?: string;
  @IsOptional() @IsIn(ROLES) role?: (typeof ROLES)[number];
  @IsOptional() @IsString() @MinLength(8) password?: string; // reset by OWNER
  @IsOptional() @Matches(/^\d{4,6}$/) pin?: string;
  @IsOptional() @IsBoolean() archived?: boolean;
}

export class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString() @MinLength(8, { message: "كلمة المرور الجديدة 8 أحرف على الأقل" }) newPassword!: string;
}
