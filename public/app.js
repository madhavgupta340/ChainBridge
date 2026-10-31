// ChainBridge UI. One paid service, paid once with x402 (direct payment on Cardano Preprod):
//  free:  upload → review privacy labels → price quote
//  paid:  AI tidy-up → choose what to publish → fingerprint and publication on Cardano → download package
// The signed payment is only settled after the fingerprint is published; if anything fails before, nothing is charged.
// Parsing, labelling, tidying, fingerprinting and checking run here in the browser. The agent receives only
// counts (for the quote), a masked sample (for the AI) and record fingerprints (to publish).
import {h,svg,dropdown,mount,display,toast,api,download,short,copyButton} from './ui.js';
import {availableWallets,connect,signPayment} from './wallet.js';
import {zip,toCsv} from './zip.js';
import {paymentOverlay} from './payfx.js';
import {mountChecker,openCertificateId} from './verify.js';
import {ingest} from '/core/ingest.mjs';
import {analyzeSchema,applyOverride,FIELD_TYPES,SENSITIVITY} from '/core/schema.mjs';
import {recommendPlan,validatePlan,countDuplicates} from '/core/plan.mjs';
import {buildCommitment,verifyRecord} from '/core/commitment.mjs';
import {CANON_ID} from '/core/canonical.mjs';
import {LEAF_DOMAIN} from '/core/merkle.mjs';
import {checkRecipe,applyRecipe,recipeRecord,describeStep} from '/core/recipe.mjs';
import {buildAiSample,suggestRecipeLocally,countTidyIssues} from '/core/organize.mjs';
import {measure,measureDocuments,ada,PRICING} from '/core/pricing.mjs';
import {describeDocument,sha256Hex,recordsFromExtractions,DOC_LIMITS} from '/core/documents.mjs';
import {fileProof} from '/core/certificate.mjs';

// area: 'seal' (create a fingerprint, the paid flow) or 'check' (check a document against a certificate, free).
const S={area:location.pathname.startsWith('/verify')?'check':'seal',config:null,x402:null,mode:'table',docs:[],source:null,shares:null,extract:null,extractConsent:false,data:null,original:null,schema:[],reviewSchema:null,selected:new Set(),plan:null,validation:null,
 commitment:null,salts:{},verify:null,organize:null,session:null,paying:null,busy:false,view:0,page:0,open:new Set()};
const $=id=>document.getElementById(id);
const PAGE=20,PREVIEW_ROWS=5,PREVIEW_COLS=5;
const STEP_NAMES=['Upload data','Review data','Price & payment','AI tidy-up','Choose what to publish','Fingerprint & publish','Your package'];
const steps=()=>S.mode==='documents'?STEP_NAMES.map((n,i)=>i===1?'Review documents':i===3?'AI extraction':n):STEP_NAMES;
const hasInput=()=>S.mode==='documents'?S.docs.length>0:!!S.data;
const VERIFY='verify';
const SENS_LABEL={none:'Not sensitive',personal:'Personal',confidential:'Confidential'};
const TYPE_LABEL={text:'Text',number:'Number',boolean:'Yes / no',datetime:'Date or time',url:'Web link',identifier:'ID',json:'Structured data'};
const EXPLORER='https://preprod.cardanoscan.io/transaction/';

// ---------- state helpers ----------
const selectedRecords=()=>S.data?S.data.records.filter(r=>S.selected.has(r.sourceRow)):[];
const paid=()=>['paid','analyzed','publishing','settling','complete'].includes(S.session?.status);
const complete=()=>S.session?.status==='complete';
function revalidate(){S.validation=S.plan?validatePlan(S.plan,S.schema,selectedRecords().length):null;}
function canOpen(i){
 if(i===VERIFY)return !!S.commitment;
 return [true,hasInput(),hasInput(),paid(),paid()&&!!S.data,paid()&&!!S.data&&!!S.validation?.ok,complete()][i];
}
function go(i){
 if(!canOpen(i))return;
 S.view=i;render();
 window.scrollTo({top:0,behavior:'smooth'});
 $('view').querySelector('h1,h2')?.focus({preventScroll:true});
}
function changed(){if(!complete())S.commitment=null;S.verify=null;revalidate();render();}

// ---------- small building blocks ----------
function expander(cls,key,summary,children){
 const id=`${S.view}:${key}`;
 return h('details',{class:cls,open:S.open.has(id),ontoggle:e=>{e.currentTarget.open?S.open.add(id):S.open.delete(id);}},h('summary',{},summary),h('div',{class:`${cls}-body`},...children));
}
const tech=(...children)=>expander('tech','tech','Details for technical users',children);
const more=(key,summary,...children)=>expander('more',key,summary,children);
const note=(kind,...children)=>h('div',{class:`note ${kind}`,role:kind==='error'?'alert':null},...children);
const pad=n=>String(n).padStart(2,'0');
function heading(text,sub){
 const i=S.view,isVerify=i===VERIFY,isPaid=!isVerify&&i>=3&&i<=5;
 return [h('div',{class:'eyebrow'},h('span',{class:'num'},isVerify?'Tool':`Step ${pad(i+1)} / ${pad(steps().length)}`),h('span',{},isVerify?'Free, on this device':steps()[i]),isPaid&&h('span',{class:'paid-tag'},'Paid')),
  h('h2',{tabindex:-1},text),sub&&h('p',{class:'lead'},sub)];
}
function actions({back,next,nextLabel,nextHint,disabled}){
 return h('div',{class:'actions'},
  back!==undefined?h('button',{class:'btn ghost',type:'button',onclick:()=>go(back)},'← Back'):h('span'),
  next!==undefined&&h('div',{class:'next'},nextHint&&h('span',{class:'hint'},nextHint),
   h('button',{class:'btn primary',type:'button',disabled,onclick:()=>go(next)},nextLabel??'Continue →')));
}
function facts(rows){return h('dl',{class:'facts'},rows.filter(Boolean).flatMap(([k,v])=>[h('dt',{},k),h('dd',{},v)]));}
function recordLabel(r){
 const idField=S.schema.find(f=>f.type==='identifier')?.name??S.data.fields[0];
 return `Record ${r.sourceRow}: ${display(r.values[idField]).slice(0,40)}`;
}
const txLink=(hash,label)=>h('a',{href:EXPLORER+hash,target:'_blank',rel:'noopener'},label??`${hash.slice(0,10)}…${hash.slice(-6)} ↗`);
function choice(name,value,options,onpick){
 return h('div',{class:'choices',role:'radiogroup'},options.map(([v,title,desc])=>h('label',{class:`choice ${v===value?'on':''}`},
  h('input',{type:'radio',name,value:v,checked:v===value,onchange:()=>onpick(v)}),h('span',{},h('strong',{},title),h('span',{class:'muted'},desc)))));
}
const WHAT_YOU_GET=['Data file (CSV): your data, tidied, or the facts extracted from your documents','Report: what the AI found, kept, changed and left out',
 'Certificate: your fingerprint, the date, and the Cardano transaction link as public proof','Proof file: private, used later to check any record'];

// ---------- header, status strip, stepper ----------
function renderHeader(){
 const x=S.x402;
 const mode=x?.enabled?['Pay per use: x402 on Cardano Preprod','ok']:['Payments not set up','warn'];
 mount($('badges'),h('span',{class:'badge net'},'Cardano Preprod (test network)'),h('span',{class:`badge ${mode[1]}`,title:x?.reason??''},mode[0]));
}
function renderStatus(){
 const s=S.session,pub=s?.publication;
 const pay=!s?['Not yet','']:s.status==='quoted'?[`Quoted: ${ada(s.quote.totalLovelace)} tADA`,'info']:
  ['paid','analyzed','publishing'].includes(s.status)?['Signed. Charged only when your fingerprint is published','info']:
  s.status==='complete'?[`Paid ${ada(s.quote.totalLovelace)} tADA`,'ok']:s.status==='failed'?['Not charged','']:[s.status,'info'];
 const item=(label,value,cls='')=>h('div',{class:`status-item ${cls}`},h('span',{},label),h('strong',{},value));
 mount($('status'),
  item('Your original data','Stays on this device'),
  S.commitment?item('Fingerprint',`Created (${S.commitment.stats.committed} record${S.commitment.stats.committed===1?'':'s'})`,'ok'):item('Fingerprint','Not created yet'),
  pub?item('Published to Cardano',pub.status==='confirmed'?`Yes, block ${pub.blockHeight}`:'Sent, awaiting confirmation',pub.status==='confirmed'?'ok':'info'):item('Published to Cardano','Nothing yet'),
  item('Payment',pay[0],pay[1]));
}
function renderStepper(){
 mount($('stepper'),
  steps().map((label,i)=>{
   const current=S.view===i,done=canOpen(i)&&i<S.view&&S.view!==VERIFY;
   const isPaid=i>=3&&i<=5;
   return h('li',{class:`${current?'current':''} ${done?'done':''} ${isPaid?'paid-step':''}`},
    h('button',{type:'button','aria-label':`Step ${i+1}: ${label}${isPaid?' (paid)':''}`,disabled:!canOpen(i),'aria-current':current?'step':null,onclick:()=>go(i)},
     h('span',{class:'dot','aria-hidden':'true'},done&&!current?`✓ ${pad(i+1)}`:pad(i+1)),h('span',{class:'label'},label)));
  }),
  h('li',{class:`optional ${S.view===VERIFY?'current':''}`},
   h('button',{type:'button','aria-label':'Verify a record',disabled:!canOpen(VERIFY),'aria-current':S.view===VERIFY?'step':null,onclick:()=>go(VERIFY),title:canOpen(VERIFY)?null:'Create a fingerprint first'},
    h('span',{class:'dot','aria-hidden':'true'},'Tool'),h('span',{class:'label'},'Verify a record'))));
}
// ---------- two things the app does: seal or check ----------
const checkerEl=h('section',{class:'card'});let checkerReady=false;
function setArea(area,certId){
 S.area=area;
 const path=area==='check'?(certId?`/verify/${certId}`:'/verify'):'/';
 if(location.pathname!==path)history.pushState({},'',path);
 render();
 if(certId)openCertificateId(certId);
 $('view').focus({preventScroll:true});window.scrollTo(0,0);
}
window.addEventListener('popstate',()=>{const m=location.pathname.match(/^\/verify(?:\/([0-9a-f]{32}))?$/);S.area=m?'check':'seal';render();if(m?.[1])openCertificateId(m[1]);});
// Two things the app does, as page tabs: Seal (create a fingerprint, paid) or Check (verify a copy, free).
const ICONS={
 check:[['circle',{cx:7,cy:7,r:4.6}],['path',{d:'m10.4 10.4 3.6 3.6'}]]};
