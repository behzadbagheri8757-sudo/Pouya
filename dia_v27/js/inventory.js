// DIA Inventory — the ONE place where stock rules live. Pure functions only (no DOM, no IndexedDB).
//
// Stock ledger model (Phase 2)
// ----------------------------
// * `stockMovements` is the source of truth. products.stock is only a CACHE of the ledger (kept in sync by every write).
// * A movement is immutable history: {productId, quantity>0, direction:'in'|'out', sourceType, sourceId, projectId,
//   date (event date, ISO local day), description, unitCost (Rial, snapshot), reason, key (unique), reversalOf?, createdAt (real time)}.
// * sourceType: opening | purchase | invoice | sales_return | adjustment | project
// * Idempotency: `key` is unique at DB level (unique index). Invoice movements are RECONCILED against the ledger
//   (desired net quantity − already booked net quantity), so saving the same invoice twice can never book twice.
// * Invoice rules:  issued / partially_paid / paid  => stock-out of its product lines
//                   draft / cancelled                 => net 0 (cancel reverses exactly what is booked, once)
//                   services and manual lines never touch stock.
// * Legacy invoices (no `stockTracked` flag, created before Phase 2) are NEVER retro-booked: that would silently change
//   stock numbers the user maintained by hand. They stay untracked until re-created.
// * Insufficient stock policy (explicit + centralized): STOCK_POLICY.allowNegative === false => the operation is rejected
//   with a clear message listing every short product. Drafts never reserve or check stock.
// * Dates: `date` is the event date. Issuing = invoice date; later corrections (edit delta / cancel) = the day it happened.
export const STOCK_POLICY = Object.freeze({ allowNegative: false });
export const MOVEMENT_SOURCES = ['opening', 'purchase', 'invoice', 'sales_return', 'adjustment', 'project'];
export const MOVEMENT_SOURCE_LABELS = { opening: 'موجودی اولیه', purchase: 'خرید / ورود به انبار', invoice: 'فاکتور فروش', sales_return: 'برگشت از فروش', adjustment: 'تعدیل دستی', project: 'مصرف پروژه' };
export const MOVEMENT_DIRECTIONS = ['in', 'out'];

export const qty3 = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0; };
const money0 = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const isISO = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime());
const signed = m => (m.direction === 'in' ? 1 : -1) * qty3(m.quantity);

// ---------- ledger reading ----------
export function stockOf(productId, movements = []) {
  return qty3(movements.filter(m => String(m.productId) === String(productId)).reduce((s, m) => s + signed(m), 0));
}
export function stockMap(movements = []) {
  const map = new Map();
  movements.forEach(m => map.set(String(m.productId), qty3((map.get(String(m.productId)) || 0) + signed(m))));
  return map;
}
// Products whose cached `stock` differs from the ledger (diagnostics / integrity check).
export function stockMismatches(products = [], movements = []) {
  const map = stockMap(movements);
  return products.filter(p => qty3(p.stock) !== (map.get(String(p.id)) || 0)).map(p => ({ id: p.id, cache: qty3(p.stock), ledger: map.get(String(p.id)) || 0 }));
}

// ---------- movement construction / validation ----------
export function makeMovement(o) {
  return {
    productId: o.productId, quantity: qty3(o.quantity), direction: o.direction, sourceType: o.sourceType,
    sourceId: o.sourceId ?? null, projectId: o.projectId ?? null, date: o.date, description: o.description || '',
    unitCost: money0(o.unitCost), reason: o.reason || '', key: o.key, ...(o.reversalOf != null ? { reversalOf: o.reversalOf } : {})
  };
}
export function validateMovement(m) {
  if (!m || typeof m !== 'object') return 'حرکت موجودی نامعتبر است.';
  if (m.productId === null || m.productId === undefined || m.productId === '') return 'کالا مشخص نیست.';
  if (!(Number.isFinite(Number(m.quantity)) && Number(m.quantity) > 0)) return 'مقدار حرکت موجودی باید بیشتر از صفر باشد.';
  if (!MOVEMENT_DIRECTIONS.includes(m.direction)) return 'جهت حرکت موجودی نامعتبر است.';
  if (!MOVEMENT_SOURCES.includes(m.sourceType)) return 'منبع حرکت موجودی نامعتبر است.';
  if (!isISO(m.date)) return 'تاریخ حرکت موجودی معتبر نیست.';
  if (!m.key) return 'کلید یکتای حرکت موجودی مشخص نیست.';
  return null;
}
// Replace the `{id}` placeholder (used when the owning invoice/product id is only known inside the DB transaction).
export const finalizeMovement = (draft, id) => ({ ...draft, sourceId: draft.sourceId ?? id, productId: draft.productId ?? id, key: String(draft.key).replace('{id}', String(id)) });

