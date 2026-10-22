import { normalizeAmountInput } from './validators.js';
export { isIncomeType, isExpenseType, dateToTimestamp, effectiveTimestamp, buildCustomerLedger, invoicePaidAmount, financialSummary, totalReceivables } from './finance.js';
export const CURRENCY='ریال';
export const money=(n,unit=CURRENCY)=>new Intl.NumberFormat('fa-IR').format(Math.round(Number(n)||0))+(unit?' '+unit:'');
export const num=n=>new Intl.NumberFormat('fa-IR',{maximumFractionDigits:2}).format(Number(n)||0);
export const formatAmountInput=value=>{
  if(value===null||value===undefined||value==='') return '';
  const normalized=normalizeAmountInput(value);
  const m=normalized.match(/^(\d+)(?:\.(\d{0,3}))?$/);
  if(!m) return value;
  const integer=new Intl.NumberFormat('fa-IR').format(Number(m[1]));
  return m[2]!==undefined?`${integer}.${m[2]}`:integer;
};
export function bindAmountInput(input, options={}){
  if(!input) return;
  const allowDecimal=options.allowDecimal!==false;
  // Whole-Rial fields use the numeric keyboard on mobile so decimal punctuation cannot
  // be silently concatenated into a value ten times larger.
  if(!allowDecimal) input.setAttribute('inputmode','numeric');
  const format=()=>{
    // Normalize Persian/Arabic digits and separators before enforcing the field policy.
    const raw=normalizeAmountInput(input.value);
    if(!raw) return;
    const clean=allowDecimal
      ? raw.replace(/[^0-9.]/g,'').split('.').slice(0,2).join('.')
      : raw.split('.')[0].replace(/[^0-9]/g,'');
    const parts=clean.split('.');
    const integer=parts[0]||'0';
    const decimal=allowDecimal&&parts.length>1?parts[1].slice(0,3):'';
    const formatted=new Intl.NumberFormat('fa-IR').format(Number(integer));
    input.value=decimal!==''?`${formatted}.${decimal}`:formatted;
  };
  input.addEventListener('input',format);
  input.addEventListener('blur',format);
  if(input.value) format();
}
const toLocalDate=d=>{if(typeof d==='string'){const m=d.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(m)return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));}return new Date(d);};
export const dateFa=d=>{if(!d)return '—';const dt=toLocalDate(d);return Number.isNaN(dt.getTime())?'—':new Intl.DateTimeFormat('fa-IR',{year:'numeric',month:'2-digit',day:'2-digit'}).format(dt);};
export const dateTimeFa=d=>{if(!d)return '—';const dt=toLocalDate(d);return Number.isNaN(dt.getTime())?'—':new Intl.DateTimeFormat('fa-IR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(dt);};
// Per-form idempotency token: generated once when a form opens and sent with the write, so a retry/double tap can never book twice.
export const newToken=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,9);
export const uid=()=>Date.now()+Math.floor(Math.random()*100000);
export const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
export const icon=(name,label='',cls='icon')=>`<img class="${cls}" src="./assets/icons/${name}.svg" alt="${esc(label)}" aria-hidden="${label?'false':'true'}">`;
export const todayISO=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};

