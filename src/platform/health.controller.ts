import { Controller, Get } from "@nestjs/common";
import { Public } from "../common/auth";

/** GET /health — نبض عام للمراقبة وللـ keep-alive ping (يمنع نوم الاستضافة المجانية). */
@Controller("health")
export class HealthController {
  @Public()
  @Get()
  ping() {
    return { status: "ok", time: new Date().toISOString() };
  }
}
