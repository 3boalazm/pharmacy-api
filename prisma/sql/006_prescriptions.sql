-- الروشتات — عزل المستأجر (idempotent: آمن لإعادة التنفيذ)
ALTER TABLE prescriptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescription_lines ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['prescriptions','prescription_lines'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%s ON %s', t, t);
    EXECUTE format('CREATE POLICY tenant_isolation_%s ON %s USING ("pharmacyId" = current_setting(''app.pharmacy_id'', true)::uuid)', t, t);
  END LOOP;
END $$;
