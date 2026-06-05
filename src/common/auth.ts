import {
  CanActivate, ExecutionContext, Injectable, SetMetadata,
  UnauthorizedException, ForbiddenException, BadRequestException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export type Role = 'OWNER' | 'PHARMACIST' | 'ASSISTANT' | 'CASHIER';

/** Tenant context — pharmacyId comes ONLY from the verified JWT (Contract §0.1). */
export interface Actor {
  userId: string;
  pharmacyId: string;
  role: Role;
  scope?: 'override';
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const Public = () => SetMetadata('isPublic', true);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  return (ctx.switchToHttp().getRequest() as Request & { actor: Actor }).actor;
});

export const IdemKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const key = ctx.switchToHttp().getRequest<Request>().header('Idempotency-Key');
  if (!key) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required' });
  return key;
});

export const OverrideToken = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => {
  return ctx.switchToHttp().getRequest<Request>().header('X-Override-Approved') ?? undefined;
});

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>('isPublic', [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const token = req.header('authorization')?.replace(/^Bearer /i, '');
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Missing bearer token' });
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; pharmacyId: string; role: Role; scope?: 'override' }>(token);
      if ((payload as { scope?: string }).scope === 'portal') throw new UnauthorizedException(); // customer tokens never reach staff routes
      req.actor = { userId: payload.sub, pharmacyId: payload.pharmacyId, role: payload.role, scope: payload.scope };
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles) {
      // Declared restriction: OWNER always passes; empty list means OWNER-only.
      const role = req.actor!.role;
      if (role !== 'OWNER' && !roles.includes(role)) {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Insufficient role' });
      }
    }
    return true;
  }
}