const icon=name=>svg('svg',{class:'mode-icon',viewBox:'0 0 16 16','aria-hidden':'true'},ICONS[name].map(([t,a])=>svg(t,a)));
function renderModes(){
 const tab=(area,n,tag,label,desc)=>h('button',{type:'button',class:`mode ${S.area===area?'on':''}`,'aria-current':S.area===area?'page':null,onclick:()=>setArea(area)},
  h('span',{class:'mode-meta'},h('span',{class:'mode-num'},n),h('span',{class:`mode-tag ${tag.toLowerCase()}`},tag)),
  h('span',{class:'mode-label'},label,h('span',{class:'mode-arrow','aria-hidden':'true'},'→')),
  h('span',{class:'mode-desc'},desc));
 mount($('modes'),
  tab('seal','01','Paid','Seal a document','Read it with AI, fingerprint it and publish the fingerprint on Cardano.'),
  tab('check','02','Free','Check a document','See if a copy you received is exactly the version that was sealed.'));
}
function render(){
 renderHeader();renderModes();
 const checking=S.area==='check';
 for(const id of ['status','activity'])$(id).hidden=checking;
 $('stepper').parentElement.hidden=checking;
 if(checking){
  if(!checkerReady){mountChecker(checkerEl);checkerReady=true;}
  if($('view').firstChild!==checkerEl)mount($('view'),checkerEl);
  return;
 }
 renderStatus();renderStepper();
 const views=[viewUpload,viewReview,viewPrice,viewTidy,viewChoose,viewPublish,viewPackage];
 mount($('view'),h('section',{class:'card'},S.view===VERIFY?viewVerify():views[S.view]()));
}

// ---------- 1. upload ----------
// `sha256` is the hash of the file's exact bytes: it becomes the file leaf a recipient can check later.
async function loadText(name,text,byteLength,sha256){
 try{
  const data=ingest({name,text,byteLength});
  if(S.session&&!complete()&&S.session.status!=='quoted')toast('Your earlier signed payment was not used, so it will not be charged.');
  Object.assign(S,{mode:'table',docs:[],source:sha256?{name,sha256}:null,shares:null,extract:null,extractConsent:false,original:data,organize:null,session:null,reviewSchema:null,commitment:null,loadError:null});useData(data);changed();
  toast(`Loaded ${data.records.length} records`,'ok');
 }catch(e){S.data=null;S.plan=null;S.loadError=e.message;changed();}
}
const isTable=name=>/\.(csv|json)$/i.test(name);
async function onFiles(list){
 const files=[...(list||[])];if(!files.length)return;
 const L=S.config.limits;
 if(files.length===1&&isTable(files[0].name)){
  const file=files[0];
  if(file.size>L.maxBytes){S.loadError=`This file is ${(file.size/1048576).toFixed(1)} MB. The limit is ${L.maxBytes/1048576} MB.`;return render();}
  const bytes=new Uint8Array(await file.arrayBuffer());
  return loadText(file.name,new TextDecoder().decode(bytes),file.size,await sha256Hex(bytes));
 }
 if(files.some(f=>isTable(f.name))){S.loadError='Load one spreadsheet, or one or more documents (PDFs, photos, screenshots), not both at once.';return render();}
 loadDocuments(files);
}
async function loadSample(name){
 try{const res=await fetch(`/samples/${name}`);if(!res.ok)throw new Error();
  if(isTable(name)){const bytes=new Uint8Array(await res.arrayBuffer());loadText(name,new TextDecoder().decode(bytes),bytes.length,await sha256Hex(bytes));}else loadDocuments([new File([await res.blob()],name)]);}
 catch{S.loadError='Could not load the sample file.';render();}
}
const b64=bytes=>{let t='';for(let i=0;i<bytes.length;i+=32768)t+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(t);};
// The copy sent to the AI. Transparent images get a white background (otherwise they can read as black).
// The fingerprint always uses the original file.
async function aiCopy(bytes,doc){
 if(!['png','webp','gif'].includes(doc.type))return {name:doc.name,data:b64(bytes)};
 const bmp=await createImageBitmap(new Blob([bytes],{type:doc.mime}));
 const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;
 const g=c.getContext('2d');g.fillStyle='#ffffff';g.fillRect(0,0,c.width,c.height);g.drawImage(bmp,0,0);
 const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.92));
 return {name:doc.name.replace(/\.[a-z0-9]+$/i,'')+'.jpg',data:b64(new Uint8Array(await blob.arrayBuffer()))};
}
async function loadDocuments(files){
 try{
  if(files.length>DOC_LIMITS.maxFiles)throw new Error(`Up to ${DOC_LIMITS.maxFiles} documents at once.`);
  const docs=[];let total=0;
  for(const f of files){
   const bytes=new Uint8Array(await f.arrayBuffer());total+=bytes.length;
   const info=describeDocument(f.name,bytes);
   docs.push({...info,sha256:await sha256Hex(bytes),ai:await aiCopy(bytes,info),preview:info.type==='pdf'?null:URL.createObjectURL(new Blob([bytes],{type:info.mime}))});
  }
  if(total>DOC_LIMITS.maxTotalBytes)throw new Error(`The documents are ${(total/1048576).toFixed(1)} MB together. The limit is ${DOC_LIMITS.maxTotalBytes/1048576} MB.`);
  if(S.session&&!complete()&&S.session.status!=='quoted')toast('Your earlier signed payment was not used, so it will not be charged.');
  Object.assign(S,{mode:'documents',docs,source:null,shares:null,extract:null,extractConsent:false,data:null,original:null,schema:[],plan:null,organize:null,session:null,reviewSchema:null,commitment:null,loadError:null});
  changed();toast(`Loaded ${docs.length} document(s)`,'ok');
 }catch(e){S.loadError=e.message;render();}
}
function useData(data,labels={}){
 S.data=data;S.schema=analyzeSchema(data.records,data.fields).map(f=>labels[f.name]?applyOverride(f,{sensitivity:labels[f.name]}):f);
 S.selected=new Set(data.records.map(r=>r.sourceRow));S.page=0;S.salts={};S.plan=recommendPlan(S.schema,data.records);
}
function viewUpload(){
 const L=S.config.limits,d=S.data;
 const input=h('input',{type:'file',id:'file',multiple:true,accept:'.csv,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif',class:'visually-hidden',onchange:e=>onFiles(e.target.files)});
 return [
  h('section',{class:'hero'},
   h('div',{},
    h('div',{class:'eyebrow'},h('span',{class:'num'},`Step 01 / ${pad(steps().length)}`),h('span',{},'Data integrity agent on Cardano')),
    h('h1',{tabindex:-1},'Seal your data.',h('br'),'Prove it later',h('span',{class:'dot'},'.')),
    h('p',{class:'lead'},'ChainBridge reads your documents and spreadsheets with AI (PDFs, photos, screenshots, CSV), picks out the facts that matter, seals them with a digital fingerprint, and publishes that fingerprint on the Cardano blockchain. You see the price first, and pay only when the fingerprint is published.')),
   drawing()),
  h('div',{class:'upload'},input,
   h('label',{for:'file',class:'drop',ondragover:e=>{e.preventDefault();e.currentTarget.classList.add('over');},ondragleave:e=>e.currentTarget.classList.remove('over'),
    ondrop:e=>{e.preventDefault();e.currentTarget.classList.remove('over');onFiles(e.dataTransfer.files);}},
    h('strong',{},'Choose documents or a spreadsheet'),h('span',{},'PDF, photo, screenshot, CSV or JSON. Drag them here.'),
    h('small',{},`Up to ${DOC_LIMITS.maxFiles} documents (${DOC_LIMITS.maxBytes/1048576} MB, ${DOC_LIMITS.maxPages} pages each), or one spreadsheet with up to ${L.maxRows.toLocaleString('en')} records. Nothing is uploaded until you pay and agree.`)),
   h('div',{class:'samples'},
    h('button',{class:'check-cta',type:'button',onclick:()=>setArea('check')},icon('check'),
     h('span',{class:'check-cta-text'},h('strong',{},'Received a sealed document?'),h('span',{},'Check your copy here. Free, nothing is uploaded.')),
     h('span',{class:'check-cta-arrow','aria-hidden':'true'},'→')),
    h('p',{},'Or try a sample:'),
    h('button',{class:'btn',type:'button',onclick:()=>loadSample('car-inspection-report.pdf')},'Car inspection report (PDF)'),
    h('button',{class:'btn',type:'button',onclick:()=>loadSample('car-inspection-photo.png')},'Photo of an inspection report (image)'),
    h('button',{class:'btn',type:'button',onclick:()=>loadSample('messy-shipments.csv')},'Messy shipment list (CSV)'),
    h('button',{class:'btn',type:'button',onclick:()=>loadSample('supplier-certificates.csv')},'Supplier inspection certificates'),
    h('button',{class:'btn',type:'button',onclick:()=>loadSample('payroll-export.json')},'Payroll export (JSON, personal data)'))),
  S.loadError&&note('error',h('strong',{},'We couldn\'t read that file. '),S.loadError),
  S.mode==='table'&&d&&note('ok',h('strong',{},`Loaded ${d.name}. `),`${d.records.length} records, ${d.fields.length} columns.`),
  S.mode==='documents'&&S.docs.length&&note('ok',h('strong',{},`Loaded ${S.docs.length} document(s). `),S.docs.map(x=>`${x.name} (${x.pages} page${x.pages>1?'s':''})`).join(', ')),
  S.mode==='table'&&d?.issues.length?note('warn',`${d.issues.length} row(s) couldn't be read and were skipped.`,
   more('skipped','Show skipped rows',h('ul',{},d.issues.slice(0,50).map(i=>h('li',{},`Row ${i.row}: ${i.message}`))))):null,
  actions({next:1,disabled:!hasInput(),nextHint:hasInput()?null:'Choose a file or a sample to continue'}),
 ];
}

