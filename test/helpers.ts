import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";

/**
 * عدّة اختبارات التكامل المالية.
 * تشتغل ضد Postgres حقيقي (خدمة في CI) — لا mocks، لأن الهدف التحقق من
 * توازن القيد المزدوج والـ idempotency على مستوى المعاملة الفعلية + قادح DB.
 * DATABASE_URL يأتي من بيئة CI (خدمة postgres).
 */
export const prisma = new PrismaClient();

/** يطبّق السكيما على قاعدة الاختبار الفارغة مرة واحدة قبل كل المجموعات. */
export function pushSchema() {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env },
  });
}

export interface Seeded {
  pharmacyId: string;
  userId: string;
  medicineId: string;
  batchId: string;
  customerId: string;
}

/** يزرع مستأجرًا كاملًا: صيدلية + مالك + دواء + تشغيلة بمخزون + عميل + حسابات الدفتر. */
export async function seedTenant(): Promise<Seeded> {
  const pharmacy = await prisma.pharmacy.create({
    data: { name: "صيدلية الاختبار", phone: "01000000000" },
  });
  const user = await prisma.user.create({
    data: {
      pharmacyId: pharmacy.id,
      name: "مالك الاختبار",
      phone: "01000000001",
      role: "OWNER",
      passwordHash: "x",
    },
  });
  const medicine = await prisma.medicine.create({
    data: {
      pharmacyId: pharmacy.id,
      tradeName: "TestDrug",
      tradeNameAr: "دواء اختبار",
      scientificName: "testium",
      form: "أقراص",
      internalCode: "TST-0001",
      sellPrice: "100.0000",
      minStockLevel: 5,
    },
  });
  const batch = await prisma.batch.create({
    data: {
      pharmacyId: pharmacy.id,
      medicineId: medicine.id,
      batchNumber: "B-TEST-1",
      expiryDate: new Date(Date.now() + 365 * 86400_000),
      quantityOnHand: 100,
      unitCost: "60.0000",
      status: "ACTIVE",
    },
  });
  const customer = await prisma.customer.create({
    data: { pharmacyId: pharmacy.id, name: "عميل اختبار", phone: "01000000002", creditLimit: "5000.0000" },
  });

  // حسابات الدفتر الأساسية المطلوبة للترحيل
  const accounts = [
    ["1000", "الصندوق"], ["1010", "البنك"], ["1100", "ذمم مدينة"], ["1200", "المخزون"],
    ["2000", "ذمم دائنة"], ["4000", "المبيعات"], ["4100", "خصم المبيعات"],
    ["5000", "تكلفة المبيعات"], ["5900", "عجز/زيادة"],
  ];
  await prisma.account.createMany({
    data: accounts.map(([code, name]) => ({ pharmacyId: pharmacy.id, code, name })),
  });

  return { pharmacyId: pharmacy.id, userId: user.id, medicineId: medicine.id, batchId: batch.id, customerId: customer.id };
}

/** تنظيف كامل بين الاختبارات — يحفظ العزل التسلسلي. */
export async function wipe() {
  // ترتيب الحذف يحترم المفاتيح الأجنبية
  const tables = [
    "journal_lines", "journal_entries", "batch_allocations", "sales_items", "sales_invoices",
    "cash_entries", "cash_categories", "installments", "shifts", "audit_logs", "outbox_events",
    "idempotency_keys", "batches", "medicines", "customers", "accounts", "users", "pharmacies",
  ];
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
}
