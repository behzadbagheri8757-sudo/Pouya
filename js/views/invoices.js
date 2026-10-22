import { DB, getSettings } from '../db.js';
import { money, num, dateFa, esc, toast, invoiceToImage, amountToWordsFa, printWithClass, INVOICE_STATUS_LABELS, INVOICE_STATUS_BADGE, faLabel, icon, showValidationErrors, guardSubmit, todayISO, newToken, bindAmountInput, jalaliFromISO, isoFromJalali, jalaliMonthNames, jalaliIsLeap } from '../utils.js';
import { INVOICE_STATUS, validateInvoice, validateAmount, toNumber, toMoney, findDuplicate } from '../validators.js';
import { invoiceSnapshot, checkInvoiceSave, legacyMigrationTx, planInvoicePayment, isoFromTimestamp } from '../finance.js';
import { calculateInvoice, invoiceStatusFromPayment } from '../invoice-engine.js';
import { planInvoiceStock, planSalesReturn, movementOps, stockCacheOps, bookedForInvoice, invoiceStockActive } from '../inventory.js';
import { openRefundModal } from './payment-modal.js';
import { navigate } from '../router.js';
import { pageHeader, emptyState, openModal, closeModal, actionMenu, bindActionMenus } from '../components.js';

function calculateTotals(items, discount, taxEnabled, taxPercent, discountType='amount', extraCosts=0) {
  const result = calculateInvoice(items, { discount, discountType, taxEnabled, taxPercent, extraCosts });
  return { ...result, lineTotals: result.items.map(i => i.total) };
}

function deriveInvoiceStatus(status, paidAmount, total) {
  return invoiceStatusFromPayment(status, paidAmount, total);
}

function invoiceStatusClass(status) { return INVOICE_STATUS_BADGE[status] || 'muted'; }

function jalaliDaysInMonth(year, month) {
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  return jalaliIsLeap(Number(year)) ? 30 : 29;
}

function jalaliDateControls(existing) {
  const iso = existing?.date || (existing?.createdAt ? isoFromTimestamp(existing.createdAt) : todayISO());
  const [jy,jm,jd] = jalaliFromISO(iso) || jalaliFromISO(todayISO());
  const years = Array.from(new Set([jy, ...Array.from({length: 11}, (_,i) => jy - 5 + i)])).sort((a,b)=>a-b);
  return {
    iso, jy, jm, jd,
    years: years.map(y=>`<option value="${y}" ${y===jy?'selected':''}>${num(y)}</option>`).join(''),
    months: jalaliMonthNames.map((name,i)=>`<option value="${i+1}" ${i+1===jm?'selected':''}>${name}</option>`).join(''),
    days: Array.from({length:31},(_,i)=>i+1).map(d=>`<option value="${d}" ${d===jd?'selected':''}>${num(d)}</option>`).join('')
  };
}

function invoiceCard(i) {
  return `<article class="list-item invoice-list-card" data-invoice-id="${i.id}">
    <button class="invoice-card-hit" data-open-invoice="${i.id}" aria-label="مشاهده فاکتور ${esc(i.number)}">
      <span class="invoice-card-icon">${icon('file-text','')}</span>
      <span class="list-main"><span class="list-title">فاکتور ${esc(i.number)}</span><span class="list-sub">${esc(i.customerName || 'مشتری آزاد')} · ${dateFa(i.date||i.createdAt)}</span></span>
      <span class="list-value">${money(i.total)}<small class="badge badge-${invoiceStatusClass(i.status)}">${faLabel(INVOICE_STATUS_LABELS, i.status)}</small></span>
    </button>
    ${actionMenu(i.id)}
  </article>`;
}