// Technical drawing of the service: records → fingerprints → one root → Cardano.
function drawing(){
 const line=(x1,y1,x2,y2,extra={})=>svg('line',{x1,y1,x2,y2,stroke:'currentColor','stroke-width':1,...extra});
 const box=(x,y,w,hh,label,cls)=>[svg('rect',{x,y,width:w,height:hh,fill:'none',stroke:'currentColor','stroke-width':1}),svg('text',{x:x+w/2,y:y+hh/2+3,'text-anchor':'middle',class:cls},label)];
 const cx=[52,130,208,286];                       // record centres
 const mid=[91,247],root=169;                       // pair centres, root centre
 return h('figure',{class:'drawing','aria-label':'Diagram: your records are fingerprinted, combined into one fingerprint, and that fingerprint is published on Cardano'},
  h('div',{class:'drawing-head'},h('span',{},'ChainBridge · Seal · Cutaway'),h('span',{},'SHA-256 · Merkle')),
  svg('svg',{viewBox:'0 0 400 280',role:'img'},
   cx.map((x,i)=>box(x-28,214,56,26,`REC ${pad(i+1)}`)),
   cx.map(x=>line(x,214,x,204)),line(cx[0],204,cx[1],204),line(cx[2],204,cx[3],204),
   mid.map(x=>line(x,204,x,196)),
   mid.map((x,i)=>box(x-36,166,72,30,i?'H(03,04)':'H(01,02)')),
   mid.map(x=>line(x,166,x,150)),line(mid[0],150,mid[1],150),line(root,150,root,124),
   box(root-56,92,112,32,'ROOT · a33b…aaa9','strong'),
   line(root,92,root,52,{'stroke-dasharray':'3 3'}),
   svg('circle',{cx:root,cy:52,r:3,fill:'var(--signal)',stroke:'none'}),
   box(root-78,18,156,30,'CARDANO TX · LABEL 674','accent'),
   line(326,214,336,214),line(326,240,336,240),line(336,214,336,240),svg('text',{x:342,y:230},'PRIVATE'),
   line(root+60,108,326,108),svg('text',{x:330,y:111},'PUBLIC'),
   svg('text',{x:12,y:270},'Records stay on device · only the root is published')),
  h('div',{class:'drawing-table'},h('div',{},'Network',h('b',{},'Preprod')),h('div',{},'Payment',h('b',{},'x402')),h('div',{},'AI',h('b',{},'Meta')),h('div',{},'Rev',h('b',{},'1'))));
}

// ---------- 2. review (free) ----------
function sensSelect(f,i){
 return dropdown({cls:`sens ${f.sensitivity}`,label:`Privacy label for ${f.name}`,disabled:!!S.session&&S.session.status!=='quoted',value:f.sensitivity,
  options:SENSITIVITY.map(s=>[s,SENS_LABEL[s]]),
  onChange:v=>{S.schema[i]=applyOverride(f,{sensitivity:v});if(S.session?.status==='quoted')S.session=null;revalidate();render();}});
}
function viewReview(){
 if(S.mode==='documents')return viewReviewDocs();
 const d=S.data,recs=d.records;
 const cols=d.fields.slice(0,PREVIEW_COLS);
 const flagged=S.schema.map((f,i)=>[f,i]).filter(([f])=>f.sensitivity!=='none'||f.inferred.sensitivity!=='none');
 const locked=!!S.session&&S.session.status!=='quoted';
 return [
  ...heading('Review data','Check the data, and tell ChainBridge which columns are private. Private columns are always hidden from the AI.'),
  h('h3',{},'Preview'),
  h('div',{class:'table-wrap'},h('table',{},
   h('thead',{},h('tr',{},cols.map(f=>h('th',{scope:'col'},f)))),
   h('tbody',{},recs.slice(0,PREVIEW_ROWS).map(r=>h('tr',{},cols.map(f=>h('td',{},display(r.values[f]).slice(0,60)))))))),
  h('p',{class:'muted small'},`Showing ${Math.min(PREVIEW_ROWS,recs.length)} of ${recs.length} records and ${cols.length} of ${d.fields.length} columns.`),
  h('h3',{},'Privacy check'),
  locked&&note('info','Privacy labels are locked after payment, because the AI analysis uses them.'),
  flagged.length?h('div',{},
    h('p',{},`We think ${flagged.length===1?'this column contains':'these columns contain'} personal or confidential information. Change a label if we got it wrong.`),
    h('ul',{class:'flag-list'},flagged.map(([f,i])=>h('li',{},
     h('div',{},h('strong',{},f.name),h('span',{class:'muted small'},f.reasons.length?f.reasons.join('. '):'Label set by you')),sensSelect(f,i)))))
   :note('info','We didn\'t spot personal or confidential information. Our checks are simple, though, so please look for yourself.'),
  h('p',{class:'muted small'},'These labels come from simple rules on column names and values. They can be wrong either way, so you have the final say.'),
  more('columns',`Show all ${d.fields.length} columns`,
   h('div',{class:'table-wrap'},h('table',{},
    h('thead',{},h('tr',{},h('th',{scope:'col'},'Column'),h('th',{scope:'col'},'Kind of data'),h('th',{scope:'col'},'Privacy label'))),
    h('tbody',{},S.schema.map((f,i)=>h('tr',{},h('th',{scope:'row'},f.name),
     h('td',{},dropdown({label:`Kind of data in ${f.name}`,value:f.type,options:FIELD_TYPES.map(t=>[t,TYPE_LABEL[t]]),onChange:v=>{S.schema[i]=applyOverride(f,{type:v});render();}})),
     h('td',{},sensSelect(f,i)))))))),
  tech(h('p',{},'Privacy labels come from column-name patterns (e.g. email, phone, iban, salary, …name) and value patterns (email addresses, IBANs, card numbers, street addresses, person names).')),
  actions({back:0,next:2,nextLabel:'See the price →'}),
 ];
}

