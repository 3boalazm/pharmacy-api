import { PrismaClient, Prisma } from "@prisma/client";
import * as bcrypt from "bcryptjs";

/** Seeds the first tenant (Dr. Nehad Hosny pharmacy) + chart of accounts + sample data. */
const prisma = new PrismaClient();
const ACCOUNTS: [string, string][] = [
  ["1000", "النقدية"], ["1100", "ذمم العملاء"], ["1200", "المخزون"],
  ["2000", "ذمم الموردين"], ["4000", "المبيعات"], ["4100", "خصومات المبيعات"],
  ["5000", "تكلفة المبيعات"], ["5100", "إعدام مخزون"], ["5900", "عجز/زيادة الخزينة"],
];

async function main() {
  const pharmacy = await prisma.pharmacy.create({
    data: { name: "صيدلية د. نهاد حسني", ownerName: "د. نهاد حسني", phone: "01000391583" },
  });

  await prisma.account.createMany({
    data: ACCOUNTS.map(([code, name]) => ({ pharmacyId: pharmacy.id, code, name })),
  });

  const password = await bcrypt.hash("ChangeMe!2026", 10);
  const pin = await bcrypt.hash("4821", 10);
  await prisma.user.createMany({
    data: [
      { pharmacyId: pharmacy.id, name: "د. نهاد حسني", phone: "01000391583", passwordHash: password, pinHash: pin, role: "OWNER" },
      { pharmacyId: pharmacy.id, name: "صيدلي أول", phone: "01000000001", passwordHash: password, pinHash: pin, role: "PHARMACIST" },
      { pharmacyId: pharmacy.id, name: "مساعد صيدلي", phone: "01000000002", passwordHash: password, role: "ASSISTANT" },
    ],
  });

  const med = await prisma.medicine.create({
    data: {
      pharmacyId: pharmacy.id, tradeName: "Augmentin 1g", tradeNameAr: "أوجمنتين ١ جم",
      scientificName: "Amoxicillin/Clavulanate", form: "TABLET", company: "GSK",
      internalCode: "MED-000001", sellPrice: new Prisma.Decimal("98.0000"),
      requiresPrescription: true, minStockLevel: 10,
    },
  });
  await prisma.batch.create({
    data: {
      pharmacyId: pharmacy.id, medicineId: med.id, batchNumber: "B2026-001",
      expiryDate: new Date("2027-12-31"), quantityOnHand: 50, unitCost: new Prisma.Decimal("61.2500"),
    },
  });

  await prisma.supplier.create({ data: { pharmacyId: pharmacy.id, name: "شركة الأدوية المتحدة", phone: "0500000000" } });
  await prisma.customer.create({
    data: {
      pharmacyId: pharmacy.id, name: "محمد أحمد", phone: "01011111111",
      creditLimit: new Prisma.Decimal("3000.0000"), allergies: ["penicillin"],
    },
  });
  console.log(`Seeded pharmacy ${pharmacy.id}`);
}

main().finally(() => prisma.$disconnect());
