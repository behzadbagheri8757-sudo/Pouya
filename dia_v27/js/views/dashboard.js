import { DB } from '../db.js';
import { money, num, dateFa, esc, INVOICE_STATUS_LABELS, INVOICE_STATUS_BADGE, faLabel, icon, todayISO } from '../utils.js';
import { effectiveTimestamp, isExpenseType, safeAmount, invoiceSnapshot } from '../finance.js';
import { openReceivePaymentModal } from './payment-modal.js';
import { pageHeader } from '../components.js';
import { navigate } from '../router.js';
import { dashboardMetrics, buildActivityFeed } from '../dashboard-metrics.js';

export async function renderDashboard(App) {
  const [invoices, transactions, products, customers, allocations, projects, movements] = await Promise.all([
    DB.all('invoices'), DB.all('transactions'), DB.all('products'), DB.all('customers'), DB.all('paymentAllocations'), DB.all('projects'), DB.all('stockMovements')
  ]);
  const m = dashboardMetrics({ today: todayISO(), invoices, transactions, customers, allocations, products, projects, movements });
  const valid = invoices.filter(i => i.status !== 'cancelled');
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const nextMonthStart = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime();
  const inMonth = t => { const ts = effectiveTimestamp(t); return Number.isFinite(ts) && ts >= monthStart && ts < nextMonthStart; };
  const salesMonth = valid.filter(inMonth).reduce((s, i) => s + safeAmount(i.total), 0);
  const receiptsMonth = transactions.filter(t => t.type === 'customer_payment' && inMonth(t)).reduce((s, t) => s + safeAmount(t.amount), 0);
  const refundsMonth = transactions.filter(t => t.type === 'customer_refund' && inMonth(t)).reduce((s, t) => s + safeAmount(t.amount), 0);
  const expensesMonth = transactions.filter(t => isExpenseType(t.type) && inMonth(t)).reduce((s, t) => s + safeAmount(t.amount), 0);
  const latestInvoices = [...valid].sort((a, b) => (effectiveTimestamp(b) || 0) - (effectiveTimestamp(a) || 0)).slice(0, 5);
  const activity = buildActivityFeed({ invoices, transactions, limit: 8 });
  const activityHtml = activity.map(a => {
    const cls = a.kind === 'expense' || a.kind === 'refund' ? 'red' : a.kind === 'receipt' ? 'green' : '';
    const sign = a.kind === 'invoice' ? '' : (a.kind === 'expense' || a.kind === 'refund' ? '− ' : '+ ');
    const target = a.kind === 'invoice' && a.refId ? `data-route="#/invoices/${a.refId}"` : '';
    return `<button class="activity-row" ${target}><span class="activity-icon">${icon(a.kind === 'invoice' ? 'file-text' : a.kind === 'expense' ? 'wallet' : a.kind === 'refund' ? 'arrow-right' : 'wallet','')}</span><span class="activity-main"><strong>${esc(a.title)}</strong><small>${esc(a.detail)}${a.date ? ' · ' + dateFa(a.date) : ''}</small></span><b class="${cls}">${sign}${money(a.amount)}</b></button>`;
  }).join('') || '<div class="empty">هنوز فعالیتی ثبت نشده است.</div>';
  const attention = [
    m.openInvoiceCount ? `<button class="attention-row" data-route="#/reports?type=debtors"><span>${icon('file-text','')}<span><strong>${num(m.openInvoiceCount)} فاکتور باز</strong><small>مجموع مانده ${money(m.openInvoiceAmount)}</small></span></span><b class="red">مشاهده</b></button>` : '',
    m.lowStock.length ? `<button class="attention-row" data-route="#/reports?type=inventory"><span>${icon('box','')}<span><strong>${num(m.lowStock.length)} کالا در حداقل موجودی</strong><small>نیاز به بررسی انبار</small></span></span><b class="red">بررسی</b></button>` : '',
    m.projectAttention.length ? `<button class="attention-row" data-route="#/reports?type=projects"><span>${icon('folder','')}<span><strong>${num(m.projectAttention.length)} پروژه نیازمند پیگیری</strong><small>مانده دریافت یا عبور از بودجه</small></span></span><b class="red">بررسی</b></button>` : ''
  ].filter(Boolean).join('') || '<div class="empty">فعلاً مورد فوری برای پیگیری ندارید.</div>';
  App.setView(`${pageHeader('داشبورد')}
    <div class="dashboard-welcome card card-pad"><div><small>وضعیت کسب‌وکار</small><h2>خلاصه امروز</h2><p>تمرکز روی کارهایی که امروز نیاز به اقدام دارند.</p></div><div class="dashboard-ring">${num(valid.length)}</div></div>
    <div class="stats-grid dashboard-kpis">
      <button class="card stat stat-action" data-dashboard-target="sales"><div class="stat-label">فروش این ماه</div><div class="stat-value">${money(salesMonth)}</div><div class="stat-meta">فروش کل: ${money(m.sales)}</div></button>
      <button class="card stat stat-action" data-dashboard-target="received"><div class="stat-label">دریافت این ماه</div><div class="stat-value green">${money(receiptsMonth - refundsMonth)}</div><div class="stat-meta">خالص کل: ${money(m.received)}</div></button>
      <button class="card stat stat-action" data-dashboard-target="expenses"><div class="stat-label">هزینه این ماه</div><div class="stat-value red">${money(expensesMonth)}</div><div class="stat-meta">هزینه کل: ${money(m.expenses)}</div></button>
      <button class="card stat stat-action" data-dashboard-target="receivables"><div class="stat-label">مطالبات مشتریان</div><div class="stat-value red">${money(Math.max(0, m.receivables))}</div><div class="stat-meta">${num(m.openInvoiceCount)} فاکتور باز</div></button>
    </div>
    <div class="section-title">امروز</div>
    <div class="today-grid">
      <div class="card today-card"><small>دریافت خالص امروز</small><strong class="green">${money(m.todayNetReceived)}</strong><span>دریافت ${money(m.todayReceived)} · برگشت ${money(m.todayRefunded)}</span></div>
      <div class="card today-card"><small>هزینه امروز</small><strong class="red">${money(m.todayExpenses)}</strong><span>خالص نقدی امروز ${money(m.todayNetCash)}</span></div>
    </div>
    <div class="section-title-row"><div class="section-title-compact">نیاز به اقدام</div><button class="btn btn-ghost" data-route="#/reports">همه گزارش‌ها</button></div>
    <div class="attention-list">${attention}</div>
    <div class="section-title">دسترسی سریع</div><div class="quick-grid">${[['#/invoices?new=1','file-plus','فاکتور جدید'],['#/customers?new=1','users','مشتری جدید'],['receive','wallet','ثبت دریافت'],['#/accounting?new=expense','wallet','ثبت هزینه'],['#/products?new=1','box-plus','افزودن کالا'],['#/services?new=1','briefcase','افزودن خدمت']].map(x=>`<button class="quick" ${x[0]==='receive'?'id="qa-receive"':`data-route="${x[0]}"`}><span class="qicon">${icon(x[1],'')}</span><small>${x[2]}</small></button>`).join('')}</div>
    <div class="section-title-row"><div class="section-title-compact">امکانات برنامه</div><span class="section-caption">همه‌چیز یک‌جا</span></div>
    <div class="capability-grid">
      <button class="capability-card" data-route="#/invoices"><span class="capability-icon capability-primary">${icon('file-text','')}</span><span><strong>فاکتورها</strong><small>صدور، دریافت، برگشت و خروجی</small></span><b>›</b></button>
      <button class="capability-card" data-route="#/customers"><span class="capability-icon capability-blue">${icon('users','')}</span><span><strong>مشتریان</strong><small>گردش حساب و پروژه‌های هر مشتری</small></span><b>›</b></button>
      <button class="capability-card" data-route="#/projects"><span class="capability-icon capability-purple">${icon('folder','')}</span><span><strong>پروژه‌ها</strong><small>فروش، هزینه، دریافت و سود پروژه</small></span><b>›</b></button>
      <button class="capability-card" data-route="#/products"><span class="capability-icon capability-orange">${icon('box','')}</span><span><strong>انبار و کالا</strong><small>موجودی و گردش ورود و خروج</small></span><b>›</b></button>
      <button class="capability-card" data-route="#/accounting"><span class="capability-icon capability-green">${icon('wallet','')}</span><span><strong>حسابداری</strong><small>درآمد، هزینه و دریافت‌ها</small></span><b>›</b></button>
      <button class="capability-card" data-route="#/reports"><span class="capability-icon capability-teal">${icon('chart','')}</span><span><strong>گزارش‌ها</strong><small>گزارش مالی، فعالیت و موجودی</small></span><b>›</b></button>
      <button class="capability-card" data-route="#/settings"><span class="capability-icon capability-gray">${icon('settings','')}</span><span><strong>پشتیبان‌گیری</strong><small>خروجی و بازیابی امن اطلاعات</small></span><b>›</b></button>
      <button class="capability-card" data-route="#/services"><span class="capability-icon capability-yellow">${icon('briefcase','')}</span><span><strong>خدمات</strong><small>مدیریت خدمات و قیمت‌ها</small></span><b>›</b></button>
    </div>
    <div class="section-title-row"><div class="section-title-compact">آخرین فاکتورها</div><button class="btn btn-ghost" id="all-invoices">همه</button></div>
    <div class="list dashboard-invoices">${latestInvoices.map(i=>`<button class="dashboard-invoice-card" data-invoice="${i.id}"><span class="invoice-card-icon">${icon('file-text','')}</span><span class="list-main"><strong>فاکتور ${esc(i.number)}</strong><small>${esc(i.customerName||'مشتری آزاد')} · ${dateFa(i.date||i.createdAt)}</small></span><span class="list-value">${money(i.total)}<small class="badge badge-${INVOICE_STATUS_BADGE[i.status]||'muted'}">${faLabel(INVOICE_STATUS_LABELS,i.status)}</small></span></button>`).join('')||'<div class="empty">هنوز فاکتوری ثبت نشده است.</div>'}</div>
    <div class="section-title">آخرین فعالیت‌ها</div><div class="activity-list">${activityHtml}</div>`);
  document.getElementById('all-invoices').onclick = () => navigate('#/invoices');
  document.getElementById('qa-receive').onclick = () => openReceivePaymentModal({ onDone: () => renderDashboard(App) });
  document.querySelectorAll('[data-invoice]').forEach(b => b.onclick = () => navigate('#/invoices/' + b.dataset.invoice));
  document.querySelectorAll('[data-route]').forEach(b => b.onclick = e => { e.preventDefault(); navigate(b.dataset.route); });
  document.querySelectorAll('[data-dashboard-target]').forEach(b => b.onclick = () => navigate({sales:'#/reports?type=sales',received:'#/reports?type=income',expenses:'#/reports?type=expense',receivables:'#/reports?type=debtors'}[b.dataset.dashboardTarget]));
}