// ---------- 3. price & payment ----------
function measurements(){return S.mode==='documents'?measureDocuments(S.docs):measure(S.data,S.schema,countTidyIssues);}
async function getQuote(){
 S.busy=true;render();
 try{S.session=await api('/api/x402/quote',{measurements:measurements()});S.reviewSchema=S.schema.map(f=>({...f}));}
 catch(e){toast(e.message,'error');}
 S.busy=false;render();
}
async function payWith(kind){
 const id=S.session.id,amount=`${ada(S.session.quote.totalLovelace)} tADA`;
 const fx=paymentOverlay({title:'Authorising your payment',amount,steps:kind==='demo'
  ?['Getting the payment details from ChainBridge','Signing with the demo test wallet','Checking the signed payment']
  :['Getting the payment details from ChainBridge','Approve the payment in your wallet','Checking the signed payment']});
 let n=0;const step=t=>{S.paying=t;fx.step(n++);};
 try{
  step('Asking ChainBridge for its payment details (HTTP 402)…');
  const r402=await fetch(`/x402/session/${id}`);
  if(r402.status!==402)throw new Error(`Expected "402 Payment Required", got ${r402.status}`);
  S.paymentRequired=await r402.json();
  if(kind==='demo'){
   step('Signing with the demo test wallet and checking the payment…');
   S.session=await api(`/api/x402/session/${id}/demo-pay`,{});
  }else{
   const {api:wallet,address}=await connect(kind);
   const u=await api(`/api/x402/session/${id}/build`,{buyerAddress:address});
   step('Please approve the payment in your wallet…');
   const witnessSet=await signPayment(wallet,u.unsignedTx);
   const {header}=await api(`/api/x402/session/${id}/signature`,{unsignedTx:u.unsignedTx,witnessSet,nonce:u.nonce});
   step('Checking your signed payment…');
   const res=await fetch(`/x402/session/${id}`,{method:'POST',headers:{'content-type':'application/json','PAYMENT-SIGNATURE':header},body:'{}'});
   const body=await res.json();
   if(!res.ok)throw new Error(body.error||`HTTP ${res.status}`);
   S.session=body;
  }
  S.paying=null;refreshActivity();
  fx.success({headline:'Authorised',detail:[h('span',{},'Your wallet signed the payment and ChainBridge checked it.'),h('strong',{},'You are charged only when your fingerprint is published.')],
   buttons:[[S.mode==='documents'?'Start the AI extraction →':'Start the AI tidy-up →',()=>go(3),true]]});
 }catch(e){S.paying=null;render();fx.fail({headline:'Not authorised',detail:[h('span',{},e.message),h('strong',{},'Nothing was charged.')],buttons:[['Close',null,true]]});}
}
function viewPrice(){
 const s=S.session,x=S.x402,m=measurements();
 const wallets=availableWallets();
 if(!x?.enabled)return [...heading('Price & payment'),note('warn',h('strong',{},'Payments are not set up on this computer. '),x?.reason??''),actions({back:1})];
 return [
  ...heading('Price & payment','Your price is calculated from simple measurements of your file. Getting a price is free.'),
  !s&&[
   h('h3',{},'What we measured'),
   S.mode==='documents'?facts([['Documents',m.documents],['Pages and images',m.pages]]):facts([['Records',m.records.toLocaleString('en')],['Columns',m.columns],['Private columns',m.privateColumns],['Tidy-up problems found',m.tidyIssues]]),
   h('p',{class:'small muted'},'Only these numbers are sent to get a price. No data.'),
   h('div',{class:'center-action'},h('button',{class:'btn primary big',type:'button',disabled:S.busy,onclick:getQuote},S.busy?'Calculating…':'Get my price'))],
  s&&[
   h('div',{class:'quote'},
    h('table',{class:'quote-table'},h('tbody',{},
     s.quote.lines.map(l=>h('tr',{},h('td',{},l.label),h('td',{class:'num'},`${l.lovelace<0?'−':''}${ada(Math.abs(l.lovelace))} tADA`))),
     h('tr',{class:'total'},h('th',{scope:'row'},'Total'),h('td',{class:'num'},`${ada(s.quote.totalLovelace)} tADA`)))),
    h('p',{class:'small muted'},'tADA is test ADA on Cardano Preprod. It has no real value. The small Cardano network fee for your payment (about 0.17 tADA) is added by your wallet.')),
   h('h3',{},'What you get'),h('ul',{class:'getlist'},WHAT_YOU_GET.map(w=>h('li',{},w))),
   s.status==='quoted'&&[
    S.mode==='documents'&&note('info',h('strong',{},'About your documents. '),'After you pay, you will be asked to confirm before the documents are sent to Meta\'s AI for reading. A photo or PDF can\'t be partly hidden, so the AI sees the whole document. Only a fingerprint is ever published.'),
    h('h3',{},'How payment works'),
    h('ol',{class:'small'},h('li',{},'Your wallet signs the payment. It is checked, but not sent yet.'),
     h('li',{},`ChainBridge does the work: ${S.mode==='documents'?'AI extraction':'AI tidy-up'}, fingerprint, publication on Cardano.`),
     h('li',{},'Only when your fingerprint is published is the payment sent to ChainBridge. If anything fails before that, you are not charged.'),
     h('li',{},'Finish within 30 minutes of paying, or the signed payment expires (and nothing is charged).')),
    S.paying?note('info',h('strong',{},'Payment in progress…')):
    h('div',{class:'pay-options'},
     wallets.map(w=>h('button',{class:'btn pay',type:'button',onclick:()=>payWith(w.key)},h('span',{class:'pay-label'},w.icon&&h('img',{src:w.icon,alt:'',class:'wallet-icon'}),`Accept and pay with ${w.name}`),h('span',{class:'pay-amount'},`${ada(s.quote.totalLovelace)} tADA`))),
     !wallets.length&&note('info','No Cardano browser wallet found. To pay with your own wallet, install Lace or Eternl in Chrome, switch it to Preprod (test network), and get free test ADA from the Cardano faucet.'),
     x.demoWallet&&h('button',{class:'btn pay',type:'button',onclick:()=>payWith('demo')},
      h('span',{class:'pay-label'},'Accept and pay with the demo test wallet'),h('span',{class:'pay-amount'},`${ada(s.quote.totalLovelace)} tADA`)),
     x.demoWallet&&h('p',{class:'small muted'},`Demo test wallet balance: ${x.demoWallet.balance!=null?ada(x.demoWallet.balance*1e6):'?'} tADA`),
     h('button',{class:'btn ghost',type:'button',onclick:()=>{S.session=null;render();toast('Quote cancelled. Nothing was charged.');}},'Cancel')),
    x.demoWallet&&h('p',{class:'small muted'},'The demo test wallet lives on this laptop so the service can be shown without a wallet extension. With a real wallet, you approve the payment in the wallet itself.'),
   ],
   s.status!=='quoted'&&note('ok',h('strong',{},'Payment signed and verified. '),s.status==='complete'?`Paid ${ada(s.quote.totalLovelace)} tADA.`:'Nothing is charged until your fingerprint is published.'),
   tech(facts([['Protocol','x402 "exact" scheme on cardano:preprod, direct payment (no escrow)'],['Paid to (ChainBridge)',x.payTo],
    ['Payment checker',x.facilitator],S.paymentRequired&&['402 response',h('pre',{class:'code'},JSON.stringify(S.paymentRequired.accepts?.[0]??S.paymentRequired,null,2))],
    s.payer&&['Paid by',s.payer],['Pricing model',`Base ${ada(PRICING.base)} tADA, per 1,000 records ${ada(PRICING.per1000Records)}, per private column ${ada(PRICING.perPrivateColumn)}, per tidy-up problem ${ada(PRICING.perTidyIssue)}`]])),
  ],
  actions({back:1,next:paid()?3:undefined,nextLabel:S.mode==='documents'?'Start the AI extraction →':'Start the AI tidy-up →'}),
 ];
}

