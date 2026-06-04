import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService, Tx } from "../../common/prisma.service";
import { ACCOUNTS } from "../ledger.service";

export interface SubledgerLine {
  date: Date;
  memo: string | null;
  sourceType: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  entryId: string;
}
export interface AccountBalanceRow {
  code: string;
  name: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  balance: Prisma.Decimal;
}

/**
 * Journal repository — the ONLY raw-SQL surface over journal_entries/journal_lines.
 * Subledgers are folds over dimensioned lines (BR-2.3): balances can never drift
 * from the accounting facts because they ARE the accounting facts.
 */
@Injectable()
export class JournalRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** AR balance for one customer = Σ(debit−credit) over 1100 lines with that dimension. */
  async customerBalance(tx: Tx, pharmacyId: string, customerId: string): Promise<Prisma.Decimal> {
    const rows = await tx.$queryRaw<{ balance: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,4) AS balance
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl."accountId"
      WHERE jl."pharmacyId" = ${pharmacyId}::uuid
        AND jl."customerId" = ${customerId}::uuid
        AND a.code = ${ACCOUNTS.AR}`;
    return new Prisma.Decimal(rows[0]?.balance ?? 0);
  }

  /** AP balance for one supplier = Σ(credit−debit) over 2000 lines (liability normal side). */
  async supplierBalance(tx: Tx, pharmacyId: string, supplierId: string): Promise<Prisma.Decimal> {
    const rows = await tx.$queryRaw<{ balance: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric(19,4) AS balance
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl."accountId"
      WHERE jl."pharmacyId" = ${pharmacyId}::uuid
        AND jl."supplierId" = ${supplierId}::uuid
        AND a.code = ${ACCOUNTS.AP}`;
    return new Prisma.Decimal(rows[0]?.balance ?? 0);
  }

  /** Dimensioned subledger lines in posting order (statement folds run over these). */
  async subledgerLines(
    pharmacyId: string,
    dimension: { customerId: string } | { supplierId: string },
  ): Promise<SubledgerLine[]> {
    if ("customerId" in dimension) {
      return this.prisma.$queryRaw<SubledgerLine[]>`
        SELECT je."entryDate" AS date, je.memo, je."sourceType", jl.debit, jl.credit, je.id AS "entryId"
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl."entryId"
        JOIN accounts a ON a.id = jl."accountId"
        WHERE jl."pharmacyId" = ${pharmacyId}::uuid
          AND jl."customerId" = ${dimension.customerId}::uuid
          AND a.code = ${ACCOUNTS.AR}
        ORDER BY je."entryDate" ASC, je."createdAt" ASC`;
    }
    return this.prisma.$queryRaw<SubledgerLine[]>`
      SELECT je."entryDate" AS date, je.memo, je."sourceType", jl.debit, jl.credit, je.id AS "entryId"
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl."entryId"
      JOIN accounts a ON a.id = jl."accountId"
      WHERE jl."pharmacyId" = ${pharmacyId}::uuid
        AND jl."supplierId" = ${dimension.supplierId}::uuid
        AND a.code = ${ACCOUNTS.AP}
      ORDER BY je."entryDate" ASC, je."createdAt" ASC`;
  }

  /** Trial balance: Σdebit − Σcredit across the whole ledger (must be 0). */
  async trialBalanceDiff(pharmacyId: string): Promise<Prisma.Decimal> {
    const rows = await this.prisma.$queryRaw<{ diff: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(debit) - SUM(credit), 0)::numeric(19,4) AS diff
      FROM journal_lines WHERE "pharmacyId" = ${pharmacyId}::uuid`;
    return new Prisma.Decimal(rows[0]?.diff ?? 0);
  }

  /** Per-account balances — the trial balance report (Contract §6 account balances). */
  async accountBalances(pharmacyId: string): Promise<AccountBalanceRow[]> {
    return this.prisma.$queryRaw<AccountBalanceRow[]>`
      SELECT a.code, a.name,
             COALESCE(SUM(jl.debit), 0)::numeric(19,4) AS debit,
             COALESCE(SUM(jl.credit), 0)::numeric(19,4) AS credit,
             COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,4) AS balance
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl."accountId" = a.id
      WHERE a."pharmacyId" = ${pharmacyId}::uuid
      GROUP BY a.id
      ORDER BY a.code`;
  }

  /** Customer cached-balance drift vs ledger truth (daily reconciliation). */
  async customerDrift(pharmacyId: string) {
    return this.prisma.$queryRaw<{ id: string; name: string; cached: Prisma.Decimal; ledger: Prisma.Decimal }[]>`
      SELECT c.id, c.name, c."balanceCached" AS cached,
             COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,4) AS ledger
      FROM customers c
      LEFT JOIN journal_lines jl ON jl."customerId" = c.id
      LEFT JOIN accounts a ON a.id = jl."accountId" AND a.code = ${ACCOUNTS.AR}
      WHERE c."pharmacyId" = ${pharmacyId}::uuid
      GROUP BY c.id
      HAVING c."balanceCached" <> COALESCE(SUM(jl.debit - jl.credit), 0)`;
  }
}
