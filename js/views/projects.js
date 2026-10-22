import {DB} from '../db.js';
import {money,num,dateFa,esc,toast,icon,showValidationErrors,guardSubmit,PROJECT_STATUS_LABELS,INVOICE_STATUS_LABELS,faLabel} from '../utils.js';
import {navigate} from '../router.js';
import {openStockMovementModal} from './stock-modal.js';
import {MOVEMENT_SOURCE_LABELS} from '../inventory.js';
import {PROJECT_STATUS,validateProject,toMoney} from '../validators.js';
import {projectFinancials,entityUsage} from '../finance.js';
import {pageHeader,emptyState,actionMenu,openModal,closeModal,bindActionMenus,deleteOrArchive} from '../components.js';

export async function renderProjects(App){
  const [rows,customers,invoices,transactions,movements,allocations]=await Promise.all([DB.all('projects'),DB.all('customers'),DB.all('invoices'),DB.all('transactions'),DB.all('stockMovements'),DB.all('paymentAllocations')]);
  App.setView(`${pageHeader('پروژه‌ها',{action:'پروژه جدید',actionId:'add'})}<div id="list" class="list"><div class="skeleton"></div><div class="skeleton"></div></div>`);
  const list=document.getElementById('list');
  const cname=id=>customers.find(c=>c.id==id)?.name||'بدون مشتری';
  // every project figure comes from the central finance module: sales, received, costs, receivable, approximate profit stay separate
  list.innerHTML=rows.map(x=>{const f=projectFinancials(x,invoices,transactions,movements,allocations);return `<div class="list-item project-item"><div class="list-main clickable" data-open="${x.id}"><div class="list-title">${esc(x.name)}</div><div class="list-sub">${esc(cname(x.customerId))} · ${faLabel(PROJECT_STATUS_LABELS,x.status||'active')}${x.archived?' · آرشیو':''}</div><div class="project-mini-stats"><span>فروش ${money(f.billed)}</span><span>دریافت ${money(f.received)}</span><span>هزینه ${money(f.costs)}</span><span>مانده دریافت ${money(f.receivable)}</span><span class="${f.profit>=0?'green':'red'}">سود تقریبی ${money(f.profit)}</span></div></div><div class="list-value"><small>بودجه</small>${money(x.budget||0)}</div>${actionMenu(x.id)}</div>`;}).join('')||emptyState('پروژه‌ای ثبت نشده','پروژه‌های برق ساختمان و صنعتی را ثبت کنید.','افزودن پروژه','add-empty');
  bindActionMenus(list,{edit:id=>form(rows.find(x=>x.id==id)),delete:id=>deleteOrArchive({store:'projects',row:rows.find(x=>String(x.id)===String(id)),usage:entityUsage('project',id,{invoices,transactions,movements}),noun:'پروژه',onDone:()=>renderProjects(App)})});
  list.querySelector('#add-empty')?.addEventListener('click',()=>form());
  list.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>navigate('#/projects/'+b.dataset.open));
  document.getElementById('add').onclick=()=>form();
  function form(x={}){
    const m=openModal(`<div class="modal-head"><h3>${x.id?'ویرایش پروژه':'پروژه جدید'}</h3><button class="close">${icon('x','')}</button></div><form id="f" class="form-grid" novalidate><div class="field full"><label>نام پروژه</label><input name="name" autofocus value="${esc(x.name||'')}"></div><div class="field"><label>مشتری</label><select name="customerId"><option value="">بدون مشتری</option>${customers.filter(c=>!c.archived||x.customerId==c.id).map(c=>`<option value="${c.id}" ${x.customerId==c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>وضعیت</label><select name="status">${PROJECT_STATUS.map(s=>`<option value="${s}" ${(x.status||'active')===s?'selected':''}>${faLabel(PROJECT_STATUS_LABELS,s)}</option>`).join('')}</select></div><div class="field"><label>تاریخ شروع</label><input name="startDate" type="date" value="${x.startDate||''}"></div><div class="field"><label>تاریخ پایان</label><input name="endDate" type="date" value="${x.endDate||''}"></div><div class="field"><label>بودجه</label><input name="budget" type="text" inputmode="decimal" value="${x.budget||0}"></div><div class="field"><label>هزینه دستی/قدیمی</label><input name="cost" type="text" inputmode="decimal" value="${x.cost||0}"></div><div class="field full"><label>توضیحات</label><textarea name="description">${esc(x.description||x.notes||'')}</textarea></div><div class="field full"><button class="btn btn-primary btn-block">${icon('check','')}ذخیره</button></div></form>`);
    const f=m.querySelector('#f');
    f.onsubmit=guardSubmit(async()=>{const d=Object.fromEntries(new FormData(f));d.customerId=d.customerId?Number(d.customerId):null;const v=validateProject(d);if(showValidationErrors(f,v))return;d.budget=toMoney(d.budget);d.cost=toMoney(d.cost);await DB.put('projects',x.id?{...x,...d,id:x.id}:d);closeModal();toast('پروژه ذخیره شد');renderProjects(App);});
  }
}

// Project workflow page: customer, status, dates, budget, invoices, received, expenses, inventory consumption, receivable, approximate profit.
// Every number comes from projectFinancials() (finance.js) — nothing is recomputed here.
export async function renderProjectDetail(App,params){
  const id=Number(params.id);
  const [project,customers,invoices,transactions,movements,allocations,products]=await Promise.all([DB.get('projects',id),DB.all('customers'),DB.all('invoices'),DB.all('transactions'),DB.all('stockMovements'),DB.all('paymentAllocations'),DB.all('products')]);
  if(!project){App.setView(`${emptyState('پروژه پیدا نشد','این پروژه وجود ندارد.')}<button class="btn btn-secondary" data-route="#/projects">بازگشت به پروژه‌ها</button>`);document.querySelectorAll('[data-route]').forEach(b=>b.onclick=e=>{e.preventDefault();navigate(b.dataset.route)});return;}
  const f=projectFinancials(project,invoices,transactions,movements,allocations);
  const customer=customers.find(c=>String(c.id)===String(project.customerId));
  const pInvoices=invoices.filter(i=>String(i.projectId)===String(id)).sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));
  const expenses=transactions.filter(t=>t.projectId!=null&&String(t.projectId)===String(id)&&['expense','supplier_payment','other_expense'].includes(t.type));
  const used=movements.filter(m=>m.sourceType==='project'&&String(m.projectId)===String(id));
  const pname=pid=>products.find(p=>String(p.id)===String(pid))?.name||'کالا';
  const stat=(label,value,cls='',meta='')=>`<div class="card stat"><div class="stat-label">${label}</div><div class="stat-value ${cls}">${value}</div>${meta?`<div class="stat-meta">${meta}</div>`:''}</div>`;
  App.setView(`${pageHeader(project.name,{back:true,subtitle:`${customer?.name||'بدون مشتری'} · ${faLabel(PROJECT_STATUS_LABELS,project.status||'active')}`})}
    <div class="card card-pad"><div class="invoice-total"><span>تاریخ شروع</span><strong>${project.startDate?dateFa(project.startDate):'—'}</strong></div><div class="invoice-total"><span>تاریخ پایان</span><strong>${project.endDate?dateFa(project.endDate):'—'}</strong></div><div class="invoice-total"><span>بودجه</span><strong>${money(f.budget)}</strong></div></div>
    <div class="stats-grid mt-3" id="project-stats">
      ${stat('فروش (فاکتورها)',money(f.billed),'',`${num(f.invoiceCount)} فاکتور`)}
      ${stat('دریافت‌شده (خالص)',money(f.received),'green',f.refunded>0?`برگشت وجه: ${money(f.refunded)}`:'')}
      ${stat('مانده دریافت',money(f.receivable),'red')}
      ${stat('هزینه‌های ثبت‌شده',money(f.txCosts),'red',`${num(f.expenseCount)} تراکنش`)}
      ${stat('مصرف انبار',money(f.inventoryCost),'red','از دفتر موجودی')}
      ${stat('هزینه دستی/قدیمی',money(f.manualCost),'red','ثبت‌شده روی پروژه')}
      ${stat('جمع هزینه',money(f.costs),'red')}
      ${stat('سود تقریبی',money(f.profit),f.profit>=0?'green':'red','فروش − هزینه (دریافت جدا است)')}
    </div>
    <div class="quick-grid mt-3"><button class="quick" id="pj-invoice"><span class="qicon">${icon('file-plus','')}</span><small>فاکتور جدید</small></button><button class="quick" id="pj-expense"><span class="qicon">${icon('wallet','')}</span><small>ثبت هزینه</small></button><button class="quick" id="pj-use"><span class="qicon">${icon('box-plus','')}</span><small>مصرف کالا</small></button></div>
    <div class="section-title">فاکتورها</div><div class="report-list">${pInvoices.map(i=>`<button class="report-row report-row-button" data-invoice="${i.id}"><span class="report-row-icon">${icon('file-text','')}</span><span><strong>فاکتور ${esc(i.number)}</strong><small>${dateFa(i.date||i.createdAt)} · ${faLabel(INVOICE_STATUS_LABELS,i.status)}</small></span><b>${money(i.total)}</b></button>`).join('')||'<div class="empty">فاکتوری ثبت نشده است.</div>'}</div>
    <div class="section-title">هزینه‌ها</div><div class="report-list">${expenses.map(t=>`<article class="report-row"><span><strong>${esc(t.description||'هزینه')}</strong><small>${dateFa(t.date||t.createdAt)}</small></span><b class="red">− ${money(t.amount)}</b></article>`).join('')||'<div class="empty">هزینه‌ای ثبت نشده است.</div>'}</div>
    <div class="section-title">مصرف کالا از انبار</div><div class="report-list">${used.map(m=>`<article class="report-row"><span><strong>${esc(pname(m.productId))}</strong><small>${dateFa(m.date)} · ${esc(MOVEMENT_SOURCE_LABELS.project)}${m.direction==='in'?' (برگشت)':''}</small></span><b class="${m.direction==='out'?'red':'green'}">${m.direction==='out'?'−':'+'} ${num(m.quantity)}</b></article>`).join('')||'<div class="empty">مصرفی ثبت نشده است.</div>'}</div>`);
  document.querySelector('[data-back]')?.addEventListener('click',()=>history.length>1?history.back():navigate('#/projects'));
  document.getElementById('pj-invoice').onclick=()=>navigate(`#/invoices?new=1&project=${id}`);
  document.getElementById('pj-expense').onclick=()=>navigate('#/accounting?new=expense');
  document.getElementById('pj-use').onclick=()=>openStockMovementModal({projectId:id,kind:'project_use',onDone:()=>renderProjectDetail(App,params)});
  document.querySelectorAll('[data-invoice]').forEach(b=>b.onclick=()=>navigate('#/invoices/'+b.dataset.invoice));
}