// ---------- 4. AI tidy-up (paid) ----------
function setSuggestions(result){
 const {steps,rejected}=checkRecipe(result.steps,S.original.fields);
 S.organize={source:result.source,provider:result.provider,model:result.model,summary:result.summary,issues:result.issues??[],steps,
  enabled:new Set(steps.map((_,i)=>i)),rejected:[...(result.rejected??[]),...rejected.map(r=>({op:String(r.step?.op??'?'),error:r.error}))],applied:S.organize?.applied??null};
 render();
}
function organizePreview(){
 const o=S.organize;const chosen=o.steps.filter((_,i)=>o.enabled.has(i));
 const {steps,rejected}=checkRecipe(chosen,S.original.fields);
 return {steps,rejected,result:applyRecipe(S.original,steps)};
}
async function runAi(){
 S.busy=true;render();
 try{
  const sample=buildAiSample(S.original,S.reviewSchema??S.schema,'masked');
  S.session=await api(`/api/x402/session/${S.session.id}/analyze`,{sample});
  setSuggestions({source:'ai',...S.session.analysis});toast('AI analysis ready. Review the suggestions.','ok');
 }catch(e){toast(e.message,'error');}
 S.busy=false;render();
}
// Privacy labels follow renamed columns; AI label changes are tickable steps.
function labelsAfter(steps,resultLabels){
 const origin=new Map(S.original.fields.map(f=>[f,f]));
 for(const st of steps)if(st.op==='rename'){origin.set(st.to,origin.get(st.column));origin.delete(st.column);}
 const base=Object.fromEntries((S.reviewSchema??S.schema).map(f=>[f.name,f.sensitivity]));
 const out={};for(const [now,orig] of origin)if(base[orig])out[now]=base[orig];
 return {...out,...resultLabels};
}
function viewTidy(){
 if(S.mode==='documents')return viewExtract();
 const o=S.organize,applied=o?.applied,hasSuggestions=!!o?.source;
 const preview=hasSuggestions?organizePreview():null;
 const logFor=new Map(preview?preview.result.log.map((l,i)=>[i,l]):[]);
 let enabledIndex=-1;
 const sample=buildAiSample(S.original,S.reviewSchema??S.schema,'masked');
 return [
  ...heading('AI tidy-up','ChainBridge\'s AI agent looks at a masked sample of your data and suggests how to tidy and sort it. You approve every change; ChainBridge then makes the approved changes itself, the same way every time.'),
  applied&&note('ok',h('strong',{},`${applied.length} change(s) applied. `),`Your data now has ${S.data.records.length} records and ${S.data.fields.length} columns. Your original file is untouched.`,
   !complete()&&h('div',{class:'row'},h('button',{class:'btn small',type:'button',onclick:()=>{S.organize={...o,applied:null};useData(S.original,labelsAfter([],{}));changed();toast('Back to the original data');}},'Undo all changes'))),
  !hasSuggestions&&h('div',{class:'center-action'},
   h('button',{class:'btn primary big',type:'button',disabled:S.busy,onclick:runAi},S.busy?'The AI is analysing your data…':'Run the AI analysis'),
   h('p',{class:'hint'},'Included in your payment. The AI sees only the masked sample below.'),
   more('aisample','Show exactly what the AI receives',h('pre',{class:'code'},JSON.stringify(sample,null,2))),
   h('button',{class:'btn small ghost',type:'button',onclick:()=>setSuggestions(suggestRecipeLocally(S.original))},'Or use quick rules instead (no AI)')),
  hasSuggestions&&h('div',{class:'suggestions'},
   h('h3',{},o.source==='ai'?`AI report (${o.provider??'AI'}${o.model?`, ${o.model}`:''})`:'Suggestions from the quick rules'),
   o.summary&&h('p',{},o.summary),
   o.issues.length?h('ul',{class:'muted'},o.issues.map(i=>h('li',{},i))):null,
   o.steps.length?h('ul',{class:'step-list'},o.steps.map((st,i)=>{
     const on=o.enabled.has(i);if(on)enabledIndex++;
     const log=on?logFor.get(enabledIndex):null;
     const blocked=on&&preview.rejected.some(r=>r.step===st);
     return h('li',{class:on?'on':''},h('label',{class:'check'},
      h('input',{type:'checkbox',checked:on,disabled:!!applied,onchange:e=>{e.target.checked?o.enabled.add(i):o.enabled.delete(i);render();}}),
      h('span',{},h('strong',{},describeStep(st)),st.reason&&h('span',{class:'muted small'},st.reason),
       log&&h('span',{class:'tag count'},st.op==='rename'?'column renamed':st.op==='drop_column'?'column removed':st.op==='mark_sensitive'?'label only':st.op.startsWith('remove')?`${log.changed} row(s) removed`:st.op==='sort'?`${log.changed} row(s) move`:`${log.changed} value(s) change`),
       blocked&&h('span',{class:'tag warn'},'skipped: depends on an unticked step'))));
    })):note('info','No changes suggested. The data already looks tidy.'),
   o.rejected.length?note('warn',`${o.rejected.length} suggestion(s) were ignored because ChainBridge can't apply them safely.`,
    more('rejected','Show ignored suggestions',h('ul',{},o.rejected.map(r=>h('li',{},`${r.op}: ${r.error}`))))):null,
   preview&&preview.steps.length?more('beforeafter','Preview: before and after',beforeAfter(S.original,preview.result,preview.steps)):null,
   !applied&&preview&&preview.steps.length?h('div',{class:'row'},h('button',{class:'btn primary',type:'button',onclick:()=>{
     o.applied=preview.steps;
     useData({...S.original,records:preview.result.records,fields:preview.result.fields},labelsAfter(preview.steps,preview.result.labels));changed();
     toast(`Applied ${preview.steps.length} change(s)`,'ok');}},`Apply ${preview.steps.length} change(s)`),
    h('span',{class:'hint'},'Changes your working copy only. The original file stays as it is.')):null),
  tech(h('p',{},'Allowed steps: rename, trim, lowercase, yes/no to true/false, dates to YYYY-MM-DD, numbers, remove column, remove empty or duplicate rows, sort, change a privacy label. Anything else the AI suggests is ignored.'),
   h('p',{},'Each step is checked, then applied by ChainBridge\'s own code (not the AI). The approved steps are saved in the proof file, so anyone with the original file can rebuild the same records and fingerprint.')),
  actions({back:2,next:4,nextLabel:applied||!hasSuggestions?'Continue →':'Continue without these changes →'}),
 ];
}
function beforeAfter(before,after,steps){
 const origin=new Map(before.fields.map(f=>[f,f]));
 for(const st of steps)if(st.op==='rename'){origin.set(st.to,origin.get(st.column));origin.delete(st.column);}
 const byRow=new Map(before.records.map(r=>[r.sourceRow,r]));
 const table=(fields,recs,compare)=>h('div',{class:'table-wrap'},h('table',{},h('thead',{},h('tr',{},fields.map(f=>h('th',{scope:'col'},f)))),
  h('tbody',{},recs.slice(0,PREVIEW_ROWS).map(r=>h('tr',{},fields.map(f=>{
   const old=compare&&byRow.get(r.sourceRow);
   const diff=old&&display(r.values[f])!==display(old.values[origin.get(f)]);
   return h('td',{class:diff?'changed-cell':''},display(r.values[f]).slice(0,60));}))))));
 return [h('h4',{},'Before'),table(before.fields.slice(0,PREVIEW_COLS),before.records,false),
  h('h4',{},'After'),table(after.fields.slice(0,PREVIEW_COLS),after.records,true),
  h('p',{class:'small muted'},`Showing the first ${PREVIEW_ROWS} rows and ${PREVIEW_COLS} columns. Highlighted cells changed. Rows: ${before.records.length} before, ${after.records.length} after.`)];
}

// ---------- documents: review (free) and AI extraction (paid) ----------
function viewReviewDocs(){
 const pages=S.docs.reduce((n,d)=>n+d.pages,0);
 return [
  ...heading('Review documents',`${S.docs.length} document(s), ${pages} page(s) in total. Check these are the files you want ChainBridge to read and seal.`),
  h('ul',{class:'doc-list'},S.docs.map(d=>h('li',{},
   d.preview?h('img',{src:d.preview,alt:'',class:'doc-thumb'}):h('div',{class:'doc-thumb pdf','aria-hidden':'true'},'PDF'),
   h('div',{class:'doc-meta'},h('strong',{},d.name),
    h('span',{class:'muted small'},`${d.type.toUpperCase()} · ${d.pages} page${d.pages>1?'s':''} · ${Math.max(1,Math.round(d.bytes/1024))} KB`),
    h('span',{class:'mono-key'},`SHA-256 ${d.sha256.slice(0,16)}…${d.sha256.slice(-8)}`))))),
  note('info',h('strong',{},'How your documents are handled. '),'Nothing leaves this device until you have paid and confirmed. Then the whole documents are sent to Meta\'s AI (Muse Spark) to be read: a photo or PDF can\'t be partly hidden the way spreadsheet columns can. Meta states that content sent through its API in standard mode is not used to train its models. You decide which of the facts it finds are kept, and only a fingerprint is published.'),
  tech(h('p',{},'The file type is checked from the file\'s own bytes. Pages are counted on this device for the price. Each file\'s SHA-256 fingerprint is added to its row, so the certificate also proves which exact file the facts came from.')),
  actions({back:0,next:2,nextLabel:'See the price →'}),
 ];
}
async function runExtraction(){
 S.busy=true;render();
 try{
  S.session=await api(`/api/x402/session/${S.session.id}/extract`,{consent:true,documents:S.docs.map(d=>({name:d.ai.name,data:d.ai.data}))});
  S.extract={applied:false,docs:S.session.extraction.map((r,i)=>({...r,name:S.docs[i].name,sha256:S.docs[i].sha256,fields:r.fields.map(f=>({...f,keep:f.relevant}))}))};
  toast('The AI has read your documents. Check the facts it found.','ok');
 }catch(e){toast(e.message,'error');}
 S.busy=false;render();
}
function applyExtraction(){
 const rank={none:0,personal:1,confidential:2};
 const labels={source_file:'none',source_sha256:'none'};
 for(const d of S.extract.docs)for(const f of d.fields)if(f.keep&&(labels[f.key]===undefined||rank[f.sensitivity]>rank[labels[f.key]]))labels[f.key]=f.sensitivity;
 const data=recordsFromExtractions(S.extract.docs);
 S.original=data;useData(data,labels);S.reviewSchema=S.schema.map(f=>({...f}));S.extract.applied=true;changed();
 toast(`${data.fields.length-2} fact(s) ready to seal`,'ok');
}
function viewExtract(){
 const x=S.extract,pages=S.docs.reduce((n,d)=>n+d.pages,0);
 if(!x)return [
  ...heading('AI extraction','ChainBridge\'s AI reads your documents and picks out the facts worth sealing: identifiers, dates, results, measurements, findings. It skips filler such as legal boilerplate, and shows you the exact words each fact came from.'),
  h('label',{class:'check consent-check'},h('input',{type:'checkbox',checked:S.extractConsent,onchange:e=>{S.extractConsent=e.target.checked;render();}}),
   `Send ${S.docs.length} document(s) (${pages} page${pages>1?'s':''}) to Meta's AI to be read. I understand the whole documents are sent.`),
  h('div',{class:'center-action'},h('button',{class:'btn primary big',type:'button',disabled:!S.extractConsent||S.busy,onclick:runExtraction},
   S.busy?'The AI is reading your documents (about 30 seconds each)…':'Extract with AI'),h('p',{class:'hint'},'Included in your payment.')),
  actions({back:2}),
 ];
 const kept=x.docs.reduce((n,d)=>n+d.fields.filter(f=>f.keep).length,0);
 return [
  ...heading('AI extraction','Check what the AI found. Untick anything you don\'t want sealed and correct values if needed. Each fact shows the words it came from.'),
  x.applied&&note('ok',h('strong',{},'Facts confirmed. '),`${S.data.records.length} row(s) with ${S.data.fields.length} columns, including each file's name and SHA-256 fingerprint.`),
  x.docs.map((d,di)=>h('section',{class:'doc-result'},
   h('div',{class:'eyebrow'},h('span',{class:'num'},`Document ${pad(di+1)}`),h('span',{},d.documentType.replace(/_/g,' ')),h('span',{},d.name)),
   h('h3',{class:'doc-title'},d.title||d.name),d.summary&&h('p',{class:'doc-summary'},d.summary),
   h('div',{class:'fact-list'},d.fields.map((f,fi)=>h('div',{class:`fact ${f.keep?'on':''}`},
    h('input',{type:'checkbox',checked:f.keep,disabled:x.applied,'aria-label':`Keep ${f.label}`,onchange:e=>{f.keep=e.target.checked;render();}}),
    h('div',{class:'fact-main'},
     h('label',{class:'fact-label',for:`fv-${di}-${fi}`},f.label,h('span',{class:'mono-key'},f.key)),
     h('input',{type:'text',id:`fv-${di}-${fi}`,value:f.value,disabled:x.applied,oninput:e=>{f.value=e.target.value;}}),
     f.evidence&&h('p',{class:'evidence'},`“${f.evidence}”`),
     !f.relevant&&f.reason&&h('p',{class:'small muted'},`Not ticked by default: ${f.reason}`)),
    h('div',{class:'fact-side'},
     dropdown({cls:`sens ${f.sensitivity}`,label:`Privacy label for ${f.label}`,value:f.sensitivity,disabled:x.applied,options:SENSITIVITY.map(v=>[v,SENS_LABEL[v]]),onChange:v=>{f.sensitivity=v;render();}}),
     f.confidence<0.8&&h('span',{class:'tag warn'},'Check this value'))))),
   d.omitted.length?more(`omit-${di}`,`What the AI left out (${d.omitted.length})`,h('ul',{},d.omitted.map(o=>h('li',{},h('strong',{},o.what),`: ${o.reason}`)))):null)),
  !x.applied&&h('div',{class:'center-action'},h('button',{class:'btn primary big',type:'button',disabled:!kept,onclick:applyExtraction},`Use ${kept} fact${kept===1?'':'s'}`),
   h('p',{class:'hint'},'Each document becomes one row. Its file name and SHA-256 fingerprint are added automatically.')),
  tech(h('p',{},`Read by ${x.docs[0]?.provider??'AI'} (${x.docs[0]?.model??''}) with a fixed answer format. ChainBridge checks every field name, value and label before showing it. Text inside a document is treated as content, never as instructions.`)),
  actions({back:2,next:x.applied?4:undefined,nextLabel:'Choose what to publish →'}),
 ];
}

