import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";

export const PORTAL_PUBLIC = "portalPublic";
/** Marks a shop route as reachable without a customer token (register/login/catalog). */
export const PortalPublic = () => SetMetadata(PORTAL_PUBLIC, true);

export interface PortalActor {
  customerId: string;
  pharmacyId: string;
}
export const CurrentCustomer = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): PortalActor => ctx.switchToHttp().getRequest().portalActor,
);

/**
 * Customer-portal guard — a SEPARATE trust domain from staff:
 * portal JWTs carry scope='portal' and are rejected by the staff AuthGuard;
 * staff tokens are rejected here. A customer can only ever reach /shop/*.
 */
@Injectable()
export class CustomerGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PORTAL_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!token) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync<{ scope?: string; sub: string; pharmacyId: string }>(token);
      if (payload.scope !== "portal") throw new UnauthorizedException();
      req.portalActor = { customerId: payload.sub, pharmacyId: payload.pharmacyId } satisfies PortalActor;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
