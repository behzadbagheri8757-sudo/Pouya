// Stock movement UI (purchase / adjustment / project consumption + history). All rules are in inventory.js.
import { DB } from '../db.js';
import { money, num, esc, toast, icon, guardSubmit, showValidationErrors, todayISO, newToken, dateFa } from '../utils.js';
import { validateAmount, toNumber, toMoney } from '../validators.js';
import { planManualMovement, movementOps, stockCacheOps, stockOf, MOVEMENT_SOURCE_LABELS } from '../inventory.js';
import { openModal, closeModal } from '../components.js';

const KIND_LABELS = { purchase: 'خرید / ورود به انبار', adjust_in: 'تعدیل مثبت (افزایش)', adjust_out: 'تعدیل منفی (کاهش)', project_use: 'مصرف در پروژه', project_return: 'برگشت از پروژه به انبار' };

export async function openStockMovementModal({ productId = null, projectId = null, kind = null, onDone } = {}) {
  const [products, projects, movements] = await Promise.all([DB.all('products'), DB.all('projects'), DB.all('stockMovements')]);
  const usable = products.filter(p => !p.archived || String(p.id) === String(productId));
  if (!usable.length) { toast('ابتدا یک کالا ثبت کنید.', 'error'); return; }
  const token = newToken();
  const startKind = kind || (projectId != null ? 'project_use' : 'purchase');
  const m = openModal(`<div class="modal-head"><h3>حرکت موجودی</h3><button class="close">${icon('x', '')}</button></div>
    <form id="stock-form" class="form-grid" novalidate>
      <div class="field full"><label>کالا</label><select name="productId">${usable.map(p => `<option value="${p.id}" ${String(p.id) === String(productId) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field full"><label>موجودی فعلی (از دفتر موجودی)</label><input id="stock-now" disabled></div>
      <div class="field full"><label>نوع حرکت</label><select name="kind">${Object.entries(KIND_LABELS).map(([k, v]) => `<option value="${k}" ${k === startKind ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field full" id="project-wrap" hidden><label>پروژه</label><select name="projectId"><option value="">انتخاب پروژه</option>${projects.filter(p => !p.archived || String(p.id) === String(projectId)).map(p => `<option value="${p.id}" ${String(p.id) === String(projectId) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>مقدار</label><input name="quantity" type="text" inputmode="decimal" autofocus></div>
      <div class="field"><label>بهای واحد (ریال)</label><input name="unitCost" type="text" inputmode="decimal"></div>
      <div class="field"><label>تاریخ</label><input name="date" type="date" value="${todayISO()}"></div>
      <div class="field full"><label>توضیحات</label><input name="description"></div>
      <div class="field full"><button class="btn btn-primary btn-block">${icon('check', '')}ثبت حرکت</button></div>
    </form>`);
  const f = m.querySelector('#stock-form');
  m.querySelector('.close').onclick = closeModal;
  const sync = () => {
    const p = products.find(x => String(x.id) === String(f.productId.value));
    m.querySelector('#stock-now').value = p ? `${num(stockOf(p.id, movements))} ${p.unit || 'عدد'}` : '—';
    m.querySelector('#project-wrap').hidden = !f.kind.value.startsWith('project');
    if (!f.unitCost.dataset.touched) f.unitCost.value = p?.purchasePrice ? String(p.purchasePrice) : '';
  };
  f.unitCost.addEventListener('input', () => { f.unitCost.dataset.touched = '1'; });
  f.productId.onchange = () => { delete f.unitCost.dataset.touched; sync(); }; f.kind.onchange = sync; sync();
  f.onsubmit = guardSubmit(async () => {
    const qv = validateAmount(f.quantity.value, 'quantity', { required: true, allowZero: false });
    const cv = validateAmount(f.unitCost.value, 'unitCost', { allowDecimal: false });
    if (showValidationErrors(f, { valid: qv.valid && cv.valid, errors: [...qv.errors, ...cv.errors] })) return;
    // re-read the ledger: the plan must be computed from the current books, not from when the modal opened
    const [fp, fm] = await Promise.all([DB.all('products'), DB.all('stockMovements')]);
    const product = fp.find(x => String(x.id) === String(f.productId.value));
    const plan = planManualMovement({ kind: f.kind.value, product, quantity: toNumber(f.quantity.value), date: f.date.value, projectId: f.projectId.value || null, unitCost: f.unitCost.value.trim() === '' ? undefined : toMoney(f.unitCost.value), description: f.description.value.trim(), movements: fm, token });
    if (!plan.ok) { toast(plan.error, 'error'); return; }
    await DB.atomic([...movementOps(plan.drafts), ...stockCacheOps(fp, fm, plan.drafts)]);
    closeModal(); toast('حرکت موجودی ثبت شد'); onDone?.();
  });
  return m;
}

export async function openStockHistoryModal({ productId }) {
  const [products, movements, projects, invoices] = await Promise.all([DB.all('products'), DB.all('stockMovements'), DB.all('projects'), DB.all('invoices')]);
  const p = products.find(x => String(x.id) === String(productId));
  if (!p) return;
  const rows = movements.filter(x => String(x.productId) === String(productId)).sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.id || 0) - (a.id || 0));
  const ref = x => x.sourceType === 'project' ? ` · ${esc(projects.find(pr => String(pr.id) === String(x.projectId))?.name || 'پروژه')}` : (x.sourceType === 'invoice' || x.sourceType === 'sales_return') ? ` · فاکتور ${esc(invoices.find(i => String(i.id) === String(x.sourceId))?.number || '')}` : '';
  openModal(`<div class="modal-head"><h3>گردش کالا — ${esc(p.name)}</h3><button class="close">${icon('x', '')}</button></div>
    <div class="card card-pad"><div class="invoice-total"><span>موجودی فعلی</span><strong id="history-stock">${num(stockOf(p.id, movements))} ${esc(p.unit || 'عدد')}</strong></div></div>
    <div class="report-list mt-3">${rows.map(x => `<article class="report-row"><span><strong>${esc(MOVEMENT_SOURCE_LABELS[x.sourceType] || x.sourceType)}${ref(x)}</strong><small>${dateFa(x.date)}${x.description ? ' · ' + esc(x.description) : ''}</small></span><b class="${x.direction === 'in' ? 'green' : 'red'}">${x.direction === 'in' ? '+' : '−'} ${num(x.quantity)}</b></article>`).join('') || '<div class="empty">حرکتی ثبت نشده است.</div>'}</div>`);
  document.querySelector('#modal-root .close').onclick = closeModal;
}
