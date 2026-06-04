import { PrismaClient, Prisma } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

/**
 * Catalog import — الاصناف.xlsx (both tabs: Sheet1 + ثلاجة), per the owner's rule:
 * quantities and expiry dates are ZEROED → we create catalog rows ONLY, no batches.
 * Stock shows 0 everywhere until real GRNs land (the only door for stock, BR-1.6),
 * which is exactly how opening inventory should enter: counted, batched, dated.
 *
 * Idempotent: re-running skips items whose (tradeNameAr, form) already exist, and
 * internal codes continue from the current max. Usage: npm run import:items
 */
const prisma = new PrismaClient();

interface ItemRow { tradeNameAr: string; form: string; sellPrice: string }

async function main() {
  const pharmacy = await prisma.pharmacy.findFirst();
  if (!pharmacy) throw new Error("No pharmacy found — run `npm run seed` first.");

  const file = path.join(__dirname, "data", "items.json");
  const items: ItemRow[] = JSON.parse(fs.readFileSync(file, "utf-8"));

  const existing = await prisma.medicine.findMany({
    where: { pharmacyId: pharmacy.id },
    select: { tradeNameAr: true, form: true, internalCode: true },
  });
  const have = new Set(existing.map((m) => `${m.tradeNameAr}|${m.form}`));
  let seq = existing
    .map((m) => Number(m.internalCode.replace(/\D/g, "")) || 0)
    .reduce((a, b) => Math.max(a, b), 0);

  const fresh = items.filter((i) => !have.has(`${i.tradeNameAr}|${i.form}`));
  console.log(`File items: ${items.length} · already in catalog: ${items.length - fresh.length} · to insert: ${fresh.length}`);

  const data: Prisma.MedicineCreateManyInput[] = fresh.map((i) => ({
    pharmacyId: pharmacy.id,
    tradeNameAr: i.tradeNameAr,
    tradeName: i.tradeNameAr, // English trade name unknown in the source file
    scientificName: "غير مسجل", // fill per item later — feeds DUR matching when set
    form: i.form,
    internalCode: `MED-${String(++seq).padStart(6, "0")}`,
    sellPrice: new Prisma.Decimal(i.sellPrice),
    minStockLevel: 0,
  }));

  // Chunked createMany (no batches created → onHand = 0, no expiry, as requested)
  for (let i = 0; i < data.length; i += 500) {
    await prisma.medicine.createMany({ data: data.slice(i, i + 500), skipDuplicates: true });
    console.log(`inserted ${Math.min(i + 500, data.length)}/${data.length}`);
  }
  console.log("Done. Stock is 0 for all items — receive real shipments via GRN to add batches.");
}

main().finally(() => prisma.$disconnect());
