/** Domain event catalog — Architecture Decision Doc §2 (BINDING). */
export const EVENTS = {
  SaleCompleted: "SaleCompleted",
  SaleReturned: "SaleReturned",
  PaymentRecorded: "PaymentRecorded",
  StockReceived: "StockReceived",
  StockAdjusted: "StockAdjusted",
  LowStockDetected: "LowStockDetected",
  BatchExpiringSoon: "BatchExpiringSoon",
  CustomerCreditExtended: "CustomerCreditExtended",
  CreditLimitBreached: "CreditLimitBreached",
  AccountingPeriodClosed: "AccountingPeriodClosed",
  DURAlertRaised: "DURAlertRaised",
} as const;
export type EventType = (typeof EVENTS)[keyof typeof EVENTS];

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  pharmacyId: string;
  eventType: EventType;
  payload: T;
}

export interface SaleCompletedPayload {
  invoiceId: string;
  customerId: string | null;
  total: string;
  paymentMethod: string;
  lines: { medicineId: string; quantity: number }[];
  [key: string]: unknown;
}