// Gregorian/Jalali conversion kept local and dependency-free for offline/PWA use.
export function gregorianToJalali(gy,gm,gd){
  const gdm=[0,31,59,90,120,151,181,212,243,273,304,334];
  let gy2=gy+(gm>2?1:0);
  let days=355666+365*gy+Math.floor((gy2+3)/4)-Math.floor((gy2+99)/100)+Math.floor((gy2+399)/400)+gd+gdm[gm-1];
  let jy=-1595+33*Math.floor(days/12053); days%=12053;
  jy+=4*Math.floor(days/1461); days%=1461;
  if(days>365){jy+=Math.floor((days-1)/365);days=(days-1)%365;}
  const jm=days<186?1+Math.floor(days/31):7+Math.floor((days-186)/30);
  const jd=1+(days<186?days%31:(days-186)%30);
  return [jy,jm,jd];
}
export function jalaliToGregorian(jy,jm,jd){
  jy=Number(jy);jm=Number(jm);jd=Number(jd);
  let jy2=jy+1595;
  let days=-355668+365*jy2+Math.floor(jy2/33)*8+Math.floor((jy2%33+3)/4)+jd+(jm<7?(jm-1)*31:(jm-7)*30+186);
  let gy=400*Math.floor(days/146097); days%=146097;
  if(days>36524){gy+=100*Math.floor(--days/36524);days%=36524;if(days>=365)days++;}
  gy+=4*Math.floor(days/1461);days%=1461;
  if(days>365){gy+=Math.floor((days-1)/365);days=(days-1)%365;}
  const gd=days+1;
  const leap=gy%4===0&&(gy%100!==0||gy%400===0);
  const gdm=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  let gm=1; let rem=gd; for(let i=0;i<12;i++){if(rem>gdm[i]){rem-=gdm[i];gm++;}else break;}
  return [gy,gm,rem];
}
export const jalaliFromISO=iso=>{if(!iso)return null;const m=String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return null;const [gy,gm,gd]=m.slice(1).map(Number);return gregorianToJalali(gy,gm,gd);};
export const isoFromJalali=(jy,jm,jd)=>{const [gy,gm,gd]=jalaliToGregorian(jy,jm,jd);return `${gy}-${String(gm).padStart(2,'0')}-${String(gd).padStart(2,'0')}`;};
export const jalaliDateText=iso=>{const j=jalaliFromISO(iso);return j?`${new Intl.NumberFormat('fa-IR').format(j[0])}/${new Intl.NumberFormat('fa-IR').format(j[1]).padStart(2,'۰')}/${new Intl.NumberFormat('fa-IR').format(j[2]).padStart(2,'۰')}`:'—';};
export const jalaliYearMonthDay=iso=>jalaliFromISO(iso)||gregorianToJalali(...todayISO().split('-').map(Number));
export const jalaliMonthNames=['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
export const jalaliIsLeap=jy=>{const [gy,gm,gd]=jalaliToGregorian(jy,12,30);const back=gregorianToJalali(gy,gm,gd);return back[0]===Number(jy)&&back[1]===12&&back[2]===30;};

export function toast(msg,kind=''){const r=document.getElementById('toast-root');if(!r)return;r.innerHTML=`<div class="toast ${kind?'toast-'+kind:''}" role="status">${esc(msg)}</div>`;clearTimeout(toast._t);toast._t=setTimeout(()=>r.innerHTML='',2600);}
export async function downloadBlob(blob,name){
  if(!blob) throw new Error('فایل خروجی ساخته نشد.');
  // iOS Safari often ignores <a download> for Blob URLs. Prefer the native
  // Share Sheet when a File can be shared, then fall back to opening the file.
  try{
    const file=new File([blob],name,{type:blob.type||'application/octet-stream'});
    if(navigator.share && navigator.canShare && navigator.canShare({files:[file]})){
      await navigator.share({files:[file],title:name});
      return {shared:true};
    }
  }catch(err){
    if(err?.name==='AbortError') return {cancelled:true};
  }
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;a.rel='noopener';
  document.body.appendChild(a);a.click();a.remove();
  // On Safari, opening the blob is a more reliable last resort than silently
  // failing a download attribute.
  setTimeout(()=>{try{window.open(url,'_blank','noopener')}catch(_){}},120);
  setTimeout(()=>URL.revokeObjectURL(url),30000);
  return {downloaded:true};
}
export const downloadJSON=(data,name)=>downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),name);
export function printWithClass(cls){document.body.classList.add(cls);const cleanup=()=>{document.body.classList.remove(cls);window.removeEventListener('afterprint',cleanup)};window.addEventListener('afterprint',cleanup);setTimeout(()=>window.print(),40);}
export async function invoiceToImage(el,name='invoice.jpg'){
  if(!el) throw new Error('محتوای فاکتور پیدا نشد.');
  // Canvas does not always pick up a CSS @font-face immediately on iOS/Safari.
  // Explicitly register/load the Persian text font before drawing so the PNG
  // text matches the live invoice UI. Numbers deliberately use no @font-face —
  // they draw with the iOS/native system font stack (NUM_FONT_STACK below),
  // which is always available and needs no loading step.
  try{
    const fontFiles={
      regular:new URL('../assets/fonts/NotoKufiArabic-Regular.ttf',import.meta.url).href,
      bold:new URL('../assets/fonts/NotoKufiArabic-Bold.ttf',import.meta.url).href
    };
    const faces=[
      ['DIAFont',fontFiles.regular,'400'],['DIAFont',fontFiles.bold,'700']
    ];
    for(const [family,src,weight] of faces){
      const face=new FontFace(family,`url(${src})`,{weight});
      await face.load();
      document.fonts.add(face);
    }
    await Promise.all([
      document.fonts.load('400 20px DIAFont'),document.fonts.load('700 20px DIAFont')
    ]);
    await document.fonts.ready;
  }catch(_){
    try{await document.fonts?.ready;}catch(__){}
  }
  const clean=t=>String(t??'').replace(/\s+/g,' ').trim();
  const rows=[...el.querySelectorAll('.clean-invoice-table tbody tr')].map(tr=>[...tr.children].map(td=>clean(td.textContent))).filter(r=>r.length>=7);
  const summary=[...el.querySelectorAll('.invoice-summary-box>div')].map(d=>({label:clean(d.querySelector('span')?.textContent),value:clean(d.querySelector('strong')?.textContent),grand:d.classList.contains('grand'),balance:d.classList.contains('balance-row')}));
  const business=clean(el.querySelector('.invoice-business-name')?.textContent)||'DIA Sanat';
  const businessSub=clean(el.querySelector('.invoice-business-sub')?.textContent)||'تأسیسات الکتریکی و نورپردازی';
  const docLabel=clean(el.querySelector('.invoice-doc-label')?.textContent)||'فاکتور فروش';
  const docNumber=clean(el.querySelector('.invoice-doc-number')?.textContent)||'';
  const seller=[...el.querySelectorAll('.invoice-party-card')][0];
  const buyer=[...el.querySelectorAll('.invoice-party-card')][1];
  const sellerName=clean(seller?.querySelector('strong')?.textContent)||business;
  const sellerLines=[...seller?.querySelectorAll('span')||[]].map(x=>clean(x.textContent)).filter(Boolean);
  const buyerName=clean(buyer?.querySelector('strong')?.textContent)||'مشتری آزاد';
  const buyerLines=[...buyer?.querySelectorAll('span')||[]].map(x=>clean(x.textContent)).filter(Boolean);
  const meta=[...el.querySelectorAll('.invoice-meta-card>div')].map(d=>({label:clean(d.querySelector('span')?.textContent),value:clean(d.querySelector('strong')?.textContent)}));
  const project=el.querySelector('.invoice-project-card');
  const projectParts=project?[...project.children].map(x=>({label:clean(x.querySelector('span')?.textContent),value:clean(x.querySelector('strong')?.textContent)})).filter(x=>x.value):[];
  const words=clean(el.querySelector('.invoice-words-block>strong')?.textContent);
  const notes=clean(el.querySelector('.invoice-notes-block p')?.textContent);
  const footer=clean(el.querySelector('.invoice-footer-note')?.textContent);
  const logoSrc=el.querySelector('.invoice-logo')?.getAttribute('src');
  const W=1240, PAD=58, CW=W-PAD*2;
  const headH=58;
  const estimatedRows=Math.max(1,rows.length);
  const estimatedRowHeight=rows.length?rows.reduce((sum,r)=>{const d=clean(r[1]);return sum+Math.max(62,24+Math.max(1,Math.ceil(d.length/48))*18)},0):62;
  const estimatedWordLines=Math.max(1,Math.ceil(words.length/48));
  const estimatedNoteLines=notes?Math.max(1,Math.ceil(notes.length/55)):0;
  let H=1100 + estimatedRowHeight + (projectParts.length?115:0) + Math.min(340,80+estimatedWordLines*28+estimatedNoteLines*25) + (footer?68:0) + 110;
  H=Math.max(1500,Math.min(3200,H));
  const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('مرورگر امکان ساخت تصویر فاکتور را ندارد.');
  const C={black:'#151918',text:'#252b29',muted:'#69726f',line:'#b9c0bd',soft:'#f6f7f6',accent:'#087f70',accentSoft:'#e9f4f1',white:'#ffffff'};
  ctx.fillStyle=C.white;ctx.fillRect(0,0,W,H);ctx.direction='rtl';ctx.textBaseline='middle';
  const containsNumber=t=>/[0-9۰-۹٠-٩]/.test(String(t??''));
  // Numeric text draws with the iOS/native system font (no bundled numeral font),
  // matching the CSS --num-font stack used on-screen. Non-numeric text keeps DIAFont.
  const NUM_FONT_STACK='-apple-system,BlinkMacSystemFont,"SF Pro Text",Tahoma,Arial,sans-serif';
  const font=(size,bold=false,numeric=false)=>{ctx.font=`${bold?'700':'400'} ${size}px ${numeric?NUM_FONT_STACK:'DIAFont,Tahoma,Arial,sans-serif'}`;};
  const wrap=(text,max,size=20,bold=false,numeric=containsNumber(text))=>{font(size,bold,numeric);const words=clean(text).split(' ');const out=[];let line='';for(const word of words){const test=line?`${line} ${word}`:word;if(ctx.measureText(test).width<=max)line=test;else{if(line)out.push(line);line=word;}}if(line)out.push(line);return out.length?out:[''];};
  const textR=(text,x,y,size,bold=false,fill=C.text,max=CW,numeric=containsNumber(text))=>{font(size,bold,numeric);ctx.fillStyle=fill;ctx.textAlign='right';const lines=wrap(text,max,size,bold,numeric);lines.forEach((ln,i)=>ctx.fillText(ln,x,y+i*29));return lines.length*29;};
  const textC=(text,x,y,size,bold=false,fill=C.text,numeric=containsNumber(text))=>{font(size,bold,numeric);ctx.fillStyle=fill;ctx.textAlign='center';ctx.fillText(clean(text),x,y);};
  const textL=(text,x,y,size,bold=false,fill=C.text,numeric=containsNumber(text))=>{font(size,bold,numeric);ctx.fillStyle=fill;ctx.textAlign='left';ctx.fillText(clean(text),x,y);};
  const line=(x1,y1,x2,y2,w=1,stroke=C.line)=>{ctx.strokeStyle=stroke;ctx.lineWidth=w;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();};
  const box=(x,y,w,h,fill=C.white,stroke=C.line,lw=1)=>{ctx.fillStyle=fill;ctx.fillRect(x,y,w,h);ctx.strokeStyle=stroke;ctx.lineWidth=lw;ctx.strokeRect(x,y,w,h);};
  const logo=async()=>{if(!logoSrc)return;try{const img=await new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=logoSrc;});const size=64;ctx.drawImage(img,W/2-size/2,18,size,size);}catch(_) {}};
  await logo();
  // Header mirrors the on-screen invoice: business identity is centered, the document title is a separate block below it.
  // This avoids the common visual collision where "فاکتور فروش" and the company name read as one heading.
  textL('نسخه مشتری',PAD,63,17,true,C.black);textL('سیستم حسابداری DIA',PAD,96,13,true,C.muted);
  textC(business,W/2,102,26,true,C.black);textC(businessSub,W/2,132,14,false,C.muted);
  line(PAD,160,W-PAD,160,1,C.line);
  textC(docLabel,W/2,202,32,true,C.black);textC(docNumber,W/2,237,16,false,C.muted);
  line(PAD,272,W-PAD,272,1.4,C.black);
  let y=294;
  // Seller / buyer / invoice metadata block.
  const gap=14, metaW=230, partyW=(CW-metaW-gap)/2;
  const bx=PAD, sx=PAD+partyW+gap, mx=W-PAD-metaW;
  box(bx,y,partyW,132,C.white,C.line);box(sx,y,partyW,132,C.white,C.line);box(mx,y,metaW,132,C.white,C.line);
  textR('فروشنده',bx+partyW-16,y+22,14,true,C.muted);textR(sellerName,bx+partyW-16,y+50,18,true,C.black);sellerLines.slice(0,2).forEach((v,i)=>textR(v,bx+partyW-16,y+79+i*24,13,false,C.text,partyW-32));
  textR('خریدار / طرف حساب',sx+partyW-16,y+22,14,true,C.muted);textR(buyerName,sx+partyW-16,y+50,18,true,C.black);buyerLines.slice(0,2).forEach((v,i)=>textR(v,sx+partyW-16,y+79+i*24,13,false,C.text,partyW-32));
  meta.slice(0,2).forEach((it,i)=>{textR(it.label,mx+metaW-16,y+28+i*50,13,false,C.muted);textR(it.value,mx+metaW-16,y+54+i*50,17,true,C.black,metaW-32);});
  y+=150;
  if(projectParts.length){box(PAD,y,CW,92,C.soft,C.line);projectParts.slice(0,3).forEach((it,i)=>{const colW=CW/Math.min(3,projectParts.length);const xx=W-PAD-i*colW-14;textR(it.label,xx,y+22,12,false,C.muted,colW-28);textR(it.value,xx,y+53,15,true,C.black,colW-28);});y+=108;}
  textR('شرح کالا و خدمات',W-PAD,y+18,17,true,C.black);y+=45;
  // Table.
  const widths=[52,150,130,170,82,82,458]; // physical LTR: row, total, discount, unit price, unit, qty, description (description ends up on the RTL right)
  const tableX=PAD, tableW=widths.reduce((a,b)=>a+b,0);
  // Numeric font is chosen per cell from its actual content (same rule used everywhere
  // else in this renderer), not from a fixed column index — a fixed index list here had
  // "قیمت واحد" (a number) rendered in the text font and "واحد" (a text label) rendered
  // in the number font, which is the mismatch users saw between the app and the exported image.
  const rowHeights=rows.length?rows.map(r=>{const desc=wrap(r[1],widths[6]-18,13,true,false);const unit=wrap(r[3],widths[4]-10,13,false,false);return Math.max(62,24+Math.max(desc.length,unit.length)*18);}):[62];
  const tableH=headH+rowHeights.reduce((a,b)=>a+b,0);
  box(tableX,y,tableW,tableH,C.white,C.black,1.2);
  ctx.fillStyle=C.soft;ctx.fillRect(tableX,y,tableW,headH);
  const headers=['ردیف','مبلغ','تخفیف','قیمت واحد','واحد','تعداد','شرح کالا / خدمت'];
  let x=tableX;
  headers.forEach((h,i)=>{const w=widths[i];textC(h,x+w/2,y+headH/2,13,true,C.black);if(i>0)line(x,y,x,y+tableH,1,C.line);x+=w;});
  let rowY=y+headH;
  rows.forEach((r,ri)=>{const rh=rowHeights[ri];line(tableX,rowY,tableX+tableW,rowY,1,C.line);const cells=[r[0],r[6],r[5],r[4],r[3],r[2],r[1]];let xx=tableX;cells.forEach((v,ci)=>{const w=widths[ci];const max=ci===6?w-18:w-10;const isNum=ci!==6&&containsNumber(v);const lines=wrap(v,max,13,ci===1||ci===6,isNum);font(13,ci===1||ci===6,isNum);ctx.fillStyle=C.text;ctx.textAlign=ci===6?'right':'center';const tx=ci===6?xx+w-9:xx+w/2;const shown=lines.slice(0,Math.max(2,Math.floor((rh-24)/18)));shown.forEach((ln,j)=>ctx.fillText(ln,tx,rowY+rh/2+(j-(shown.length>1?(shown.length-1)/2:0))*18));xx+=w;});rowY+=rh;});
  y+=tableH+22;
  // Totals and amount in words, matching the screenshot's two-column lower section.
  const summaryW=360, wordsW=CW-summaryW-gap, sy=y;
  const wordLines=Math.max(1,wrap(words,wordsW-32,16,true).length);
  const noteLines=notes?Math.max(1,wrap(notes,wordsW-32,13,false).length):0;
  const sh=Math.max(190,Math.min(340,72+wordLines*28+noteLines*25));
  box(PAD,sy,wordsW,sh,C.white,C.line);box(W-PAD-summaryW,sy,summaryW,sh,C.white,C.line);
  textR('مبلغ به حروف',PAD+wordsW-16,sy+25,13,true,C.muted);let wy=sy+61;for(const ln of wrap(words,wordsW-32).slice(0,5)){textR(ln,PAD+wordsW-16,wy,16,true,C.black,wordsW-32);wy+=28;}
  if(notes){textR('توضیحات و شرایط',PAD+wordsW-16,sy+150,13,true,C.muted);let ny=sy+183;for(const ln of wrap(notes,wordsW-32).slice(0,3)){textR(ln,PAD+wordsW-16,ny,13,false,C.text,wordsW-32);ny+=24;}}
  let yy=sy+15;summary.forEach(it=>{const h=it.grand?49:34;if(it.grand){ctx.fillStyle=C.accentSoft;ctx.fillRect(W-PAD-summaryW,yy,summaryW,h);}textR(it.label,W-PAD-16,yy+h/2,13,it.grand,C.muted);textL(it.value,W-PAD-summaryW+16,yy+h/2,14,it.grand,it.grand?C.accent:C.black,true);yy+=h;});
  y+=sh+24;
  if(footer){box(PAD,y,CW,46,C.soft,C.soft);textC(footer,W/2,y+23,12,false,C.muted);y+=68;}
  // Signatures.
  const half=(CW-80)/2;textC('امضای خریدار',PAD+half/2,y+20,14,true,C.black);textC('مهر و امضای فروشنده',PAD+half+80+half/2,y+20,14,true,C.black);line(PAD+30,y+68,PAD+half-30,y+68,1,C.line);line(PAD+half+110,y+68,W-PAD-30,y+68,1,C.line);
  // PNG keeps Persian text and thin invoice lines crisp and is reliably shareable on iOS.
  const outName=/\.(png|jpeg|jpg)$/i.test(name)?name.replace(/\.(png|jpeg|jpg)$/i,'.png'):name.replace(/\.[^.]+$/,'')+'.png';
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('ساخت تصویر فاکتور ناموفق بود.')),'image/png'));
  return downloadBlob(blob,outName);
}

