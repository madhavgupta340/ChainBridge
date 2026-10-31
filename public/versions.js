// Certificate versions in the browser: looking up the version to continue, and the version history view.
// Everything is read from Cardano through the ChainBridge server (Blockfrost): no app database. The history starts at
// a given transaction and follows each version's "previous version" link backwards; newer versions can't be found.
import {h,mount,api,spinner} from './ui.js';

const EXPLORER='https://preprod.cardanoscan.io/transaction/';
const cache=new Map();
const when=iso=>iso?new Date(iso).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'}):'';
const short=x=>x?`${x.slice(0,10)}…${x.slice(-6)}`:'';
const note=(kind,...c)=>h('div',{class:`note ${kind}`},...c);

// The transaction of a ChainBridge certificate file: the package certificate.json or a shareable file certificate.
export function transactionOf(cert){
 const tx=cert?.publication?.transaction??cert?.cardano?.transaction;
 return /^[0-9a-f]{64}$/.test(tx??'')?tx:null;
}
export const lookupVersion=tx=>api(`/api/versions/${tx}`);
export const newSeriesId=()=>`s-${Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>b.toString(16).padStart(2,'0')).join('')}`;

// Plain-language explanation of version, series and transaction.
export const termsExplainer=()=>h('dl',{class:'terms'},
 h('dt',{},'Certificate version'),h('dd',{},'One sealed state of your file or data, with its own certificate and proof file. A new version never changes an older one.'),
 h('dt',{},'Certificate series'),h('dd',{},'A random ID such as s-3f9a0c… that connects the versions. It contains nothing about you or the content. Every version repeats it on Cardano, so anyone can see which versions belong together.'),
 h('dt',{},'Cardano transaction'),h('dd',{},'The public record of one version: its fingerprint, version number and a link to the previous version\'s transaction.'));

// One check as a compact chip: icon + plain words (✓ passed, ✕ failed, – not checked).
const ICON={valid:'✓',mismatch:'✕','not-found':'✕','not-checked':'–'};
const KIND={valid:'ok',mismatch:'bad','not-found':'bad','not-checked':'none'};
const chip=(c,words)=>h('span',{class:`vchip ${KIND[c?.status]??'none'}`,title:c?.detail??'Not checked'},h('i',{'aria-hidden':'true'},ICON[c?.status]??'–'),words);
function chips(v,i,expected){
 const tx=v.tx?.status,rec=v.record?.status,link=v.link?.status;
 return [
  chip(v.tx,tx==='valid'?'On Cardano':tx==='not-found'?'Missing on Cardano':'Transaction not checked'),
  v.record&&chip(v.record,rec==='valid'?(i===0&&expected?'Fingerprint matches':'Fingerprint recorded'):'Fingerprint differs'),
  v.link&&chip(v.link,link==='valid'?(v.version===1?'Start of the series':`Links to version ${v.version-1}`):'Link broken'),
 ];
}
function summary(r){
 const n=r.versions.length;
 if(r.complete)return h('p',{class:'vsum ok'},h('i',{'aria-hidden':'true'},'✓'),n>1?`${n} versions, each linked to the one before, back to version 1.`:'Version 1, the start of this series. No earlier versions.');
 const bad=r.versions.flatMap(v=>[v.tx,v.record,v.link]).find(c=>c&&c.status!=='valid'&&c.status!=='not-checked');
 if(bad)return h('p',{class:'vsum bad'},h('i',{'aria-hidden':'true'},'✕'),bad.detail);
 if(r.stop==='too-long')return h('p',{class:'vsum'},h('i',{'aria-hidden':'true'},'–'),`Only the newest ${n} versions were followed.`);
 return h('p',{class:'vsum'},h('i',{'aria-hidden':'true'},'–'),'Not everything could be checked. See below.');
}
function rows(r,expected){
 return [summary(r),
  h('ol',{class:'vtl'},r.versions.map((v,i)=>{
   const problems=[v.tx,v.record,v.link].filter(c=>c&&c.status!=='valid');
   return h('li',{class:`vnode ${i===0?'head':''} ${problems.some(c=>c.status!=='not-checked')?'bad':''}`},
    h('span',{class:'vdot','aria-hidden':'true'},v.version??'?'),
    h('div',{class:'vcard'},
     h('div',{class:'vcard-head'},
      h('strong',{},v.version?`Version ${v.version}`:'Unknown version'),i===0&&h('span',{class:'vtag'},expected?'This certificate':'Starting point'),
      v.blockTime&&h('span',{class:'vwhen'},when(v.blockTime))),
     h('a',{class:'vtx',href:v.explorer,target:'_blank',rel:'noopener'},`tx ${short(v.txHash)} ↗`),
     h('div',{class:'vchips'},chips(v,i,expected)),
     problems.map(c=>h('p',{class:'vproblem'},c.detail)),
     v.root&&h('details',{class:'vdetails'},h('summary',{},'Details'),h('dl',{},
      h('dt',{},'Fingerprint'),h('dd',{},h('code',{},v.root)),h('dt',{},'Series'),h('dd',{},h('code',{},v.series??'none')),
      h('dt',{},'Previous version'),h('dd',{},v.prevTx?h('code',{},v.prevTx):'None (version 1)')))));
  }))];
}
// Version history from `txHash` backwards. Cached per transaction, so re-renders don't refetch; every copy of the view
// on the page is redrawn when the lookup finishes.
// `chain` (optional): where the chain comes from; by default the local server's /api/versions route.
export function versionHistory(txHash,{expectedRoot=null,title='Version history',chain=null}={}){
 const fetchChain=chain??((tx,o)=>api(`/api/versions/${tx}/chain${o.expectedRoot?`?root=${o.expectedRoot}`:''}`));
 const key=`${txHash}:${expectedRoot??''}`;
 const el=h('section',{class:'vhist'});
 const head=(busy=false)=>h('div',{class:'vhist-head'},
  h('div',{},h('h3',{},title),h('p',{class:'vhist-sub'},'Read from Cardano by following each version\'s link to the one before. Newer versions can\'t be seen from here: if you need the latest, ask the sender for its certificate.')),
  h('button',{class:'btn small',type:'button',disabled:busy,onclick:load},busy?'Checking…':'Check again'));
 const load=()=>{
  const entry={loading:true,views:cache.get(key)?.views??new Set()};cache.set(key,entry);redraw();
  fetchChain(txHash,{expectedRoot})
   .then(result=>Object.assign(entry,{loading:false,result}),e=>Object.assign(entry,{loading:false,error:e.message})).then(redraw);
 };
 const draw=view=>{
  const c=cache.get(key);
  if(!c||c.loading)return mount(view,head(true),h('div',{class:'vwait'},spinner('Following the links on Cardano…')));
  if(c.error)return mount(view,head(),note('warn',`The version history could not be read: ${c.error}`));
  mount(view,head(),rows(c.result,expectedRoot));
 };
 function redraw(){const c=cache.get(key);for(const v of [...c.views]){if(!v.isConnected&&v!==el){c.views.delete(v);continue;}draw(v);}}
 if(!cache.has(key))cache.set(key,{views:new Set()});
 cache.get(key).views.add(el);
 if(!cache.get(key).result&&!cache.get(key).loading&&!cache.get(key).error)load();else draw(el);
 return el;
}
