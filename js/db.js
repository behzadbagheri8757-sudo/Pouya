// DIA Business — IndexedDB data layer. No UI/DOM logic here.
import { parseNumber } from './validators.js';
import { validateMovement, planStockLedgerInit, finalizeMovement } from './inventory.js';
import { isoFromTimestamp } from './finance.js';
const DB_NAME = 'DIA_Business_DB';
const DB_VERSION = 3;
export const stores = ['customers','products','services','projects','invoices','transactions','accounts','settings','stockMovements','paymentAllocations'];
// stores introduced by Phase 2 (absent from backups with dataVersion < 2)
export const PHASE2_STORES = ['stockMovements','paymentAllocations'];
export const SETTINGS_ID = 'app';
export const APP_ID = 'DIA-Business';
// DATA_VERSION: version of the *data semantics* stored (independent of the IndexedDB schema version).
// 1 = amounts in Rial, transactions carry a real `date`, invoice paid/remaining are a cache of customer_payment transactions.
// 2 = Phase 2: stockMovements (inventory ledger; products.stock is a cache of it) + paymentAllocations + customer_refund transactions.
export const DATA_VERSION = 2;
const DEFAULT_SETTINGS = {
  id: SETTINGS_ID, businessName: 'DIA Business', ownerName: '', phone: '', email: '', address: '',
  invoiceNote: 'از انتخاب شما سپاسگزاریم.', invoicePrefix: '', invoiceStart: 1001,
  taxEnabled: false, taxPercent: 9, sampleDataLoaded: false
};
let dbPromise;
function openDB(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      stores.forEach(s=>{if(!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:'id',autoIncrement:true});});
      // v1 -> v2 intentionally preserves all stores and records.
      // v2 -> v3 (Phase 2): the two new stores above are created empty; existing records are untouched.
      // Unique `key` index = DB-level idempotency (the same movement / allocation can never be stored twice).
      for(const s of PHASE2_STORES){const os=req.transaction.objectStore(s);if(!os.indexNames.contains('key'))os.createIndex('key','key',{unique:true});}
    };
    req.onblocked=()=>console.warn('DIA DB upgrade is blocked by another open tab.');
    req.onerror=()=>{dbPromise=null; reject(req.error);};
    req.onsuccess=()=>{
      const db=req.result;
      db.onversionchange=()=>db.close();
      resolve(db);
    };
  });
  return dbPromise;
}
function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}

