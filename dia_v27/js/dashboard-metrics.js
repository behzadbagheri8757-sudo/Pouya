import { effectiveTimestamp, financialSummaryDetailed, invoiceSnapshot, isExpenseType, safeAmount, buildCustomerLedger, projectFinancials, receiptEvents, refundEvents } from './finance.js';

const dayKey = value => {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export function dashboardMetrics({ today, invoices = [], transactions = [], customers = [], allocations = [], products = [], projects = [], movements = [] } = {}) {
  const todayKey = typeof today === 'string' ? today.slice(0, 10) : dayKey(today || Date.now());
  const liveInvoices = invoices.filter(i => i.status !== 'cancelled');
  const snaps = liveInvoices.map(i => invoiceSnapshot(i, transactions, allocations));
  const openInvoices = snaps.filter(s => s.remaining > 0);
  const sales = liveInvoices.reduce((s, i) => s + safeAmount(i.total), 0);
  const summary = financialSummaryDetailed(invoices, transactions, allocations);
  const receipts = receiptEvents(invoices, transactions, allocations).filter(e => e.kind === 'customer_payment');
  const refunds = refundEvents(invoices, transactions);
  const todayReceived = receipts.filter(e => dayKey(e.date) === todayKey).reduce((s, e) => s + e.amount, 0);
  const todayRefunded = refunds.filter(e => dayKey(e.date) === todayKey).reduce((s, e) => s + e.amount, 0);
  const todayExpenses = transactions.filter(t => isExpenseType(t.type) && dayKey(effectiveTimestamp(t)) === todayKey).reduce((s, t) => s + safeAmount(t.amount), 0);
  const receivables = customers.reduce((s, c) => s + Math.max(0, buildCustomerLedger(invoices, transactions, c.id, allocations).balance), 0);
  const lowStock = products.filter(p => Number(p.stock) <= Number(p.minStock) && Number(p.minStock) > 0);
  const projectRows = projects.filter(p => !p.archived).map(p => ({ project: p, financials: projectFinancials(p, invoices, transactions, movements, allocations) }));
  const projectAttention = projectRows.filter(x => x.financials.receivable > 0 || (x.financials.budget > 0 && x.financials.costs > x.financials.budget));
  return {
    sales,
    received: summary.received,
    grossReceived: summary.grossReceived,
    refunded: summary.refunded,
    expenses: transactions.filter(t => isExpenseType(t.type)).reduce((s, t) => s + safeAmount(t.amount), 0),
    receivables,
    openInvoiceCount: openInvoices.length,
    openInvoiceAmount: openInvoices.reduce((s, x) => s + x.remaining, 0),
    todayReceived,
    todayRefunded,
    todayNetReceived: todayReceived - todayRefunded,
    todayExpenses,
    todayNetCash: todayReceived - todayRefunded - todayExpenses,
    lowStock,
    projectAttention,
    activeProjectCount: projectRows.length,
  };
}

export function buildActivityFeed({ invoices = [], transactions = [], limit = 12 } = {}) {
  const invoiceItems = invoices.filter(i => i.status !== 'draft').map(i => ({
    kind: 'invoice', date: effectiveTimestamp(i), title: `فاکتور ${i.number || ''}`.trim(), detail: i.customerName || 'مشتری آزاد', amount: safeAmount(i.total), direction: 'debit', refId: i.id
  }));
  const txItems = transactions.filter(t => ['customer_payment', 'customer_refund', 'income', 'expense', 'supplier_payment', 'other_expense'].includes(t.type)).map(t => {
    const refund = t.type === 'customer_refund';
    const income = t.type === 'customer_payment' || t.type === 'income';
    return { kind: refund ? 'refund' : income ? 'receipt' : 'expense', date: effectiveTimestamp(t), title: t.description || (refund ? 'برگشت وجه' : income ? 'دریافت وجه' : 'هزینه'), detail: t.customerName || '', amount: safeAmount(t.amount), direction: refund || !income ? 'credit' : 'debit', refId: t.id, invoiceId: t.invoiceId ?? null };
  });
  return [...invoiceItems, ...txItems].filter(x => Number.isFinite(x.date)).sort((a, b) => b.date - a.date).slice(0, limit);
}
