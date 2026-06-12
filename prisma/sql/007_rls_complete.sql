-- ═══════════════════════════════════════════════════════════════════════════
-- 007 — C1 Tenant Isolation (RLS كامل + FORCE + set_config)
-- idempotent: آمن لإعادة التنفيذ. يطبّق العزل على كل جدول فيه pharmacyId.
-- العزل الفعلي = current_setting('app.pharmacy_id') المضبوط في غلاف المعاملة (withTenant).
-- FORCE: يطبّق RLS حتى على مالك الجدول (وإلا الاتصال بمالك الجداول يتجاوزه).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t text;
  -- كل الجداول التي تحمل pharmacyId (عمود العزل المباشر)
  tenant_tables text[] := ARRAY[
    'accounts','alerts','audit_logs','batches','cash_categories','cash_entries',
    'closed_periods','customers','grns','grn_lines','idempotency_keys','installments',
    'inventory_transactions','journal_entries','medicines','online_orders','online_order_lines',
    'outbox_events','prescriptions','prescription_lines','sale_returns','sale_return_lines',
    'sales_invoices','sales_items','shifts','suppliers','users','batch_allocations','journal_lines'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    -- بعض الجداول قد لا تكون موجودة في كل بيئة — تجاهلها بأمان
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%s ON %I', t, t);
      -- السياسة: الصف مرئي/قابل للتعديل فقط إذا طابق pharmacyId سياق المعاملة.
      -- USING يحكم القراءة/التحديث/الحذف · WITH CHECK يمنع إدراج/تحديث صف لمستأجر آخر.
      EXECUTE format(
        'CREATE POLICY tenant_isolation_%s ON %I '
        'USING ("pharmacyId" = current_setting(''app.pharmacy_id'', true)::uuid) '
        'WITH CHECK ("pharmacyId" = current_setting(''app.pharmacy_id'', true)::uuid)',
        t, t
      );
    END IF;
  END LOOP;
END $$;

-- ملاحظة: pharmacies نفسه يُعزل بالـ id لا pharmacyId (الجدول الجذر)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pharmacies') THEN
    ALTER TABLE pharmacies ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pharmacies FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_pharmacies ON pharmacies;
    CREATE POLICY tenant_isolation_pharmacies ON pharmacies
      USING (id = current_setting('app.pharmacy_id', true)::uuid)
      WITH CHECK (id = current_setting('app.pharmacy_id', true)::uuid);
  END IF;
END $$;
