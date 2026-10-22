import { isValidISODate } from './finance.js';
// validators.js — لایه اعتبارسنجی خالص (بدون DOM، بدون IndexedDB، بدون UI)
// این فایل تنها داده دریافت می‌کند و نتیجه ساختاریافته برمی‌گرداند. هیچ استثنایی برای ورودی نامعتبر کاربر پرتاب نمی‌شود.

// ============================================================
// 1) نرمال‌سازی
// ============================================================

// اعداد فارسی/عربی را به اعداد انگلیسی تبدیل می‌کند؛ ورودی اصلی را تغییر نمی‌دهد.
export function normalizeDigits(value) {
  if (value === null || value === undefined) return value;
  const fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
  return String(value).replace(/[۰-۹٠-٩]/g, ch => {
    const fi = fa.indexOf(ch); if (fi > -1) return String(fi);
    const ai = ar.indexOf(ch); if (ai > -1) return String(ai);
    return ch;
  });
}

// رشته مبلغ/عدد ورودی کاربر را به رشته عددی استاندارد (ارقام انگلیسی، نقطه اعشار، بدون جداکننده هزارگان) تبدیل می‌کند.
// پوشش: ارقام فارسی/عربی، جداکننده هزارگان ٬ ، ,  ، اعشار عربی ٫ ، فاصله/نویسه‌های جهت‌دهی نامرئی (iOS)، منفی یونیکد.
export function normalizeAmountInput(value) {
  if (value === null || value === undefined) return '';
  let s = normalizeDigits(String(value));
  s = s.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u00a0\s]/g, '');
  s = s.replace(/\u066B/g, '.');
  s = s.replace(/[\u066C\u060C,]/g, '');
  s = s.replace(/[\u2212\u2013\u2012]/g, '-');
  return s;
}

// تنها مسیر مرکزی تبدیل ورودی عددی به Number. هیچ‌وقت NaN برنمی‌گرداند مگر با valid:false.
// خروجی: {empty, valid, value}. ورودی‌هایی مثل "1e3"، "0x10"، "abc"، "1.2.3" نامعتبر هستند.
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { empty: false, valid: true, value } : { empty: false, valid: false, value: NaN };
  const s = normalizeAmountInput(value);
  if (s === '') return { empty: true, valid: true, value: null };
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return { empty: false, valid: false, value: NaN };
  const n = Number(s);
  return Number.isFinite(n) ? { empty: false, valid: true, value: n } : { empty: false, valid: false, value: NaN };
}
// مقدار عددی امن برای ذخیره: خالی/نامعتبر => fallback (پیش‌فرض ۰). اعتبارسنجی باید قبل از این انجام شده باشد.
export function toNumber(value, fallback = 0) {
  const r = parseNumber(value);
  return r.valid && !r.empty ? r.value : fallback;
}
// مبلغ (ریال): عدد صحیح
export const toMoney = (value, fallback = 0) => Math.round(toNumber(value, fallback));