// ---- Financial integrity guard: no NaN / Infinity / non-numeric value may ever reach a numeric field ----
const NUMERIC_FIELDS = {
  products: ['purchasePrice', 'salePrice', 'stock', 'minStock'],
  services: ['price'],
  projects: ['budget', 'cost'],
  transactions: ['amount'],
  invoices: ['discount', 'discountInput', 'extraCosts', 'tax', 'total', 'paidAmount', 'remainingAmount', 'subtotal', 'itemDiscountTotal', 'grandTotal', 'taxableAmount', 'taxPercent'],
  settings: ['taxPercent', 'invoiceStart'],
  stockMovements: ['quantity', 'unitCost'],
  paymentAllocations: ['amount']
};
const ITEM_FIELDS = ['quantity', 'unitPrice', 'discount', 'discountInput', 'lineSubtotal', 'total'];
// Returns a copy whose numeric fields are real finite Numbers (numeric strings are converted); throws otherwise.
export function sanitizeRow(store, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('رکورد نامعتبر است.');
  const out = { ...row };
  const fix = (obj, key) => {
    const v = obj[key];
    if (v === undefined || v === null) return;
    const r = parseNumber(v);
    if (!r.valid) throw new Error(`مقدار عددی نامعتبر در «${key}» — ذخیره انجام نشد.`);
    obj[key] = r.empty ? 0 : r.value;
  };
  (NUMERIC_FIELDS[store] || []).forEach(k => fix(out, k));
  if (store === 'transactions') {
    if (out.amount === undefined || out.amount === null) throw new Error('مبلغ تراکنش مشخص نیست.');
    if (out.amount < 0) throw new Error('مبلغ تراکنش نمی‌تواند منفی باشد.');
  }
  if (store === 'stockMovements') { const e = validateMovement(out); if (e) throw new Error(e); }
  if (store === 'paymentAllocations') {
    if (!(out.amount > 0)) throw new Error('مبلغ تخصیص باید بیشتر از صفر باشد.');
    if (out.paymentId === null || out.paymentId === undefined || out.invoiceId === null || out.invoiceId === undefined) throw new Error('تخصیص باید به یک دریافت و یک فاکتور متصل باشد.');
  }
  if (store === 'invoices') {
    if (out.total === undefined || out.total === null) throw new Error('مبلغ کل فاکتور مشخص نیست.');
    if (Array.isArray(out.items)) out.items = out.items.map(it => { const x = { ...it }; ITEM_FIELDS.forEach(k => fix(x, k)); return x; });
  }
  return out;
}
export const DB={
  async all(store){const db=await openDB();return request(db.transaction(store,'readonly').objectStore(store).getAll());},
  async get(store,id){const db=await openDB();return request(db.transaction(store,'readonly').objectStore(store).get(id));},
  async add(store,data){const db=await openDB();const now=Date.now();const row=sanitizeRow(store,{...data,createdAt:data.createdAt??now,updatedAt:now});return request(db.transaction(store,'readwrite').objectStore(store).add(row));},
  async put(store,data){const db=await openDB();const old=data.id!=null?await DB.get(store,data.id):null;const row=sanitizeRow(store,{...data,createdAt:data.createdAt??old?.createdAt??Date.now(),updatedAt:Date.now()});return request(db.transaction(store,'readwrite').objectStore(store).put(row));},
  async delete(store,id){const db=await openDB();return request(db.transaction(store,'readwrite').objectStore(store).delete(id));},
  async clear(store){const db=await openDB();return request(db.transaction(store,'readwrite').objectStore(store).clear());},
  // stockDrafts: inventory movements of the new/edited invoice (written in the SAME transaction, sourceId finalized with the invoice id);
  // extraOps: further {store,action,data} puts (e.g. products.stock cache). Everything commits or nothing does.
  async saveInvoiceWithPayment(invoice, payment=null, stockDrafts=[], extraOps=[]){
    const db=await openDB();
    let invoiceId=null;
    const prepared=extraOps.map(op=>({...op,data:sanitizeRow(op.store,{...op.data,createdAt:op.data?.createdAt??Date.now(),updatedAt:Date.now()})}));
    await new Promise((resolve,reject)=>{
      const t=db.transaction(['invoices','transactions','stockMovements','products'],'readwrite');
      const invoiceStore=t.objectStore('invoices');
      const txStore=t.objectStore('transactions');
      const now=Date.now();
      let row;
      try{row=sanitizeRow('invoices',{...invoice,createdAt:invoice.createdAt??now,updatedAt:now});}catch(e){try{t.abort();}catch(_){} reject(e);return;}
      const req=invoice.id!=null ? invoiceStore.put(row) : invoiceStore.add(row);
      req.onsuccess=()=>{
        invoiceId=req.result;
        try{
          if(payment && Number(payment.amount)>0){
            txStore.add(sanitizeRow('transactions',{...payment,invoiceId,createdAt:payment.createdAt??now,updatedAt:now}));
          }
          stockDrafts.forEach(d=>t.objectStore('stockMovements').add(sanitizeRow('stockMovements',{...finalizeMovement(d,invoiceId),createdAt:now,updatedAt:now})));
          prepared.forEach(op=>t.objectStore(op.store)[op.action](op.data));
        }catch(e){try{t.abort();}catch(_){} reject(e);}
      };
      req.onerror=()=>{try{t.abort();}catch(_){} };
      t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('ذخیره فاکتور و پرداخت انجام نشد.'));
    });
    return invoiceId;
  },
  // ops: {store, action:'add'|'put'|'delete', data|id}. Optional chaining inside ONE transaction:
  //   bindKey:'k'            -> remember the generated id of this add under 'k'
  //   bind:{field:'k'}       -> set data[field] to that id before writing (movement keys may contain '{id}', replaced by the bound id)
  async atomic(operations=[]){
    if(!Array.isArray(operations)||!operations.length) return;
    // validate + sanitize EVERYTHING first: a bad row must abort the whole operation before any write happens
    const prepared=operations.map(op=>{
      if(!op||!stores.includes(op.store)) throw new Error('عملیات پایگاه داده نامعتبر است.');
      if((op.action==='add'||op.action==='put')&&!op.bind) return {...op,data:sanitizeRow(op.store,{...op.data,createdAt:op.data?.createdAt??Date.now(),updatedAt:Date.now()})};
      return op;
    });
    const db=await openDB();
    await new Promise((resolve,reject)=>{
      const t=db.transaction(stores,'readwrite');
      const ids={};let i=0;
      const step=()=>{
        if(i>=prepared.length) return;
        const op=prepared[i++];
        let data=op.data;
        try{
          if(op.bind){
            data={...data,createdAt:data?.createdAt??Date.now(),updatedAt:Date.now()};
            const first=Object.values(op.bind)[0];
            for(const [field,k] of Object.entries(op.bind)) data[field]=ids[k];
            if(op.store==='stockMovements'&&data.key) data.key=String(data.key).replace('{id}',String(ids[first]));
            data=sanitizeRow(op.store,data);
          }
          const os=t.objectStore(op.store);
          let r;
          if(op.action==='add') r=os.add(data);
          else if(op.action==='put') r=os.put(data);
          else if(op.action==='delete') r=os.delete(op.id);
          else throw new Error('نوع عملیات پایگاه داده نامعتبر است.');
          r.onsuccess=()=>{if(op.bindKey)ids[op.bindKey]=r.result;step();};
        }catch(e){try{t.abort();}catch(_){} reject(e);}
      };
      step();
      t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('عملیات پایگاه داده انجام نشد.'));
    });
  }
};
async function migrateLegacyTomanDataToRial(){
  const current=await DB.get('settings',SETTINGS_ID);
  if(current?.rialMigrationV1===true) return;
  const monetaryByStore={
    products:['purchasePrice','salePrice'],
    services:['price'],
    projects:['budget','cost'],
    transactions:['amount'],
    invoices:['discount','discountInput','extraCosts','tax','total','paidAmount','remainingAmount','subtotal','itemDiscountTotal','grandTotal','taxableAmount']
  };
  const db=await openDB();
  await new Promise((resolve,reject)=>{
    const t=db.transaction([...Object.keys(monetaryByStore),'settings'],'readwrite');
    try{
      for(const [store,fields] of Object.entries(monetaryByStore)){
        const os=t.objectStore(store);
        const req=os.getAll();
        req.onsuccess=()=>{
          req.result.forEach(row=>{
            const next={...row};
            fields.forEach(k=>{if(next[k]!==undefined&&next[k]!==null&&Number.isFinite(Number(next[k]))) next[k]=Number(next[k])*10;});
            if(store==='invoices'&&Array.isArray(next.items)){
              next.items=next.items.map(item=>{const it={...item};['unitPrice','discount','discountInput','lineSubtotal','total'].forEach(k=>{if(it[k]!==undefined&&it[k]!==null&&Number.isFinite(Number(it[k])))it[k]=Number(it[k])*10;});return it;});
            }
            os.put(next);
          });
        };
        req.onerror=()=>t.abort();
      }
      const settings={...(current||DEFAULT_SETTINGS),id:SETTINGS_ID,rialMigrationV1:true};
      t.objectStore('settings').put(settings);
    }catch(e){t.abort();reject(e);return;}
    t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('تبدیل مبالغ به ریال انجام نشد.'));
  });
}