// ---------- 5. choose what to publish (paid) ----------
function setPlan(patch){S.plan={...S.plan,...patch};changed();}
function viewChoose(){
 const p=S.plan,v=S.validation,recs=selectedRecords(),locked=complete();
 const dup=countDuplicates(recs,p.fields);
 return [
  ...heading('Choose what to publish','Pick which columns the fingerprint should cover. Only the fingerprint is ever published, never these values.'),
  note('ok','We\'ve picked safe defaults: confidential columns are left out, and an extra secret value is added where personal data is involved.'),
  h('h3',{},'Columns to cover'),
  h('div',{class:'col-grid'},S.schema.map(f=>h('label',{class:`col ${p.fields.includes(f.name)?'on':''}`},
   h('input',{type:'checkbox',disabled:locked,checked:p.fields.includes(f.name),onchange:e=>{
    const set=new Set(p.fields);e.target.checked?set.add(f.name):set.delete(f.name);
    setPlan({fields:S.schema.map(x=>x.name).filter(n=>set.has(n))});}}),
   h('span',{class:'col-name'},f.name),f.sensitivity!=='none'&&h('span',{class:`tag ${f.sensitivity}`},SENS_LABEL[f.sensitivity])))),
  h('p',{class:'muted small'},'Columns you leave out are not protected, so changes to them will not be detected.'),
  h('h3',{},'Extra secret value'),
  choice('salt',p.salt,[
   ['per-record','Add an extra secret value to each record (recommended)','Makes it much harder for anyone to guess your records from the fingerprint. You\'ll need to keep the proof file to check records later.'],
   ['none','Don\'t add one','Anyone who has a record can check it without the proof file, but someone who can guess the values could confirm the guess.']],
   o=>{if(!locked){S.salts={};setPlan({salt:o});}}),
  dup>0&&[h('h3',{},`Duplicate records (${dup} found)`),
   choice('dups',p.duplicates,[['keep','Keep every record','Each record counts, even exact copies.'],['drop','Remove exact copies','Only the first of each identical record is covered.']],o=>{if(!locked)setPlan({duplicates:o});})],
  v?.errors.length?note('error',h('strong',{},'Please fix this first: '),h('ul',{},v.errors.map(e=>h('li',{},e)))):null,
  h('div',{class:'note warn'},h('strong',{},'Things to know'),h('ul',{},[...(v?.warnings??[]),...p.risks].map(w=>h('li',{},w)))),
  more('why','Why we recommend these settings',h('ul',{},p.rationale.map(r=>h('li',{},r)))),
  tech(facts([['Strategy',p.strategy],['Ordering',p.ordering],['Salting',p.salt],['Duplicates',p.duplicates],['Fields',p.fields.join(', ')]])),
  actions({back:3,next:5,disabled:!v?.ok,nextHint:v?.ok?null:'Fix the issue above to continue'}),
 ];
}

// ---------- 6. fingerprint & publish (paid) ----------
// Source files get their own leaves, so each can be shared and checked on its own (see /core/certificate.mjs).
const sourceFiles=()=>S.mode==='documents'?S.docs.map(d=>({name:d.name,sha256:d.sha256})):S.source?[S.source]:[];
async function createProof(){
 S.busy=true;render();
 try{
  S.commitment=await buildCommitment({records:selectedRecords(),plan:S.plan,salts:Object.fromEntries(Object.entries(S.salts).filter(([,v])=>v)),
   recipe:S.organize?.applied?recipeRecord(S.organize.applied):null,files:sourceFiles()});
  for(const e of S.commitment.entries)if(e.salt)S.salts[e.sourceRow]=e.salt;
  S.verify=null;
 }catch(e){toast(e.message,'error');}
 S.busy=false;render();
}
async function publishAndFinish(){
 S.busy=true;render();
 const amount=`${ada(S.session.quote.totalLovelace)} tADA`;
 const fx=paymentOverlay({title:'Publishing and paying',amount,steps:['Publishing your fingerprint on Cardano','Waiting for Cardano to confirm it','Completing your payment']});
 fx.pace(14000);
 try{
  const c=S.commitment;
  S.session=await api(`/api/x402/session/${S.session.id}/publish`,{payload:c.payload,leaves:c.leaves,files:c.files.length});
  S.busy=false;refreshActivity();render();
  const s=S.session;
  if(s.status==='complete'){
   const pub=s.publication,pay=s.settlement?.transaction;
   fx.success({headline:'Paid',detail:[
     h('span',{},pub.status==='confirmed'?`Fingerprint published on Cardano, block ${pub.blockHeight}.`:'Fingerprint sent to Cardano.'),
     h('a',{href:EXPLORER+pub.txHash,target:'_blank',rel:'noopener'},`Publication ${pub.txHash.slice(0,10)}… ↗`),
     pay&&h('a',{href:EXPLORER+pay,target:'_blank',rel:'noopener'},`Payment ${pay.slice(0,10)}… ↗`)],
    buttons:[['Get your package →',()=>go(6),true]]});
   return;
  }
  fx.fail({headline:s.status==='settle-failed'?'Published, payment not completed':'Not charged',detail:[h('span',{},s.error??`Status: ${s.status}`)],buttons:[['Close',null,true]]});
 }catch(e){
  try{S.session=await api(`/api/x402/session/${S.session.id}`);}catch{}
  S.busy=false;refreshActivity();render();
  fx.fail({headline:'Not charged',detail:[h('span',{},e.message)],buttons:[['Close',null,true]]});
 }
}
function viewPublish(){
 const c=S.commitment,s=S.session,recs=selectedRecords(),p=S.plan;
 return [
  ...heading('Fingerprint & publish','ChainBridge seals your selected records with one fingerprint, here on your device. The agent then publishes it on Cardano, and your payment is completed.'),
  h('div',{class:'split'},
   h('div',{class:'panel private'},h('h3',{},'Stays on your device'),h('ul',{},
    h('li',{},`Your ${recs.length} records and all their values`),
    p.salt==='per-record'&&h('li',{},'The extra secret values (in your proof file)'),
    h('li',{},'The proof file you\'ll use to check records later'))),
   h('div',{class:'panel public'},h('h3',{},'Published on Cardano'),h('ul',{},
    h('li',{},'One fingerprint (a 64-character code)'),h('li',{},`The number of records (${recs.length})`),h('li',{},'A job reference and the date'),h('li',{},'No column names and no values')))),
  !c&&h('div',{class:'center-action'},h('button',{class:'btn primary big',type:'button',disabled:S.busy,onclick:createProof},S.busy?'Creating…':'Create my fingerprint'),
   h('p',{class:'hint'},'Runs entirely in this browser. Free to redo until you publish.')),
  c&&h('div',{class:'success'},
   h('h3',{},'✓ Fingerprint created on this device'),
   h('code',{class:'fingerprint'},c.root),
   h('p',{class:'small'},`Seals ${c.stats.committed} record${c.stats.committed===1?'':'s'}`+(c.stats.duplicates?` (${c.stats.duplicates} duplicate${c.stats.duplicates>1?'s':''} ${c.stats.dropped?'removed':'kept'})`:'')
    +(c.stats.files===1?', plus the original file, so anyone you share it with can check it':c.stats.files?`, plus the ${c.stats.files} original files, so anyone you share one with can check it`:'')+'.'),
   !complete()&&h('div',{class:'center-action'},
    h('button',{class:'btn pay',type:'button',disabled:S.busy||!paid(),onclick:publishAndFinish},h('span',{class:'pay-label'},S.busy?'Publishing on Cardano…':'Publish on Cardano and pay'),h('span',{class:'pay-amount'},`${ada(s.quote.totalLovelace)} tADA`)),
    h('p',{class:'hint'},'Takes about a minute: the agent publishes your fingerprint, waits for Cardano to confirm it, then your signed payment is sent.')),
   !complete()&&h('button',{class:'btn ghost small',type:'button',disabled:S.busy,onclick:createProof},'Create again'),
   complete()&&note('ok',h('strong',{},'Published and paid. '),'Your package is ready.')),
  s?.status==='failed'&&note('error',s.error),
  ['settle-failed','needs-inspection'].includes(s?.status)&&note('warn',s.error),
  tech(facts([
   ['"One fingerprint"','The Merkle root of the record fingerprints (SHA-256, binary tree; an odd node is carried up unchanged)'],
   ['Record fingerprint',`SHA-256(0x00 ‖ "${LEAF_DOMAIN}" ‖ 0x00 ‖ salt ‖ 0x00 ‖ formatted record); combining two: SHA-256(0x01 ‖ left ‖ right)`],
   ['How records are formatted',`${CANON_ID}: chosen columns only, keys sorted, Unicode NFC, JSON escaping, values exactly as in the data`],
   ['Source file fingerprint','SHA-256(0x00 ‖ "chainbridge/v1/file" ‖ 0x00 ‖ salt ‖ 0x00 ‖ {"sha256":"<file hash>"}), one per original file, after the records. Lets a recipient check one file without seeing any record.'],
   ['On-chain message','Cardano transaction metadata, label 674 (CIP-20)'],
   c&&['Exact public payload',h('pre',{class:'code'},JSON.stringify(c.payload,null,2))]])),
  actions({back:4,next:complete()?6:undefined,nextLabel:'Get your package →'}),
 ];
}

