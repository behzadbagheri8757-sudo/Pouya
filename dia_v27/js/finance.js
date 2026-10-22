// DIA Finance — the ONE place where money rules live. Pure functions only (no DOM, no IndexedDB).
//
// Data model (Phase 1 policy)
// ---------------------------
// * Transaction.date       = financial/event date (ISO "YYYY-MM-DD"). createdAt = real record-creation time.
//                            Legacy rows without `date` fall back to createdAt (see effectiveTimestamp).
// * Payment source of truth = `customer_payment` transactions.
//     - A payment linked to an existing invoice (invoiceId) belongs to that invoice.
//     - A payment without invoiceId (or whose invoice no longer exists) is an "on-account" payment (customer credit).
//     - Legacy: invoice.paidAmount counts ONLY when the invoice has no linked payment transactions.
//       So one real receipt is never counted twice, whatever combination of old/new data exists.
//     - invoice.paidAmount / remainingAmount / status are a CACHE derived by invoiceSnapshot(); never the truth.
// * Cancelled invoice     = removed from sales/receivables. Money that was already received stays received
//                            (cash) and remains in the customer's ledger as a credit — never silently dropped.
// * Overpayment policy     = an invoice can never be paid above its total, and its total can never be lowered
//                            below what was already received (reject with explicit message, never truncate).
//                            Payments recorded from Accounting without an invoice are on-account credit.
// * Project profit         = sales(non-cancelled invoices) − costs(project expense transactions + manual project cost).
//                            It is NOT cash received and NOT the remaining receivable; those are reported separately.
//
// Phase 2 additions (all backward compatible; every new parameter is optional and defaults to "none")
// ---------------------------------------------------------------------------------------------------
// * Payment allocation = store `paymentAllocations` {paymentId, invoiceId, amount, date}. It splits ONE on-account payment
//   (customer_payment WITHOUT invoiceId) across invoices. A payment WITH invoiceId is an implicit 100% allocation to that invoice
//   (Phase 1 meaning, unchanged) and can never carry explicit allocations. Allocation never creates money: the payment is still
//   counted exactly once in the customer ledger / receipts; allocation only decides WHICH invoice it settles.
//     unallocated credit of a payment = amount − Σ allocations (stays customer credit / on-account)
// * Refund = transaction type `customer_refund` {amount, customerId, invoiceId?, date, refundKey}. It is cash OUT to the customer:
//     - reduces the invoice's net paid (so remaining/status move back), reduces project received and dashboard received (net),
//     - is a DEBIT in the customer ledger, and is NOT an operating expense (never reduces profit).
//   The original payment is never deleted or edited. A refundKey makes a refund idempotent.
// * invoice net paid = Σ linked payments + Σ allocations − Σ refunds on the invoice  (legacy paidAmount only when none of those exist)
// * Project inventory cost = stock consumed by the project (stockMovements sourceType 'project'), shown separately from
//   transaction expenses and from the legacy/manual `project.cost`; the three are summed once into `costs`.
import { invoiceStatusFromPayment } from './invoice-engine.js';
import { projectInventoryCost } from './inventory.js';

export const isIncomeType = t => t === 'income' || t === 'customer_payment';
export const isExpenseType = t => t === 'expense' || t === 'supplier_payment' || t === 'other_expense';
export const isRefundType = t => t === 'customer_refund';

const amt = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const safeAmount = amt;