async function migrateInvoiceTaxSnapshots(){
  const current=await DB.get('settings',SETTINGS_ID);
  if(current?.invoiceTaxSnapshotV1===true) return;
  const invoices=await DB.all('invoices');
  const db=await openDB();
  await new Promise((resolve,reject)=>{
    const t=db.transaction(['invoices','settings'],'readwrite');
    try{
      const os=t.objectStore('invoices');
      invoices.forEach(inv=>{
        if(inv.taxEnabled!==undefined && inv.taxPercent!==undefined) return;
        const taxable=Number(inv.taxableAmount)||0;
        const tax=Number(inv.tax)||0;
        const inferredEnabled=inv.taxEnabled!==undefined ? !!inv.taxEnabled : tax>0;
        const inferredPercent=inv.taxPercent!==undefined ? Number(inv.taxPercent) : (inferredEnabled&&taxable>0 ? Math.max(0,Math.min(100,(tax/taxable)*100)) : Number(current?.taxPercent??DEFAULT_SETTINGS.taxPercent));
        os.put({...inv,taxEnabled:inferredEnabled,taxPercent:Number.isFinite(inferredPercent)?inferredPercent:DEFAULT_SETTINGS.taxPercent});
      });
      t.objectStore('settings').put({...DEFAULT_SETTINGS,...(current||{}),id:SETTINGS_ID,invoiceTaxSnapshotV1:true});
    }catch(e){t.abort();reject(e);return;}
    t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('ثبت تنظیمات تاریخی فاکتورها انجام نشد.'));
  });
}
const todayLocalISO=()=>isoFromTimestamp(Date.now());
// Phase 2 migration: give every product with legacy stock ONE opening movement so the ledger starts equal to the old cache.
// products.stock is never touched. Idempotent: products that already have a movement are skipped, and `opening:<productId>` is a
// unique key, so even a concurrent second run cannot create duplicates.
async function migrateStockLedgerV1(){
  const current=await DB.get('settings',SETTINGS_ID);
  if(current?.stockLedgerV1===true) return;
  const [products,movements]=await Promise.all([DB.all('products'),DB.all('stockMovements')]);
  const rows=planStockLedgerInit(products,movements,todayLocalISO(),isoFromTimestamp);
  const db=await openDB();
  await new Promise((resolve,reject)=>{
    const t=db.transaction(['stockMovements','settings'],'readwrite');
    try{
      const now=Date.now();
      rows.forEach(r=>t.objectStore('stockMovements').add(sanitizeRow('stockMovements',{...r,createdAt:now,updatedAt:now})));
      t.objectStore('settings').put({...DEFAULT_SETTINGS,...(current||{}),id:SETTINGS_ID,stockLedgerV1:true});
    }catch(e){try{t.abort();}catch(_){} reject(e);return;}
    t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('ایجاد دفتر موجودی انجام نشد.'));
  });
}
let migrating=null;
function ensureMigrated(){
  if(!migrating) migrating=(async()=>{
    const s=await DB.get('settings',SETTINGS_ID);
    if(!s?.rialMigrationV1) await migrateLegacyTomanDataToRial();   // must stay first: later steps read Rial amounts
    await migrateInvoiceTaxSnapshots();
    await migrateStockLedgerV1();
  })().finally(()=>{migrating=null;});
  return migrating;
}
export async function getSettings(){await ensureMigrated();const fresh=await DB.get('settings',SETTINGS_ID);return {...DEFAULT_SETTINGS,...(fresh||{})};}
export async function saveSettings(patch){const merged={...await getSettings(),...patch,id:SETTINGS_ID};await DB.put('settings',merged);return merged;}
export async function exportDatabase(){const out={app:APP_ID,version:DB_VERSION,dataVersion:DATA_VERSION,exportedAt:new Date().toISOString(),stores:{}};for(const s of stores)out.stores[s]=await DB.all(s);return out;}

