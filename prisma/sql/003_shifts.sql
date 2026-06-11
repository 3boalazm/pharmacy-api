-- Shifts (WF-5) — tenant isolation (نفّذه مرة واحدة في Neon SQL Editor بعد prisma db push)
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_shifts ON shifts;
CREATE POLICY tenant_isolation_shifts ON shifts
  USING ("pharmacyId" = current_setting('app.pharmacy_id', true)::uuid);
