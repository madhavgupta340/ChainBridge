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

const LABEL={valid:'Valid',mismatch:'Not valid','not-found':'Missing','not-checked':'Not checked'};
const KIND={valid:'ok',mismatch:'bad','not-found':'bad','not-checked':'none'};
const pill=c=>c?h('span',{class:`pill ${KIND[c.status]??'none'}`},LABEL[c.status]??c.status):h('span',{class:'pill none'},'Not checked');

function rows(r,{onRefresh}){
 const bad=r.versions.filter(v=>[v.tx,v.record,v.link].some(c=>c&&c.status!=='valid'));
 return [
  r.complete?note('ok',h('strong',{},`All ${r.versions.length} version${r.versions.length>1?'s':''} check out. `),'Each one links to the version before it, back to version 1, and matches what is recorded on Cardano.')
   :bad.length?note('error',h('strong',{},'The chain has a problem. '),bad.map(v=>[v.tx,v.record,v.link].find(c=>c&&c.status!=='valid')?.detail).filter(Boolean)[0]??'')
   :r.stop==='too-long'?note('warn',`Only the newest ${r.versions.length} versions were followed.`):null,
  h('ol',{class:'vlist'},r.versions.map((v,i)=>h('li',{class:'vrow'},
   h('div',{class:'vrow-head'},h('strong',{},v.version?`Version ${v.version}`:'Unknown version'),i===0&&h('span',{class:'tag'},'Starting point'),
    h('a',{class:'mono-key',href:v.explorer,target:'_blank',rel:'noopener'},`${short(v.txHash)} ↗`),v.blockTime&&h('span',{class:'muted small'},`Recorded ${when(v.blockTime)}`)),
   h('div',{class:'vchecks'},
    h('span',{class:'vcheck'},'Transaction ',pill(v.tx)),h('span',{class:'vcheck'},'Commitment ',pill(v.record)),h('span',{class:'vcheck'},'Link ',pill(v.link))),
   [v.tx,v.record,v.link].filter(c=>c&&c.status!=='valid').map(c=>h('p',{class:'small'},c.detail)),
   v.root&&h('details',{class:'tech'},h('summary',{},'Technical details'),h('div',{class:'tech-body'},h('dl',{class:'facts'},
    h('dt',{},'Fingerprint'),h('dd',{},h('code',{class:'break'},v.root)),h('dt',{},'Series'),h('dd',{},h('code',{},v.series??'none')),
    h('dt',{},'Previous version'),h('dd',{},v.prevTx?h('code',{class:'break'},v.prevTx):'None (version 1)'))))))),
  h('p',{class:'small muted'},r.note),
  h('div',{class:'row'},h('button',{class:'btn ghost small',type:'button',onclick:onRefresh},'Check again')),
 ];
}
// Version history from `txHash` backwards. Cached per transaction, so re-renders don't refetch; every copy of the view
// on the page is redrawn when the lookup finishes.
export function versionHistory(txHash,{expectedRoot=null,title='Version history'}={}){
 const key=`${txHash}:${expectedRoot??''}`;
 const el=h('section',{class:'vhist'});
 const head=()=>[h('h3',{},title),h('p',{class:'small muted'},'Rebuilt from Cardano: ChainBridge keeps no list of versions.')];
 const load=()=>{
  const entry={loading:true,views:cache.get(key)?.views??new Set()};cache.set(key,entry);redraw();
  api(`/api/versions/${txHash}/chain${expectedRoot?`?root=${expectedRoot}`:''}`)
   .then(result=>Object.assign(entry,{loading:false,result}),e=>Object.assign(entry,{loading:false,error:e.message})).then(redraw);
 };
 const draw=view=>{
  const c=cache.get(key);
  if(!c||c.loading)return mount(view,head(),spinner('Following the links on Cardano…'));
  if(c.error)return mount(view,head(),note('warn',`The version history could not be read: ${c.error}`),h('div',{class:'row'},h('button',{class:'btn ghost small',type:'button',onclick:load},'Try again')));
  mount(view,head(),rows(c.result,{onRefresh:load}));
 };
 function redraw(){const c=cache.get(key);for(const v of [...c.views]){if(!v.isConnected&&v!==el){c.views.delete(v);continue;}draw(v);}}
 if(!cache.has(key))cache.set(key,{views:new Set()});
 cache.get(key).views.add(el);
 if(!cache.get(key).result&&!cache.get(key).loading&&!cache.get(key).error)load();else draw(el);
 return el;
}
