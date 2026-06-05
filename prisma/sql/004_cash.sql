-- Cashbox (الخزينة) — tenant isolation. Run once after `prisma db push`.
ALTER TABLE cash_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_entries    ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_categories','cash_entries'] LOOP
    EXECUTE format('CREATE POLICY tenant_isolation_%s ON %s USING ("pharmacyId" = current_setting(''app.pharmacy_id'', true)::uuid)', t, t);
  END LOOP;
END $$;
-- cash_entries append-only: reversal is a new row, never an UPDATE of financial fields
CREATE OR REPLACE FUNCTION cash_entries_no_mutation() RETURNS trigger AS $$
BEGIN
  IF (NEW.amount <> OLD.amount OR NEW.type <> OLD.type OR NEW."journalEntryId" <> OLD."journalEntryId") THEN
    RAISE EXCEPTION 'cash_entries are immutable (amount/type/journal)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_cash_entries_no_mutation ON cash_entries;
CREATE TRIGGER trg_cash_entries_no_mutation BEFORE UPDATE ON cash_entries
FOR EACH ROW EXECUTE FUNCTION cash_entries_no_mutation();