const Y=['','یک','دو','سه','چهار','پنج','شش','هفت','هشت','نه'],D19=['ده','یازده','دوازده','سیزده','چهارده','پانزده','شانزده','هفده','هجده','نوزده'],D=['','','بیست','سی','چهل','پنجاه','شصت','هفتاد','هشتاد','نود'],H=['','صد','دویست','سیصد','چهارصد','پانصد','ششصد','هفتصد','هشتصد','نهصد'],S=['','هزار','میلیون','میلیارد','هزار میلیارد','میلیون میلیارد'];
function three(n){const a=[],h=Math.floor(n/100),d=Math.floor(n%100/10),y=n%10;if(h)a.push(H[h]);if(d===1)a.push(D19[y]);else{if(d)a.push(D[d]);if(y)a.push(Y[y]);}return a.join(' و ');}
export function numberToWordsFa(input){let n=Math.round(Math.abs(Number(input)||0));if(n===0)return 'صفر';const g=[];while(n){g.unshift(n%1000);n=Math.floor(n/1000)}return g.map((x,i)=>x?three(x)+(g.length-1-i?` ${S[g.length-1-i]}`:''):'').filter(Boolean).join(' و ');}
export const amountToWordsFa=(n)=>numberToWordsFa(n)+' ریال';
export const INVOICE_STATUS_LABELS={draft:'پیش‌نویس',issued:'صادر شده',partially_paid:'پرداخت جزئی',paid:'پرداخت شده',cancelled:'لغو شده'};
export const INVOICE_STATUS_BADGE={draft:'muted',issued:'info',partially_paid:'warn',paid:'paid',cancelled:'danger'};
export const PROJECT_STATUS_LABELS={planned:'در انتظار',active:'در حال اجرا',completed:'تمام شده',cancelled:'لغو شده'};
export const TRANSACTION_TYPE_LABELS={income:'درآمد',expense:'هزینه',customer_payment:'دریافت از مشتری',supplier_payment:'پرداخت به تأمین‌کننده',other_expense:'پرداخت سایر هزینه‌ها',customer_refund:'برگشت وجه به مشتری'};
export const faLabel=(map,code)=>map[code]||code||'—';
export function clearFieldErrors(form){form.querySelectorAll('.field-error').forEach(x=>x.remove());form.querySelectorAll('[aria-invalid]').forEach(x=>x.removeAttribute('aria-invalid'));}
export function showValidationErrors(form,result){
  clearFieldErrors(form);
  if(result.valid)return false;
  const unmatched=[];
  result.errors.forEach(e=>{
    const field=form.querySelector(`[name="${CSS.escape(e.field)}"]`);
    if(field){
      field.setAttribute('aria-invalid','true');
      const msg=document.createElement('div');msg.className='field-error';msg.textContent=e.message;
      field.closest('.field')?.appendChild(msg);
      // errors inside collapsed sections ("جزئیات بیشتر") must never stay invisible
      let h=field.closest('[hidden]');while(h&&form.contains(h)){h.hidden=false;h=h.parentElement?.closest('[hidden]');}
    }else unmatched.push(e.message);
  });
  // errors that belong to no single input (e.g. invoice line items) are shown as a message, not swallowed
  if(unmatched.length)toast(unmatched[0],'error');
  form.querySelector('[aria-invalid]')?.focus();
  return true;
}
// Wrap a form submit handler: blocks double-tap re-entry and reports failures instead of failing silently.
export function guardSubmit(handler){
  let busy=false;
  return async e=>{
    e?.preventDefault?.();
    if(busy)return;
    busy=true;
    try{await handler(e);}
    catch(err){console.error(err);toast(err?.message||'ذخیره انجام نشد. دوباره تلاش کنید.','error');}
    finally{busy=false;}
  };
}