// ---------- 7. package ----------
function reportMarkdown(){
 const s=S.session,o=S.organize,c=S.commitment,p=S.plan;
 if(S.mode==='documents')return documentReport();
 const lines=[`# ChainBridge data report`,'',`- Source file: ${S.original.name}`,`- Created: ${new Date().toISOString()}`,
  `- Records: ${S.original.records.length} in the file, ${c.stats.committed} sealed`,`- Columns: ${S.data.fields.length}`,'',
  '## AI analysis',o?.source==='ai'?`By ${o.provider??'AI'}${o.model?` (${o.model})`:''}, on a masked sample (private columns hidden).`:o?'Quick rules (no AI).':'Not run.','',
  o?.summary??'', ...(o?.issues?.length?['','Issues found:',...o.issues.map(i=>`- ${i}`)]:[]),'',
  '## Changes applied',...(o?.applied?.length?o.applied.map(st=>`- ${describeStep(st)}`):['- None']),'',
  '## Privacy labels',...S.schema.map(f=>`- ${f.name}: ${SENS_LABEL[f.sensitivity]}`),'',
  '## Fingerprint',`- Columns covered: ${p.fields.join(', ')}`,`- Extra secret value per record: ${p.salt==='per-record'?'yes':'no'}`,
  `- Fingerprint: ${c.root}`,s.publication?`- Published on Cardano Preprod: ${EXPLORER}${s.publication.txHash}`:'','',
  '## Limits','- The fingerprint proves the data has not changed since it was sealed. It does not prove the data was correct.',
  '- The AI analysis is advice; every change was approved before it was applied.'];
 return lines.join('\n')+'\n';
}
function documentReport(){
 const c=S.commitment,s=S.session,lines=['# ChainBridge document report','',`- Created: ${new Date().toISOString()}`,`- Documents: ${S.extract.docs.length}`,''];
 for(const d of S.extract.docs){
  lines.push(`## ${d.title||d.name}`,'',`- File: ${d.name}`,`- SHA-256: ${d.sha256}`,`- Type: ${d.documentType.replace(/_/g,' ')}`,`- Read by: ${d.provider} (${d.model})`,'',d.summary,'','### Facts sealed');
  for(const f of d.fields.filter(f=>f.keep))lines.push(`- ${f.label}: ${f.value}${f.evidence?` (source: "${f.evidence}")`:''}`);
  const dropped=d.fields.filter(f=>!f.keep);
  if(dropped.length)lines.push('','### Facts found but not sealed',...dropped.map(f=>`- ${f.label}: ${f.value}`));
  if(d.omitted.length)lines.push('','### Left out by the AI',...d.omitted.map(o=>`- ${o.what}: ${o.reason}`));
  lines.push('');
 }
 lines.push('## Fingerprint',`- Columns covered: ${S.plan.fields.join(', ')}`,`- Fingerprint: ${c.root}`,s.publication?`- Published on Cardano Preprod: ${EXPLORER}${s.publication.txHash}`:'','',
  '## Limits','- The fingerprint proves these facts and files have not changed since they were sealed. It does not prove the documents were true.',
  '- The AI can misread a document. Every fact was shown with its source words and confirmed before sealing.');
 return lines.join('\n')+'\n';
}
function certificate(){
 const s=S.session,c=S.commitment,pub=s.publication;
 return {document:'ChainBridge certificate',version:1,network:'Cardano Preprod (test network)',issuedAt:new Date().toISOString(),
  fingerprint:{root:c.root,records:c.stats.committed,salted:c.payload.salted,hash:'sha-256 Merkle root',canonicalization:CANON_ID,publicPayload:c.payload},
  publication:pub?{transaction:pub.txHash,explorer:pub.explorer,block:pub.blockHeight,status:pub.status,metadataLabel:pub.label,message:pub.metadata,publisher:pub.publisher}:null,
  payment:{protocol:'x402 (exact scheme, direct payment)',network:'cardano:preprod',amount:`${ada(s.quote.totalLovelace)} tADA`,
   transaction:s.settlement?.transaction??null,explorer:s.settlement?.transaction?EXPLORER+s.settlement.transaction:null,payer:s.payer,status:s.status},
  sources:S.mode==='documents'?S.extract.docs.map(d=>({file:d.name,sha256:d.sha256,pages:d.pages})):[{file:S.original.name,...(S.source?{sha256:S.source.sha256}:{})}],
  shareableFiles:(Array.isArray(S.shares)?S.shares:[]).filter(x=>x.certificate).map(x=>({file:x.file.name,sha256:x.file.sha256,certificateId:x.certificate.id,verifyLink:x.link.url,linkKind:x.link.kind})),
  quote:s.quote,
  howToVerify:'To check one original file: open its verification link (or the verify page with its file certificate) and add the file. No proof file is needed. To check one record: open ChainBridge with the data and the private proof file. A match means it is unchanged since it was sealed, not that it is true.'};
}
function downloadPackage(){
 const c=S.commitment;
 const files=[
  {name:'README.txt',text:`ChainBridge package\n\n${S.mode==='documents'?'extracted-data.csv  The facts you confirmed, one row per document, with each file\'s SHA-256.':`cleaned-data.csv   Your data after the approved tidy-up (all ${S.data.records.length} records).`}\nreport.md          What the AI found, what was changed, privacy labels.\ncertificate.json   Your fingerprint and the Cardano transaction links (publication and payment). Share this.\nproof-file.json    PRIVATE. Needed with your data to check records later. Contains the extra secret values. Do not share.\nfile-certificates/ One certificate per original file. Safe to share: lets the holder of that file check it on the verify page, without the proof file.\n\nThe fingerprint proves the data has not changed since it was sealed, not that it was correct.\n`},
  {name:S.mode==='documents'?'extracted-data.csv':'cleaned-data.csv',text:toCsv(S.data.fields,S.data.records)},
  {name:'report.md',text:reportMarkdown()},
  {name:'certificate.json',text:JSON.stringify(certificate(),null,2)},
  {name:'proof-file.json',text:JSON.stringify(c.bundle,null,2)},
  ...(Array.isArray(S.shares)?S.shares:[]).filter(x=>x.certificate).map(x=>({name:`file-certificates/${x.certificate.id.slice(0,8)}-${x.file.name.replace(/[^A-Za-z0-9._-]+/g,'_')}.json`,text:JSON.stringify(x.certificate,null,2)}))];
 const url=URL.createObjectURL(zip(files));
 const a=h('a',{href:url,download:`chainbridge-package-${c.root.slice(0,8)}.zip`});document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),2000);
}
// ---------- shareable verification ----------
// One signed certificate per original file: its hash plus the proof path to the published fingerprint, nothing else.
async function createShares(){
 const c=S.commitment;
 S.shares=c.files.map((f,i)=>({file:{name:f.name,sha256:f.sha256},status:'creating',index:i}));render();
 for(const x of S.shares){
  try{const r=await api(`/api/x402/session/${S.session.id}/share`,fileProof(c,x.index));Object.assign(x,{status:'ready',certificate:r.certificate,link:r.link});}
  catch(e){Object.assign(x,{status:'error',error:e.message});}
  render();
 }
}
function shareCard(x){
 if(x.status==='creating')return h('li',{class:'share-card'},h('div',{},h('strong',{},x.file.name),h('p',{class:'muted'},'Creating the certificate…')));
 if(x.status==='error')return h('li',{class:'share-card'},h('div',{},h('strong',{},x.file.name),note('error',x.error),h('button',{class:'btn small',type:'button',onclick:createShares},'Try again')));
 const local=x.link.kind!=='public',id=x.certificate.id;
 return h('li',{class:`share-card ${local?'local':''}`},
  h('figure',{class:'qr'},h('img',{src:`/api/certificates/${id}/qr.svg`,alt:`QR code for the verification link of ${x.file.name}`,width:150,height:150}),
   h('figcaption',{class:'mono-key'},local?'Local demo QR':'Scan to verify')),
  h('div',{class:'share-body'},
   h('strong',{},x.file.name),
   h('code',{class:'share-url break'},x.link.url),
   local?note('warn',h('strong',{},'Local demo link. '),'It only opens on a computer running this ChainBridge app, so other people can\'t use it yet. To share it, run ChainBridge at a public address and set PUBLIC_BASE_URL. Until then, send the certificate file: it opens on any ChainBridge verify page.')
    :h('p',{class:'small'},'Anyone with this link can check their copy of the file.'),
   h('div',{class:'row'},h('button',{class:'btn small',type:'button',onclick:()=>setArea('check',id)},'Try the check yourself →'),copyButton(x.link.url,'Copy link'),
    h('button',{class:'btn small ghost',type:'button',onclick:()=>download(`chainbridge-file-certificate-${id.slice(0,8)}.json`,JSON.stringify(x.certificate,null,2))},'Download certificate'))));
}
function viewShare(){
 const c=S.commitment;
 if(!c.files?.length)return note('info','This fingerprint was created without the original file, so it has no shareable file check. Records can still be checked with the proof file.');
 if(!S.shares){S.shares=[];setTimeout(createShares);}
 return [h('h3',{},'Share a check'),
  h('p',{},'Send someone a link or QR code with a document. They add their copy of the file and see whether it is the exact version you sealed. They don\'t need your proof file.'),
  h('ul',{class:'share-list'},(S.shares??[]).map(shareCard)),
  more('share-what','What a link reveals',h('ul',{},
   h('li',{},'The file\'s name and its fingerprint (SHA-256). Anyone holding the file can compute that fingerprint anyway.'),
   h('li',{},'A short list of other fingerprints that connect it to the published one. They reveal nothing about your other records or files.'),
   h('li',{},'The Cardano transaction and the demo issuer\'s signature. No extracted facts, no other data, no proof file.')))];
}
function viewPackage(){
 const s=S.session,pub=s.publication;
 return [
  ...heading('Your package','Everything from this job in one download.'),
  h('div',{class:'success'},
   h('h3',{},'✓ Published on Cardano and paid'),
   facts([['Your fingerprint',h('code',{},S.commitment.root)],
    ['Published',h('span',{},pub.status==='confirmed'?`Confirmed in block ${pub.blockHeight}. `:'Sent, awaiting confirmation. ',txLink(pub.txHash))],
    ['Paid',h('span',{},`${ada(s.quote.totalLovelace)} tADA with x402. `,s.settlement?.transaction&&txLink(s.settlement.transaction))]])),
  h('h3',{},'What\'s in the package'),
  h('ul',{class:'getlist'},h('li',{},h('strong',{},S.mode==='documents'?'extracted-data.csv':'cleaned-data.csv'),S.mode==='documents'?' the facts you confirmed, one row per document':' your data, tidied and sorted'),h('li',{},h('strong',{},'report.md'),' what the AI found and what was changed'),
   h('li',{},h('strong',{},'certificate.json'),' your fingerprint with the Cardano links. Share this as proof.'),h('li',{},h('strong',{},'proof-file.json'),' private. Keep it to check records later.')),
  h('div',{class:'center-action'},h('button',{class:'btn primary big',type:'button',onclick:downloadPackage},'Download package (.zip)'),
   h('div',{class:'row'},h('button',{class:'btn small',type:'button',onclick:()=>download(`chainbridge-certificate-${S.commitment.root.slice(0,8)}.json`,JSON.stringify(certificate(),null,2))},'Certificate only'),
    h('button',{class:'btn small',type:'button',onclick:()=>go(VERIFY)},'Try verifying a record →'))),
  viewShare(),
  actions({back:5}),
 ];
}

