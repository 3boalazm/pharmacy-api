import { Body, Controller, HttpStatus, Post } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { IsString } from "class-validator";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { PrismaService } from "../common/prisma.service";
import { CacheService } from "../platform/cache.service";
import { Actor, CurrentActor, Public, Roles } from "../common/auth";
import { DomainException } from "../common/errors";

class LoginDto {
  @IsString() phone!: string;
  @IsString() password!: string;
  @IsString() deviceId!: string;
}
class PinDto { @IsString() pin!: string }

@Controller("auth")
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cache: CacheService,
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
    return {
      accessToken,
      refreshToken: accessToken, // refresh rotation lands with session store; same shape for clients
      user: { id: user.id, name: user.name, role: user.role },
    };
  }

  /** POST /auth/pin-elevate — short-lived pharmacist override token (Contract §2). */
  @Post("pin-elevate")
  @Roles("PHARMACIST")
  async pinElevate(@CurrentActor() actor: Actor, @Body() dto: PinDto) {
    const user = await this.prisma.user.findFirst({ where: { id: actor.userId, pharmacyId: actor.pharmacyId } });
    if (!user?.pinHash || !(await bcrypt.compare(dto.pin, user.pinHash))) {
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
}
