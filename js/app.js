import { route,onNavigate,startRouter,navigate } from './router.js';
import { getSettings } from './db.js';
import { renderDashboard } from './views/dashboard.js';
import { renderCustomers } from './views/customers.js';
import { renderCustomerDetail } from './views/customer-detail.js';
import { renderProducts } from './views/products.js';
import { renderServices } from './views/services.js';
import { renderProjects, renderProjectDetail } from './views/projects.js';
import { renderInvoices, renderInvoiceDetail } from './views/invoices.js';
import { renderAccounting } from './views/accounting.js';
import { renderReports } from './views/reports.js';
import { renderSettings } from './views/settings.js';
const view=()=>document.getElementById('view');
const setView=html=>{view().innerHTML=html;window.scrollTo(0,0);};
export const App={view,setView};
route('#/dashboard',()=>renderDashboard(App));route('#/customers',p=>renderCustomers(App,{openNew:p.query.get('new')}));route('#/customers/:id',p=>renderCustomerDetail(App,p));
route('#/products',p=>renderProducts(App,{openNew:p.query.get('new')}));route('#/services',p=>renderServices(App,{openNew:p.query.get('new')}));route('#/projects',()=>renderProjects(App));route('#/projects/:id',p=>renderProjectDetail(App,p));route('#/invoices',p=>renderInvoices(App,{editId:p.query.get('edit'),newBlank:p.query.get('new'),newProject:p.query.get('project')}));route('#/invoices/new/:customerId',p=>renderInvoices(App,{newForCustomer:p.customerId}));route('#/invoices/:id',p=>renderInvoiceDetail(App,p));
route('#/accounting',p=>renderAccounting(App,{newType:p.query.get('new')}));route('#/reports',p=>renderReports(App,p));route('#/settings',()=>renderSettings(App));
const MORE=['#/services','#/projects','#/accounting','#/reports','#/settings'];
function syncNav(hash){const base=hash.split('?')[0];const active=base.startsWith('#/customers')?'#/customers':MORE.some(r=>base.startsWith(r))?'#/more':base;document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.route===active));}
onNavigate(syncNav);
document.addEventListener('click',e=>{const b=e.target.closest('[data-route]');if(b){e.preventDefault();navigate(b.dataset.route);return;}const more=e.target.closest('[data-more]');if(more){e.preventDefault();openMoreSheet();}});
function openMoreSheet(){const root=document.getElementById('modal-root');root.innerHTML=`<div class="sheet-backdrop" data-sheet-close><section class="bottom-sheet" role="dialog" aria-modal="true" aria-label="بیشتر"><div class="sheet-handle"></div><div class="sheet-title">بیشتر</div><div class="sheet-grid">${[['#/services','briefcase','خدمات','برق ساختمان و صنعتی'],['#/projects','folder','پروژه‌ها','مدیریت پروژه'],['#/accounting','wallet','حسابداری','درآمد و هزینه'],['#/reports','chart','گزارش‌ها','گزارش‌های مالی'],['#/settings','settings','تنظیمات','پشتیبان و تنظیمات']].map(x=>`<button class="sheet-item" data-route="${x[0]}">${iconName(x[1])}<span><b>${x[2]}</b><small>${x[3]}</small></span></button>`).join('')}</div></section></div>`;root.querySelector('[data-sheet-close]').addEventListener('click',e=>{if(e.target===e.currentTarget)root.innerHTML='';});root.querySelectorAll('[data-route]').forEach(b=>b.addEventListener('click',()=>root.innerHTML=''));}
function iconName(n){return `<img class="icon icon-lg" src="./assets/icons/${n}.svg" alt="" aria-hidden="true">`;}
function online(){const e=document.getElementById('online-indicator');if(!e)return;e.textContent=navigator.onLine?'آنلاین':'آفلاین';e.className='online-indicator '+(navigator.onLine?'is-online':'is-offline');}
window.addEventListener('online',online);window.addEventListener('offline',online);
// Run the (idempotent) data migrations BEFORE the first screen renders, so no view can ever read/write un-migrated amounts
// and the one-time Toman->Rial conversion can never fire later on top of data entered in Rial.
document.addEventListener('DOMContentLoaded',()=>{Promise.race([getSettings(),new Promise(r=>setTimeout(r,5000))]).catch(err=>console.error('DIA migration failed',err)).finally(()=>{startRouter();online();});if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});});