// Central insufficient-stock policy. `needs` = Map(productId -> extra quantity that must leave stock).
export function checkStockAvailability(needs, products = [], movements = []) {
  if (STOCK_POLICY.allowNegative) return { ok: true, shortages: [] };
  const map = stockMap(movements);
  const shortages = [];
  needs.forEach((need, pid) => {
    const available = map.get(String(pid)) || 0;
    if (qty3(need) > available + 1e-9) shortages.push({ productId: pid, available, needed: qty3(need), name: products.find(p => String(p.id) === String(pid))?.name || '' });
  });
  return { ok: !shortages.length, shortages, error: shortages.length ? 'موجودی کافی نیست: ' + shortages.map(x => `«${x.name || 'کالا'}» (موجود: ${x.available}، لازم: ${x.needed})`).join('؛ ') : null };
}

// ---------- opening / legacy migration ----------
// Safe initialization: every product with a non-zero legacy `stock` and no movement gets ONE opening movement equal to it.
// products.stock is never modified, so the ledger starts out exactly equal to the legacy cache. Re-running adds nothing.
export function planStockLedgerInit(products = [], movements = [], todayISO = null, isoOf = null) {
  const has = new Set(movements.map(m => String(m.productId)));
  const rows = [];
  products.forEach(p => {
    const s = qty3(p.stock);
    if (!s || has.has(String(p.id))) return;
    const date = (isoOf && p.createdAt ? isoOf(p.createdAt) : null) || todayISO;
    rows.push(makeMovement({ productId: p.id, quantity: Math.abs(s), direction: s > 0 ? 'in' : 'out', sourceType: 'opening', date, unitCost: p.purchasePrice, description: 'موجودی اولیه (انتقال خودکار از موجودی قبلی)', reason: 'legacy-migration', key: `opening:${p.id}` }));
  });
  return rows;
}

// ---------- product form (create / edit) ----------
// The product form still has a "stock" field. It never overwrites the cache: the difference becomes a recorded movement.
export function planProductStockEdit({ product = null, desiredStock, movements = [], date, token }) {
  const want = qty3(desiredStock);
  if (want < 0 && !STOCK_POLICY.allowNegative) return { ok: false, error: 'موجودی نمی‌تواند منفی باشد.' };
  if (!product || product.id == null) {
    return { ok: true, drafts: want > 0 ? [makeMovement({ productId: null, quantity: want, direction: 'in', sourceType: 'opening', date, description: 'موجودی اولیه', reason: 'initial', key: 'opening:{id}' })] : [], stock: want };
  }
  const current = stockOf(product.id, movements);
  const delta = qty3(want - current);
  if (!delta) return { ok: true, drafts: [], stock: current };
  const hasOpening = movements.some(m => String(m.productId) === String(product.id));
  return { ok: true, stock: want, drafts: [makeMovement({ productId: product.id, quantity: Math.abs(delta), direction: delta > 0 ? 'in' : 'out', sourceType: hasOpening ? 'adjustment' : 'opening', date, unitCost: product.purchasePrice, description: 'اصلاح دستی موجودی از فرم کالا', reason: 'product-form', key: `${hasOpening ? 'adjustment' : 'opening'}:${product.id}:${token || Date.now()}` })] };
}

// ---------- manual movements: purchase, adjustment, project consumption ----------
export const MANUAL_KINDS = {
  purchase: { sourceType: 'purchase', direction: 'in' },
  adjust_in: { sourceType: 'adjustment', direction: 'in' },
  adjust_out: { sourceType: 'adjustment', direction: 'out' },
  project_use: { sourceType: 'project', direction: 'out' },
  project_return: { sourceType: 'project', direction: 'in' }
};
export function planManualMovement({ kind, product, quantity, date, projectId = null, unitCost, description = '', movements = [], token }) {
  const k = MANUAL_KINDS[kind];
  if (!k) return { ok: false, error: 'نوع حرکت موجودی نامعتبر است.' };
  if (!product) return { ok: false, error: 'کالا انتخاب نشده است.' };
  const q = qty3(quantity);
  if (!(q > 0)) return { ok: false, error: 'مقدار باید بیشتر از صفر باشد.' };
  if (!isISO(date)) return { ok: false, error: 'تاریخ معتبر نیست.' };
  if (k.sourceType === 'project' && (projectId === null || projectId === undefined || projectId === '')) return { ok: false, error: 'برای مصرف پروژه، انتخاب پروژه الزامی است.' };
  if (!token) return { ok: false, error: 'شناسه یکتای ثبت مشخص نیست.' };
  if (k.direction === 'out') {
    const chk = checkStockAvailability(new Map([[product.id, q]]), [product], movements);
    if (!chk.ok) return { ok: false, error: chk.error, shortages: chk.shortages };
  }
  const cost = unitCost !== undefined && unitCost !== null && unitCost !== '' ? money0(unitCost) : money0(product.purchasePrice);
  const draft = makeMovement({ productId: product.id, quantity: q, direction: k.direction, sourceType: k.sourceType, projectId: k.sourceType === 'project' ? Number(projectId) : null, date, unitCost: cost, description, reason: kind, key: `${k.sourceType}:${product.id}:${token}` });
  const stock = qty3(stockOf(product.id, movements) + (k.direction === 'in' ? q : -q));
  return { ok: true, drafts: [draft], stock };
}