let presetProject = null;
export async function renderInvoices(App, opts = {}) {
  presetProject = null;
  const [rows, customers, products, services, projects, settings, transactions, allocations, movements] = await Promise.all([
    DB.all('invoices'), DB.all('customers'), DB.all('products'), DB.all('services'), DB.all('projects'), getSettings(), DB.all('transactions'), DB.all('paymentAllocations'), DB.all('stockMovements')
  ]);
  App.setView(`${pageHeader('فاکتورها', { action: 'فاکتور جدید', actionId: 'add' })}
    <div class="invoice-list-summary"><span><strong>${num(rows.length)}</strong> فاکتور</span><span>مجموع فروش <strong>${money(rows.filter(x => x.status !== 'cancelled').reduce((s,x)=>s+(x.total||0),0))}</strong></span></div>
    <div class="search"><img class="icon" src="./assets/icons/search.svg" alt=""><input id="search" placeholder="جستجوی شماره فاکتور یا مشتری"></div>
    <div id="list" class="list"><div class="skeleton"></div><div class="skeleton"></div></div>`);

  const list = document.getElementById('list');
  const draw = (filter = '') => {
    const q = filter.trim().toLocaleLowerCase('fa-IR');
    const rs = rows.filter(x => `${x.number} ${x.customerName || ''}`.toLocaleLowerCase('fa-IR').includes(q)).sort((a,b)=>b.createdAt-a.createdAt);
    list.innerHTML = rs.map(invoiceCard).join('') || emptyState('فاکتوری ثبت نشده', 'برای شروع یک فاکتور فروش ایجاد کنید.', 'فاکتور جدید', 'add-empty');
    list.querySelectorAll('[data-open-invoice]').forEach(b => b.onclick = () => navigate(`#/invoices/${b.dataset.openInvoice}`));
    bindActionMenus(list, {
      edit: id => { const x = rows.find(r => String(r.id) === String(id)); if (x) { closeModal(); navigate(`#/invoices?edit=${encodeURIComponent(x.id)}`); } },
      delete: async id => { const x=rows.find(r=>String(r.id)===String(id)); if(!x)return;
        const snap=invoiceSnapshot(x,transactions,allocations);
        // an invoice that ever touched the stock ledger is never hard-deleted: its history must stay intact (cancel instead)
        const hasStockHistory=movements.some(m=>(m.sourceType==='invoice'||m.sourceType==='sales_return')&&String(m.sourceId)===String(x.id));
        if(x.status==='draft'&&snap.paid===0&&!hasStockHistory){if(confirm('این پیش‌نویس حذف شود؟')){await DB.delete('invoices',Number(id));toast('پیش‌نویس حذف شد');renderInvoices(App);}return;}
        if(x.status==='cancelled'){toast('این فاکتور قبلاً لغو شده است.');return;}
        const note=snap.paid>0?`\nمبلغ ${money(snap.paid)} که قبلاً دریافت شده است حذف نمی‌شود؛ به‌عنوان بستانکاری مشتری در گردش حساب باقی می‌ماند.`:'';
        if(confirm('فاکتور لغو شود؟ فاکتورهای ثبت‌شده حذف نمی‌شوند و فقط لغو می‌شوند.'+note)){
          const cancelled={...x,status:'cancelled',paidAmount:snap.paid,remainingAmount:0,cancelledAt:Date.now()};
          // cancelling reverses exactly what the ledger holds for this invoice (nothing if already reversed) in the same transaction
          const sp=planInvoiceStock({invoice:cancelled,invoiceId:x.id,movements,products,date:todayISO()});
          if(!sp.ok){if(sp.shortages?.length){sp.shortages.forEach(sh=>{const r=[...itemsEl.querySelectorAll('.invoice-row')].find(x=>String(x._item?.id)===String(sh.productId));if(!r)return;const q=r.querySelector('.qty');q.setAttribute('aria-invalid','true');let hint=r.querySelector('.stock-hint');if(!hint){hint=document.createElement('div');hint.className='stock-hint danger';r.appendChild(hint);}hint.hidden=false;hint.className='stock-hint danger';hint.textContent=`موجودی: ${num(sh.available)}، درخواستی: ${num(sh.needed)}`;r.scrollIntoView({block:'center'});});}toast(sp.error,'error');return;}
          await DB.atomic([{store:'invoices',action:'put',data:cancelled},...movementOps(sp.drafts),...stockCacheOps(products,movements,sp.drafts)]);
          toast('فاکتور لغو شد');renderInvoices(App);}
      }
    });
    list.querySelector('#add-empty')?.addEventListener('click', () => form());
  };
  draw();
  document.getElementById('search').oninput = e => draw(e.target.value);
  document.getElementById('add').onclick = () => form();
  if (opts.newForCustomer) form(Number(opts.newForCustomer));
  if (opts.newBlank) { presetProject = opts.newProject || null; form(); }
  if (opts.editId) { const x=rows.find(r=>String(r.id)===String(opts.editId)); if(x) form(null,x); }

  function nextNumber() {
    const seqs = rows.map(r => Number(r.seq) || 0);
    const base = Number(settings.invoiceStart) || 1001;
    let seq = Math.max(base, ...seqs.map(x => x + 1), base);
    // legacy invoices may have no `seq`: never hand out a number that already exists
    while (findDuplicate(rows, 'number', (settings.invoicePrefix || '') + seq)) seq++;
    return { seq, number: (settings.invoicePrefix || '') + seq };
  }

  function form(preselected = null, existing = null) {
    const legacyTaxEnabled = existing?.taxEnabled ?? (Number(existing?.tax||0) > 0);
    const legacyTaxPercent = existing?.taxPercent ?? (legacyTaxEnabled && Number(existing?.taxableAmount||0) > 0 ? (Number(existing.tax||0) / Number(existing.taxableAmount||1)) * 100 : settings.taxPercent);
    const taxEnabled = existing ? !!legacyTaxEnabled : !!settings.taxEnabled;
    const taxPercent = Number.isFinite(Number(legacyTaxPercent)) ? Math.max(0,Math.min(100,Number(legacyTaxPercent))) : Number(settings.taxPercent)||0;
    const existingLinkedPaid = existing ? invoiceSnapshot(existing, transactions, allocations).paid : 0;
    const jd = jalaliDateControls(existing);
    let recoveryDraft=null;
    if(!existing){try{const raw=localStorage.getItem('dia.invoice.draft');const parsed=raw?JSON.parse(raw):null;if(parsed&&Date.now()-Number(parsed.savedAt)<86400000&&Array.isArray(parsed.items)&&parsed.items.length)recoveryDraft=parsed;else if(parsed)localStorage.removeItem('dia.invoice.draft');}catch{}}
    const m = openModal(`<div class="modal-head"><div><h3>${existing ? 'ویرایش فاکتور' : 'فاکتور فروش جدید'}</h3><small class="invoice-preview-number">شماره: ${esc(existing?.number||nextNumber().number)}</small></div><button class="close" type="button">${icon('x','')}</button></div>
      <form id="invoice-form" class="invoice-editor" novalidate>
        ${recoveryDraft?`<div class="invoice-draft-recovery" id="invoice-draft-recovery"><span>پیش‌نویس ذخیره‌شده از ${num(Math.max(1,Math.floor((Date.now()-recoveryDraft.savedAt)/60000)))} دقیقه پیش</span><button type="button" class="btn btn-secondary" id="recover-invoice-draft">بازیابی</button><button type="button" class="btn btn-secondary" id="discard-invoice-draft">شروع تازه</button></div>`:''}
        <div class="form-grid">
          <div class="field"><label>مشتری</label><div class="invoice-search-wrap"><input id="customer-search" autocomplete="off" placeholder="نام مشتری..." value="${esc(customers.find(c=>String(c.id)===String(existing?.customerId ?? preselected))?.name||'')}"><input type="hidden" name="customerId" value="${existing?.customerId ?? preselected ?? ''}"><div class="invoice-results" id="customer-results" hidden></div></div></div>
          <div class="field"><label>پروژه</label><div class="invoice-search-wrap"><input id="project-search" autocomplete="off" placeholder="نام پروژه..." value="${esc(projects.find(p=>String(p.id)===String(existing?.projectId||presetProject||''))?.name||'')}"><input type="hidden" name="projectId" value="${existing?.projectId||presetProject||''}"><div class="invoice-results" id="project-results" hidden></div></div></div>
          <div class="field"><label>تاریخ فاکتور</label><input type="hidden" name="date" value="${jd.iso}"><div class="jalali-date-picker" data-jalali-picker><select name="jYear" aria-label="سال">${jd.years}</select><select name="jMonth" aria-label="ماه">${jd.months}</select><select name="jDay" aria-label="روز">${jd.days}</select></div><small class="field-hint">${num(jd.jy)}/${String(jd.jm).padStart(2,'0')}/${String(jd.jd).padStart(2,'0')} شمسی</small></div>
          <div class="field"><label>وضعیت</label><select name="status">${(existing?INVOICE_STATUS:INVOICE_STATUS.filter(s=>s==='draft'||s==='issued')).map(s=>`<option value="${s}" ${(existing?.status||'issued')===s?'selected':''}>${faLabel(INVOICE_STATUS_LABELS,s)}</option>`).join('')}</select></div>
        </div>
        <div class="section-title-row"><div class="section-title-compact">اقلام فاکتور</div><button type="button" class="btn btn-secondary" id="add-item">${icon('plus','')}افزودن ردیف</button></div>
        <div id="items"></div>
        <div class="section-title">تخفیف، مالیات و پرداخت</div>
        <div class="form-grid">
          <div class="field"><label>نوع تخفیف کلی</label><select name="discountType"><option value="amount" ${(existing?.discountType||'amount')==='amount'?'selected':''}>مبلغ ثابت</option><option value="percent" ${existing?.discountType==='percent'?'selected':''}>درصدی</option></select></div>
          <div class="field"><label id="discount-label">تخفیف کلی</label><input name="discount" class="amount-input" type="text" inputmode="numeric" value="${existing?.discountInput ?? existing?.discount ?? 0}"></div>
          ${taxEnabled?`<div class="field"><label>مالیات ${num(taxPercent)}٪</label><input id="tax-preview" disabled value="۰ ریال"></div>`:''}
          <div class="field"><label>هزینه‌های جانبی</label><input name="extraCosts" class="amount-input" type="text" inputmode="numeric" value="${existing?.extraCosts||0}"></div>
          <div class="field"><label>مبلغ پرداختی</label><small id="paid-hint" class="field-hint">پرداخت‌های ثبت‌شده از گردش حساب خوانده می‌شوند.</small><input name="paidAmount" class="amount-input" type="text" inputmode="numeric" value="${existing?existingLinkedPaid:0}" ${existing && existingLinkedPaid>0?'aria-describedby="paid-hint"':''}></div>
        </div>
        <div class="field mt-3"><label>توضیحات</label><textarea name="notes">${esc(existing?.notes||'')}</textarea></div>
        <div class="card card-pad mt-3"><div class="invoice-total"><span>جمع اقلام</span><span id="subtotal">۰ ریال</span></div><div class="invoice-total"><span>تخفیف</span><span id="discount-preview">۰ ریال</span></div>${taxEnabled?`<div class="invoice-total"><span>مالیات</span><span id="tax-total">۰ ریال</span></div>`:''}<div class="invoice-total"><span>مبلغ نهایی</span><strong id="sum">۰ ریال</strong></div></div>
      </form>
      <div class="sticky-invoice-footer"><div class="sticky-invoice-inner"><button type="button" class="btn btn-secondary btn-icon" id="footer-add-row" aria-label="افزودن ردیف">+</button><div class="sticky-total"><small id="footer-meta">۰ ردیف</small><strong id="sticky-sum">۰ ریال</strong><small id="sticky-words" class="sticky-words"></small></div>${!existing?'<button type="button" class="btn btn-secondary" id="save-next">ثبت + بعدی</button>':''}<button type="button" class="btn btn-primary" id="save-invoice">${icon('check','')} ${existing?'ذخیره تغییرات':'ثبت فاکتور'}</button></div></div>`);
    const f = m.querySelector('#invoice-form'), itemsEl = m.querySelector('#items'); let counter = 0;
    const dateHidden=f.querySelector('[name=date]'), datePicker=f.querySelector('[data-jalali-picker]'), dateHint=f.querySelector('.field-hint');
    const syncJalaliDate=()=>{
      const jy=Number(f.jYear.value), jm=Number(f.jMonth.value), max=jalaliDaysInMonth(jy,jm);
      [...f.jDay.options].forEach(o=>o.hidden=Number(o.value)>max);
      if(Number(f.jDay.value)>max) f.jDay.value=String(max);
      dateHidden.value=isoFromJalali(jy,jm,Number(f.jDay.value));
      if(dateHint) dateHint.textContent=`${num(jy)}/${String(jm).padStart(2,'0')}/${String(f.jDay.value).padStart(2,'0')} شمسی`;
    };
    datePicker?.querySelectorAll('select').forEach(s=>s.addEventListener('change',syncJalaliDate));
    syncJalaliDate();
    const catalog = [...products.filter(p=>!p.archived).map(p=>({type:'product',id:p.id,name:p.name,unit:p.unit||'عدد',price:Number(p.salePrice)||0,stock:Number(p.stock)||0})), ...services.filter(s=>!s.archived).map(s=>({type:'service',id:s.id,name:s.name,unit:s.unit||'مورد',price:Number(s.price)||0}))];
    const customerSearch=m.querySelector('#customer-search'),customerResults=m.querySelector('#customer-results'),customerIdInput=f.elements.namedItem('customerId');
    const projectSearch=m.querySelector('#project-search'),projectResults=m.querySelector('#project-results'),projectIdInput=f.elements.namedItem('projectId');
    const customerFrequency=new Map();rows.forEach(inv=>{if(inv.customerId!=null)customerFrequency.set(String(inv.customerId),(customerFrequency.get(String(inv.customerId))||0)+1);});
    const renderCustomerResults=q=>{const query=(q||'').trim().toLocaleLowerCase('fa-IR');const active=customers.filter(c=>!c.archived||String(c.id)===String(customerIdInput.value));const frequent=[...active].sort((a,b)=>(customerFrequency.get(String(b.id))||0)-(customerFrequency.get(String(a.id))||0));const found=(query?active.filter(c=>c.name.toLocaleLowerCase('fa-IR').includes(query)):frequent).slice(0,10);customerResults.innerHTML=`<button type="button" class="invoice-result" data-id="">مشتری آزاد</button>`+found.map(c=>`<button type="button" class="invoice-result" data-id="${c.id}">${esc(c.name)}</button>`).join('');customerResults.hidden=false;};
    const renderProjectResults=q=>{const query=(q||'').trim().toLocaleLowerCase('fa-IR'),cid=customerIdInput.value;const found=projects.filter(pr=>(!pr.archived||String(pr.id)===String(projectIdInput.value))&&(!cid||String(pr.customerId||'')===String(cid))&&(!query||pr.name.toLocaleLowerCase('fa-IR').includes(query))).slice(0,10);projectResults.innerHTML=`<button type="button" class="invoice-result" data-id="">بدون پروژه</button>`+found.map(pr=>`<button type="button" class="invoice-result" data-id="${pr.id}">${esc(pr.name)}</button>`).join('');projectResults.hidden=false;};
    customerSearch.onfocus=()=>{customerResults.hidden=false;renderCustomerResults(customerSearch.value);projectResults.hidden=true;};customerSearch.oninput=()=>{customerIdInput.value='';projectIdInput.value='';projectSearch.value='';renderCustomerResults(customerSearch.value);renderProjectResults('');};
    customerResults.addEventListener('click',e=>{const b=e.target.closest('.invoice-result');if(!b)return;customerIdInput.value=b.dataset.id||'';customerSearch.value=b.dataset.id?customers.find(c=>String(c.id)===String(b.dataset.id))?.name||'':'';customerResults.hidden=true;projectIdInput.value='';projectSearch.value='';});
    projectSearch.onfocus=()=>{projectResults.hidden=false;renderProjectResults(projectSearch.value);customerResults.hidden=true;};projectSearch.oninput=()=>{projectIdInput.value='';renderProjectResults(projectSearch.value);};
    projectResults.addEventListener('click',e=>{const b=e.target.closest('.invoice-result');if(!b)return;projectIdInput.value=b.dataset.id||'';projectSearch.value=b.dataset.id?projects.find(pr=>String(pr.id)===String(b.dataset.id))?.name||'':'';projectResults.hidden=true;});
    [customerSearch,projectSearch].forEach(inp=>inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();const list=inp===customerSearch?customerResults:projectResults;list.querySelector('.invoice-result')?.click();}else if(e.key==='Escape'){(inp===customerSearch?customerResults:projectResults).hidden=true;}}));
    const addRow = (item=null) => {
      counter++; const row=document.createElement('div'); row.className='card card-pad invoice-row';
      row.innerHTML=`<div class="row-top"><span class="row-index">${num(counter)}</span><div class="invoice-search-wrap"><input class="item-search" autocomplete="off" aria-label="کالا یا خدمت" placeholder="نام کالا یا خدمت…" value="${esc(item?.name||'')}"><div class="invoice-results" hidden></div></div><button type="button" class="btn-remove" aria-label="حذف ردیف">×</button></div><div class="selected-item" ${item?'':'hidden'}><span class="selected-name">${esc(item?.name||'')}</span><small class="selected-type">${item?(item.type==='product'?'کالا':item.type==='service'?'خدمت':'قلم دستی'):''}</small><button type="button" class="selected-change" aria-label="تغییر انتخاب">تغییر</button></div><small class="manual-item-badge" hidden>قلم دستی</small><div class="row-bottom"><div class="qty-stepper"><button type="button" class="qty-dec" aria-label="کاهش تعداد">−</button><input class="qty" type="text" inputmode="decimal" aria-label="تعداد" value="${item?.quantity??1}"><button type="button" class="qty-inc" aria-label="افزایش تعداد">+</button></div><input class="price" type="text" inputmode="numeric" aria-label="قیمت واحد" placeholder="قیمت واحد" value="${item?.unitPrice??0}"><output class="line-total">۰</output><button type="button" class="row-extras-toggle" aria-label="تخفیف ردیف" aria-expanded="${!!item?.discount}">٪</button></div><div class="row-extras" ${item?.discount?'':'hidden'}><select class="rdtype" aria-label="نوع تخفیف"><option value="amount" ${(item?.discountType||'amount')==='amount'?'selected':''}>مبلغ</option><option value="percent" ${item?.discountType==='percent'?'selected':''}>درصد</option></select><input class="rdisc amount-input" type="text" inputmode="numeric" aria-label="تخفیف ردیف" placeholder="تخفیف ردیف" value="${item?.discountInput ?? item?.discount ?? 0}"></div><div class="stock-hint" hidden></div>`
      row._item=item?{...(catalog.find(x=>String(x.id)===String(item.id??item.itemId)&&x.type===(item.type||'product'))||{}),...item,id:item.id ?? item.itemId ?? null}:null; itemsEl.appendChild(row);
      const search=row.querySelector('.item-search'), results=row.querySelector('.invoice-results');
      const renderResults=q=>{const s=(q||'').trim().toLocaleLowerCase('fa-IR');const found=catalog.filter(x=>!s||x.name.toLocaleLowerCase('fa-IR').includes(s)).slice(0,8);results.innerHTML=found.map(x=>`<button type="button" class="invoice-result" data-id="${x.id}" data-type="${x.type}"><span>${esc(x.name)}<small>${x.type==='product'?'کالا':'خدمت'} · ${esc(x.unit)}${x.type==='product'?` · موجودی ${num(x.stock)}`:''}</small></span><strong>${money(x.price)}</strong></button>`).join('')||`<div class="hint empty-result">موردی پیدا نشد.</div>`;results.hidden=false;};
      search.oninput=()=>{if(row._item && search.value.trim()!==String(row._item.name||'').trim()){row._item=null;row.querySelector('.selected-item').hidden=true;row.querySelector('.manual-item-badge').hidden=false;} renderResults(search.value);}; search.onfocus=()=>{itemsEl.querySelectorAll('.invoice-results').forEach(el=>{if(el!==results)el.hidden=true;});renderResults(search.value);};
      search.onkeydown=e=>{const opts=[...results.querySelectorAll('.invoice-result')];if(e.key==='Enter'){e.preventDefault();if(!results.hidden&&opts.length)opts[0].click();}else if(e.key==='ArrowDown'){e.preventDefault();opts[0]?.focus();}else if(e.key==='Escape'){e.preventDefault();results.hidden=true;}};
      results.addEventListener('keydown',e=>{const opts=[...results.querySelectorAll('.invoice-result')],i=opts.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();opts[Math.max(0,Math.min(opts.length-1,i+(e.key==='ArrowDown'?1:-1)))]?.focus();}else if(e.key==='Enter'||e.key===' '){e.preventDefault();document.activeElement.click();}else if(e.key==='Escape'){e.preventDefault();results.hidden=true;search.focus();}});
      const selectResult=b=>{if(!b)return;const found=catalog.find(x=>x.id==b.dataset.id&&x.type===b.dataset.type);if(!found)return;row._item={...found,quantity:1,unitPrice:found.price,discount:0};search.value=found.name;row.querySelector('.selected-item').hidden=false;row.querySelector('.manual-item-badge').hidden=true;row.querySelector('.selected-name').textContent=found.name;row.querySelector('.selected-type').textContent=found.type==='product'?'کالا':'خدمت';row.querySelector('.qty').value='1';row.querySelector('.price').value=String(found.price);results.hidden=true;updateStockHint(row);refreshTotals();setTimeout(()=>{const q=row.querySelector('.qty');q.focus();q.select();},40);};
      results.addEventListener('click',e=>selectResult(e.target.closest('.invoice-result')));
      row.querySelector('.selected-change').onclick=()=>{row._item=null;search.value='';row.querySelector('.selected-item').hidden=true;row.querySelector('.manual-item-badge').hidden=true;renderResults('');search.focus();};
      const stepQty=dir=>{const q=row.querySelector('.qty');q.value=String(Math.max(0,(Number(toNumber(q.value))||0)+dir));updateStockHint(row);refreshTotals();};
      row.querySelector('.qty-inc').onclick=()=>stepQty(1);row.querySelector('.qty-dec').onclick=()=>stepQty(-1);
      let holdTimer=null,holdInterval=null;const startHold=dir=>{holdTimer=setTimeout(()=>{holdInterval=setInterval(()=>stepQty(dir*5),100);},300);};const endHold=()=>{clearTimeout(holdTimer);clearInterval(holdInterval);holdTimer=holdInterval=null;};
      row.querySelectorAll('.qty-inc,.qty-dec').forEach((b,i)=>{const dir=i===0?1:-1;b.addEventListener('pointerdown',()=>startHold(dir));['pointerup','pointerleave','pointercancel'].forEach(ev=>b.addEventListener(ev,endHold));});
      row.querySelector('.row-extras-toggle').onclick=e=>{const extras=row.querySelector('.row-extras');extras.hidden=!extras.hidden;e.currentTarget.setAttribute('aria-expanded',String(!extras.hidden));};
      row.querySelectorAll('input,select').forEach(i=>{i.addEventListener('input',()=>{updateStockHint(row);refreshTotals();});i.addEventListener('change',()=>{updateStockHint(row);refreshTotals();});if(i.classList.contains('qty'))bindAmountInput(i,{allowDecimal:true});else if(i.classList.contains('price')||i.classList.contains('rdisc'))bindAmountInput(i,{allowDecimal:false});});
      row.querySelectorAll('.price,.rdisc,.rdtype').forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Enter')e.preventDefault();}));
      row.querySelector('.qty').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addRow();const next=itemsEl.lastElementChild.querySelector('.item-search');setTimeout(()=>{next.focus();next.scrollIntoView({block:'center',behavior:'smooth'});},80);}});
      row.querySelector('.btn-remove').onclick=()=>{row.remove();refreshTotals();}; if(!item)setTimeout(()=>search.focus(),20);
    };
    const updateStockHint=row=>{const hint=row.querySelector('.stock-hint'),qtyInput=row.querySelector('.qty'),it=row._item;if(!it||it.type!=='product'){hint.hidden=true;qtyInput.removeAttribute('aria-invalid');return;}const qty=toNumber(qtyInput.value),stock=Number(it.stock)||0;hint.hidden=false;hint.className='stock-hint'+(qty>stock?' danger':'');hint.textContent=qty>stock?`موجودی: ${num(stock)}، درخواستی: ${num(qty)}`:`موجودی: ${num(stock)} ${it.unit||'عدد'}`;if(qty>stock)qtyInput.setAttribute('aria-invalid','true');else qtyInput.removeAttribute('aria-invalid');};
    const readItems=()=>[...itemsEl.querySelectorAll('.invoice-row')].map(row=>{const it=row._item||{};const manual=!row._item;return {type:manual?'manual':(it.type||'product'),itemId:it.id??it.itemId??null,name:row.querySelector('.item-search').value.trim(),unit:it.unit||'مورد',quantity:toNumber(row.querySelector('.qty').value),unitPrice:toNumber(row.querySelector('.price').value),discountType:row.querySelector('.rdtype')?.value||it.discountType||'amount',discountInput:toNumber(row.querySelector('.rdisc').value),discount:toNumber(row.querySelector('.rdisc').value)};});
    const refreshTotals=()=>{
      const its=readItems();
      const d=toNumber(f.discount.value);
      const extra=toNumber(f.extraCosts?.value);
      const z=calculateTotals(its,d,taxEnabled,taxPercent,f.discountType?.value||'amount',extra);
      m.querySelector('#subtotal').textContent=money(z.subtotal);
      m.querySelector('#discount-preview').textContent=money(z.discountTotal);
      m.querySelector('#sum').textContent=money(z.total);
      m.querySelector('#sticky-sum').textContent=money(z.total);
      const footerMeta=m.querySelector('#footer-meta');if(footerMeta)footerMeta.textContent=`${num(itemsEl.querySelectorAll('.invoice-row').length)} ردیف`;const words=m.querySelector('#sticky-words');if(words)words.textContent=amountToWordsFa(z.total);
      [...itemsEl.querySelectorAll('.invoice-row')].forEach((r,i)=>{const idx=r.querySelector('.row-index');if(idx)idx.textContent=num(i+1);r.dataset.rowN=String(i);const q=toNumber(r.querySelector('.qty')?.value),p=toNumber(r.querySelector('.price')?.value);const out=r.querySelector('.line-total');if(out)out.textContent=money(Math.max(0,q*p));});
      if(taxEnabled){m.querySelector('#tax-preview').value=money(z.tax);m.querySelector('#tax-total').textContent=money(z.tax);}
      const label=m.querySelector('#discount-label'); if(label) label.textContent=f.discountType.value==='percent'?'تخفیف کلی (٪)':'تخفیف کلی (ریال)';
      return z;
    };
    if(existing?.items?.length) existing.items.forEach(addRow); else addRow();
    itemsEl.querySelectorAll('.invoice-row').forEach(updateStockHint);
    const applyDraft=d=>{itemsEl.innerHTML='';for(const saved of d.items||[]){const r=addRow(saved.item||null);r.querySelector('.item-search').value=saved.name||saved.item?.name||'';r.querySelector('.qty').value=saved.qty??1;r.querySelector('.price').value=saved.price??0;r.querySelector('.rdtype').value=saved.discountType||'amount';r.querySelector('.rdisc').value=saved.discount??0;if(!saved.item&&saved.name)r.querySelector('.manual-item-badge').hidden=false;updateStockHint(r);}if(!itemsEl.children.length)addRow();for(const key of ['customerId','projectId','status','discountType','discount','extraCosts','paidAmount','notes','jYear','jMonth','jDay']){const el=f.elements.namedItem(key);if(el&&d[key]!==undefined)el.value=d[key];}syncJalaliDate();if(d.date)dateHidden.value=d.date;syncDraftPayment();refreshTotals();};
    if(recoveryDraft){m.querySelector('#recover-invoice-draft').onclick=()=>{applyDraft(recoveryDraft);m.querySelector('#invoice-draft-recovery').hidden=true;try{localStorage.removeItem('dia.invoice.draft');}catch{};};m.querySelector('#discard-invoice-draft').onclick=()=>{try{localStorage.removeItem('dia.invoice.draft');}catch{};m.querySelector('#invoice-draft-recovery').remove();};}
    let draftSaveTimer=null;
    const persistDraft=()=>{if(existing)return;clearTimeout(draftSaveTimer);draftSaveTimer=setTimeout(()=>{try{const d={savedAt:Date.now(),date:dateHidden.value};for(const key of ['customerId','projectId','status','discountType','discount','extraCosts','paidAmount','notes','jYear','jMonth','jDay']){const el=f.elements.namedItem(key);if(el)d[key]=el.value;}d.items=[...itemsEl.querySelectorAll('.invoice-row')].map(r=>({name:r.querySelector('.item-search').value,qty:r.querySelector('.qty').value,price:r.querySelector('.price').value,discountType:r.querySelector('.rdtype').value,discount:r.querySelector('.rdisc').value,item:r._item||null}));localStorage.setItem('dia.invoice.draft',JSON.stringify(d));}catch{}} ,500);};
    f.addEventListener('input',persistDraft);f.addEventListener('change',persistDraft);
    m.querySelector('#add-item').onclick=()=>{addRow();const row=itemsEl.lastElementChild;setTimeout(()=>{row.scrollIntoView({block:'center',behavior:'smooth'});row.querySelector('.item-search').focus();},80);};
    m.querySelector('#footer-add-row').onclick=()=>{addRow();const row=itemsEl.lastElementChild;setTimeout(()=>{row.scrollIntoView({block:'center',behavior:'smooth'});row.querySelector('.item-search').focus();},80);};
    [f.discount,f.extraCosts,f.paidAmount].filter(Boolean).forEach(i=>bindAmountInput(i,{allowDecimal:false}));
    f.discount.addEventListener('input',refreshTotals); f.extraCosts?.addEventListener('input',refreshTotals); f.discountType?.addEventListener('change',()=>{f.discount.value='';refreshTotals();});
    const statusSelect=f.querySelector('[name="status"]'), paidHint=m.querySelector('#paid-hint');
    const syncDraftPayment=()=>{const draft=!existing&&statusSelect.value==='draft';f.paidAmount.disabled=draft;if(paidHint)paidHint.textContent=draft?'پیش‌نویس پرداخت نمی‌گیرد.':'پرداخت‌های ثبت‌شده از گردش حساب خوانده می‌شوند.';};
    statusSelect.addEventListener('change',syncDraftPayment);syncDraftPayment();
    const footer=m.querySelector('.sticky-invoice-footer'), vv=window.visualViewport;
    const fixFooter=()=>{if(!footer||!vv)return;const kb=Math.max(0,window.innerHeight-vv.height-vv.offsetTop);footer.style.bottom=`${kb}px`;footer.style.paddingBottom=kb>0?'8px':'max(10px, env(safe-area-inset-bottom))';};
    const cleanupViewport=()=>{if(vv){vv.removeEventListener('resize',fixFooter);vv.removeEventListener('scroll',fixFooter);}};
    if(vv){vv.addEventListener('resize',fixFooter);vv.addEventListener('scroll',fixFooter);fixFooter();window.addEventListener('hashchange',cleanupViewport,{once:true});}
    let saveNextRequested=false;
    m.querySelector('.close').onclick=()=>{cleanupViewport();closeModal();};
    m.querySelector('#save-invoice').onclick=()=>{saveNextRequested=false;f.requestSubmit();};
    m.querySelector('#save-next')?.addEventListener('click',()=>{saveNextRequested=true;f.requestSubmit();});
    refreshTotals();
    const submitButtons=[...m.querySelectorAll('#save-invoice,#save-next')];
    const resetSubmitButtons=()=>submitButtons.forEach(btn=>{btn.disabled=false;if(btn.dataset.originalText!==undefined){btn.innerHTML=btn.dataset.originalText;delete btn.dataset.originalText;}});
    f.onsubmit=guardSubmit(async()=>{
      const isSaveNext=saveNextRequested;saveNextRequested=false;
      submitButtons.forEach(btn=>{btn.disabled=true;btn.dataset.originalText=btn.innerHTML;btn.innerHTML='<span class="spinner" aria-hidden="true"></span> در حال ثبت…';});
      try{
      const its=readItems(),rawDiscount=toNumber(f.discount.value),rawExtra=toNumber(f.extraCosts?.value),fd=Object.fromEntries(new FormData(f));
      const z=calculateTotals(its,rawDiscount,taxEnabled,taxPercent,fd.discountType||'amount',rawExtra);
      // the paid field must be a whole, non-negative Rial amount (validated on the raw text, never silently coerced)
      if(showValidationErrors(f,validateAmount((!existing&&fd.status==='draft')?'0':fd.paidAmount,'paidAmount',{allowDecimal:false})))return;
      const paidAmount=(!existing&&fd.status==='draft')?0:toMoney(fd.paidAmount);
      const before=existing?invoiceSnapshot(existing,transactions,allocations):null, recorded=before?before.paid:0;
      const derived=(!existing&&fd.status==='draft')?'draft':deriveInvoiceStatus(fd.status,paidAmount,z.total);
      const data={invoiceNumber:existing?.number||nextNumber().number,customerId:fd.customerId?Number(fd.customerId):null,projectId:fd.projectId?Number(fd.projectId):null,date:fd.date,items:z.items.map(({lineSubtotal,...i})=>i),discount:z.discountTotal,discountType:z.discountType,discountInput:z.discountInput,extraCosts:z.extraCosts,tax:z.tax,paidAmount,status:derived,total:z.total,remainingAmount:z.remainingAmount,allowOverpayment:false};
      // money policy lives in finance.js: paid can never go down, total can never drop below what was received, no silent truncation
      const policyError=existing?checkInvoiceSave({existing,snapshot:before,newTotal:z.total,paidInput:paidAmount,finalStatus:fd.status==='cancelled'?'cancelled':derived,customerId:data.customerId,projectId:data.projectId}):null;
      if(policyError){toast(policyError,'error');return;}
      const v=validateInvoice(data);
      // Item validation errors are rendered beside the offending row/field instead of being lost in a generic toast.
      const itemErrors=v.errors.filter(err=>/^items\[\d+\]\./.test(err.field));
      const otherErrors=v.errors.filter(err=>!/^items\[\d+\]\./.test(err.field));
      let itemInvalid=false;
      itemsEl.querySelectorAll('.field-error').forEach(el=>el.remove());
      itemsEl.querySelectorAll('.invoice-row').forEach(r=>{r.removeAttribute('aria-invalid');r.querySelectorAll('[aria-invalid="true"]').forEach(el=>el.removeAttribute('aria-invalid'));});
      itemErrors.forEach(err=>{const match=err.field.match(/^items\[(\d+)\]\.(.+)$/);if(!match)return;const row=itemsEl.querySelectorAll('.invoice-row')[Number(match[1])];if(!row)return;itemInvalid=true;row.setAttribute('aria-invalid','true');const fieldMap={quantity:'.qty',unitPrice:'.price',discount:'.rdisc',discountInput:'.rdisc',name:'.item-search',itemId:'.item-search',type:'.item-search'};const target=row.querySelector(fieldMap[match[2]]||'.item-search');target?.setAttribute('aria-invalid','true');const wrap=target?.closest('.field')||row;const msg=document.createElement('div');msg.className='field-error';msg.textContent=err.message;wrap.appendChild(msg);});
      if(itemInvalid){const bad=itemsEl.querySelector('[aria-invalid="true"]');bad?.scrollIntoView({block:'center',behavior:'smooth'});}
      if(showValidationErrors(f,{valid:otherErrors.length===0,errors:otherErrors}))return;
      if(itemInvalid){toast('خطاهای اقلام مشخص شده‌اند؛ لطفاً همان ردیف‌ها را اصلاح کنید.','error');return;}
      if(!existing&&findDuplicate(rows,'number',data.invoiceNumber)){toast('شماره فاکتور تکراری است.','error');return;}
      const customer=customers.find(c=>c.id===data.customerId);
      const finalPaid=Math.max(recorded,paidAmount), delta=Math.max(0,finalPaid-recorded);
      const finalStatus=(!existing&&fd.status==='draft')?'draft':deriveInvoiceStatus(fd.status,finalPaid,z.total);
      const row={...(existing||{}),number:data.invoiceNumber,seq:existing?.seq||nextNumber().seq,customerId:data.customerId,projectId:data.projectId,customerName:customer?.name||'مشتری آزاد',items:data.items,discount:data.discount,discountType:data.discountType,discountInput:data.discountInput,extraCosts:data.extraCosts,tax:data.tax,taxableAmount:z.taxableAmount,taxEnabled,taxPercent,total:data.total,paidAmount:finalPaid,remainingAmount:finalStatus==='cancelled'?0:Math.max(0,z.total-finalPaid),status:finalStatus,notes:fd.notes||'',date:data.date,createdAt:existing?.createdAt||Date.now()};
      // payment date: creating an invoice => the invoice date; adding a payment while editing => today (when the money really arrived)
      const payment=delta>0?{type:'customer_payment',amount:delta,customerId:data.customerId,party:customer?.name||'مشتری آزاد',description:existing?'دریافت هنگام ویرایش فاکتور':'دریافت هنگام ثبت فاکتور',projectId:row.projectId||null,date:existing?todayISO():data.date}:null;
      // inventory: new invoices are tracked from now on; legacy (pre-ledger) invoices stay untracked and never touch stock
      if(!existing) row.stockTracked=true;
      const sp=planInvoiceStock({invoice:row,invoiceId:existing?.id??null,movements,products,date:todayISO()});
      if(!sp.ok){if(sp.shortages?.length){sp.shortages.forEach(sh=>{const r=[...itemsEl.querySelectorAll('.invoice-row')].find(x=>String(x._item?.id)===String(sh.productId));if(!r)return;const q=r.querySelector('.qty');q.setAttribute('aria-invalid','true');let hint=r.querySelector('.stock-hint');if(!hint){hint=document.createElement('div');hint.className='stock-hint danger';r.appendChild(hint);}hint.hidden=false;hint.className='stock-hint danger';hint.textContent=`موجودی: ${num(sh.available)}، درخواستی: ${num(sh.needed)}`;r.scrollIntoView({block:'center'});});}toast(sp.error,'error');return;}
      if(existing){
        const ops=[{store:'invoices',action:'put',data:row},...movementOps(sp.drafts),...stockCacheOps(products,movements,sp.drafts)];
        // legacy invoice (paidAmount without payment transactions): convert it ONCE into a real payment so it is never counted twice
        if(before.linkedCount===0&&before.legacyPaid>0) ops.push({store:'transactions',action:'add',data:legacyMigrationTx(existing,existing.customerName||customer?.name)});
        if(payment) ops.push({store:'transactions',action:'add',data:{...payment,invoiceId:existing.id}});
        await DB.atomic(ops);
      } else {
        row.id=await DB.saveInvoiceWithPayment(row,payment,sp.drafts,stockCacheOps(products,movements,sp.drafts));
      }
      cleanupViewport();if(!existing){try{localStorage.removeItem('dia.invoice.draft');}catch{};rows.push(row);}closeModal();toast(existing?'فاکتور ویرایش شد':'فاکتور ثبت شد');if(isSaveNext&&!existing){presetProject=row.projectId||null;form(row.customerId,null);}else navigate(`#/invoices/${row.id}`);
      }finally{resetSubmitButtons();}
    });
  }
}

