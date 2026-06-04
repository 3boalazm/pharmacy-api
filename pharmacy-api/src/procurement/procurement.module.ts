import { Module } from "@nestjs/common";
import { SuppliersController } from "./suppliers.controller";

/** Procurement bounded context — MVP slice: supplier registry (Architecture §3). */
@Module({ controllers: [SuppliersController] })
export class ProcurementModule {}
