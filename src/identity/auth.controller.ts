import { Body, Controller, Get, HttpStatus, Post } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { IsString } from "class-validator";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { PrismaService } from "../common/prisma.service";
import { CacheService } from "../platform/cache.service";
import { AuditService } from "../platform/audit.service";
import { BootstrapDto, ChangePasswordDto } from "./dto/users.dto";
import { Actor, CurrentActor, Public, Roles } from "../common/auth";
import { DomainException } from "../common/errors";

class LoginDto {
  @IsString() phone!: string;
  @IsString() password!: string;
  @IsString() deviceId!: string;
}
class PinDto { @IsString() pin!: string }

const CHART_OF_ACCOUNTS: [string, string][] = [
  ["1000", "النقدية"], ["1100", "ذمم العملاء"], ["1200", "المخزون"],
  ["2000", "ذمم الموردين"], ["4000", "المبيعات"], ["4100", "خصومات المبيعات"],
  ["5000", "تكلفة المبيعات"], ["5100", "إعدام مخزون"], ["5900", "عجز/زيادة الخزينة"],
];

@Controller("auth")
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  /** POST /auth/login (Contract §2). pharmacyId is embedded in the JWT — never client-supplied. */
  @Public()
  @Post("login")
  async login(@Body() dto: LoginDto) {
    // R-2: brute-force guard — 5 attempts / 60s / phone. Degraded mode (no Redis) leaves the limit open.
    const attempts = await this.cache.incrWithTtl(`ratelimit:login:${dto.phone}`, 60);
    if (attempts !== null && attempts > 5) {
      throw new DomainException("RATE_LIMITED", "محاولات كثيرة — انتظر دقيقة ثم أعد المحاولة", HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.prisma.user.findFirst({ where: { phone: dto.phone, archivedAt: null } });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new DomainException("UNAUTHORIZED", "بيانات الدخول غير صحيحة", 401);
    }
    const accessToken = await this.jwt.signAsync({ sub: user.id, pharmacyId: user.pharmacyId, role: user.role });
    const pharmacy = await this.prisma.pharmacy.findUnique({ where: { id: user.pharmacyId } });
    return {
      accessToken,
      refreshToken: accessToken, // refresh rotation lands with session store; same shape for clients
      user: { id: user.id, name: user.name, role: user.role },
      pharmacy: { id: user.pharmacyId, name: pharmacy?.name ?? "" },
    };
  }

  /** POST /auth/pin-elevate — short-lived pharmacist override token (Contract §2). */
  @Post("pin-elevate")
  @Roles("PHARMACIST")
  async pinElevate(@CurrentActor() actor: Actor, @Body() dto: PinDto) {
    // H2: حد محاولات — الـ PIN مفتاح أخطر تجاوزات النظام (DUR/ائتمان/روشتة)
    const attempts = (await this.cache.incrWithTtl(`ratelimit:pin:${actor.userId}`, 300)) ?? 0;
    if (attempts > 5) {
      throw new DomainException("RATE_LIMITED", "محاولات كثيرة — انتظر 5 دقائق", 429);
    }
    const user = await this.prisma.user.findFirst({ where: { id: actor.userId, pharmacyId: actor.pharmacyId } });
    if (!user?.pinHash || !(await bcrypt.compare(dto.pin, user.pinHash))) {
      if (attempts >= 3) {
        await this.audit.record(this.prisma, { userId: actor.userId, pharmacyId: actor.pharmacyId, role: actor.role }, "PIN_ELEVATE_FAILED", "User", actor.userId, { attempts });
      }
      throw new DomainException("UNAUTHORIZED", "رمز الصيدلي غير صحيح", 401);
    }
    // R-1: jti registered in Redis as single-use; sales consume it atomically (Plan §0).
    const jti = randomUUID();
    const overrideToken = await this.jwt.signAsync(
      { sub: user.id, pharmacyId: user.pharmacyId, role: user.role, scope: "override", jti },
      { expiresIn: "120s" },
    );
    await this.cache.put(`override:${jti}`, user.id, 120);
    return { overrideToken, expiresIn: 120 };
  }

  /** GET /auth/bootstrap — first-run check: setup screen shows only while no tenant exists. */
  @Public()
  @Get("bootstrap")
  async bootstrapStatus() {
    const count = await this.prisma.pharmacy.count();
    return { needsSetup: count === 0 };
  }

  /**
   * POST /auth/bootstrap — first-run setup FROM THE BROWSER (replaces the seed shell step):
   * one transaction creating the pharmacy + chart of accounts + OWNER account, then
   * auto-login. Hard guard: refuses permanently once any pharmacy exists — this is a
   * one-time door, not an open registration endpoint.
   */
  @Public()
  @Post("bootstrap")
  async bootstrap(@Body() dto: BootstrapDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      const count = await tx.pharmacy.count();
      if (count > 0) throw new DomainException("FORBIDDEN", "تم إعداد النظام بالفعل — سجّل الدخول", 403);

      const pharmacy = await tx.pharmacy.create({
        data: { name: dto.pharmacyName, ownerName: dto.ownerName, phone: dto.phone },
      });
      await tx.account.createMany({
        data: CHART_OF_ACCOUNTS.map(([code, name]) => ({ pharmacyId: pharmacy.id, code, name })),
      });
      const owner = await tx.user.create({
        data: {
          pharmacyId: pharmacy.id,
          name: dto.ownerName,
          phone: dto.phone,
          role: "OWNER",
          passwordHash: await bcrypt.hash(dto.password, 10),
          pinHash: await bcrypt.hash(dto.pin, 10),
        },
      });
      await tx.auditLog.create({
        data: {
          pharmacyId: pharmacy.id, actorUserId: owner.id,
          action: "SYSTEM_BOOTSTRAPPED", entityType: "Pharmacy", entityId: pharmacy.id,
          detail: { pharmacyName: dto.pharmacyName },
        },
      });
      return { pharmacy, owner };
    });

    const accessToken = await this.jwt.signAsync({
      sub: result.owner.id, pharmacyId: result.pharmacy.id, role: "OWNER",
    });
    return {
      accessToken,
      refreshToken: accessToken,
      user: { id: result.owner.id, name: result.owner.name, role: "OWNER" as const },
      pharmacy: { id: result.pharmacy.id, name: result.pharmacy.name },
    };
  }

  /** POST /auth/change-password — any signed-in user changes their own password. */
  @Post("change-password")
  async changePassword(@CurrentActor() actor: Actor, @Body() dto: ChangePasswordDto) {
    const user = await this.prisma.user.findFirst({ where: { id: actor.userId, pharmacyId: actor.pharmacyId } });
    if (!user || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new DomainException("UNAUTHORIZED", "كلمة المرور الحالية غير صحيحة", 401);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(dto.newPassword, 10) } });
      await this.audit.record(tx, actor, "PASSWORD_CHANGED", "User", user.id);
    });
    return { ok: true };
  }
}
