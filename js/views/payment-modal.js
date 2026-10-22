// Shared money-in workflows (receive payment, allocate credit, refund). UI orchestration only:
// every rule (caps, allocation, legacy migration, idempotency, cache update) lives in finance.js.
import { DB } from '../db.js';
import { money, esc, toast, icon, guardSubmit, showValidationErrors, todayISO, newToken, dateFa } from '../utils.js';
import { validateAmount, toMoney } from '../validators.js';
import { buildCustomerLedger, openInvoices, invoiceSnapshot, planReceivePayment, planPaymentAllocation, planRefund, paymentUnallocated, customerCredit } from '../finance.js';
import { openModal, closeModal } from '../components.js';

const loadAll = async () => {
  const [customers, invoices, transactions, allocations] = await Promise.all([DB.all('customers'), DB.all('invoices'), DB.all('transactions'), DB.all('paymentAllocations')]);
  return { customers, invoices, transactions, allocations };
};
const num0 = v => Math.max(0, toMoney(v));

// Receive money from a customer: pay down the account, settle ONE invoice, spread over SEVERAL invoices, or keep it as advance credit.
export async function openReceivePaymentModal({ customerId = null, invoiceId = null, onDone } = {}) {
  const { customers, invoices, transactions, allocations } = await loadAll();
  const token = newToken();
  let cid = customerId != null ? Number(customerId) : null;
  const pickable = customers.filter(c => !c.archived || String(c.id) === String(cid));
  const m = openModal(`<div class="modal-head"><h3>ثبت دریافت</h3><button class="close">${icon('x', '')}</button></div>
    <form id="customer-payment" class="form-grid" novalidate>
      ${cid == null ? `<div class="field full"><label>مشتری</label><select name="customerId"><option value="">انتخاب مشتری</option>${pickable.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field full"><label>مانده حساب</label><input id="pay-balance" value="—" disabled></div>
      <div class="field full"><label>دریافت بابت</label><select name="mode"><option value="account">مانده حساب مشتری</option><option value="invoice">یک فاکتور مشخص</option><option value="multi">چند فاکتور</option><option value="advance">پیش‌دریافت (بستانکاری)</option></select></div>
      <div class="field full" id="invoice-wrap" hidden><label>فاکتور</label><select name="invoiceId"></select></div>
      <div class="field full"><label>مبلغ دریافت</label><input name="amount" type="text" inputmode="decimal" autofocus></div>
      <div class="field full" id="multi-wrap" hidden><label>تخصیص به فاکتورها</label><div id="multi-list"></div><small class="field-hint" id="multi-hint"></small><button type="button" class="btn btn-secondary mt-3" id="auto-split">تقسیم خودکار (قدیمی‌ترین اول)</button></div>
      <div class="field full"><label>شرح</label><input name="description" placeholder="مثلاً دریافت بابت حساب"></div>
      <div class="field full"><button class="btn btn-primary btn-block">${icon('check', '')}ثبت دریافت</button></div>
    </form>`);
  const f = m.querySelector('#customer-payment');
  m.querySelector('.close').onclick = closeModal;
  const cust = () => customers.find(c => String(c.id) === String(cid));
  const open = () => cid == null ? [] : openInvoices(invoices, transactions, allocations, cid);
  const refreshCustomer = () => {
    if (cid == null) { m.querySelector('#pay-balance').value = '—'; return; }
    const bal = buildCustomerLedger(invoices, transactions, cid, allocations).balance;
    m.querySelector('#pay-balance').value = bal >= 0 ? money(bal) : `${money(-bal)} (بستانکار)`;
    const list = open();
    f.invoiceId.innerHTML = list.map(x => `<option value="${x.invoice.id}">فاکتور ${esc(x.invoice.number)} — مانده ${money(x.snapshot.remaining)}</option>`).join('') || '<option value="">فاکتور بازی وجود ندارد</option>';
    if (invoiceId != null && list.some(x => String(x.invoice.id) === String(invoiceId))) f.invoiceId.value = String(invoiceId);
    m.querySelector('#multi-list').innerHTML = list.map(x => `<div class="field"><label>فاکتور ${esc(x.invoice.number)} · مانده ${money(x.snapshot.remaining)}</label><input class="alloc-input" data-invoice="${x.invoice.id}" data-max="${x.snapshot.remaining}" type="text" inputmode="decimal" value="0"></div>`).join('') || '<div class="hint">فاکتور بازی وجود ندارد.</div>';
    m.querySelectorAll('.alloc-input').forEach(i => i.addEventListener('input', hint));
    hint();
  };
  const hint = () => {
    const sum = [...m.querySelectorAll('.alloc-input')].reduce((s, i) => s + num0(i.value), 0), total = num0(f.amount.value);
    m.querySelector('#multi-hint').textContent = `تخصیص‌یافته: ${money(sum)}${total ? ` — باقی‌مانده به‌عنوان بستانکاری: ${money(Math.max(0, total - sum))}` : ''}`;
  };
  const syncMode = () => {
    const mode = f.mode.value;
    m.querySelector('#invoice-wrap').hidden = mode !== 'invoice';
    m.querySelector('#multi-wrap').hidden = mode !== 'multi';
    if (mode === 'invoice' && !f.amount.value) { const x = open().find(y => String(y.invoice.id) === String(f.invoiceId.value)); if (x) f.amount.value = String(x.snapshot.remaining); }
  };
  f.mode.onchange = syncMode; f.invoiceId.onchange = () => { f.amount.value = ''; syncMode(); }; f.amount.addEventListener('input', hint);
  if (f.customerId) f.customerId.onchange = () => { cid = f.customerId.value ? Number(f.customerId.value) : null; refreshCustomer(); };
  m.querySelector('#auto-split').onclick = () => {
    let left = num0(f.amount.value);
    m.querySelectorAll('.alloc-input').forEach(i => { const v = Math.min(left, Number(i.dataset.max)); i.value = String(v); left -= v; });
    hint();
  };
  refreshCustomer();
  if (cid != null) {
    const bal = buildCustomerLedger(invoices, transactions, cid, allocations).balance;
    f.mode.value = invoiceId != null ? 'invoice' : (bal > 0 ? 'account' : 'advance');
    syncMode();
  }
  f.onsubmit = guardSubmit(async () => {
    if (cid == null) { toast('مشتری را انتخاب کنید.', 'error'); return; }
    const mode = f.mode.value;
    const parts = [...m.querySelectorAll('.alloc-input')].map(i => ({ invoiceId: Number(i.dataset.invoice), amount: num0(i.value) })).filter(p => p.amount > 0);
    if (mode === 'multi' && !f.amount.value.trim() && parts.length) f.amount.value = String(parts.reduce((s, p) => s + p.amount, 0));
    if (showValidationErrors(f, validateAmount(f.amount.value, 'amount', { required: true, allowZero: false, allowDecimal: false }))) return;
    // always re-read: another tab / a previous tap may have changed the books since the modal opened
    const fresh = await loadAll();
    const plan = planReceivePayment({ mode, customerId: cid, customerName: cust()?.name || '', amount: toMoney(f.amount.value), date: todayISO(), description: f.description.value.trim(), invoiceId: mode === 'invoice' ? Number(f.invoiceId.value) : null, parts, invoices: fresh.invoices, transactions: fresh.transactions, allocations: fresh.allocations, key: token });
    if (!plan.ok) { toast(plan.error, 'error'); return; }
    if (!plan.duplicate) await DB.atomic(plan.ops);
    closeModal(); toast('دریافت ثبت شد'); onDone?.();
  });
  return m;
}

// Allocate an EXISTING on-account payment (customer credit) to open invoices.
export async function openAllocateCreditModal({ customerId, onDone } = {}) {
  const { invoices, transactions, allocations } = await loadAll();
  const credits = transactions.filter(t => t.type === 'customer_payment' && (t.invoiceId === null || t.invoiceId === undefined) && String(t.customerId) === String(customerId) && paymentUnallocated(t, allocations) > 0);
  const open = openInvoices(invoices, transactions, allocations, customerId);
  if (!credits.length) { toast('بستانکاری تخصیص‌نیافته‌ای وجود ندارد.', 'error'); return; }
  if (!open.length) { toast('فاکتور بازی برای تخصیص وجود ندارد.', 'error'); return; }
  const token = newToken();
  const m = openModal(`<div class="modal-head"><h3>تخصیص بستانکاری به فاکتور</h3><button class="close">${icon('x', '')}</button></div>
    <form id="allocate-form" class="form-grid" novalidate>
      <div class="field full"><label>دریافت</label><select name="paymentId">${credits.map(t => `<option value="${t.id}">${dateFa(t.date || t.createdAt)} · ${esc(t.description || 'دریافت وجه')} · قابل تخصیص ${money(paymentUnallocated(t, allocations))}</option>`).join('')}</select></div>
      <div class="field full">${open.map(x => `<div class="field"><label>فاکتور ${esc(x.invoice.number)} · مانده ${money(x.snapshot.remaining)}</label><input class="alloc-input" data-invoice="${x.invoice.id}" type="text" inputmode="decimal" value="0"></div>`).join('')}</div>
      <div class="field full"><button class="btn btn-primary btn-block">${icon('check', '')}ثبت تخصیص</button></div>
    </form>`);
  const f = m.querySelector('#allocate-form');
  m.querySelector('.close').onclick = closeModal;
  f.onsubmit = guardSubmit(async () => {
    const fresh = await loadAll();
    const payment = fresh.transactions.find(t => String(t.id) === String(f.paymentId.value));
    const parts = [...m.querySelectorAll('.alloc-input')].map(i => ({ invoiceId: Number(i.dataset.invoice), amount: num0(i.value) })).filter(p => p.amount > 0);
    const plan = planPaymentAllocation({ payment, parts, invoices: fresh.invoices, transactions: fresh.transactions, allocations: fresh.allocations, date: todayISO(), key: `${token}:${payment?.id}` });
    if (!plan.ok) { toast(plan.error, 'error'); return; }
    if (!plan.duplicate) await DB.atomic(plan.ops);
    closeModal(); toast('تخصیص ثبت شد'); onDone?.();
  });
}

// Refund money to a customer: against one invoice (reduces what that invoice has received) or from the customer's credit.
export async function openRefundModal({ invoiceId = null, customerId = null, onDone } = {}) {
  const { customers, invoices, transactions, allocations } = await loadAll();
  const invoice = invoiceId != null ? invoices.find(i => String(i.id) === String(invoiceId)) : null;
  const cid = invoice ? invoice.customerId : customerId;
  const customer = customers.find(c => String(c.id) === String(cid));
  const limit = invoice ? invoiceSnapshot(invoice, transactions, allocations).paid : customerCredit(buildCustomerLedger(invoices, transactions, cid, allocations));
  if (!(limit > 0)) { toast(invoice ? 'برای این فاکتور مبلغ قابل برگشتی وجود ندارد.' : 'مشتری بستانکاری قابل برگشت ندارد.', 'error'); return; }
  const token = newToken();
  const m = openModal(`<div class="modal-head"><h3>برگشت وجه</h3><button class="close">${icon('x', '')}</button></div>
    <form id="refund-form" class="form-grid" novalidate>
      <div class="field full"><label>${invoice ? `حداکثر قابل برگشت (فاکتور ${esc(invoice.number)})` : 'حداکثر قابل برگشت (بستانکاری مشتری)'}</label><input value="${money(limit)}" disabled></div>
      <div class="field full"><label>مبلغ برگشت وجه</label><input name="amount" type="text" inputmode="decimal" autofocus></div>
      <div class="field"><label>تاریخ</label><input name="date" type="date" value="${todayISO()}"></div>
      <div class="field full"><label>شرح</label><input name="description" placeholder="مثلاً برگشت کالا"></div>
      <div class="field full"><button class="btn btn-primary btn-block">${icon('check', '')}ثبت برگشت وجه</button></div>
    </form>`);
  const f = m.querySelector('#refund-form');
  m.querySelector('.close').onclick = closeModal;
  f.onsubmit = guardSubmit(async () => {
    if (showValidationErrors(f, validateAmount(f.amount.value, 'amount', { required: true, allowZero: false, allowDecimal: false }))) return;
    const fresh = await loadAll();
    const inv = invoice ? fresh.invoices.find(i => String(i.id) === String(invoice.id)) : null;
    const plan = planRefund({ invoice: inv, customerId: cid, customerName: customer?.name || '', invoices: fresh.invoices, transactions: fresh.transactions, allocations: fresh.allocations, amount: toMoney(f.amount.value), date: f.date.value, description: f.description.value.trim(), refundKey: token });
    if (!plan.ok) { toast(plan.error, 'error'); return; }
    if (!plan.duplicate) await DB.atomic(plan.ops);
    closeModal(); toast('برگشت وجه ثبت شد'); onDone?.();
  });
}
