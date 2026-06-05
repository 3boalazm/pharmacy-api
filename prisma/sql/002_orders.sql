-- Customer Portal / Online Orders — tenant isolation (run once in Neon SQL Editor after `prisma db push`)
ALTER TABLE online_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_order_lines ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['online_orders','online_order_lines'] LOOP
    EXECUTE format('CREATE POLICY tenant_isolation_%s ON %s USING ("pharmacyId" = current_setting(''app.pharmacy_id'', true)::uuid)', t, t);
  END LOOP;
END $$;
