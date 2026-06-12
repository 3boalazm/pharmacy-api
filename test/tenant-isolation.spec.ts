import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

/**
 * اختبارات اختراق C1 — تثبت أن RLS يعزل المستأجرين فعليًا.
 * تشتغل ضد Postgres حقيقي (CI). تزرع مستأجرين A وB، ثم تتحقق:
 *  - A لا يقرأ بيانات B
 *  - A لا يعدّل بيانات B
 *  - A لا يصل لتحليلات B
 * كل عملية تمرّ عبر set_config('app.pharmacy_id') لتفعيل السياسات.
 */
const prisma = new PrismaClient();

/** ينفّذ استعلامات داخل سياق مستأجر محدد (يحاكي withTenant). */
async function asTenant<T>(pharmacyId: string, fn: (tx: any) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.pharmacy_id', ${pharmacyId}, true)`;
    return fn(tx);
  });
}

describe("C1 — Tenant Isolation penetration tests", () => {
  let A: string, B: string;
  let medicineB: string, customerB: string;

  beforeAll(async () => {
    // طبّق السكيما + سكربت RLS على قاعدة الاختبار
    execSync("npx prisma db push --skip-generate --accept-data-loss", { stdio: "inherit", env: { ...process.env } });
    execSync(`psql "${process.env.DATABASE_URL}" -f prisma/sql/007_rls_complete.sql`, { stdio: "inherit", env: { ...process.env } });

    // زرع مستأجرين — بصلاحية متجاوزة للـ RLS (superuser) لإنشاء البيانات الأولية
    const pharmA = await prisma.pharmacy.create({ data: { name: "صيدلية A", phone: "01000000001" } });
    const pharmB = await prisma.pharmacy.create({ data: { name: "صيدلية B", phone: "01000000002" } });
    A = pharmA.id; B = pharmB.id;

    const medB = await prisma.medicine.create({
      data: { pharmacyId: B, tradeName: "DrugB", tradeNameAr: "دواء B", scientificName: "bbb", form: "أقراص", internalCode: "B-1", sellPrice: "50.0000", minStockLevel: 1 },
    });
    const custB = await prisma.customer.create({
      data: { pharmacyId: B, name: "عميل B", phone: "01099999999", creditLimit: "1000.0000" },
    });
    medicineB = medB.id; customerB = custB.id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM medicines`);
    await prisma.$executeRawUnsafe(`DELETE FROM customers`);
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacies`);
    await prisma.$disconnect();
  });

  it("A لا يقرأ أدوية B", async () => {
    const seen = await asTenant(A, (tx) => tx.medicine.findMany());
    expect(seen.find((m: any) => m.id === medicineB)).toBeUndefined();
  });

  it("A لا يقرأ عملاء B", async () => {
    const seen = await asTenant(A, (tx) => tx.customer.findMany());
    expect(seen.length).toBe(0);
  });

  it("A لا يصل لصنف B حتى بالـ id المباشر", async () => {
    const direct = await asTenant(A, (tx) => tx.medicine.findFirst({ where: { id: medicineB } }));
    expect(direct).toBeNull();
  });

  it("A لا يعدّل بيانات B (التحديث لا يصيب صفوف B)", async () => {
    const result = await asTenant(A, (tx) =>
      tx.medicine.updateMany({ where: { id: medicineB }, data: { sellPrice: "999.0000" } }),
    );
    expect(result.count).toBe(0); // صفر صفوف تأثرت
    // تأكيد أن سعر B لم يتغير (قراءة كـ B)
    const stillB = await asTenant(B, (tx) => tx.medicine.findFirst({ where: { id: medicineB } }));
    expect(Number(stillB!.sellPrice)).toBe(50);
  });

  it("A لا يصل لتحليلات B — _count محمي", async () => {
    const agg = await asTenant(A, (tx) => tx.medicine.aggregate({ _count: true }));
    expect(agg._count).toBe(0);
  });

  it("A لا يصل لتحليلات B — _sum/_avg محميان (لا تسريب قيم عبر التجميع)", async () => {
    // حتى لو حاول A تجميع أسعار كل الأدوية، يجب ألا يرى قيم B
    const agg = await asTenant(A, (tx) =>
      tx.medicine.aggregate({ _sum: { sellPrice: true }, _avg: { sellPrice: true } }),
    );
    // RLS يفلتر صفوف B قبل التجميع → الناتج null (لا صفوف لدى A)
    expect(agg._sum.sellPrice).toBeNull();
    expect(agg._avg.sellPrice).toBeNull();
  });

  it("A لا يصل لتحليلات B — groupBy لا يُرجع مجموعات B", async () => {
    const groups = await asTenant(A, (tx) =>
      tx.medicine.groupBy({ by: ["pharmacyId"], _count: { _all: true } }),
    );
    // يجب ألا تظهر مجموعة بـ pharmacyId = B
    expect(groups.find((g: any) => g.pharmacyId === B)).toBeUndefined();
    expect(groups.length).toBe(0); // A لا يملك صفوفًا
  });

  it("A لا يصل لتحليلات B — count مباشر محمي", async () => {
    const n = await asTenant(A, (tx) => tx.medicine.count());
    expect(n).toBe(0);
  });

  it("الضد الإيجابي للتجميع: B يجمّع بياناته بنجاح", async () => {
    const agg = await asTenant(B, (tx) => tx.medicine.aggregate({ _count: true, _sum: { sellPrice: true } }));
    expect(agg._count).toBeGreaterThan(0);
    expect(Number(agg._sum.sellPrice)).toBe(50); // سعر صنف B الوحيد
  });

  it("B يرى بياناته الخاصة (الضد الإيجابي — العزل لا يكسر الوصول المشروع)", async () => {
    const seen = await asTenant(B, (tx) => tx.medicine.findMany());
    expect(seen.find((m: any) => m.id === medicineB)).toBeTruthy();
  });
});