// ---------- verify (free tool) ----------
function viewVerify(){
 const c=S.commitment;
 const rows=c.entries.map(e=>e.sourceRow).sort((a,b)=>a-b);
 const current=S.verify?.sourceRow??rows[0];
 const rec=S.data.records.find(r=>r.sourceRow===current);
 const edited=S.verify?.values??{...rec.values};
 const res=S.verify?.result;
 const isEdited=S.plan.fields.some(f=>display(edited[f])!==display(rec.values[f]));
 return [
  ...heading('Verify a record','Pick a record and check it against the fingerprint. Try changing a value to see what happens when data is altered.'),
  h('div',{class:'field'},h('label',{for:'vrow'},'Record to check'),
   dropdown({id:'vrow',cls:'wide',label:'Record to check',value:current,options:rows.map(r=>[r,recordLabel(S.data.records.find(x=>x.sourceRow===r))]),
    onChange:v=>{S.verify={sourceRow:v};render();}})),
  h('div',{class:'vgrid'},S.plan.fields.map((f,i)=>{
   const diff=display(edited[f])!==display(rec.values[f]);
   return h('div',{class:`field ${diff?'changed':''}`},h('label',{for:`vf-${i}`},f,diff&&h('span',{class:'tag warn'},'changed')),
    h('input',{id:`vf-${i}`,type:'text',value:display(edited[f]),oninput:e=>{
     const orig=rec.values[f],raw=e.target.value;
     let val=raw;if(typeof orig==='number'&&raw.trim()!==''&&Number.isFinite(Number(raw)))val=Number(raw);else if(typeof orig==='boolean'&&/^(true|false)$/.test(raw))val=raw==='true';else if(orig!==null&&typeof orig==='object'){try{val=JSON.parse(raw);}catch{}}
     S.verify={sourceRow:current,values:{...edited,[f]:val}};}}));
  })),
  h('div',{class:'row'},h('button',{class:'btn primary',type:'button',onclick:async()=>{
    const values=S.verify?.values??{...rec.values};
    S.verify={sourceRow:current,values,result:await verifyRecord({values,sourceRow:current,bundle:c.bundle})};render();}},'Check this record'),
   isEdited&&h('button',{class:'btn ghost',type:'button',onclick:()=>{S.verify={sourceRow:current};render();}},'Undo my changes'),
   h('span',{class:'hint'},'Free. Runs on this device. Nothing is sent.')),
  res&&h('div',{class:`verdict ${res.match?'ok':'bad'}`,role:'status'},
   h('strong',{},res.match?'✓ Match':'✗ No match'),
   h('p',{},res.match?'This record is unchanged since the fingerprint was created.':res.computedLeaf?'This record is different from when the fingerprint was created. At least one covered column has changed.':res.reason)),
  res?.computedLeaf&&tech(facts([['Fingerprint of this record',h('code',{},res.computedLeaf)],['Fingerprint in the proof',h('code',{},res.expectedLeaf)],
   ['Proof path',`${res.proof.siblings.length} step(s) to the fingerprint ${short(res.root)}`]])),
  actions({back:complete()?6:5}),
 ];
}

// ---------- activity log ----------
const EVENT_TEXT={x402_quote:'Price shown',x402_payment_verified:'Payment signed and verified',x402_analyzed:'AI analysis done',x402_published:'Fingerprint published on Cardano',
 x402_settled:'Payment completed',x402_publish_failed:'Publishing failed (not charged)',x402_settle_problem:'Payment problem',x402_verify_failed:'Payment rejected'};
async function refreshActivity(){
 let entries=[];try{entries=await api('/api/audit');}catch{}
 entries=entries.filter(e=>e.mode==='x402');
 mount($('activity'),h('details',{},h('summary',{},`Activity log (${entries.length})`,h('span',{class:'muted small'},' · payment and publication events only, never your data')),
  entries.length?h('div',{class:'table-wrap'},h('table',{},h('thead',{},h('tr',{},['Time','What happened','Job','Price','Transaction'].map(x=>h('th',{scope:'col'},x)))),
   h('tbody',{},entries.slice(0,30).map(e=>h('tr',{},h('td',{},e.at.replace('T',' ').slice(0,19)),h('td',{},EVENT_TEXT[e.event]??e.event),h('td',{},(e.taskId??'').slice(0,8)),
    h('td',{},e.price??''),h('td',{},e.txHash?txLink(e.txHash):''))))))
  :h('p',{class:'muted'},'No activity yet.')));
}

// ---------- start ----------
(async()=>{
 const linked=location.pathname.match(/^\/verify\/([0-9a-f]{32})$/)?.[1];
 try{[S.config,S.x402]=await Promise.all([api('/api/config'),api('/api/x402/info')]);}
 catch(e){mount($('view'),note('error',`Can't reach the ChainBridge app server: ${e.message}`));return;}
 render();refreshActivity();
 if(linked)openCertificateId(linked);
})();