// ---------- dates ----------
export function dateToTimestamp(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00`).getTime();
  return new Date(s).getTime();
}
// Local calendar date (YYYY-MM-DD) of a timestamp.
export function isoFromTimestamp(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Strict "YYYY-MM-DD" that is a real calendar day.
export function isValidISODate(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}
// Event time of a record: its `date` if present, otherwise (legacy) createdAt. NaN when neither is usable.
export function effectiveTimestamp(rec) {
  const d = dateToTimestamp(rec?.date);
  if (Number.isFinite(d)) return d;
  const c = Number(rec?.createdAt);
  return Number.isFinite(c) && c > 0 ? c : NaN;
}
export const effectiveISODate = rec => {
  const t = effectiveTimestamp(rec);
  return Number.isFinite(t) ? (isValidISODate(rec?.date) ? rec.date : isoFromTimestamp(t)) : null;
};
// Inclusive [from, to] day range test on the record's event date. No range => always true (never silently drops rows).
export function inDateRange(rec, from, to) {
  if (!from && !to) return true;
  const t = effectiveTimestamp(rec);
  if (!Number.isFinite(t)) return false;
  if (from && t < dateToTimestamp(from)) return false;
  if (to && t > dateToTimestamp(to) + 86399999) return false;
  return true;
}

// ---------- invoice payments ----------
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
export const linkedPayments = (invoiceId, transactions = []) =>
  transactions.filter(t => t.type === 'customer_payment' && sameId(t.invoiceId, invoiceId));
export const linkedRefunds = (invoiceId, transactions = []) =>
  transactions.filter(t => t.type === 'customer_refund' && sameId(t.invoiceId, invoiceId));
// Explicit allocations to this invoice that belong to a still-existing on-account payment (a payment can never be double counted).
export function invoiceAllocations(invoiceId, transactions = [], allocations = []) {
  const onAccount = new Map(transactions.filter(t => t.type === 'customer_payment' && (t.invoiceId === null || t.invoiceId === undefined)).map(t => [String(t.id), t]));
  return allocations.filter(a => sameId(a.invoiceId, invoiceId) && onAccount.has(String(a.paymentId)));
}

export function invoicePaidAmount(invoice, transactions = [], allocations = []) {
  const linked = linkedPayments(invoice.id, transactions), alloc = invoiceAllocations(invoice.id, transactions, allocations);
  const refunds = linkedRefunds(invoice.id, transactions).reduce((s, t) => s + amt(t.amount), 0);
  if (!linked.length && !alloc.length) return Math.max(0, amt(invoice.paidAmount) - refunds);
  return Math.max(0, linked.reduce((s, t) => s + amt(t.amount), 0) + alloc.reduce((s, a) => s + amt(a.amount), 0) - refunds);
}

// Everything the UI/reports need to know about one invoice's money, derived from the source of truth.
export function invoiceSnapshot(invoice, transactions = [], allocations = []) {
  const total = Math.max(0, amt(invoice.total));
  const linked = linkedPayments(invoice.id, transactions), alloc = invoiceAllocations(invoice.id, transactions, allocations);
  const refunded = linkedRefunds(invoice.id, transactions).reduce((s, t) => s + amt(t.amount), 0);
  const paid = invoicePaidAmount(invoice, transactions, allocations);
  const real = linked.length + alloc.length;
  const cancelled = invoice.status === 'cancelled';
  return {
    id: invoice.id, total, paid, cancelled,
    linkedCount: real,
    allocatedAmount: alloc.reduce((s, a) => s + amt(a.amount), 0),
    refunded,
    paidGross: paid + refunded,
    legacyPaid: real ? 0 : Math.max(0, amt(invoice.paidAmount)),
    remaining: cancelled ? 0 : Math.max(0, total - paid),
    // Money held for the customer beyond what this invoice needs (cancelled invoice, or legacy over-paid data).
    credit: cancelled ? paid : Math.max(0, paid - total),
    status: invoiceStatusFromPayment(invoice.status, paid, total)
  };
}
// Fields of the invoice record that mirror the snapshot (cache).
export const invoiceCacheFields = snap => ({ paidAmount: snap.paid, remainingAmount: snap.remaining, status: snap.status });

export function legacyMigrationTx(invoice, customerName) {
  return {
    type: 'customer_payment', amount: Math.round(Math.max(0, amt(invoice.paidAmount))),
    customerId: invoice.customerId ?? null, invoiceId: invoice.id,
    party: customerName || invoice.customerName || 'مشتری آزاد', description: 'انتقال خودکار پرداخت قبلی',
    projectId: invoice.projectId ?? null, date: effectiveISODate(invoice)
  };
}
export function paymentTx({ invoice, amount, date, description, customerName }) {
  return {
    type: 'customer_payment', amount: Math.round(amt(amount)), customerId: invoice.customerId ?? null, invoiceId: invoice.id,
    party: customerName || invoice.customerName || 'مشتری آزاد', description: description || `دریافت فاکتور ${invoice.number}`,
    projectId: invoice.projectId ?? null, date
  };
}

// Plan (not execute) a payment against an existing invoice. Returns {ok:false,error} or {ok:true, ops}.
// ops are DB.atomic operations: the invoice cache update, an optional legacy migration and the payment itself.
export function planInvoicePayment({ invoice, transactions = [], allocations = [], amount, date, description, customerName }) {
  const snap = invoiceSnapshot(invoice, transactions, allocations);
  const value = Math.round(amt(amount));
  if (snap.cancelled) return { ok: false, error: 'برای فاکتور لغوشده نمی‌توان دریافت ثبت کرد.' };
  if (!(value > 0)) return { ok: false, error: 'مبلغ دریافت باید بیشتر از صفر باشد.' };
  if (value > snap.remaining) return { ok: false, error: 'مبلغ دریافت از مانده فاکتور بیشتر است.' };
  const ops = [];
  if (snap.linkedCount === 0 && snap.legacyPaid > 0) ops.push({ store: 'transactions', action: 'add', data: legacyMigrationTx(invoice, customerName) });
  ops.push({ store: 'transactions', action: 'add', data: paymentTx({ invoice, amount: value, date, description, customerName }) });
  const after = invoiceSnapshot(invoice, [...transactions, ...ops.filter(o => o.store === 'transactions').map(o => o.data)], allocations);
  ops.unshift({ store: 'invoices', action: 'put', data: { ...invoice, ...invoiceCacheFields(after) } });
  return { ok: true, ops, snapshot: after };
}

// Policy checks for saving (create/edit) an invoice form. Returns an error message or null.
export function checkInvoiceSave({ existing, snapshot, newTotal, paidInput, finalStatus, customerId, projectId }) {
  const recorded = snapshot ? snapshot.paid : 0;
  const cancelled = finalStatus === 'cancelled';
  if (existing && paidInput < recorded) return 'مبلغ پرداخت‌شده قبلی قابل کاهش نیست. برای اصلاح از ثبت اصلاحی/برگشت وجه استفاده کنید.';
  if (existing && recorded > 0 && String(existing.customerId ?? '') !== String(customerId ?? '')) return 'مشتری فاکتور پس از ثبت دریافت قابل تغییر نیست. برای اصلاح، فاکتور جدید صادر کنید.';
  if (existing && recorded > 0 && String(existing.projectId ?? '') !== String(projectId ?? '')) return 'پروژه فاکتور پس از ثبت دریافت قابل تغییر نیست.';
  const finalPaid = Math.max(recorded, paidInput);
  if (!cancelled && finalPaid > newTotal) {
    return recorded > newTotal
      ? `مبلغ کل فاکتور از مجموع دریافت‌های ثبت‌شده کمتر می‌شود و این مجاز نیست. مبلغ نهایی نمی‌تواند کمتر از ${Math.round(recorded).toLocaleString('fa-IR')} ریال (دریافتی‌ها) باشد. برای اصلاح، فاکتور را لغو کنید (دریافتی‌ها به‌عنوان بستانکاری مشتری حفظ می‌شوند).`
      : 'مبلغ پرداختی نمی‌تواند بیشتر از مبلغ کل فاکتور باشد.';
  }
  return null;
}

// ---------- receipts (cash in) : every real receipt exactly once ----------
// An on-account payment that was (partly) allocated is split into one event per allocation + one for the unallocated rest.
// The events always sum to the payment amount, so totals never change because of allocation.
export function receiptEvents(invoices = [], transactions = [], allocations = []) {
  const byId = new Map(invoices.map(i => [String(i.id), i]));
  const events = [];
  transactions.forEach(t => {
    if (t.type !== 'customer_payment' && t.type !== 'income') return;
    if (t.type === 'customer_payment' && (t.invoiceId === null || t.invoiceId === undefined)) {
      const parts = allocations.filter(a => sameId(a.paymentId, t.id) && byId.has(String(a.invoiceId)));
      if (parts.length) {
        let rest = amt(t.amount);
        parts.forEach(a => {
          const iv = byId.get(String(a.invoiceId)); const part = Math.max(0, Math.min(amt(a.amount), rest)); rest -= part;
          events.push({ source: 'allocation', id: `${t.id}#${a.id ?? a.invoiceId}`, kind: 'customer_payment', date: effectiveTimestamp(t), amount: part, customerId: iv.customerId ?? t.customerId ?? null, projectId: iv.projectId ?? t.projectId ?? null, invoiceId: iv.id, cancelledInvoice: iv.status === 'cancelled', description: t.description || '' });
        });
        if (rest > 0) events.push({ source: 'transaction', id: t.id, kind: t.type, date: effectiveTimestamp(t), amount: rest, customerId: t.customerId ?? null, projectId: t.projectId ?? null, invoiceId: null, cancelledInvoice: false, description: t.description || '' });
        return;
      }
    }
    const inv = t.type === 'customer_payment' && t.invoiceId != null ? byId.get(String(t.invoiceId)) : null;
    events.push({
      source: 'transaction', id: t.id, kind: t.type, date: effectiveTimestamp(t), amount: amt(t.amount),
      customerId: inv ? (inv.customerId ?? null) : (t.customerId ?? null),
      projectId: inv ? (inv.projectId ?? t.projectId ?? null) : (t.projectId ?? null),
      invoiceId: inv ? inv.id : null, cancelledInvoice: !!inv && inv.status === 'cancelled',
      description: t.description || ''
    });
  });
  invoices.forEach(i => {
    if (linkedPayments(i.id, transactions).length || invoiceAllocations(i.id, transactions, allocations).length) return; // real payments exist -> legacy cache is NOT counted
    const legacy = Math.max(0, amt(i.paidAmount));
    if (legacy > 0) events.push({
      source: 'legacy', id: `legacy-${i.id}`, kind: 'customer_payment', date: effectiveTimestamp(i), amount: legacy,
      customerId: i.customerId ?? null, projectId: i.projectId ?? null, invoiceId: i.id, cancelledInvoice: i.status === 'cancelled',
      description: `دریافت فاکتور ${i.number}`
    });
  });
  return events;
}
// Money handed back to customers. Each refund exactly once; customer/project come from the refunded invoice when there is one.
export function refundEvents(invoices = [], transactions = []) {
  const byId = new Map(invoices.map(i => [String(i.id), i]));
  return transactions.filter(t => t.type === 'customer_refund').map(t => {
    const inv = t.invoiceId != null ? byId.get(String(t.invoiceId)) : null;
    return { source: 'transaction', id: t.id, kind: 'customer_refund', date: effectiveTimestamp(t), amount: amt(t.amount),
      customerId: inv ? (inv.customerId ?? t.customerId ?? null) : (t.customerId ?? null),
      projectId: inv ? (inv.projectId ?? t.projectId ?? null) : (t.projectId ?? null),
      invoiceId: inv ? inv.id : null, cancelledInvoice: !!inv && inv.status === 'cancelled', description: t.description || '' };
  });
}
// Gross receipts (Phase 1 meaning, unchanged), refunds, and net.
export const customerReceiptTotal = (invoices, transactions, allocations = []) => receiptEvents(invoices, transactions, allocations).filter(e => e.kind === 'customer_payment').reduce((s, e) => s + e.amount, 0);
export const customerRefundTotal = (invoices, transactions) => refundEvents(invoices, transactions).reduce((s, e) => s + e.amount, 0);

