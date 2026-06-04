import { Injectable } from "@nestjs/common";
import { Tx } from "../common/prisma.service";
import { randomUUID } from "crypto";

export interface DurAlert {
  id: string;
  severity: "BLOCK" | "WARN" | "INFO";
  type: "INTERACTION" | "ALLERGY" | "DUPLICATE_THERAPY";
  detail: string;
  ruleId: string;
}

/**
 * Pharmacy-Ops bounded context — DUR clinical gate (Architecture §3, §5):
 * a DETERMINISTIC rules engine — every alert carries a ruleId for auditability.
 * Never generative AI on the safety path. Rule data ships as a licensed dataset
 * in production; the engine below is the production interface with a seed ruleset.
 */
@Injectable()
export class DurService {
  /** Seed interaction pairs by scientific name (replace with licensed dataset loader). */
  private readonly interactionRules: { a: string; b: string; severity: "BLOCK" | "WARN"; ruleId: string; detail: string }[] = [
    { a: "warfarin", b: "aspirin", severity: "BLOCK", ruleId: "INT-0001", detail: "خطر نزيف مرتفع: وارفارين + أسبرين" },
    { a: "sildenafil", b: "nitroglycerin", severity: "BLOCK", ruleId: "INT-0002", detail: "هبوط حاد في ضغط الدم" },
    { a: "amoxicillin/clavulanate", b: "methotrexate", severity: "WARN", ruleId: "INT-0101", detail: "ارتفاع سمية الميثوتريكسات" },
  ];

  async check(tx: Tx, pharmacyId: string, customerId: string | null, medicineIds: string[]): Promise<DurAlert[]> {
    const meds = await tx.medicine.findMany({
      where: { pharmacyId, id: { in: medicineIds } },
      select: { id: true, tradeNameAr: true, scientificName: true },
    });
    const alerts: DurAlert[] = [];

    // Drug–drug interactions within the cart
    const names = meds.map((m) => m.scientificName.toLowerCase());
    for (const rule of this.interactionRules) {
      if (names.some((n) => n.includes(rule.a)) && names.some((n) => n.includes(rule.b))) {
        alerts.push({ id: randomUUID(), severity: rule.severity, type: "INTERACTION", detail: rule.detail, ruleId: rule.ruleId });
      }
    }

    // Allergy match against the customer's recorded allergies
    if (customerId) {
      const customer = await tx.customer.findFirst({ where: { id: customerId, pharmacyId }, select: { allergies: true } });
      for (const allergy of customer?.allergies ?? []) {
        const hit = meds.find((m) => m.scientificName.toLowerCase().includes(allergy.toLowerCase()));
        if (hit) {
          alerts.push({
            id: randomUUID(),
            severity: "BLOCK",
            type: "ALLERGY",
            detail: `العميل لديه حساسية مسجلة من «${allergy}» — الصنف ${hit.tradeNameAr}`,
            ruleId: `ALG-${allergy.toUpperCase()}`,
          });
        }
      }
    }

    // Duplicate therapy: same scientific name twice in one cart
    const seen = new Map<string, number>();
    for (const m of meds) seen.set(m.scientificName, (seen.get(m.scientificName) ?? 0) + 1);
    for (const [name, count] of seen) {
      if (count > 1) {
        alerts.push({ id: randomUUID(), severity: "WARN", type: "DUPLICATE_THERAPY", detail: `ازدواج علاجي: ${name}`, ruleId: "DUP-0001" });
      }
    }
    return alerts;
  }
}
