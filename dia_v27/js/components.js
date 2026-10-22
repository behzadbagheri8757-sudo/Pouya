import { esc, icon, toast } from './utils.js';
import { DB } from './db.js';
export const pageHeader=(title,{back=false,action=null,actionIcon='plus',actionId='',subtitle=''}={})=>`<div class="page-title-row">${back?`<button class="btn btn-ghost btn-icon" data-back aria-label="بازگشت">${icon('arrow-right','بازگشت')}</button>`:''}<div class="${back?'page-heading':''}"><h1 class="page-title">${esc(title)}</h1>${subtitle?`<div class="page-subtitle">${esc(subtitle)}</div>`:''}</div>${action?`<button class="btn btn-primary" id="${esc(actionId)}">${icon(actionIcon,'')}${esc(action)}</button>`:''}</div>`;
export const emptyState=(title,text,action=null,id='')=>`<div class="empty">${icon('folder','') }<strong>${esc(title)}</strong><div>${esc(text)}</div>${action?`<button class="btn btn-secondary mt-3" id="${esc(id)}">${icon('plus','')}${esc(action)}</button>`:''}</div>`;
export const actionMenu=(id)=>`<div class="item-actions"><button class="btn btn-ghost btn-icon menu-toggle" data-menu="${id}" aria-label="عملیات">${icon('more-vertical','')}</button><div class="action-menu" data-action-menu="${id}" hidden><button data-edit="${id}">${icon('edit','')} ویرایش</button><button class="danger" data-delete="${id}">${icon('trash','')} حذف</button></div></div>`;
let modalEscapeBound=false;
export function closeModal(){
  const r=document.getElementById('modal-root');if(r)r.innerHTML='';
  document.body.classList.remove('modal-open');
  if(modalEscapeBound){document.removeEventListener('keydown',closeOnEscape);modalEscapeBound=false;}
  // Some modals are opened via a hash query (e.g. #/invoices?edit=123). If the query is
  // left in place after closing, tapping the same "Edit" action again sets location.hash
  // to the exact same value, which does not fire 'hashchange' and silently fails to
  // reopen the modal. Clearing the query on every close keeps the hash reusable.
  if(location.hash.includes('?')){
    const clean=location.hash.split('?')[0]||'#/dashboard';
    history.replaceState(null,'',location.pathname+location.search+clean);
  }
}
function closeOnEscape(e){if(e.key==='Escape'){e.preventDefault();closeModal();}}
export function openModal(html){closeModal();const r=document.getElementById('modal-root');r.innerHTML=`<div class="modal-backdrop" data-modal-backdrop><section class="modal" role="dialog" aria-modal="true">${html}</section></div>`;document.body.classList.add('modal-open');document.addEventListener('keydown',closeOnEscape);modalEscapeBound=true;const backdrop=r.querySelector('[data-modal-backdrop]');backdrop.addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal();});const modal=r.querySelector('.modal');setTimeout(()=>{const target=modal?.querySelector('[autofocus]')||modal?.querySelector('input:not([disabled]),select,textarea,button');target?.focus();},30);return modal;}
let actionMenuDocumentBound=false;
function bindActionMenuDocumentClose(){if(actionMenuDocumentBound)return;document.addEventListener('click',e=>{if(e.target.closest('.item-actions'))return;document.querySelectorAll('.action-menu:not([hidden])').forEach(m=>m.hidden=true);});actionMenuDocumentBound=true;}
export function bindActionMenus(root,handlers){bindActionMenuDocumentClose();root.querySelectorAll('.menu-toggle').forEach(b=>b.onclick=e=>{e.stopPropagation();root.querySelectorAll('.action-menu').forEach(m=>m.hidden=true);const menu=root.querySelector(`[data-action-menu="${CSS.escape(b.dataset.menu)}"]`);if(menu)menu.hidden=false;});root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=e=>{e.stopPropagation();handlers.edit(b.dataset.edit)});root.querySelectorAll('[data-delete]').forEach(b=>b.onclick=e=>{e.stopPropagation();handlers.delete(b.dataset.delete)});}

// Delete-or-archive policy for customers / projects / products / services.
// * Without any financial/work history the record can be deleted.
// * With history it is NEVER destroyed: the user is offered Archive (hidden from new pickers, history intact),
//   and an archived record can be re-activated from the same action.
export async function deleteOrArchive({store,row,usage,noun,onDone}){
  if(!row) return;
  const used=usage?.total||0;
  const detail=[usage?.invoices&&`${usage.invoices} فاکتور`,usage?.transactions&&`${usage.transactions} تراکنش`,usage?.projects&&`${usage.projects} پروژه`,usage?.items&&`${usage.items} فاکتور دارای این ${noun}`].filter(Boolean).join('، ');
  if(!used){
    if(confirm(`این ${noun} حذف شود؟`)){await DB.delete(store,Number(row.id));toast(`${noun} حذف شد`);onDone?.();}
    return;
  }
  if(row.archived){
    if(confirm(`این ${noun} در آرشیو است و به دلیل سابقه (${detail}) قابل حذف نیست.\nبرای فعال‌سازی مجدد تأیید کنید.`)){await DB.put(store,{...row,archived:false,archivedAt:null});toast(`${noun} دوباره فعال شد`);onDone?.();}
    return;
  }
  if(confirm(`این ${noun} دارای سابقه (${detail}) است و حذف آن سابقه مالی را خراب می‌کند، بنابراین حذف نمی‌شود.\nبه‌جای حذف، به آرشیو منتقل شود؟ (سابقه حفظ می‌شود و در انتخاب‌های جدید نمایش داده نمی‌شود.)`)){
    await DB.put(store,{...row,archived:true,archivedAt:Date.now()});toast(`${noun} آرشیو شد`);onDone?.();
  }
}
