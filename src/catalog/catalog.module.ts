import { Module } from "@nestjs/common";
import { MedicinesController } from "./medicines.controller";

/** Catalog bounded context — descriptive medicine truth, no quantities (Architecture §3). */
@Module({ controllers: [MedicinesController] })
export class CatalogModule {}