// ---------- invoice <-> inventory ----------
export const invoiceStockActive = status => status === 'issued' || status === 'partially_paid' || status === 'paid';
// Product lines only (services / manual lines are ignored). Map(productId -> quantity)
export function invoiceProductQuantities(invoice) {
  const map = new Map();
  (invoice?.items || []).forEach(it => {
    if (it.type !== 'product' || it.itemId === null || it.itemId === undefined) return;
    map.set(String(it.itemId), qty3((map.get(String(it.itemId)) || 0) + qty3(it.quantity)));
  });
  return map;
}
const invoiceMovements = (invoiceId, movements) => movements.filter(m => (m.sourceType === 'invoice' || m.sourceType === 'sales_return') && m.sourceId != null && String(m.sourceId) === String(invoiceId));
// Net quantity currently booked out for this invoice (sales + corrections − returns), per product.
export function bookedForInvoice(invoiceId, movements = []) {
  const map = new Map();
  invoiceMovements(invoiceId, movements).forEach(m => map.set(String(m.productId), qty3((map.get(String(m.productId)) || 0) - signed(m))));
  return map;
}
export function returnedForInvoice(invoiceId, movements = []) {
  const map = new Map();
  movements.filter(m => m.sourceType === 'sales_return' && String(m.sourceId) === String(invoiceId)).forEach(m => map.set(String(m.productId), qty3((map.get(String(m.productId)) || 0) + qty3(m.quantity))));
  return map;
}

// Plan (not execute) the stock movements an invoice save needs. Pure + idempotent: the plan is the DIFFERENCE between what the
// invoice needs now and what the ledger already holds for it. Calling it again after applying it yields an empty plan.
export function planInvoiceStock({ invoice, invoiceId = null, movements = [], products = [], date }) {
  if (!invoice || invoice.stockTracked !== true) return { ok: true, drafts: [], untracked: true };
  const sid = invoiceId ?? invoice.id ?? null;
  const active = invoiceStockActive(invoice.status);
  const required = invoiceProductQuantities(invoice);
  const booked = sid != null ? bookedForInvoice(sid, movements) : new Map();
  const returned = sid != null ? returnedForInvoice(sid, movements) : new Map();
  const pids = new Set([...required.keys(), ...booked.keys()]);
  const needs = new Map(), plan = [];
  for (const pid of pids) {
    const req = required.get(pid) || 0, ret = returned.get(pid) || 0;
    if (active && req < ret - 1e-9) {
      const p = products.find(x => String(x.id) === pid);
      return { ok: false, error: `تعداد «${p?.name || 'کالا'}» نمی‌تواند کمتر از مقدار برگشت‌خورده (${ret}) باشد.` };
    }
    const desired = active ? qty3(Math.max(0, req - ret)) : 0;
    const delta = qty3(desired - (booked.get(pid) || 0));
    if (delta) plan.push({ pid, delta });
    if (delta > 0) needs.set(pid, delta);
  }
  const chk = checkStockAvailability(needs, products, movements);
  if (!chk.ok) return { ok: false, error: chk.error, shortages: chk.shortages };
  const drafts = plan.map(({ pid, delta }) => {
    const existingCount = movements.filter(m => m.sourceType === 'invoice' && String(m.sourceId) === String(sid) && String(m.productId) === pid).length;
    const reason = !active ? (invoice.status === 'cancelled' ? 'cancel' : 'revert') : (booked.size === 0 && !existingCount ? 'issue' : 'edit');
    const p = products.find(x => String(x.id) === pid);
    return makeMovement({
      productId: p ? p.id : pid, quantity: Math.abs(delta), direction: delta > 0 ? 'out' : 'in', sourceType: 'invoice', sourceId: sid,
      date: reason === 'issue' ? (invoice.date || date) : date, unitCost: p?.purchasePrice, reason,
      description: `${reason === 'issue' ? 'فروش' : reason === 'cancel' ? 'برگشت بابت لغو' : 'اصلاح'} فاکتور ${invoice.number || ''}`.trim(),
      key: `invoice:${sid ?? '{id}'}:${pid}:${existingCount + 1}`
    });
  });
  return { ok: true, drafts };
}