export async function renderInvoiceDetail(App, params) {
  const id=Number(params.id);
  const [invoice,settings,customer,transactions,projects,allocations,movements,products]=await Promise.all([DB.get('invoices',id),getSettings(), DB.get('customers', id), DB.all('transactions'), DB.all('projects'), DB.all('paymentAllocations'), DB.all('stockMovements'), DB.all('products')]);
  if(!invoice){
    App.setView(`${emptyState('فاکتور پیدا نشد','این فاکتور وجود ندارد.')}<button class="btn btn-secondary" data-route="#/invoices">بازگشت به فاکتورها</button>`);
    return;
  }
  const [allCustomers]=await Promise.all([DB.all('customers')]);
  const actualCustomer=allCustomers.find(c=>String(c.id)===String(invoice.customerId))||null;
  const actualProject=projects.find(p=>String(p.id)===String(invoice.projectId))||null;
  const taxEnabled=invoice.taxEnabled ?? (Number(invoice.tax||0)>0);
  const taxPercent=Number(invoice.taxPercent ?? (taxEnabled && Number(invoice.taxableAmount||0)>0 ? (Number(invoice.tax||0)/Number(invoice.taxableAmount||1))*100 : settings.taxPercent)) || 0;
  const computed=calculateTotals(invoice.items||[],invoice.discountInput ?? invoice.discount ?? 0,taxEnabled,taxPercent,invoice.discountType||'amount',invoice.extraCosts||0);
  const storedTotal=Number.isFinite(Number(invoice.total)) ? Number(invoice.total) : computed.total;
  const snap=invoiceSnapshot({...invoice,total:storedTotal},transactions,allocations);
  const effectivePaid=snap.paid;
  const displayInvoice={...invoice,taxEnabled,taxPercent,total:storedTotal,paidAmount:effectivePaid,discount:Number.isFinite(Number(invoice.discount))?Number(invoice.discount):computed.discount,tax:Number.isFinite(Number(invoice.tax))?Number(invoice.tax):computed.tax,taxableAmount:Number.isFinite(Number(invoice.taxableAmount))?Number(invoice.taxableAmount):computed.taxableAmount,status:snap.status};
  const balance=snap.remaining;
  const bookedMap=bookedForInvoice(invoice.id,movements);
  const canReturnGoods=invoice.stockTracked===true&&invoiceStockActive(invoice.status)&&[...bookedMap.values()].some(v=>v>0);
  App.setView(`${pageHeader('فاکتور',{back:true,subtitle:`شماره ${invoice.number}`})}
    <div class="invoice-action-bar">
      <div class="invoice-action-status"><span class="badge badge-${invoiceStatusClass(displayInvoice.status)}">${faLabel(INVOICE_STATUS_LABELS,displayInvoice.status)}</span><strong class="invoice-detail-total">${money(displayInvoice.total)}</strong><small>${balance?`مانده ${money(balance)}`:'تسویه کامل'}${snap.refunded>0?` · برگشت وجه ${money(snap.refunded)}`:''}</small></div>
      <div class="invoice-action-buttons">
        <button class="btn btn-primary" id="print-invoice">${icon('printer','')}چاپ A4</button>
        <button class="btn btn-secondary" id="image-invoice">${icon('image','')}تصویر / اشتراک</button>
        ${displayInvoice.status!=='cancelled'&&balance>0?`<button class="btn btn-secondary" id="payment-invoice">${icon('wallet','')}ثبت دریافت</button>`:''}
        ${snap.paid>0?`<button class="btn btn-ghost" id="refund-invoice">${icon('wallet','')}برگشت وجه</button>`:''}
        ${canReturnGoods?`<button class="btn btn-ghost" id="return-invoice">${icon('box','')}برگشت کالا</button>`:''}
        <button class="btn btn-ghost" id="edit-invoice">${icon('edit','')}ویرایش</button>
      </div>
    </div>
    <div class="invoice-finance-strip">
      <div><small>مبلغ فاکتور</small><strong>${money(displayInvoice.total)}</strong></div>
      <div><small>دریافت‌شده</small><strong class="green">${money(effectivePaid)}</strong></div>
      <div><small>مانده</small><strong class="${balance?'red':'green'}">${money(balance)}</strong></div>
      <div><small>برگشت وجه</small><strong>${money(snap.refunded)}</strong></div>
    </div>
    <div class="invoice-feature-hint"><span>${icon('check','')}</span><span><strong>فاکتور آماده استفاده است</strong><small>چاپ A4، خروجی تصویر برای اشتراک، ثبت دریافت و مدیریت برگشت‌ها از همین صفحه در دسترس است.</small></span></div>
    <article id="invoice-print" class="invoice-paper detail-invoice">${invoiceMarkup(displayInvoice,settings,actualCustomer,actualProject)}</article>`);
  document.querySelector('[data-back]')?.addEventListener('click',()=>history.length>1?history.back():navigate('#/invoices'));
  document.getElementById('print-invoice').onclick=()=>printWithClass('printing-invoice');
  document.getElementById('image-invoice').onclick=async()=>{try{const r=await invoiceToImage(document.getElementById('invoice-print'),`DIA-Invoice-${invoice.number}.png`);if(r?.shared)toast('تصویر فاکتور برای اشتراک آماده شد');else if(r?.downloaded)toast('تصویر فاکتور آماده شد');}catch(e){toast(e.message||'خروجی تصویر ناموفق بود','error');}};
  document.getElementById('edit-invoice').onclick=()=>editInvoice(displayInvoice);
  document.getElementById('payment-invoice')?.addEventListener('click',()=>openPaymentModal(displayInvoice));
  document.getElementById('refund-invoice')?.addEventListener('click',()=>openRefundModal({invoiceId:invoice.id,onDone:()=>renderInvoiceDetail(App,{id:invoice.id})}));
  document.getElementById('return-invoice')?.addEventListener('click',()=>openReturnModal());
  function openReturnModal(){
    const lines=[...bookedMap.entries()].filter(([,q])=>q>0).map(([pid,q])=>({pid,q,p:products.find(x=>String(x.id)===pid)}));
    const token=newToken();
    const m=openModal(`<div class="modal-head"><h3>برگشت کالا از فروش</h3><button class="close">${icon('x','')}</button></div><form id="return-form" class="form-grid" novalidate><div class="field full"><label>کالا</label><select name="productId">${lines.map(l=>`<option value="${l.pid}">${esc(l.p?.name||'کالا')} — قابل برگشت ${num(l.q)}</option>`).join('')}</select></div><div class="field full"><label>مقدار برگشتی</label><input name="quantity" type="text" inputmode="decimal" autofocus></div><div class="field full"><small class="field-hint">این ثبت فقط موجودی کالا را اصلاح می‌کند. برگشت پول به مشتری جداگانه با «برگشت وجه» ثبت می‌شود.</small></div><div class="field full"><button class="btn btn-primary btn-block">${icon('check','')}ثبت برگشت کالا</button></div></form>`);
    const f=m.querySelector('#return-form');m.querySelector('.close').onclick=closeModal;
    f.onsubmit=guardSubmit(async()=>{
      if(showValidationErrors(f,validateAmount(f.quantity.value,'quantity',{required:true,allowZero:false})))return;
      const [fm,fp]=await Promise.all([DB.all('stockMovements'),DB.all('products')]);
      const realProductId=(fp.find(x=>String(x.id)===String(f.productId.value))||{}).id??f.productId.value;
      const plan=planSalesReturn({invoice,invoiceId:invoice.id,productId:realProductId,quantity:toNumber(f.quantity.value),movements:fm,date:todayISO(),token});
      if(!plan.ok){toast(plan.error,'error');return;}
      await DB.atomic([...movementOps(plan.drafts),...stockCacheOps(fp,fm,plan.drafts)]);
      closeModal();toast('برگشت کالا ثبت شد');renderInvoiceDetail(App,{id:invoice.id});
    });
  }
  function openPaymentModal(current){
    const remaining=invoiceSnapshot(current,transactions,allocations).remaining;
    const m=openModal(`<div class="modal-head"><h3>ثبت دریافت</h3><button class="close">${icon('x','')}</button></div><form id="payment-form" class="form-grid" novalidate><div class="field full"><label>مانده فاکتور</label><input value="${money(remaining)}" disabled></div><div class="field full"><label>مبلغ دریافت</label><input name="amount" type="text" inputmode="decimal" autofocus value="${remaining||''}"></div><div class="field full"><label>توضیحات</label><input name="notes" placeholder="مثلاً کارت به کارت"></div><div class="field full"><button class="btn btn-primary btn-block">${icon('check','')}ثبت دریافت</button></div></form>`);
    const f=m.querySelector('#payment-form');m.querySelector('.close').onclick=closeModal;
    f.onsubmit=guardSubmit(async()=>{
      const fd=new FormData(f);
      if(showValidationErrors(f,validateAmount(fd.get('amount'),'amount',{required:true,allowZero:false,allowDecimal:false})))return;
      const customerName=actualCustomer?.name||current.customerName||'مشتری آزاد';
      // one central planner: policy (no overpayment / cancelled), legacy migration (no double count) and cache update, all atomic
      const plan=planInvoicePayment({invoice:current,transactions,allocations,amount:toMoney(fd.get('amount')),date:todayISO(),description:fd.get('notes')||`دریافت فاکتور ${current.number}`,customerName});
      if(!plan.ok){toast(plan.error,'error');return;}
      await DB.atomic(plan.ops);closeModal();toast('دریافت ثبت شد');renderInvoiceDetail(App,{id:current.id});
    });
  }
  document.querySelectorAll('[data-route]').forEach(b=>b.onclick=e=>{e.preventDefault();navigate(b.dataset.route)});
}

