import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ScheduleModule } from "@nestjs/schedule";
import { PlatformModule } from "./platform/platform.module";
import { IdentityModule } from "./identity/identity.module";
import { CatalogModule } from "./catalog/catalog.module";
import { InventoryModule } from "./inventory/inventory.module";
import { SalesModule } from "./sales/sales.module";
import { FinanceModule } from "./finance/finance.module";
import { CustomersModule } from "./customers/customers.module";
import { PharmacyOpsModule } from "./pharmacy-ops/pharmacy-ops.module";
import { ReportingModule } from "./reporting/reporting.module";
import { ProcurementModule } from "./procurement/procurement.module";
import { AuthGuard } from "./common/auth";
import { ApiExceptionFilter, EnvelopeInterceptor } from "./common/http.shape";
import { RequestContextMiddleware } from "./common/middleware/request-context.middleware";

/**
 * The Modular Monolith (Architecture §1, BINDING): one deployable, ten bounded
 * contexts, cross-module access ONLY via exported module facades.
 */
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    PlatformModule,
    IdentityModule,
    CatalogModule,
    InventoryModule,
    SalesModule,
    FinanceModule,
    CustomersModule,
    PharmacyOpsModule,
    ReportingModule,
    ProcurementModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,            // strips pharmacy_id or any non-DTO field from payloads (Contract §0.1)
        transform: true,
        errorHttpStatusCode: 422,
      }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
