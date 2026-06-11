import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import helmet from "helmet";

async function bootstrap() {
  const prod = process.env.NODE_ENV === "production";
  // C2: لا إقلاع بسر افتراضي — التوكنات المزورة أخطر من التوقف
  if (prod && !process.env.JWT_SECRET) throw new Error("JWT_SECRET is required in production");
  // H1: لا CORS متساهل في الإنتاج
  if (prod && !process.env.CORS_ORIGIN) throw new Error("CORS_ORIGIN is required in production");
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.setGlobalPrefix("api/v1");
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(",") ?? true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();