export function financialSummary(invoices = [], transactions = [], allocations = []) {
  return {
    sales: invoices.filter(i => i.status !== 'cancelled').reduce((s, i) => s + amt(i.total), 0),
    // `received` is NET of refunds (identical to Phase 1 whenever there are no refunds)
    received: customerReceiptTotal(invoices, transactions, allocations) - customerRefundTotal(invoices, transactions)
  };
}
export function financialSummaryDetailed(invoices = [], transactions = [], allocations = []) {
  const grossReceived = customerReceiptTotal(invoices, transactions, allocations), refunded = customerRefundTotal(invoices, transactions);
  return { sales: financialSummary(invoices, transactions, allocations).sales, grossReceived, refunded, received: grossReceived - refunded };
}

// ---------- customer ledger ----------
export function buildCustomerLedger(invoices = [], transactions = [], customerId, allocations = []) {
  const cid = String(customerId);
  const byId = new Map(invoices.map(i => [String(i.id), i]));
  const pays = transactions.filter(t => t.type === 'customer_payment');
  const mine = invoices.filter(i => String(i.customerId) === cid);
  const live = mine.filter(i => i.status !== 'cancelled');
  const ledger = [];
  live.forEach(i => ledger.push({ date: effectiveTimestamp(i), desc: `فاکتور ${i.number}`, debit: amt(i.total), credit: 0, ref: i.id, kind: 'invoice' }));
  mine.forEach(i => {
    const suffix = i.status === 'cancelled' ? ' (فاکتور لغو شده)' : '';
    const linked = linkedPayments(i.id, transactions);
    if (linked.length) {
      linked.forEach(t => ledger.push({ date: effectiveTimestamp(t) || effectiveTimestamp(i), desc: (t.description || `دریافت فاکتور ${i.number}`) + suffix, debit: 0, credit: amt(t.amount), ref: t.id, invoiceId: i.id, kind: 'payment' }));
    } else if (amt(i.paidAmount) > 0 && !invoiceAllocations(i.id, transactions, allocations).length) {
      ledger.push({ date: effectiveTimestamp(i), desc: `دریافت فاکتور ${i.number}${suffix}`, debit: 0, credit: amt(i.paidAmount), ref: i.id, invoiceId: i.id, kind: 'payment', legacy: true });
    }
  });
  // on-account payments: no invoice, or the linked invoice no longer exists. Allocation does NOT add rows: the payment is one credit.
  pays.filter(t => String(t.customerId) === cid && !(t.invoiceId != null && byId.has(String(t.invoiceId))))
    .forEach(t => ledger.push({ date: effectiveTimestamp(t), desc: t.description || 'دریافت وجه', debit: 0, credit: amt(t.amount), ref: t.id, kind: 'payment', allocated: allocations.filter(a => sameId(a.paymentId, t.id)).reduce((s, a) => s + amt(a.amount), 0) }));
  // refunds: cash back to the customer = debit (explicit row; the original payment row stays)
  const myRefunds = transactions.filter(t => t.type === 'customer_refund' && (String(t.customerId) === cid || (t.invoiceId != null && byId.get(String(t.invoiceId)) && String(byId.get(String(t.invoiceId)).customerId) === cid)));
  myRefunds.forEach(t => ledger.push({ date: effectiveTimestamp(t), desc: t.description || 'برگشت وجه به مشتری', debit: amt(t.amount), credit: 0, ref: t.id, invoiceId: t.invoiceId ?? null, kind: 'refund' }));
  ledger.sort((a, b) => (a.date || 0) - (b.date || 0) || String(a.kind).localeCompare(String(b.kind)));
  let running = 0; ledger.forEach(r => { running += r.debit - r.credit; r.balance = running; });
  const total = live.reduce((s, i) => s + amt(i.total), 0);
  const paid = ledger.reduce((s, r) => s + r.credit, 0);
  const refunded = myRefunds.reduce((s, t) => s + amt(t.amount), 0);
  return { invoices: live, transactions: pays.filter(t => String(t.customerId) === cid), ledger, total, paid, refunded, balance: total - paid + refunded };
}
export const totalReceivables = (customers = [], invoices = [], transactions = [], allocations = []) =>
  customers.reduce((sum, c) => sum + Math.max(0, buildCustomerLedger(invoices, transactions, c.id, allocations).balance), 0);