// Sales return (customer gives goods back): stock-in, bounded by what is still booked out for that invoice line.
export function planSalesReturn({ invoice, invoiceId, productId, quantity, movements = [], date, token }) {
  if (!invoice || invoice.stockTracked !== true) return { ok: false, error: 'موجودی این فاکتور قبل از فعال‌شدن دفتر موجودی ثبت شده و قابل برگشت نیست.' };
  if (!invoiceStockActive(invoice.status)) return { ok: false, error: 'برای فاکتور پیش‌نویس یا لغوشده برگشت از فروش ثبت نمی‌شود.' };
  const q = qty3(quantity);
  if (!(q > 0)) return { ok: false, error: 'مقدار برگشتی باید بیشتر از صفر باشد.' };
  if (!isISO(date)) return { ok: false, error: 'تاریخ معتبر نیست.' };
  if (!token) return { ok: false, error: 'شناسه یکتای ثبت مشخص نیست.' };
  const booked = bookedForInvoice(invoiceId, movements).get(String(productId)) || 0;
  if (q > booked + 1e-9) return { ok: false, error: `مقدار برگشتی (${q}) از مقدار فروخته‌شده باقی‌مانده (${booked}) بیشتر است.` };
  return { ok: true, drafts: [makeMovement({ productId, quantity: q, direction: 'in', sourceType: 'sales_return', sourceId: invoiceId, date, reason: 'sales-return', description: `برگشت از فروش فاکتور ${invoice.number || ''}`.trim(), key: `sales_return:${invoiceId}:${productId}:${token}` })] };
}

// Product-cache puts that keep products.stock equal to the ledger after `drafts` are applied. Returns DB.atomic operations.
export function stockCacheOps(products = [], movements = [], drafts = []) {
  const touched = new Set(drafts.filter(d => d.productId != null).map(d => String(d.productId)));
  const after = stockMap([...movements, ...drafts.filter(d => d.productId != null)]);
  const ops = [];
  touched.forEach(pid => { const p = products.find(x => String(x.id) === pid); if (p) ops.push({ store: 'products', action: 'put', data: { ...p, stock: after.get(pid) || 0 } }); });
  return ops;
}
export const movementOps = drafts => drafts.map(d => ({ store: 'stockMovements', action: 'add', data: d }));

// ---------- project consumption ----------
// Cost of stock consumed by a project (out) minus stock returned from it (in), at the unit cost snapshotted on each movement.
export function projectInventoryCost(projectId, movements = []) {
  if (projectId === null || projectId === undefined) return 0;
  return movements.filter(m => m.sourceType === 'project' && m.projectId != null && String(m.projectId) === String(projectId))
    .reduce((s, m) => s + (m.direction === 'out' ? 1 : -1) * Math.round(qty3(m.quantity) * money0(m.unitCost)), 0);
}

// ---------- reporting ----------
export function stockReport({ products = [], movements = [], productId = '', sourceType = '', from = '', to = '' } = {}) {
  const inRange = m => (!from || m.date >= from) && (!to || m.date <= to);
  const rows = movements.filter(m => (!productId || String(m.productId) === String(productId)) && (!sourceType || m.sourceType === sourceType) && inRange(m))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  const per = products.filter(p => !productId || String(p.id) === String(productId)).map(p => {
    const mine = movements.filter(m => String(m.productId) === String(p.id));
    const before = from ? mine.filter(m => m.date < from) : [];
    const within = mine.filter(inRange);
    const sum = (list, dir) => qty3(list.filter(m => m.direction === dir).reduce((s, m) => s + qty3(m.quantity), 0));
    const openingQty = qty3(before.reduce((s, m) => s + signed(m), 0));
    const inQty = sum(within, 'in'), outQty = sum(within, 'out');
    return { product: p, opening: openingQty, in: inQty, out: outQty, closing: qty3(openingQty + inQty - outQty), current: stockOf(p.id, movements), value: Math.round(stockOf(p.id, movements) * money0(p.purchasePrice)) };
  });
  return { rows, perProduct: per, totalValue: per.reduce((s, x) => s + x.value, 0) };
}