async function editInvoice(invoice){ navigate(`#/invoices?edit=${encodeURIComponent(invoice.id)}`); }

function invoiceMarkup(x,settings,customer=null,project=null){
  const items=(x.items||[]).map((i,k)=>({
    index:k+1,name:i.name||'—',qty:Number(i.quantity)||0,unit:i.unit||'مورد',unitPrice:Number(i.unitPrice)||0,discount:Number(i.discount)||0,
    total:Math.max(0,(Number(i.quantity)||0)*(Number(i.unitPrice)||0)-(Number(i.discount)||0))
  }));
  const subtotal=items.reduce((s,i)=>s+i.total,0);
  const paid=Math.max(0,Number(x.paidAmount)||0);
  const balance=Math.max(0,(Number(x.total)||0)-paid);
  const sellerLines=[settings.phone,settings.address].filter(Boolean);
  const customerLines=[customer?.phone||customer?.mobile,customer?.address].filter(Boolean);
  return `<div class="invoice-brand-row invoice-brand-row-classic">
      <div class="invoice-side-label"><span>نسخه مشتری</span><small>سیستم حسابداری DIA</small></div>
      <div class="invoice-brand">
        <img class="invoice-logo" src="./assets/apple-touch-icon.png" alt="">
        <div><div class="invoice-business-name">${esc(settings.businessName||'DIA Sanat')}</div><div class="invoice-business-sub">${esc(settings.ownerName||'تأسیسات الکتریکی و نورپردازی')}</div></div>
      </div>
      <div class="invoice-title-block"><div class="invoice-doc-label">فاکتور فروش</div><div class="invoice-doc-number">شماره: <strong>${esc(x.number)}</strong></div></div>
    </div>
    <div class="invoice-document-title"><div class="invoice-doc-label">فاکتور فروش</div><div class="invoice-doc-number">شماره: <strong>${esc(x.number)}</strong></div></div>
    <div class="invoice-accent"></div>
    <div class="invoice-parties-grid">
      <div class="invoice-party-card"><div class="invoice-party-title">فروشنده</div><strong>${esc(settings.businessName||'DIA Sanat')}</strong>${sellerLines.map(v=>`<span>${esc(v)}</span>`).join('')}</div>
      <div class="invoice-party-card"><div class="invoice-party-title">خریدار / طرف حساب</div><strong>${esc(x.customerName||customer?.name||'مشتری آزاد')}</strong>${customerLines.map(v=>`<span>${esc(v)}</span>`).join('')}</div>
      <div class="invoice-meta-card"><div><span>تاریخ</span><strong>${dateFa(x.date||x.createdAt)}</strong></div><div><span>وضعیت</span><strong>${faLabel(INVOICE_STATUS_LABELS,x.status)}</strong></div></div>
    </div>
    ${project?`<div class="invoice-project-card"><div><span>پروژه</span><strong>${esc(project.name)}</strong></div>${project.location||project.address?`<div><span>موقعیت / آدرس</span><strong>${esc(project.location||project.address)}</strong></div>`:''}${project.description||project.notes?`<div class="project-description"><span>شرح پروژه</span><strong>${esc(project.description||project.notes)}</strong></div>`:''}</div>`:''}
    <div class="invoice-section-label">شرح کالا و خدمات</div>
    <div class="invoice-table-wrap"><table class="invoice-table clean-invoice-table"><thead><tr><th class="col-index">ردیف</th><th>شرح کالا / خدمت</th><th class="num-col">تعداد</th><th class="unit-col">واحد</th><th class="money-col">قیمت واحد</th><th class="money-col discount-col">تخفیف</th><th class="money-col">مبلغ</th></tr></thead><tbody>${items.length?items.map(i=>`<tr><td class="col-index">${num(i.index)}</td><td class="item-name">${esc(i.name)}</td><td class="num-col">${num(i.qty)}</td><td class="unit-col">${esc(i.unit)}</td><td class="money-col">${money(i.unitPrice,'')}</td><td class="money-col discount-col">${money(i.discount,'')}</td><td class="money-col total-col">${money(i.total,'')}</td></tr>`).join(''):`<tr><td colspan="7" class="invoice-empty-row">موردی برای نمایش ثبت نشده است.</td></tr>`}</tbody></table></div>
    <div class="invoice-bottom-grid">
      <div class="invoice-words-block"><span>مبلغ به حروف</span><strong>${esc(amountToWordsFa(x.total))}</strong>${x.notes?`<div class="invoice-notes-block"><span>توضیحات و شرایط</span><p>${esc(x.notes)}</p></div>`:''}</div>
      <div class="invoice-summary-box">
        <div><span>جمع اقلام</span><strong>${money(subtotal)}</strong></div>
        <div><span>تخفیف کلی</span><strong>${money(x.discount||0)}</strong></div>
        ${x.taxEnabled?`<div><span>مالیات ${num(x.taxPercent||0)}٪</span><strong>${money(x.tax||0)}</strong></div>`:''}
        ${(Number(x.extraCosts)||0)>0?`<div><span>هزینه‌های جانبی</span><strong>${money(x.extraCosts)}</strong></div>`:''}
        <div class="grand"><span>مبلغ نهایی</span><strong>${money(x.total)}</strong></div>
        <div><span>پرداخت‌شده</span><strong class="green">${money(paid)}</strong></div>
        <div class="balance-row"><span>مانده</span><strong class="${balance?'red':'green'}">${money(balance)}</strong></div>
      </div>
    </div>
    <div class="invoice-payment-note"><strong>وضعیت پرداخت:</strong> ${balance?'این فاکتور دارای مانده است.':'این فاکتور تسویه شده است.'}</div>
    <div class="invoice-footer-note">${esc(settings.invoiceNote||'از انتخاب شما سپاسگزاریم.')}</div>
    <div class="invoice-signatures"><div><span>امضای خریدار</span><div></div></div><div><span>مهر و امضای فروشنده</span><div></div></div></div>`;
}