// Credit the customer holds with us (cash beyond what live invoices need).
export const customerCredit = ledger => Math.max(0, -amt(ledger?.balance));

// ---------- payment allocation ----------
export const paymentAllocatedAmount = (paymentId, allocations = []) => allocations.filter(a => sameId(a.paymentId, paymentId)).reduce((s, a) => s + amt(a.amount), 0);
export const paymentUnallocated = (payment, allocations = []) => Math.max(0, amt(payment?.amount) - paymentAllocatedAmount(payment?.id, allocations));
// Open invoices of a customer (money still due), oldest first. Uses the snapshot rule, never a cached field.
export function openInvoices(invoices = [], transactions = [], allocations = [], customerId) {
  return invoices.filter(i => i.status !== 'cancelled' && i.status !== 'draft' && String(i.customerId) === String(customerId))
    .map(i => ({ invoice: i, snapshot: invoiceSnapshot(i, transactions, allocations) })).filter(x => x.snapshot.remaining > 0)
    .sort((a, b) => (effectiveTimestamp(a.invoice) || 0) - (effectiveTimestamp(b.invoice) || 0) || (Number(a.invoice.id) || 0) - (Number(b.invoice.id) || 0));
}
const isISO = v => isValidISODate(v);
// Validate + build the allocation rows and the invoice cache updates. `payment` may be a real row or a {id:'NEW'} placeholder.
function allocationPlan({ payment, parts, invoices, transactions, allocations, date, key, customerName }) {
  const merged = new Map();
  for (const p of parts || []) {
    const v = Math.round(amt(p.amount));
    if (!(v > 0)) return { ok: false, error: 'مبلغ تخصیص باید بیشتر از صفر باشد.' };
    merged.set(String(p.invoiceId), (merged.get(String(p.invoiceId)) || 0) + v);
  }
  if (!merged.size) return { ok: false, error: 'هیچ فاکتوری برای تخصیص انتخاب نشده است.' };
  const total = [...merged.values()].reduce((s, v) => s + v, 0);
  const free = payment.id === 'NEW' ? Math.round(amt(payment.amount)) : paymentUnallocated(payment, allocations);
  if (total > free) return { ok: false, error: 'مجموع تخصیص از مبلغ قابل تخصیص دریافت بیشتر است.' };
  const ops = [], newAllocs = [];
  for (const [iid, v] of merged) {
    const inv = invoices.find(i => String(i.id) === iid);
    if (!inv) return { ok: false, error: 'فاکتور انتخاب‌شده وجود ندارد.' };
    if (payment.customerId != null && String(inv.customerId ?? '') !== String(payment.customerId)) return { ok: false, error: `فاکتور ${inv.number} متعلق به این مشتری نیست.` };
    if (inv.status === 'cancelled') return { ok: false, error: `فاکتور ${inv.number} لغو شده است و تخصیص نمی‌گیرد.` };
    if (inv.status === 'draft') return { ok: false, error: `فاکتور ${inv.number} پیش‌نویس است و تخصیص نمی‌گیرد.` };
    const snap = invoiceSnapshot(inv, transactions, allocations);
    if (v > snap.remaining) return { ok: false, error: `مبلغ تخصیص به فاکتور ${inv.number} از مانده آن بیشتر است.` };
    newAllocs.push({ invoiceId: inv.id, amount: v, inv, snap });
  }
  const dup = key && allocations.some(a => String(a.key || '').startsWith(`${key}:`));
  if (dup) return { ok: true, duplicate: true, ops: [], snapshots: [] };
  const snapshots = [];
  newAllocs.forEach(({ invoiceId, amount, inv, snap }) => {
    const extra = [];
    if (snap.linkedCount === 0 && snap.legacyPaid > 0) { const m = legacyMigrationTx(inv, customerName); extra.push({ store: 'transactions', action: 'add', data: m }); }
    const afterTx = [...transactions, ...extra.map(o => o.data)];
    const afterAlloc = [...allocations, { paymentId: payment.id, invoiceId, amount }];
    // the synthetic NEW payment must count as an on-account payment for the snapshot
    const afterTx2 = payment.id === 'NEW' ? [...afterTx, { id: 'NEW', type: 'customer_payment', amount: payment.amount, invoiceId: null, customerId: payment.customerId }] : afterTx;
    const after = invoiceSnapshot(inv, afterTx2, afterAlloc);
    snapshots.push(after);
    ops.push(...extra);
    ops.push({ store: 'paymentAllocations', action: 'add', data: { paymentId: payment.id === 'NEW' ? null : payment.id, invoiceId, amount, date, key: `${key}:${invoiceId}` }, ...(payment.id === 'NEW' ? { bind: { paymentId: 'pay' } } : {}) });
    ops.push({ store: 'invoices', action: 'put', data: { ...inv, ...invoiceCacheFields(after) } });
  });
  return { ok: true, ops, snapshots, allocated: total };
}
// Allocate (part of) an EXISTING on-account payment to invoices.
export function planPaymentAllocation({ payment, parts, invoices = [], transactions = [], allocations = [], date, key, customerName }) {
  if (!payment || payment.type !== 'customer_payment') return { ok: false, error: 'دریافت انتخاب‌شده معتبر نیست.' };
  if (payment.invoiceId !== null && payment.invoiceId !== undefined) return { ok: false, error: 'این دریافت به یک فاکتور مشخص متصل است و دوباره تخصیص نمی‌یابد.' };
  if (!isISO(date)) return { ok: false, error: 'تاریخ معتبر نیست.' };
  if (!key) return { ok: false, error: 'شناسه یکتای ثبت مشخص نیست.' };
  return allocationPlan({ payment, parts, invoices, transactions, allocations, date, key, customerName });
}
// Receive money from a customer. mode: 'account' (pay down balance, Phase 1 rule: ≤ balance) | 'advance' (explicit credit, no cap)
//   | 'invoice' (one invoice, linked) | 'multi' (parts across invoices; the unallocated remainder stays on-account credit).
export function planReceivePayment({ mode, customerId, customerName = '', amount, date, description = '', invoiceId = null, parts = [], invoices = [], transactions = [], allocations = [], key }) {
  const value = Math.round(amt(amount));
  if (!(value > 0)) return { ok: false, error: 'مبلغ دریافت باید بیشتر از صفر باشد.' };
  if (!isISO(date)) return { ok: false, error: 'تاریخ دریافت معتبر نیست.' };
  if (!key) return { ok: false, error: 'شناسه یکتای ثبت مشخص نیست.' };
  if (key && transactions.some(t => t.type === 'customer_payment' && t.receiptKey === key)) return { ok: true, duplicate: true, ops: [] };
  if (customerId === null || customerId === undefined || customerId === '') return { ok: false, error: 'مشتری مشخص نیست.' };
  const base = { type: 'customer_payment', amount: value, customerId: Number(customerId), invoiceId: null, party: customerName, description: description || 'دریافت وجه', date, receiptKey: key };
  if (mode === 'invoice') {
    const invoice = invoices.find(i => String(i.id) === String(invoiceId));
    if (!invoice) return { ok: false, error: 'فاکتور انتخاب‌شده وجود ندارد.' };
    if (String(invoice.customerId ?? '') !== String(customerId)) return { ok: false, error: 'فاکتور متعلق به این مشتری نیست.' };
    const plan = planInvoicePayment({ invoice, transactions, allocations, amount: value, date, description: description || undefined, customerName });
    if (!plan.ok) return plan;
    plan.ops.forEach(o => { if (o.store === 'transactions' && o.data.invoiceId === invoice.id && o.data.description !== 'انتقال خودکار پرداخت قبلی') o.data.receiptKey = key; });
    return plan;
  }
  if (mode === 'account') {
    const bal = buildCustomerLedger(invoices, transactions, customerId, allocations).balance;
    if (value > Math.max(0, bal)) return { ok: false, error: 'مبلغ دریافت از مانده حساب بیشتر است.' };
    return { ok: true, ops: [{ store: 'transactions', action: 'add', data: base }] };
  }
  if (mode === 'advance') return { ok: true, ops: [{ store: 'transactions', action: 'add', data: { ...base, description: description || 'پیش‌دریافت' } }] };
  if (mode === 'multi') {
    const plan = allocationPlan({ payment: { id: 'NEW', amount: value, customerId: Number(customerId) }, parts, invoices, transactions, allocations, date, key, customerName });
    if (!plan.ok) return plan;
    return { ...plan, ops: [{ store: 'transactions', action: 'add', data: base, bindKey: 'pay' }, ...plan.ops], remainder: value - plan.allocated };
  }
  return { ok: false, error: 'نوع دریافت نامعتبر است.' };
}

