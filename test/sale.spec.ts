import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { SalesService } from "../src/sales/sales.service";
import { prisma, pushSchema, seedTenant, wipe, type Seeded } from "./helpers";
import { randomUUID } from "crypto";

/**
 * أهم اختبار في النظام: التحقق من سلامة القيد المزدوج على البيع الذري.
 * كل تأكيد هنا يحرس ثابتًا ماليًا لا يجوز كسره بأي تعديل مستقبلي.
 */
describe("Financial integrity — atomic sale", () => {
  let app: INestApplication;
  let sales: SalesService;
  let seed: Seeded;

  beforeAll(async () => {
    pushSchema();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    sales = app.get(SalesService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await wipe();
    seed = await seedTenant();
  });

  const actor = (s: Seeded) => ({ pharmacyId: s.pharmacyId, userId: s.userId, role: "OWNER" as const });

  function cashSaleInput(s: Seeded, clientSaleId: string) {
    return {
      clientSaleId,
      clientTimestamp: new Date().toISOString(),
      customerId: null,
      prescriptionId: null,
      lines: [{ medicineId: s.medicineId, quantity: 2, unitPrice: "100.0000" }],
      payment: { method: "CASH" as const },
    };
  }

  it("ينتج قيدًا متوازنًا (Σ مدين = Σ دائن)", async () => {
    const res = await sales.createSale(actor(seed), cashSaleInput(seed, randomUUID()));
    const entry = await prisma.journalEntry.findFirst({
      where: { pharmacyId: seed.pharmacyId },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).toBeTruthy();
    const debits = entry!.lines.reduce((a, l) => a + Number(l.debit ?? 0), 0);
    const credits = entry!.lines.reduce((a, l) => a + Number(l.credit ?? 0), 0);
    expect(debits).toBeCloseTo(credits, 4);
    expect(debits).toBeGreaterThan(0);
    void res;
  });

  it("يخصم المخزون بالكمية المباعة (FEFO)", async () => {
    const before = await prisma.batch.findUnique({ where: { id: seed.batchId } });
    await sales.createSale(actor(seed), cashSaleInput(seed, randomUUID()));
    const after = await prisma.batch.findUnique({ where: { id: seed.batchId } });
    expect(before!.quantityOnHand - after!.quantityOnHand).toBe(2);
  });

  it("القيد النقدي: مدين الصندوق = إجمالي الفاتورة", async () => {
    await sales.createSale(actor(seed), cashSaleInput(seed, randomUUID()));
    const cashLine = await prisma.journalLine.findFirst({
      where: { pharmacyId: seed.pharmacyId, account: { code: "1000" } },
    });
    expect(Number(cashLine!.debit)).toBeCloseTo(200, 4); // 2 × 100
  });

  it("Idempotency: نفس clientSaleId لا يكرّر البيع", async () => {
    const id = randomUUID();
    await sales.createSale(actor(seed), cashSaleInput(seed, id));
    await sales.createSale(actor(seed), cashSaleInput(seed, id)); // إعادة
    const invoices = await prisma.salesInvoice.count({ where: { pharmacyId: seed.pharmacyId } });
    expect(invoices).toBe(1); // لا تكرار
    const batch = await prisma.batch.findUnique({ where: { id: seed.batchId } });
    expect(batch!.quantityOnHand).toBe(98); // خُصم مرة واحدة فقط
  });

  it("يمنع البيع عند نفاد المخزون", async () => {
    await prisma.batch.update({ where: { id: seed.batchId }, data: { quantityOnHand: 1 } });
    await expect(
      sales.createSale(actor(seed), cashSaleInput(seed, randomUUID())), // يطلب 2
    ).rejects.toThrow();
  });
});
