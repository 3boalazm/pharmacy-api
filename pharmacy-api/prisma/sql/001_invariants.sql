-- 001_invariants.sql — Database-enforced invariants (Architecture §4, BINDING).
-- Applied after `prisma migrate deploy`. These cannot be expressed in Prisma schema
-- and MUST exist in every environment: the invariants live in Postgres, not the ORM.

-- ────────────────── 1. Append-only tables: no UPDATE, no DELETE ──────────────────
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only. Corrections must be posted as contra entries.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries','journal_lines','inventory_transactions','audit_logs','batch_allocations','sale_returns','sale_return_lines']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()', t, t);
  END LOOP;
END $$;

-- ────────────────── 2. Double-entry: Σdebit = Σcredit per entry (deferred) ──────────────────
CREATE OR REPLACE FUNCTION assert_balanced_entry() RETURNS trigger AS $$
DECLARE diff numeric(19,4);
BEGIN
  SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) INTO diff
  FROM journal_lines WHERE "entryId" = COALESCE(NEW."entryId", OLD."entryId");
  IF diff <> 0 THEN
    RAISE EXCEPTION 'Unbalanced journal entry % (Σdebit-Σcredit = %)', COALESCE(NEW."entryId", OLD."entryId"), diff
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_balanced ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_balanced_entry();

-- Lines must be single-sided and non-negative
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_single_sided;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_single_sided
  CHECK (debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0));

-- ────────────────── 3. Inventory: no negative stock, ever ──────────────────
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_qty_non_negative;
ALTER TABLE batches ADD CONSTRAINT batches_qty_non_negative CHECK ("quantityOnHand" >= 0);

-- ────────────────── 4. Closed accounting periods reject postings ──────────────────
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM closed_periods
    WHERE "pharmacyId" = NEW."pharmacyId"
      AND "yearMonth" = to_char(NEW."entryDate", 'YYYY-MM')
  ) THEN
    RAISE EXCEPTION 'Accounting period % is closed', to_char(NEW."entryDate", 'YYYY-MM')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_period_open ON journal_entries;
CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();

-- ────────────────── 5. Row-Level Security: defense-in-depth tenant isolation ──────────────────
-- The application ALWAYS filters by pharmacy_id; RLS is the second moat (Architecture §1.2).
-- The app role connects with: SET app.pharmacy_id = '<uuid from JWT>' per transaction.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'medicines','batches','inventory_transactions','grns','sales_invoices',
    'journal_entries','journal_lines','installments','customers','suppliers',
    'audit_logs','alerts','outbox_events','idempotency_keys','users','accounts','closed_periods',
    'sale_returns','sale_return_lines'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("pharmacyId" = NULLIF(current_setting(''app.pharmacy_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
-- Note: the migration/admin role must be granted BYPASSRLS; the runtime app role must NOT.