// ---------- refunds ----------
export function planRefund({ invoice = null, customerId = null, customerName = '', invoices = [], transactions = [], allocations = [], amount, date, description = '', refundKey }) {
  const value = Math.round(amt(amount));
  if (!(value > 0)) return { ok: false, error: 'مبلغ برگشت وجه باید بیشتر از صفر باشد.' };
  if (!isISO(date)) return { ok: false, error: 'تاریخ برگشت وجه معتبر نیست.' };
  if (!refundKey) return { ok: false, error: 'شناسه یکتای ثبت مشخص نیست.' };
  if (transactions.some(t => t.type === 'customer_refund' && t.refundKey === refundKey)) return { ok: true, duplicate: true, ops: [] };
  const cid = invoice ? (invoice.customerId ?? null) : customerId;
  const ledger = cid != null ? buildCustomerLedger(invoices, transactions, cid, allocations) : null;
  const netCash = ledger ? ledger.paid - ledger.refunded : Infinity;
  const refundTx = { type: 'customer_refund', amount: value, customerId: cid, invoiceId: invoice ? invoice.id : null, party: customerName || invoice?.customerName || '', description: description || (invoice ? `برگشت وجه فاکتور ${invoice.number}` : 'برگشت وجه به مشتری'), projectId: invoice?.projectId ?? null, date, refundKey };
  if (invoice) {
    const snap = invoiceSnapshot(invoice, transactions, allocations);
    if (value > snap.paid) return { ok: false, error: 'مبلغ برگشت وجه از دریافتی خالص این فاکتور بیشتر است.' };
    if (value > netCash) return { ok: false, error: 'مبلغ برگشت وجه از وجه نقد باقی‌مانده مشتری بیشتر است.' };
    const ops = [];
    if (snap.linkedCount === 0 && snap.legacyPaid > 0) ops.push({ store: 'transactions', action: 'add', data: legacyMigrationTx(invoice, customerName) });
    ops.push({ store: 'transactions', action: 'add', data: refundTx });
    const after = invoiceSnapshot(invoice, [...transactions, ...ops.map(o => o.data)], allocations);
    ops.unshift({ store: 'invoices', action: 'put', data: { ...invoice, ...invoiceCacheFields(after) } });
    return { ok: true, ops, snapshot: after };
  }
  if (cid === null || cid === undefined || cid === '') return { ok: false, error: 'برای برگشت وجه بدون فاکتور، مشتری الزامی است.' };
  const credit = customerCredit(ledger);
  if (value > credit) return { ok: false, error: 'مبلغ برگشت وجه از بستانکاری مشتری بیشتر است.' };
  if (value > netCash) return { ok: false, error: 'مبلغ برگشت وجه از وجه نقد باقی‌مانده مشتری بیشتر است.' };
  return { ok: true, ops: [{ store: 'transactions', action: 'add', data: { ...refundTx, customerId: Number(cid) } }] };
}