// ---- Backup validation (pure): nothing is written unless this returns valid:true ----
const CORE_STORES = ['customers', 'products', 'services', 'projects', 'invoices', 'transactions'];
export function validateBackup(data){
  const errors=[];
  const fail=()=>({valid:false,errors,counts:{}});
  if(!data||typeof data!=='object'||Array.isArray(data)){errors.push('ساختار فایل پشتیبان معتبر نیست.');return fail();}
  if(data.app!==APP_ID) errors.push(data.app===undefined?'شناسه برنامه در فایل پشتیبان وجود ندارد؛ این فایل پشتیبان DIA نیست.':'این فایل پشتیبان متعلق به برنامه دیگری است.');
  const ver=Number(data.version);
  if(!Number.isInteger(ver)||ver<1) errors.push('نسخه ساختار (schema) در فایل پشتیبان نامعتبر است.');
  else if(ver>DB_VERSION) errors.push('این پشتیبان مربوط به نسخه جدیدتری از برنامه است. ابتدا برنامه را به‌روزرسانی کنید.');
  if(data.dataVersion!==undefined){const dv=Number(data.dataVersion);if(!Number.isInteger(dv)||dv<1) errors.push('نسخه داده‌ها در فایل پشتیبان نامعتبر است.');else if(dv>DATA_VERSION) errors.push('نسخه داده‌های این پشتیبان جدیدتر از برنامه است.');}
  if(!data.stores||typeof data.stores!=='object'||Array.isArray(data.stores)){errors.push('بخش stores در فایل پشتیبان وجود ندارد.');return fail();}
  const counts={};
  for(const name of Object.keys(data.stores)){
    if(!stores.includes(name)){errors.push(`جدول ناشناخته «${name}» در فایل پشتیبان وجود دارد.`);continue;}
    if(!Array.isArray(data.stores[name])){errors.push(`جدول «${name}» باید فهرست باشد.`);continue;}
  }
  for(const name of CORE_STORES) if(!Array.isArray(data.stores[name])) errors.push(`جدول «${name}» در فایل پشتیبان وجود ندارد.`);
  // a Phase 2 backup (dataVersion >= 2) MUST carry the new stores; older backups simply do not have them and are upgraded on restore
  if(Number(data.dataVersion)>=2) for(const name of PHASE2_STORES) if(!Array.isArray(data.stores[name])) errors.push(`جدول «${name}» در فایل پشتیبان وجود ندارد.`);
  if(errors.length) return {valid:false,errors:errors.slice(0,5),counts};
  for(const name of stores){
    const rows=data.stores[name]; if(rows===undefined) continue;
    counts[name]=rows.length;
    const seen=new Set();
    for(const row of rows){
      if(!row||typeof row!=='object'||Array.isArray(row)){errors.push(`رکورد نامعتبر در «${name}».`);break;}
      const idOk=name==='settings'?typeof row.id==='string'&&row.id!=='':(typeof row.id==='number'&&Number.isFinite(row.id));
      if(!idOk){errors.push(`شناسه رکورد در «${name}» نامعتبر است.`);break;}
      if(seen.has(row.id)){errors.push(`شناسه تکراری در «${name}» (${row.id}).`);break;}
      seen.add(row.id);
      const bad=[...(NUMERIC_FIELDS[name]||[])].find(k=>row[k]!==undefined&&row[k]!==null&&!parseNumber(row[k]).valid)
        || (name==='invoices'&&Array.isArray(row.items)?row.items.flatMap(it=>ITEM_FIELDS.filter(k=>it&&it[k]!==undefined&&it[k]!==null&&!parseNumber(it[k]).valid))[0]:undefined);
      if(bad){errors.push(`مقدار عددی نامعتبر در «${name}» (فیلد ${bad}).`);break;}
    }
  }
  // ---- Phase 2 cross-store integrity: a ledger that points at nothing would silently corrupt stock / payments ----
  if(!errors.length){
    const ids=n=>new Set((data.stores[n]||[]).map(r=>String(r.id)));
    const productIds=ids('products'),invoiceIds=ids('invoices'),txById=new Map((data.stores.transactions||[]).map(r=>[String(r.id),r]));
    const keys=new Set();
    for(const m of data.stores.stockMovements||[]){
      const e=validateMovement(m);
      if(e){errors.push(`حرکت موجودی نامعتبر (شناسه ${m.id}): ${e}`);break;}
      if(!productIds.has(String(m.productId))){errors.push(`حرکت موجودی ${m.id} به کالای ناموجود اشاره می‌کند.`);break;}
      if(keys.has(m.key)){errors.push(`حرکت موجودی تکراری (${m.key}).`);break;}
      keys.add(m.key);
    }
    const akeys=new Set();const allocSum=new Map();
    for(const a of data.stores.paymentAllocations||[]){
      if(!(Number(a.amount)>0)){errors.push(`مبلغ تخصیص نامعتبر (شناسه ${a.id}).`);break;}
      const pay=txById.get(String(a.paymentId));
      if(!pay||pay.type!=='customer_payment'||(pay.invoiceId!==null&&pay.invoiceId!==undefined)){errors.push(`تخصیص ${a.id} به دریافت معتبر (بدون فاکتور) اشاره نمی‌کند.`);break;}
      if(!invoiceIds.has(String(a.invoiceId))){errors.push(`تخصیص ${a.id} به فاکتور ناموجود اشاره می‌کند.`);break;}
      if(a.key){if(akeys.has(a.key)){errors.push(`تخصیص تکراری (${a.key}).`);break;}akeys.add(a.key);}
      allocSum.set(String(a.paymentId),(allocSum.get(String(a.paymentId))||0)+Number(a.amount));
    }
    if(!errors.length) for(const [pid,sum] of allocSum) if(sum>Number(txById.get(pid).amount)+1e-9){errors.push(`مجموع تخصیص‌های دریافت ${pid} از مبلغ آن بیشتر است.`);break;}
  }
  return {valid:errors.length===0,errors:errors.slice(0,5),counts};
}
export async function importDatabase(data){
  const check=validateBackup(data);
  if(!check.valid) throw new Error(check.errors.join('\n'));
  // new-format backups are already in Rial: make sure the one-time Toman->Rial migration can never run again on them
  const incoming={...data.stores};
  const dv=Number(data.dataVersion);
  if(dv>=1){
    const rows=Array.isArray(incoming.settings)?incoming.settings.map(r=>({...r})):[];
    let row=rows.find(r=>r.id===SETTINGS_ID);
    if(!row){row={...DEFAULT_SETTINGS};rows.push(row);}
    row.rialMigrationV1=true;row.invoiceTaxSnapshotV1=true;
    // Phase 2 upgrade of a Phase 1 backup (dataVersion 1, already Rial): build the opening ledger from the backup's own products
    // INSIDE the same restore transaction, so restore stays all-or-nothing. A Phase 2 backup already carries its ledger.
    if(dv>=2){row.stockLedgerV1=true;}
    else{
      const now=Date.now();
      incoming.stockMovements=planStockLedgerInit(Array.isArray(incoming.products)?incoming.products:[],[],todayLocalISO(),isoFromTimestamp).map(m=>({...m,createdAt:now,updatedAt:now}));
      incoming.paymentAllocations=[];
      row.stockLedgerV1=true;
    }
    incoming.settings=rows;
  }
  // dv < 1 (V2.7-era backup, amounts in Toman): flags stay unset on purpose; the (idempotent) migrations run right after the restore,
  // Toman->Rial first, then the opening ledger from the converted prices.
  const db=await openDB();
  await new Promise((resolve,reject)=>{
    const t=db.transaction(stores,'readwrite');
    try{stores.forEach(s=>{const os=t.objectStore(s);os.clear();(Array.isArray(incoming[s])?incoming[s]:[]).forEach(row=>os.put(row));});}
    catch(e){t.abort();reject(e);return;}
    t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('بازیابی انجام نشد.'));
  });
  if(!(dv>=1)) await getSettings();
  return check.counts;
}
export { DEFAULT_SETTINGS, DB_NAME, DB_VERSION };
