import { DB } from '../db.js';
import { money, num, dateFa, esc, INVOICE_STATUS_LABELS, faLabel, icon, todayISO } from '../utils.js';
import { isExpenseType, buildCustomerLedger, invoiceSnapshot, receiptEvents, refundEvents, effectiveTimestamp, inDateRange, safeAmount, projectFinancials, paymentAllocatedAmount, paymentUnallocated, isArchived } from '../finance.js';
import { stockReport, MOVEMENT_SOURCES, MOVEMENT_SOURCE_LABELS } from '../inventory.js';
import { INVOICE_STATUS } from '../validators.js';
import { pageHeader } from '../components.js';
import { dashboardMetrics, buildActivityFeed } from '../dashboard-metrics.js';
import { navigate } from '../router.js';

// Date filtering always uses the record's own event date (transaction/invoice `date`; legacy rows fall back to createdAt).
function filterRow(rec, customerId, status, from, to, rowCustomerId, rowStatus){if(!inDateRange(rec,from,to))return false;if(customerId&&String(rowCustomerId)!==String(customerId))return false;if(status&&rowStatus!==status)return false;return true;}
const dt=rec=>effectiveTimestamp(rec)||0;
const reportDefs=[
  ['sales','chart','فروش','فاکتورها، فروش، دریافت و مطالبات'],['income','wallet','درآمد','دریافت‌های ثبت‌شده'],['expense','wallet','هزینه','هزینه‌ها و پرداخت‌ها'],['debtors','users','بدهکاران','مشتریانی که مانده بدهی دارند'],['invoices','file-text','فاکتورها','جستجو و فیلتر فاکتورها'],['customer','users','صورتحساب مشتری','گردش حساب و مانده یک مشتری'],
  ['projects','folder','پروژه‌ها','فروش، دریافت، هزینه و سود تقریبی'],['inventory','box','موجودی و حرکت کالا','دفتر موجودی انبار'],['allocations','wallet','تخصیص و برگشت وجه','بستانکاری، تخصیص دریافت‌ها و برگشت‌ها'],['overview','chart','خلاصه مالی','فروش، دریافت، هزینه، سود و مطالبات'],['activity','file-text','گردش فعالیت','تمام رویدادهای مالی به ترتیب تاریخ']
];
export async function renderReports(App, params={}){
  const [customers,invoices,transactions,allocations,movements,products,projects]=await Promise.all([DB.all('customers'),DB.all('invoices'),DB.all('transactions'),DB.all('paymentAllocations'),DB.all('stockMovements'),DB.all('products'),DB.all('projects')]);
  App.setView(`${pageHeader('گزارش‌ها',{subtitle:'گزارش‌های کاربردی کسب‌وکار'})}<div class="reports-grid">${reportDefs.map(x=>`<button class="report-card" data-report="${x[0]}"><span class="report-icon">${icon(x[1],'')}</span><span><strong>${x[2]}</strong><small>${x[3]}</small></span><img class="report-chevron" src="./assets/icons/chevron-left.svg" alt=""></button>`).join('')}</div><div id="report-area" class="report-area"></div>`);
  const grid=document.querySelector('.reports-grid');
  const area=()=>document.getElementById('report-area');
  document.querySelectorAll('[data-report]').forEach(b=>b.onclick=()=>openReport(b.dataset.report));
  const filterBar=(withStatus=true)=>`<div class="report-toolbar card card-pad"><div class="report-toolbar-head"><div><strong>فیلتر گزارش</strong><small>بازه زمانی و طرف حساب را مشخص کنید.</small></div><button class="btn btn-ghost btn-icon" id="clear-filter">${icon('x','')}</button></div><div class="report-presets"><button type="button" class="filter-chip" data-preset="month">این ماه</button><button type="button" class="filter-chip" data-preset="prev">ماه قبل</button><button type="button" class="filter-chip" data-preset="30">۳۰ روز اخیر</button><button type="button" class="filter-chip" data-preset="all">همه</button></div><div class="form-grid"><div class="field"><label>از تاریخ</label><input type="date" id="f-from"></div><div class="field"><label>تا تاریخ</label><input type="date" id="f-to"></div><div class="field"><label>مشتری</label><select id="f-customer"><option value="">همه مشتریان</option>${customers.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>${withStatus?`<div class="field"><label>وضعیت</label><select id="f-status"><option value="">همه وضعیت‌ها</option>${INVOICE_STATUS.map(s=>`<option value="${s}">${faLabel(INVOICE_STATUS_LABELS,s)}</option>`).join('')}</select></div>`:''}<div class="field full"><button class="btn btn-primary btn-block" id="apply-filter">${icon('search','')}نمایش گزارش</button></div></div></div><div id="filtered-out"></div>`;
  const readFilters=()=>({from:document.getElementById('f-from')?.value,to:document.getElementById('f-to')?.value,customerId:document.getElementById('f-customer')?.value,status:document.getElementById('f-status')?.value});
  function openReport(type){
    grid.hidden=true;
    if(type==='debtors'){debtorsReport();return;}
    if(type==='customer'){customerReport();return;}
    if(type==='projects'){projectsReport();return;}
    if(type==='inventory'){inventoryReport();return;}
    if(type==='allocations'){allocationsReport();return;}
    if(type==='overview'){overviewReport();return;}
    if(type==='activity'){activityReport();return;}
    area().innerHTML=`<div class="report-view-head"><button class="btn btn-ghost" id="back-report">${icon('arrow-right','')}گزارش‌ها</button><div><h2>${reportDefs.find(x=>x[0]===type)?.[2]||'گزارش'}</h2><small>فیلتر و جزئیات گزارش</small></div></div>`+filterBar(type!=='income'&&type!=='expense');
    document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{const now=new Date();const fmt=d=>{const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;};const k=b.dataset.preset;let from='',to=fmt(now);if(k==='month')from=fmt(new Date(now.getFullYear(),now.getMonth(),1));else if(k==='prev'){from=fmt(new Date(now.getFullYear(),now.getMonth()-1,1));to=fmt(new Date(now.getFullYear(),now.getMonth(),0));}else if(k==='30'){const d=new Date(now);d.setDate(d.getDate()-29);from=fmt(d);}document.getElementById('f-from').value=from;document.getElementById('f-to').value=to;document.getElementById('apply-filter').click();});
    document.getElementById('apply-filter').onclick=()=>{const f=readFilters(); if(type==='sales')salesReport(f);else if(type==='income')incomeExpenseReport(f,true);else if(type==='expense')incomeExpenseReport(f,false);else invoicesReport(f);};
    document.getElementById('back-report').onclick=()=>showReportHome();
    document.getElementById('clear-filter').onclick=()=>openReport(type);
    document.getElementById('apply-filter').click();
  }
  function summaryCards(cards){return `<div class="report-summary-grid">${cards.map(c=>`<div class="report-summary-card"><small>${c[0]}</small><strong class="${c[2]||''}">${c[1]}</strong></div>`).join('')}</div>`;}
  function salesReport(f){const rows=invoices.filter(i=>i.status!=='cancelled'&&filterRow(i,f.customerId,f.status,f.from,f.to,i.customerId,i.status));const snaps=rows.map(i=>invoiceSnapshot(i,transactions,allocations));const total=snaps.reduce((s,x)=>s+x.total,0),paid=snaps.reduce((s,x)=>s+x.paid,0),open=snaps.reduce((s,x)=>s+x.remaining,0);document.getElementById('filtered-out').innerHTML=summaryCards([['تعداد فاکتور',num(rows.length)],['فروش کل',money(total)],['دریافت‌شده',money(paid),'green'],['مطالبات',money(open),'red']])+`<div class="section-title">فاکتورهای این گزارش</div><div class="report-list">${rows.sort((a,b)=>dt(b)-dt(a)).map(invoiceRow).join('')||'<div class="empty">موردی پیدا نشد.</div>'}</div>`;bindInvoiceRows();}
  function incomeExpenseReport(f,wantIncome){
    let rows=[];
    if(wantIncome){
      // every real receipt exactly once (customer payments + other income + legacy invoice payments that have no transaction)
      rows=[...receiptEvents(invoices,transactions,allocations).map(e=>({...e,sign:1})),...refundEvents(invoices,transactions).map(e=>({...e,sign:-1}))]
        .filter(e=>filterRow({date:null,createdAt:e.date},f.customerId,null,f.from,f.to,e.customerId,null))
        .map(e=>({date:e.date,description:e.description||(e.sign<0?'برگشت وجه':'بدون شرح'),amount:e.amount,type:e.kind,invoiceId:e.invoiceId,sign:e.sign}));
    }else{
      rows=transactions.filter(t=>isExpenseType(t.type))
        .filter(t=>filterRow(t,f.customerId,null,f.from,f.to,t.customerId,null))
        .map(t=>({date:effectiveTimestamp(t),description:t.description||'بدون شرح',amount:safeAmount(t.amount),type:t.type,invoiceId:null}));
    }
    rows.sort((a,b)=>(b.date||0)-(a.date||0));
    // net: refunds subtract (central rule: receipts − refunds)
    const total=rows.reduce((s,t)=>s+(t.sign||1)*t.amount,0);
    document.getElementById('filtered-out').innerHTML=summaryCards([['تعداد تراکنش',num(rows.length)],['مجموع',money(total),wantIncome?'green':'red']])+`<div class="section-title">جزئیات</div><div class="report-list">${rows.map(t=>t.invoiceId?`<button class="report-row report-row-button" data-invoice="${t.invoiceId}"><span class="report-row-icon">${icon('file-text','')}</span><span><strong>${esc(t.description)}</strong><small>${dateFa(t.date)} · دریافت فاکتور</small></span><b class="${t.sign<0?'red':'green'}">${t.sign<0?'− ':''}${money(t.amount)}</b></button>`:`<article class="report-row"><span class="report-row-icon">${icon('wallet','')}</span><span><strong>${esc(t.description)}</strong><small>${dateFa(t.date)}</small></span><b class="${wantIncome&&t.sign>0?'green':'red'}">${wantIncome&&t.sign>0?'+':'−'} ${money(t.amount)}</b></article>`).join('')||'<div class="empty">موردی یافت نشد.</div>'}</div>`;
    bindInvoiceRows();
  }
  function debtorsReport(){const list=customers.map(c=>{const bal=buildCustomerLedger(invoices,transactions,c.id,allocations).balance;return{c,bal};}).filter(x=>x.bal>0).sort((a,b)=>b.bal-a.bal);const total=list.reduce((s,x)=>s+x.bal,0);area().innerHTML=`<div class="report-view-head"><button class="btn btn-ghost" id="back-report">${icon('arrow-right','')}گزارش‌ها</button><div><h2>گزارش بدهکاران</h2><small>مشتریان دارای مانده بدهی</small></div></div>${summaryCards([['تعداد بدهکاران',num(list.length)],['مجموع مطالبات',money(total),'red']])}<div class="report-list">${list.map(x=>`<button class="report-row report-row-button" data-customer="${x.c.id}"><span class="client-avatar small">${esc(x.c.name.charAt(0))}</span><span><strong>${esc(x.c.name)}</strong><small>مشاهده گردش حساب</small></span><b class="red">${money(x.bal)}</b></button>`).join('')||'<div class="empty">بدهکاری ثبت نشده است.</div>'}</div>`;document.getElementById('back-report').onclick=()=>showReportHome();document.querySelectorAll('[data-customer]').forEach(b=>b.onclick=()=>navigate('#/customers/'+b.dataset.customer));}
  function invoicesReport(f){const rows=invoices.filter(i=>filterRow(i,f.customerId,f.status,f.from,f.to,i.customerId,i.status)).sort((a,b)=>dt(b)-dt(a));document.getElementById('filtered-out').innerHTML=summaryCards([['تعداد',num(rows.length)],['مجموع',money(rows.reduce((s,i)=>s+(i.total||0),0))]])+`<div class="report-list">${rows.map(invoiceRow).join('')||'<div class="empty">فاکتوری یافت نشد.</div>'}</div>`;bindInvoiceRows();}
  function invoiceRow(i){return `<button class="report-row report-row-button" data-invoice="${i.id}"><span class="report-row-icon">${icon('file-text','')}</span><span><strong>فاکتور ${esc(i.number)}</strong><small>${esc(i.customerName||'مشتری آزاد')} · ${dateFa(i.date||i.createdAt)} · ${faLabel(INVOICE_STATUS_LABELS,i.status)}</small></span><b>${money(i.total)}</b></button>`;}
  function bindInvoiceRows(){document.querySelectorAll('[data-invoice]').forEach(b=>b.onclick=()=>navigate('#/invoices/'+b.dataset.invoice));}
  function customerReport(){area().innerHTML=`<div class="report-view-head"><button class="btn btn-ghost" id="back-report">${icon('arrow-right','')}گزارش‌ها</button><div><h2>صورتحساب مشتری</h2><small>مانده و گردش حساب</small></div></div><div class="card card-pad"><div class="field"><label>مشتری</label><select id="cr"><option value="">انتخاب مشتری</option>${customers.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div id="crout"></div></div>`;document.getElementById('back-report').onclick=()=>showReportHome();document.getElementById('cr').onchange=e=>{const c=customers.find(x=>String(x.id)===String(e.target.value));const acc=c?buildCustomerLedger(invoices,transactions,c.id,allocations):null;const its=acc?.invoices||[];const total=acc?.total||0,paid=acc?.paid||0,refunded=acc?.refunded||0;document.getElementById('crout').innerHTML=c?`${summaryCards([['فاکتورها',num(its.length)],['کل',money(total)],['پرداخت',money(paid),'green'],...(refunded>0?[['برگشت وجه',money(refunded)]]:[]),['مانده',money(Math.max(0,acc.balance)),'red']])}<div class="report-list">${its.sort((a,b)=>dt(b)-dt(a)).map(invoiceRow).join('')||'<div class="empty">فاکتوری ندارد.</div>'}</div><button class="btn btn-secondary btn-block mt-3" id="open-full">مشاهده صفحه کامل مشتری</button>`:'';bindInvoiceRows();document.getElementById('open-full')?.addEventListener('click',()=>navigate('#/customers/'+c.id));};}
  const head=(title,sub)=>`<div class="report-view-head"><button class="btn btn-ghost" id="back-report">${icon('arrow-right','')}گزارش‌ها</button><div><h2>${title}</h2><small>${sub}</small></div></div>`;
  // every figure below is produced by projectFinancials / stockReport / allocation helpers — reports hold no formulas of their own
  function projectsReport(){
    const rows=projects.map(p=>({p,f:projectFinancials(p,invoices,transactions,movements,allocations)}));
    const sum=k=>rows.reduce((s,x)=>s+x.f[k],0);
    area().innerHTML=head('گزارش پروژه‌ها','فروش، دریافت، هزینه و سود تقریبی')+summaryCards([['فروش',money(sum('billed'))],['دریافت خالص',money(sum('received')),'green'],['هزینه',money(sum('costs')),'red'],['مانده دریافت',money(sum('receivable')),'red'],['سود تقریبی',money(sum('profit')),sum('profit')>=0?'green':'red']])+`<div class="report-list">${rows.map(x=>`<button class="report-row report-row-button" data-project="${x.p.id}"><span class="report-row-icon">${icon('folder','')}</span><span><strong>${esc(x.p.name)}${isArchived(x.p)?' (آرشیو)':''}</strong><small>فروش ${money(x.f.billed)} · دریافت ${money(x.f.received)} · هزینه ${money(x.f.costs)} (انبار ${money(x.f.inventoryCost)})</small></span><b class="${x.f.profit>=0?'green':'red'}">${money(x.f.profit)}</b></button>`).join('')||'<div class="empty">پروژه‌ای ثبت نشده است.</div>'}</div>`;
    document.getElementById('back-report').onclick=()=>showReportHome();
    document.querySelectorAll('[data-project]').forEach(b=>b.onclick=()=>navigate('#/projects/'+b.dataset.project));
  }
  function inventoryReport(){
    area().innerHTML=head('موجودی و حرکت کالا','دفتر موجودی انبار')+`<div class="report-toolbar card card-pad"><div class="form-grid"><div class="field"><label>کالا</label><select id="i-product"><option value="">همه کالاها</option>${products.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div><div class="field"><label>نوع حرکت</label><select id="i-source"><option value="">همه</option>${MOVEMENT_SOURCES.map(k=>`<option value="${k}">${MOVEMENT_SOURCE_LABELS[k]}</option>`).join('')}</select></div><div class="field"><label>از تاریخ</label><input type="date" id="i-from"></div><div class="field"><label>تا تاریخ</label><input type="date" id="i-to"></div><div class="field full"><button class="btn btn-primary btn-block" id="i-apply">${icon('search','')}نمایش گزارش</button></div></div></div><div id="inv-out"></div>`;
    document.getElementById('back-report').onclick=()=>showReportHome();
    const draw=()=>{
      const r=stockReport({products,movements,productId:document.getElementById('i-product').value,sourceType:document.getElementById('i-source').value,from:document.getElementById('i-from').value,to:document.getElementById('i-to').value});
      const pname=id=>products.find(p=>String(p.id)===String(id))?.name||'کالا';
      document.getElementById('inv-out').innerHTML=summaryCards([['تعداد حرکت',num(r.rows.length)],['ارزش موجودی (بهای خرید)',money(r.totalValue)]])+`<div class="section-title">موجودی کالاها</div><div class="report-list" id="inv-products">${r.perProduct.map(x=>`<article class="report-row"><span><strong>${esc(x.product.name)}</strong><small>ورود ${num(x.in)} · خروج ${num(x.out)} · پایان بازه ${num(x.closing)}</small></span><b>${num(x.current)}</b></article>`).join('')||'<div class="empty">کالایی ثبت نشده است.</div>'}</div><div class="section-title">حرکت‌ها</div><div class="report-list" id="inv-moves">${r.rows.map(m=>`<article class="report-row"><span><strong>${esc(pname(m.productId))} · ${esc(MOVEMENT_SOURCE_LABELS[m.sourceType]||m.sourceType)}</strong><small>${dateFa(m.date)}${m.description?' · '+esc(m.description):''}</small></span><b class="${m.direction==='in'?'green':'red'}">${m.direction==='in'?'+':'−'} ${num(m.quantity)}</b></article>`).join('')||'<div class="empty">حرکتی یافت نشد.</div>'}</div>`;
    };
    document.getElementById('i-apply').onclick=draw;draw();
  }
  function allocationsReport(){
    const onAccount=transactions.filter(t=>t.type==='customer_payment'&&(t.invoiceId===null||t.invoiceId===undefined));
    const cname=id=>customers.find(c=>String(c.id)===String(id))?.name||'—';
    const unalloc=onAccount.reduce((s,t)=>s+paymentUnallocated(t,allocations),0);
    const refunds=refundEvents(invoices,transactions).sort((a,b)=>(b.date||0)-(a.date||0));
    area().innerHTML=head('تخصیص و برگشت وجه','بستانکاری، تخصیص دریافت‌ها و برگشت‌ها')+summaryCards([['دریافت‌های بدون فاکتور',num(onAccount.length)],['بستانکاری تخصیص‌نیافته',money(unalloc),'green'],['مجموع برگشت وجه',money(refunds.reduce((s,e)=>s+e.amount,0)),'red']])+`<div class="section-title">دریافت‌های بدون فاکتور</div><div class="report-list" id="alloc-list">${onAccount.map(t=>`<article class="report-row"><span><strong>${esc(cname(t.customerId))} · ${esc(t.description||'دریافت وجه')}</strong><small>${dateFa(t.date||t.createdAt)} · تخصیص‌یافته ${money(paymentAllocatedAmount(t.id,allocations))} · تخصیص‌نیافته ${money(paymentUnallocated(t,allocations))}</small></span><b class="green">${money(t.amount)}</b></article>`).join('')||'<div class="empty">موردی نیست.</div>'}</div><div class="section-title">برگشت وجه‌ها</div><div class="report-list" id="refund-list">${refunds.map(e=>`<article class="report-row"><span><strong>${esc(cname(e.customerId))} · ${esc(e.description||'برگشت وجه')}</strong><small>${dateFa(e.date)}${e.invoiceId?' · فاکتور مرتبط':''}</small></span><b class="red">− ${money(e.amount)}</b></article>`).join('')||'<div class="empty">برگشت وجهی ثبت نشده است.</div>'}</div>`;
    document.getElementById('back-report').onclick=()=>showReportHome();
  }

  function overviewReport(){
    area().innerHTML=`${head('خلاصه مالی','نمای کلی برای تصمیم‌گیری روزانه')}<div class="report-toolbar card card-pad"><div class="report-presets"><button type="button" class="filter-chip active" data-overview="month">این ماه</button><button type="button" class="filter-chip" data-overview="30">۳۰ روز اخیر</button><button type="button" class="filter-chip" data-overview="all">همه</button></div><div class="form-grid"><div class="field"><label>از تاریخ</label><input type="date" id="ov-from"></div><div class="field"><label>تا تاریخ</label><input type="date" id="ov-to" value="${todayISO()}"></div></div></div><div id="overview-out"></div>`;
    const draw=()=>{
      const from=document.getElementById('ov-from').value,to=document.getElementById('ov-to').value;
      const inRange=x=>{const ts=effectiveTimestamp(x);if(!Number.isFinite(ts))return false;const d=new Date(ts);const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;return (!from||k>=from)&&(!to||k<=to);};
      const sales=invoices.filter(i=>i.status!=='cancelled'&&inRange(i)).reduce((s,i)=>s+safeAmount(i.total),0);
      const receipts=receiptEvents(invoices,transactions,allocations).filter(e=>e.kind==='customer_payment'&&inRange({date:e.date})).reduce((s,e)=>s+e.amount,0);
      const refunds=refundEvents(invoices,transactions).filter(e=>inRange({date:e.date})).reduce((s,e)=>s+e.amount,0);
      const expenses=transactions.filter(t=>isExpenseType(t.type)&&inRange(t)).reduce((s,t)=>s+safeAmount(t.amount),0);
      const current=dashboardMetrics({today:todayISO(),invoices,transactions,customers,allocations,products,projects,movements});
      const profit=sales-expenses;
      document.getElementById('overview-out').innerHTML=summaryCards([['فروش',money(sales)],['دریافت ناخالص',money(receipts),'green'],['برگشت وجه',money(refunds),'red'],['دریافت خالص',money(receipts-refunds),'green'],['هزینه',money(expenses),'red'],['سود تقریبی',money(profit),profit>=0?'green':'red'],['مطالبات فعلی',money(current.receivables),'red'],['فاکتورهای باز',num(current.openInvoiceCount)]]);
    };
    const setPreset=k=>{const now=new Date(),fmt=d=>{const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;};let from='',to=fmt(now);if(k==='month')from=fmt(new Date(now.getFullYear(),now.getMonth(),1));else if(k==='30'){const d=new Date(now);d.setDate(d.getDate()-29);from=fmt(d);}document.getElementById('ov-from').value=from;document.getElementById('ov-to').value=to;draw();};
    document.getElementById('back-report').onclick=()=>showReportHome();document.getElementById('ov-from').onchange=draw;document.getElementById('ov-to').onchange=draw;document.querySelectorAll('[data-overview]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-overview]').forEach(x=>x.classList.toggle('active',x===b));setPreset(b.dataset.overview);});setPreset('month');
  }
  function activityReport(){
    const feed=buildActivityFeed({invoices,transactions,limit:1000});
    area().innerHTML=head('گردش فعالیت','فاکتور، دریافت، هزینه و برگشت وجه به ترتیب تاریخ')+`<div class="report-toolbar card card-pad"><div class="form-grid"><div class="field"><label>از تاریخ</label><input type="date" id="act-from"></div><div class="field"><label>تا تاریخ</label><input type="date" id="act-to"></div><div class="field full"><button class="btn btn-primary btn-block" id="act-apply">${icon('search','')}نمایش</button></div></div></div><div id="act-out"></div>`;
    const draw=()=>{const from=document.getElementById('act-from').value,to=document.getElementById('act-to').value;const rows=feed.filter(x=>{if(!x.date)return false;const d=new Date(x.date),k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;return (!from||k>=from)&&(!to||k<=to);});document.getElementById('act-out').innerHTML=summaryCards([['تعداد رویداد',num(rows.length)],['ورودی نقدی',money(rows.filter(x=>x.kind==='receipt').reduce((s,x)=>s+x.amount,0)),'green'],['هزینه/برگشت',money(rows.filter(x=>x.kind==='expense'||x.kind==='refund').reduce((s,x)=>s+x.amount,0)),'red']])+`<div class="report-list">${rows.map(x=>`<button class="report-row report-row-button" ${x.kind==='invoice'&&x.refId?`data-invoice="${x.refId}"`:''}><span class="report-row-icon">${icon(x.kind==='invoice'?'file-text':x.kind==='expense'?'wallet':'wallet','')}</span><span><strong>${esc(x.title)}</strong><small>${esc(x.detail||'')}${x.date?' · '+dateFa(x.date):''}</small></span><b class="${x.kind==='expense'||x.kind==='refund'?'red':'green'}">${x.kind==='expense'||x.kind==='refund'?'− ':'+ '}${money(x.amount)}</b></button>`).join('')||'<div class="empty">رویدادی پیدا نشد.</div>'}</div>`;bindInvoiceRows();};
    document.getElementById('back-report').onclick=()=>showReportHome();document.getElementById('act-apply').onclick=draw;draw();
  }
  function showReportHome(){grid.hidden=false;area().innerHTML='';window.scrollTo(0,0);}
  const initial=params.query?.get('type'); if(initial)openReport(initial);
}