// ------ تشخیص تکراری بودن (کد مشتری/کالا/خدمت، موبایل، شماره فاکتور) ------
export const canonicalCode = v => normalizeDigits(String(v ?? '')).replace(/[\u200b-\u200f\u202a-\u202e\s]/g, '').toLowerCase();
export function canonicalMobile(v) {
  let s = normalizeDigits(String(v ?? '')).replace(/[\s\-()\u200b-\u200f]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
  return s;
}
// اگر rows رکوردی (غیر از خود رکورد) با همان مقدار داشته باشد آن را برمی‌گرداند. مقدار خالی هیچ‌وقت تکراری نیست.
// اگر مقدار نسبت به مقدار قبلی همین رکورد تغییر نکرده، بررسی انجام نمی‌شود (داده‌های Legacy ویرایش‌پذیر می‌مانند).
export function findDuplicate(rows, field, value, { excludeId = null, canon = canonicalCode, previous = undefined } = {}) {
  const v = canon(value);
  if (!v) return null;
  if (previous !== undefined && canon(previous) === v) return null;
  return (rows || []).find(r => (excludeId === null || String(r.id) !== String(excludeId)) && canon(r[field]) === v) || null;
}

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

// ============================================================
// 2) کمک‌های ترکیب نتایج
// ============================================================

export function ok() { return { valid: true, errors: [] }; }
export function fail(field, message) { return { valid: false, errors: [{ field, message }] }; }

// چند نتیجه {valid,errors} را در یک نتیجه واحد جمع می‌کند (همه خطاها حفظ می‌شوند).
export function mergeValidationResults(...results) {
  const errors = results.flatMap(r => (r && r.errors) || []);
  return { valid: errors.length === 0, errors };
}
// اجرای پشت‌سرهم چند تابع اعتبارسنج و جمع‌آوری همه خطاها (توقف نمی‌کند).
export function collectErrors(fns) {
  const errors = [];
  for (const fn of fns) {
    const r = fn();
    if (r && r.errors && r.errors.length) errors.push(...r.errors);
  }
  return { valid: errors.length === 0, errors };
}

// ============================================================
// 3) اعتبارسنج‌های پایه
// ============================================================

export function validateRequired(value, fieldName) {
  if (isEmpty(value)) return fail(fieldName, `${labelFa(fieldName)} الزامی است`);
  return ok();
}

export function validateString(value, fieldName, options = {}) {
  const { required = false, maxLength = 500, minLength = 0 } = options;
  if (isEmpty(value)) return required ? fail(fieldName, `${labelFa(fieldName)} الزامی است`) : ok();
  const s = String(value);
  if (s.length < minLength) return fail(fieldName, `${labelFa(fieldName)} خیلی کوتاه است`);
  if (s.length > maxLength) return fail(fieldName, `${labelFa(fieldName)} نمی‌تواند بیشتر از ${maxLength} کاراکتر باشد`);
  return ok();
}

export function validateNumber(value, fieldName, options = {}) {
  const { required = false, min, max, allowZero = true } = options;
  const r = parseNumber(value);
  if (r.empty) return required ? fail(fieldName, `${labelFa(fieldName)} الزامی است`) : ok();
  if (!r.valid) return fail(fieldName, `${labelFa(fieldName)} باید یک عدد معتبر باشد`);
  const n = r.value;
  if (!allowZero && n === 0) return fail(fieldName, `${labelFa(fieldName)} نمی‌تواند صفر باشد`);
  if (min !== undefined && n < min) return fail(fieldName, `${labelFa(fieldName)} نمی‌تواند کمتر از ${min} باشد`);
  if (max !== undefined && n > max) return fail(fieldName, `${labelFa(fieldName)} نمی‌تواند بیشتر از ${max} باشد`);
  return ok();
}

export function validateInteger(value, fieldName, options = {}) {
  const base = validateNumber(value, fieldName, options);
  if (!base.valid) return base;
  const r = parseNumber(value);
  if (r.empty) return base;
  if (!Number.isInteger(r.value)) return fail(fieldName, `${labelFa(fieldName)} باید عدد صحیح باشد`);
  return ok();
}

// مبلغ: می‌تواند رشته فرمت‌شده با جداکننده هزارگان یا اعداد فارسی/عربی باشد. منفی هیچ‌وقت مجاز نیست.
// allowDecimal:false برای مبالغ ریالی (عدد صحیح)؛ برای تعداد/درصد اعشار مجاز است.
export function validateAmount(value, fieldName, options = {}) {
  const { required = false, allowZero = true, max, allowDecimal = true } = options;
  const r = parseNumber(value);
  if (r.empty) return required ? fail(fieldName, `${labelFa(fieldName)} الزامی است`) : ok();
  if (!r.valid) return fail(fieldName, `${labelFa(fieldName)} باید یک عدد معتبر باشد`);
  const n = r.value;
  if (n < 0) return fail(fieldName, `${labelFa(fieldName)} نمی‌تواند منفی باشد`);
  if (!allowDecimal && !Number.isInteger(n)) return fail(fieldName, `${labelFa(fieldName)} باید عدد صحیح (بدون اعشار) باشد`);
  if (!allowZero && n === 0) return fail(fieldName, `${labelFa(fieldName)} باید بزرگ‌تر از صفر باشد`);
  if (max !== undefined && n > max) return fail(fieldName, `${labelFa(fieldName)} نمی‌تواند بیشتر از ${max} باشد`);
  return ok();
}

// شماره موبایل ایران: 09xxxxxxxxx / +989xxxxxxxxx / 00989xxxxxxxxx
export function validatePhone(value, fieldName) {
  if (isEmpty(value)) return ok();
  let s = normalizeDigits(String(value)).replace(/[\s\-()]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
  if (!/^09\d{9}$/.test(s)) return fail(fieldName, 'شماره تماس معتبر نیست');
  return ok();
}

export function validateEmail(value, fieldName) {
  if (isEmpty(value)) return ok();
  const s = String(value).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return fail(fieldName, 'ایمیل معتبر نیست');
  return ok();
}

// value می‌تواند timestamp، ISO string یا رشته قابل‌قبول برای new Date باشد.
export function isValidDate(value) {
  if (isEmpty(value)) return false;
  const d = value instanceof Date ? value : new Date(value);
  return !isNaN(d.getTime());
}
// بررسی سطحی قالب تاریخ شمسی نمایشی مثل 1405/06/13 (بدون کتابخانه تقویم)
export function isValidPersianDate(value) {
  if (isEmpty(value)) return false;
  const s = normalizeDigits(String(value)).trim();
  const m = s.match(/^(1[23]\d{2})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (!m) return false;
  const month = Number(m[2]), day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export function validateDate(value, fieldName, options = {}) {
  const { required = false } = options;
  if (isEmpty(value)) return required ? fail(fieldName, `${labelFa(fieldName)} الزامی است`) : ok();
  if (!isValidDate(value)) return fail(fieldName, `${labelFa(fieldName)} معتبر نیست`);
  return ok();
}

// شناسه‌ها در این پروژه توسط IndexedDB (autoIncrement) یا uid() تولید می‌شوند؛ نیازی به UUID نیست.
export function isValidId(value) {
  if (value === null || value === undefined || value === '') return false;
  return typeof value === 'number' ? isFinite(value) : /^[A-Za-z0-9_-]+$/.test(String(value));
}

// برچسب فارسی نام فیلدها برای پیام خطا؛ اگر نام‌آشنا نبود همان مقدار برگردانده می‌شود.
const FIELD_LABELS = {
  name: 'نام', customerName: 'نام مشتری', companyName: 'نام شرکت', phone: 'شماره تماس', mobile: 'موبایل', email: 'ایمیل',
  address: 'آدرس', customerCode: 'کد مشتری', notes: 'توضیحات', code: 'کد', category: 'دسته‌بندی', unit: 'واحد',
  purchasePrice: 'قیمت خرید', salePrice: 'قیمت فروش', stock: 'موجودی', minStock: 'حداقل موجودی', price: 'قیمت', cost: 'هزینه',
  description: 'شرح', budget: 'بودجه', startDate: 'تاریخ شروع', endDate: 'تاریخ پایان', status: 'وضعیت',
  customerId: 'مشتری', invoiceNumber: 'شماره فاکتور', date: 'تاریخ', items: 'اقلام فاکتور', discount: 'تخفیف',
  tax: 'مالیات', paidAmount: 'مبلغ پرداختی', type: 'نوع', itemId: 'کالا/خدمت', quantity: 'تعداد', unitPrice: 'قیمت واحد',
  amount: 'مبلغ', businessName: 'نام کسب‌وکار', ownerName: 'نام صاحب کسب‌وکار', invoicePrefix: 'پیشوند فاکتور',
  invoiceStartNumber: 'شماره شروع فاکتور', taxRate: 'درصد مالیات', invoiceNotes: 'توضیحات فاکتور'
};
function labelFa(field) { return FIELD_LABELS[field] || field; }

// ============================================================
// 4) وضعیت‌های مرکزی (فقط کد؛ ترجمه فارسی در لایه UI انجام می‌شود)
// ============================================================

export const CUSTOMER_STATUS = ['active', 'inactive'];
export const PROJECT_STATUS = ['planned', 'active', 'completed', 'cancelled'];
export const INVOICE_STATUS = ['draft', 'issued', 'partially_paid', 'paid', 'cancelled'];
export const TRANSACTION_TYPES = ['income', 'expense', 'customer_payment', 'supplier_payment', 'other_expense'];

export const isValidProjectStatus = s => PROJECT_STATUS.includes(s);
export const isValidInvoiceStatus = s => INVOICE_STATUS.includes(s);
export const isValidTransactionType = t => TRANSACTION_TYPES.includes(t);
export const isValidCustomerStatus = s => CUSTOMER_STATUS.includes(s);

// ============================================================
// 5) اعتبارسنج‌های سطح موجودیت (entity-level)
// ============================================================

export function validateCustomer(data = {}) {
  return collectErrors([
    () => validateString(data.name, 'name', { required: true, maxLength: 120 }),
    () => validateString(data.companyName, 'companyName', { maxLength: 150 }),
    () => validatePhone(data.phone ?? data.mobile, data.phone !== undefined ? 'phone' : 'mobile'),
    () => validateEmail(data.email, 'email'),
    () => validateString(data.address, 'address', { maxLength: 500 }),
    () => validateString(data.customerCode, 'customerCode', { maxLength: 30 }),
    () => validateString(data.notes, 'notes', { maxLength: 1000 }),
    () => (data.status ? (isValidCustomerStatus(data.status) ? ok() : fail('status', 'وضعیت مشتری معتبر نیست')) : ok())
  ]);
}

export function validateProduct(data = {}) {
  return collectErrors([
    () => validateString(data.name, 'name', { required: true, maxLength: 150 }),
    () => validateString(data.code, 'code', { maxLength: 40 }),
    () => validateString(data.category, 'category', { maxLength: 80 }),
    () => validateString(data.unit, 'unit', { maxLength: 20 }),
    () => validateAmount(data.purchasePrice, 'purchasePrice', { allowDecimal: false }),
    () => validateAmount(data.salePrice, 'salePrice', { allowDecimal: false }),
    () => validateNumber(data.stock, 'stock', { min: 0 }),
    () => validateNumber(data.minStock, 'minStock', { min: 0 })
  ]);
}

export function validateService(data = {}) {
  return collectErrors([
    () => validateString(data.name, 'name', { required: true, maxLength: 150 }),
    () => validateString(data.code, 'code', { maxLength: 40 }),
    () => validateString(data.unit, 'unit', { maxLength: 20 }),
    () => validateAmount(data.price, 'price', { allowDecimal: false }),
    () => validateString(data.description, 'description', { maxLength: 1000 })
  ]);
}

export function validateProject(data = {}) {
  const errs = collectErrors([
    () => validateString(data.name, 'name', { required: true, maxLength: 150 }),
    () => (isEmpty(data.customerId) ? ok() : (isValidId(data.customerId) ? ok() : fail('customerId', 'مشتری انتخاب‌شده معتبر نیست'))),
    () => validateAmount(data.budget, 'budget', { allowDecimal: false }),
    () => validateAmount(data.cost, 'cost', { allowDecimal: false }),
    () => (data.status ? (isValidProjectStatus(data.status) ? ok() : fail('status', 'وضعیت پروژه معتبر نیست')) : ok()),
    () => validateDate(data.startDate, 'startDate'),
    () => validateDate(data.endDate, 'endDate')
  ]);
  const extra = [];
  if (!isEmpty(data.startDate) && !isEmpty(data.endDate) && isValidDate(data.startDate) && isValidDate(data.endDate)) {
    if (new Date(data.endDate).getTime() < new Date(data.startDate).getTime()) {
      extra.push({ field: 'endDate', message: 'تاریخ پایان نمی‌تواند قبل از تاریخ شروع باشد' });
    }
  }
  return mergeValidationResults(errs, { valid: extra.length === 0, errors: extra });
}

export function validateInvoiceItem(data = {}) {
  const errors = [];
  if (data.type !== 'product' && data.type !== 'service' && data.type !== 'manual') errors.push({ field: 'type', message: 'نوع قلم فاکتور معتبر نیست' });
  if (data.type !== 'manual' && !isValidId(data.itemId)) errors.push({ field: 'itemId', message: 'کالا/خدمت انتخاب‌شده معتبر نیست' });
  const nameRes = validateString(data.name, 'name', { required: true, maxLength: 200 });
  if (!nameRes.valid) errors.push(...nameRes.errors);
  const qtyRes = validateAmount(data.quantity, 'quantity', { allowZero: false });
  if (!qtyRes.valid) errors.push({ field: 'quantity', message: 'تعداد باید بیشتر از صفر باشد' });
  const priceRes = validateAmount(data.unitPrice, 'unitPrice');
  if (!priceRes.valid) errors.push({ field: 'unitPrice', message: 'قیمت واردشده معتبر نیست' });
  const discRes = validateAmount(data.discount, 'discount');
  if (!discRes.valid) errors.push(...discRes.errors);
  else if (!isEmpty(data.discount)) {
    const qty = Number(normalizeAmountInput(data.quantity)) || 0;
    const price = Number(normalizeAmountInput(data.unitPrice)) || 0;
    const subtotal = qty * price;
    const rawDiscount = Number(normalizeAmountInput(data.discountInput ?? data.discount)) || 0;
    if (data.discountType === 'percent') {
      if (rawDiscount > 100) errors.push({ field: 'discount', message: 'درصد تخفیف نمی‌تواند بیشتر از ۱۰۰٪ باشد' });
    } else if (rawDiscount > subtotal) {
      errors.push({ field: 'discount', message: 'تخفیف نمی‌تواند بیشتر از مبلغ ردیف باشد' });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateInvoice(data = {}) {
  const errors = [];
  const numRes = validateString(data.invoiceNumber, 'invoiceNumber', { required: true, maxLength: 30 });
  if (!numRes.valid) errors.push({ field: 'invoiceNumber', message: 'شماره فاکتور الزامی است' });
  if (!isValidId(data.customerId) && data.allowWalkInCustomer !== true) {
    // مشتری آزاد در معماری فعلی مجاز است؛ فقط وقتی صراحتاً customerId داده شده باید معتبر باشد
    if (data.customerId !== null && data.customerId !== undefined && data.customerId !== '' && !isValidId(data.customerId)) {
      errors.push({ field: 'customerId', message: 'مشتری انتخاب‌شده معتبر نیست' });
    }
  }
  const dateRes = validateDate(data.date, 'date', { required: true });
  if (!dateRes.valid) errors.push(...dateRes.errors);
  if (!Array.isArray(data.items)) errors.push({ field: 'items', message: 'اقلام فاکتور باید فهرست معتبر باشد' });
  else if (data.items.length === 0) errors.push({ field: 'items', message: 'فاکتور باید حداقل یک قلم کالا یا خدمت داشته باشد' });
  else data.items.forEach((it, idx) => { const r = validateInvoiceItem(it); if (!r.valid) r.errors.forEach(e => errors.push({ field: `items[${idx}].${e.field}`, message: e.message })); });

  const invoiceDiscountInput = data.discountInput ?? data.discount ?? 0;
  const discRes = validateAmount(invoiceDiscountInput, 'discount'); if (!discRes.valid) errors.push(...discRes.errors);
  if (data.discountType === 'percent' && Number(normalizeAmountInput(invoiceDiscountInput)) > 100) errors.push({ field: 'discount', message: 'درصد تخفیف نمی‌تواند بیشتر از ۱۰۰٪ باشد' });
  const calculatedSubtotal = Array.isArray(data.items) ? data.items.reduce((s,it) => { const base=Math.max(0,(Number(normalizeAmountInput(it.quantity))||0)*(Number(normalizeAmountInput(it.unitPrice))||0)); const raw=Number(normalizeAmountInput(it.discountInput ?? it.discount))||0; const d=it.discountType==='percent'?base*Math.min(100,raw)/100:raw; return s+Math.max(0,base-Math.min(base,d)); }, 0) : 0;
  const invoiceDiscountAmount = data.discountType === 'percent' ? calculatedSubtotal * Math.min(100, Number(normalizeAmountInput(invoiceDiscountInput))||0) / 100 : Number(normalizeAmountInput(invoiceDiscountInput))||0;
  if (discRes.valid && invoiceDiscountAmount > Math.round(calculatedSubtotal)) errors.push({ field: 'discount', message: 'تخفیف کلی نمی‌تواند بیشتر از جمع اقلام باشد' });
  const taxRes = validateAmount(data.tax, 'tax'); if (!taxRes.valid) errors.push(...taxRes.errors);
  const paidRes = validateAmount(data.paidAmount, 'paidAmount', { allowDecimal: false }); if (!paidRes.valid) errors.push(...paidRes.errors);
  if (data.status && !isValidInvoiceStatus(data.status)) errors.push({ field: 'status', message: 'وضعیت فاکتور معتبر نیست' });

  if (paidRes.valid && !isEmpty(data.paidAmount) && typeof data.total === 'number' && data.allowOverpayment !== true) {
    if (Number(normalizeAmountInput(data.paidAmount)) > data.total) errors.push({ field: 'paidAmount', message: 'مبلغ پرداختی نمی‌تواند بیشتر از مبلغ کل فاکتور باشد' });
  }
  return { valid: errors.length === 0, errors };
}

export function validateTransaction(data = {}) {
  const errors = [];
  if (!isValidTransactionType(data.type)) errors.push({ field: 'type', message: 'نوع تراکنش معتبر نیست' });
  const amtRes = validateAmount(data.amount, 'amount', { required: true, allowZero: false, allowDecimal: false });
  if (!amtRes.valid) errors.push(...amtRes.errors);
  // تاریخ مالی تراکنش باید یک روز واقعی با قالب YYYY-MM-DD باشد (در رکورد ذخیره می‌شود، نه فقط در UI)
  if (isEmpty(data.date)) errors.push({ field: 'date', message: `${labelFa('date')} الزامی است` });
  else if (!isValidISODate(String(data.date))) errors.push({ field: 'date', message: `${labelFa('date')} معتبر نیست` });
  const descRes = validateString(data.description, 'description', { required: true, maxLength: 300 });
  if (!descRes.valid) errors.push(...descRes.errors);
  if (!isEmpty(data.customerId) && !isValidId(data.customerId)) errors.push({ field: 'customerId', message: 'مشتری انتخاب‌شده معتبر نیست' });
  if (data.type === 'customer_payment' && isEmpty(data.customerId)) errors.push({ field: 'customerId', message: 'برای دریافت از مشتری، انتخاب مشتری الزامی است' });
  if (!isEmpty(data.supplierId) && !isValidId(data.supplierId)) errors.push({ field: 'supplierId', message: 'تأمین‌کننده انتخاب‌شده معتبر نیست' });
  const notesRes = validateString(data.notes, 'notes', { maxLength: 1000 });
  if (!notesRes.valid) errors.push(...notesRes.errors);
  return { valid: errors.length === 0, errors };
}

export function validateSettings(data = {}) {
  const errors = [];
  const bnRes = validateString(data.businessName, 'businessName', { maxLength: 120 });
  if (!bnRes.valid) errors.push(...bnRes.errors);
  const phoneRes = validatePhone(data.phone, 'phone'); if (!phoneRes.valid) errors.push(...phoneRes.errors);
  const emailRes = validateEmail(data.email, 'email'); if (!emailRes.valid) errors.push(...emailRes.errors);
  const invoiceStart = data.invoiceStartNumber ?? data.invoiceStart;
  if (!isEmpty(invoiceStart)) {
    const r = validateInteger(invoiceStart, 'invoiceStartNumber', { min: 1 });
    if (!r.valid) errors.push({ field: 'invoiceStartNumber', message: 'شماره شروع فاکتور باید عدد صحیح مثبت باشد' });
  }
  if (!isEmpty(data.taxRate)) {
    const r = validateNumber(data.taxRate, 'taxRate', { min: 0, max: 100 });
    if (!r.valid) errors.push(...r.errors);
  }
  if (data.taxEnabled !== undefined && typeof data.taxEnabled !== 'boolean') errors.push({ field: 'taxEnabled', message: 'وضعیت فعال‌بودن مالیات نامعتبر است' });
  const notesRes = validateString(data.invoiceNotes ?? data.invoiceNote, 'invoiceNotes', { maxLength: 500 }); if (!notesRes.valid) errors.push(...notesRes.errors);
  return { valid: errors.length === 0, errors };
}
