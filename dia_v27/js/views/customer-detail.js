import { DB } from '../db.js';
import { money, num, dateFa, esc, printWithClass, faLabel, INVOICE_STATUS_LABELS, INVOICE_STATUS_BADGE, icon, buildCustomerLedger, toast, guardSubmit, showValidationErrors } from '../utils.js';
import { openInvoices, invoiceSnapshot, customerCredit, paymentUnallocated } from '../finance.js';
import { openReceivePaymentModal, openAllocateCreditModal, openRefundModal } from './payment-modal.js';
import { openModal, closeModal } from '../components.js';
import { navigate } from '../router.js';
import { pageHeader, emptyState } from '../components.js';

export async function renderCustomerDetail(App, params) {
  const id=Number(params.id);
  const [customer,invoices,transactions,allocations,projects]=await Promise.all([DB.get('customers',id),DB.all('invoices'),DB.all('transactions'),DB.all('paymentAllocations'),DB.all('projects')]);
  if(!customer){App.setView(`${emptyState('مشتری پیدا نشد','این مشتری وجود ندارد.')}<button class="btn btn-secondary" data-route="#/customers">بازگشت</button>`);return;}
  const account=buildCustomerLedger(invoices,transactions,id,allocations);
  const openList=openInvoices(invoices,transactions,allocations,id);
  const credit=customerCredit(account);
  const unallocated=transactions.filter(t=>t.type==='customer_payment'&&t.invoiceId==null&&String(t.customerId)===String(id)).reduce((s,t)=>s+paymentUnallocated(t,allocations),0);
  const showOpen=params.query?.get('open')==='1';
  const custInvoices=account.invoices;
  const ledger=account.ledger;
  const custProjects=projects.filter(p=>String(p.customerId)===String(id));
  const total=account.total,paid=account.paid,balance=account.balance;
  App.setView(`${pageHeader(customer.name,{back:true,action:'فاکتور جدید',actionId:'new-customer-invoice',subtitle:customer.mobile||customer.customerCode||''})}
    <div class="client-hero card card-pad"><div class="client-avatar">${esc((customer.name||'?').trim().charAt(0))}</div><div><strong>${esc(customer.name)}</strong><div class="list-sub">${esc(customer.companyName||'مشتری')} ${customer.mobile?' · '+esc(customer.mobile):''}</div></div></div>
    <div class="stats-grid client-kpis"><div class="card stat"><div class="stat-label">جمع فاکتورها</div><div class="stat-value">${money(total)}</div></div><div class="card stat"><div class="stat-label">دریافت‌شده</div><div class="stat-value green">${money(paid)}</div></div><div class="card stat"><div class="stat-label">مانده حساب</div><div class="stat-value ${balance>=0?'red':'green'}">${money(Math.abs(balance))}</div><div class="stat-meta">${balance>=0?'بدهکار':'بستانکار'}</div></div></div>
    <div class="quick-grid customer-quick"><button class="quick" id="qa-invoice"><span class="qicon">${icon('file-plus','')}</span><small>فاکتور جدید</small></button><button class="quick" id="add-payment"><span class="qicon">${icon('wallet','')}</span><small>ثبت دریافت</small></button><button class="quick" id="print-statement"><span class="qicon">${icon('printer','')}</span><small>صورتحساب</small></button><button class="quick" id="qa-open"><span class="qicon">${icon('file-text','')}</span><small>${showOpen?'همه فاکتورها':`فاکتورهای باز (${num(openList.length)})`}</small></button></div>
    ${credit>0?`<div class="btn-row mt-3"><span class="badge badge-paid">بستانکاری: ${money(credit)}</span>${unallocated>0&&openList.length?`<button class="btn btn-secondary" id="allocate-credit">تخصیص بستانکاری به فاکتور</button>`:''}<button class="btn btn-ghost" id="refund-customer">${icon('wallet','')}برگشت وجه</button></div>`:''}
    <div class="section-title-row"><div class="section-title-compact">${showOpen?'فاکتورهای باز':'فاکتورهای مشتری'}</div></div>
    <div id="statement" class="statement-page"><div class="client-invoice-list">${(showOpen?openList.map(x=>x.invoice):custInvoices).length?(showOpen?openList.map(x=>x.invoice):custInvoices).map(i=>`<button class="client-invoice-card" data-invoice="${i.id}"><span class="statement-icon">${icon('file-text','')}</span><span><strong>فاکتور ${esc(i.number)}</strong><small>${dateFa(i.date||i.createdAt)} · ${faLabel(INVOICE_STATUS_LABELS,i.status)}</small></span><b>${money(i.total)}${showOpen?`<small class="stat-meta"> مانده ${money(invoiceSnapshot(i,transactions,allocations).remaining)}</small>`:''}</b></button>`).join(''):emptyState(showOpen?'فاکتور بازی وجود ندارد':'فاکتوری ندارد','هنوز فاکتوری برای این مشتری ثبت نشده است.','فاکتور جدید','empty-invoice')}</div>
    <div class="section-title-row"><div class="section-title-compact">پروژه‌های مشتری</div><span class="badge badge-muted">${num(custProjects.length)}</span></div><div class="report-list customer-projects">${custProjects.map(p=>`<button class="report-row report-row-button" data-project="${p.id}"><span class="report-row-icon">${icon('folder','')}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.status||'فعال')}${p.startDate?' · شروع '+dateFa(p.startDate):''}</small></span><b>${p.budget?money(p.budget):'—'}</b></button>`).join('')||'<div class="empty">پروژه‌ای برای این مشتری ثبت نشده است.</div>'}</div><div class="section-title-row"><div class="section-title-compact">گردش حساب</div><span class="badge badge-${balance>0?'unpaid':'paid'}">${balance>0?'مانده بدهی':'تسویه'}</span></div>
    <div class="ledger-list">${ledger.length?ledger.map(r=>`<article class="ledger-card"><div class="ledger-top"><span class="ledger-kind ${r.kind==='invoice'||r.kind==='refund'?'debit':'credit'}">${icon(r.kind==='invoice'?'file-text':'wallet','')} ${r.kind==='invoice'?'فاکتور':r.kind==='refund'?'برگشت وجه':'دریافت'}</span><time>${dateFa(r.date)}</time></div><div class="ledger-body"><strong>${esc(r.desc)}</strong><span class="ledger-amount ${r.debit?'red':'green'}">${r.debit?money(r.debit):money(r.credit)}</span></div><div class="ledger-bottom"><span>مانده</span><b class="${r.balance>=0?'red':'green'}">${money(Math.abs(r.balance))} ${r.balance>=0?'بدهکار':'بستانکار'}</b></div></article>`).join(''):'<div class="empty">گردش حسابی ثبت نشده است.</div>'}</div></div>`);
  document.querySelector('[data-back]')?.addEventListener('click',()=>history.length>1?history.back():navigate('#/customers'));
  document.getElementById('new-customer-invoice').onclick=()=>navigate('#/invoices/new/'+id);
  document.getElementById('empty-invoice')?.addEventListener('click',()=>navigate('#/invoices/new/'+id));
  document.getElementById('print-statement').onclick=()=>printWithClass('printing-statement');
  // one shared workflow (finance.js rules): pay down the account, one invoice, several invoices, or advance credit
  const refresh=()=>renderCustomerDetail(App,params);
  document.getElementById('add-payment')?.addEventListener('click',()=>openReceivePaymentModal({customerId:id,onDone:refresh}));
  document.getElementById('qa-invoice').onclick=()=>navigate('#/invoices/new/'+id);
  document.getElementById('qa-open').onclick=()=>navigate(showOpen?'#/customers/'+id:'#/customers/'+id+'?open=1');
  document.getElementById('allocate-credit')?.addEventListener('click',()=>openAllocateCreditModal({customerId:id,onDone:refresh}));
  document.getElementById('refund-customer')?.addEventListener('click',()=>openRefundModal({customerId:id,onDone:refresh}));
  document.querySelectorAll('[data-invoice]').forEach(b=>b.onclick=()=>navigate('#/invoices/'+b.dataset.invoice));
  document.querySelectorAll('[data-project]').forEach(b=>b.onclick=()=>navigate('#/projects/'+b.dataset.project));
  document.querySelectorAll('[data-route]').forEach(b=>b.onclick=e=>{e.preventDefault();navigate(b.dataset.route)});
}