// ---------- projects ----------
export function projectFinancials(project, invoices = [], transactions = [], movements = [], allocations = []) {
  const pid = String(project.id);
  const live = invoices.filter(i => String(i.projectId) === pid && i.status !== 'cancelled');
  const billed = live.reduce((s, i) => s + amt(i.total), 0);
  const receipts = receiptEvents(invoices, transactions, allocations).filter(e => e.kind === 'customer_payment' && e.projectId != null && String(e.projectId) === pid);
  const refundsP = refundEvents(invoices, transactions).filter(e => e.projectId != null && String(e.projectId) === pid);
  const grossReceived = receipts.reduce((s, e) => s + e.amount, 0);
  const refunded = refundsP.reduce((s, e) => s + e.amount, 0);
  const received = grossReceived - refunded;
  const heldOnCancelled = receipts.filter(e => e.cancelledInvoice).reduce((s, e) => s + e.amount, 0) - refundsP.filter(e => e.cancelledInvoice).reduce((s, e) => s + e.amount, 0);
  const txCosts = transactions.filter(t => isExpenseType(t.type) && t.projectId != null && String(t.projectId) === pid).reduce((s, t) => s + amt(t.amount), 0);
  const manualCost = amt(project.cost);                      // legacy / manual / opening cost typed on the project form
  const inventoryCost = projectInventoryCost(project.id, movements);
  const costs = txCosts + manualCost + inventoryCost;
  return {
    billed, received, grossReceived, refunded, costs, txCosts, manualCost, legacyCost: manualCost, inventoryCost, budget: amt(project.budget),
    invoiceCount: live.length, expenseCount: transactions.filter(t => isExpenseType(t.type) && t.projectId != null && String(t.projectId) === pid).length,
    receivable: Math.max(0, billed - (received - heldOnCancelled)),
    profit: billed - costs
  };
}

