-- 005_performance.sql — مراجعة معماري قواعد البيانات (إضافي بالكامل، آمن، Idempotent)
-- يُلصق في Neon SQL Editor مرة واحدة. لا يغيّر أي سلوك — فهارس وقيود صحة فقط.

-- ── A) المسار الساخن الأخطر: قادح توازن القيد يستعلم SUM(entryId) مع كل سطر يُدرج ──
-- بدون هذا الفهرس يتدهور زمن كل بيعة خطيًا مع نمو دفتر الأستاذ.
CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON journal_lines ("entryId");

-- ── B) فهارس أسطر العلاقات (Prisma لا يفهرس FK تلقائيًا) ──
CREATE INDEX IF NOT EXISTS sales_items_invoice_idx       ON sales_items ("invoiceId");
CREATE INDEX IF NOT EXISTS sales_items_medicine_idx      ON sales_items ("pharmacyId", "medicineId"); -- تقرير الأكثر مبيعًا
CREATE INDEX IF NOT EXISTS grn_lines_grn_idx             ON grn_lines ("grnId");
CREATE INDEX IF NOT EXISTS online_order_lines_order_idx  ON online_order_lines ("orderId");

-- ── C) الزمن في التقارير (حركة النقدية/الداشبورد/درج الوردية تصفّي بـ createdAt) ──
CREATE INDEX IF NOT EXISTS journal_entries_created_idx        ON journal_entries ("pharmacyId", "createdAt");
CREATE INDEX IF NOT EXISTS journal_entries_source_created_idx ON journal_entries ("pharmacyId", "sourceType", "createdAt");
CREATE INDEX IF NOT EXISTS inventory_tx_created_idx           ON inventory_transactions ("pharmacyId", "createdAt"); -- شاشة الحركات العامة

-- ── D) فهارس جزئية لاستعلامات التحصيل ──
CREATE INDEX IF NOT EXISTS installments_open_due_idx ON installments ("pharmacyId", "dueDate") WHERE "paidAt" IS NULL; -- الأقساط المجمعة/أعمار الديون
CREATE INDEX IF NOT EXISTS customers_debtors_idx     ON customers ("pharmacyId", "balanceCached" DESC) WHERE "balanceCached" > 0; -- المدينون

-- ── E) بحث POS اللحظي: contains على 4 أعمدة لا يستفيد من B-tree — Trigram GIN ──
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS medicines_trade_ar_trgm ON medicines USING gin ("tradeNameAr" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS medicines_trade_trgm    ON medicines USING gin ("tradeName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS medicines_sci_trgm      ON medicines USING gin ("scientificName" gin_trgm_ops);

-- ── F) صحة أسطر القيد على مستوى القاعدة: لا قيم سالبة، ولا سطر مدين ودائن معًا ──
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_nonneg_chk;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_nonneg_chk
  CHECK (debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0));
