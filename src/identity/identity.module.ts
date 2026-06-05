import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { UsersController } from "./users.controller";

/** Identity & Tenancy bounded context (Architecture §3). Exports JwtModule for guards/override checks. */
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? "dev-only-secret-change-me",
      signOptions: { expiresIn: "8h" },
    }),
  ],
  controllers: [AuthController, UsersController],
  exports: [JwtModule],
})
export class IdentityModule {}