// ---------- entity usage (delete / archive decisions) ----------
export function entityUsage(kind, id, { invoices = [], transactions = [], projects = [], movements = [] } = {}) {
  const sid = String(id);
  const u = { invoices: 0, transactions: 0, projects: 0, items: 0, movements: 0 };
  if (kind === 'customer') {
    u.invoices = invoices.filter(i => i.customerId != null && String(i.customerId) === sid).length;
    u.transactions = transactions.filter(t => t.customerId != null && String(t.customerId) === sid).length;
    u.projects = projects.filter(p => p.customerId != null && String(p.customerId) === sid).length;
  } else if (kind === 'project') {
    u.invoices = invoices.filter(i => i.projectId != null && String(i.projectId) === sid).length;
    u.transactions = transactions.filter(t => t.projectId != null && String(t.projectId) === sid).length;
    u.movements = movements.filter(m => m.projectId != null && String(m.projectId) === sid).length;
  } else if (kind === 'product' || kind === 'service') {
    u.items = invoices.filter(i => (i.items || []).some(it => it.itemId != null && String(it.itemId) === sid && (it.type === kind || !it.type))).length;
    if (kind === 'product') u.movements = movements.filter(m => String(m.productId) === sid).length;
  }
  u.total = u.invoices + u.transactions + u.projects + u.items + u.movements;
  return u;
}
export const isArchived = r => r?.archived === true;
