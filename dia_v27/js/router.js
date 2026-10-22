const routes=[];let afterNavigate=null;let render=null;
function compile(pattern){const keys=[];const regex=pattern.replace(/:[^/]+/g,m=>{keys.push(m.slice(1));return '([^/]+)'});return {re:new RegExp('^'+regex+'$'),keys};}
export function route(pattern,fn){const {re,keys}=compile(pattern);routes.push({re,keys,fn});}
export function onNavigate(fn){afterNavigate=fn;}
// Setting location.hash to the value it already holds does not fire 'hashchange',
// so a repeated navigate() to the same route+query (e.g. re-opening the edit modal
// for the same invoice after Cancel, which never reset the hash) would otherwise be
// a silent no-op. Force a re-render in that case so the view/modal always opens.
export function navigate(hash){if(location.hash===hash){render?.();}else{location.hash=hash;}}
export function startRouter(){render=()=>{const raw=location.hash||'#/dashboard';const key=raw.split('?')[0];for(const r of routes){const m=key.match(r.re);if(m){const params={};r.keys.forEach((k,i)=>params[k]=decodeURIComponent(m[i+1]));const query=new URLSearchParams(raw.includes('?')?raw.split('?')[1]:'');params.query=query;r.fn(params);afterNavigate?.(raw);return;}}if(key!=='#/dashboard')navigate('#/dashboard');};window.addEventListener('hashchange',render);render();}
