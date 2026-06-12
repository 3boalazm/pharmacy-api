import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient, Prisma } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * C1 — غلاف معاملة معزول بالمستأجر.
   * يضبط app.pharmacy_id (المعامل الثالث true = على مستوى المعاملة، يُمسح تلقائيًا عند انتهائها)
   * قبل أي منطق، فتطبّق سياسات RLS العزل على كل استعلام داخلها — حتى لو نُسي where pharmacyId.
   * طبقة دفاع ثانية فوق انضباط التطبيق، لا بديلًا عنه.
   */
  async withTenant<T>(pharmacyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.pharmacy_id', ${pharmacyId}, true)`;
      return fn(tx);
    });
  }
}

/** Transaction client type used by all domain services (one ACID transaction per business fact). */
export type Tx = Prisma.TransactionClient;
