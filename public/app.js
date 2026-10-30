// ChainBridge UI: a five-step guided flow plus an optional paid task.
// Parsing, labelling, planning, fingerprinting and checking all run here in the browser, using the same
// core modules as the agent and the tests. The server only receives fingerprints and task details.
import {h,mount,display,toast,api,download,short,copyButton} from './ui.js';
import {ingest} from '/core/ingest.mjs';
import {analyzeSchema,applyOverride,schemaSummary,FIELD_TYPES,SENSITIVITY} from '/core/schema.mjs';
import {recommendPlan,normalizePlan,validatePlan,countDuplicates} from '/core/plan.mjs';
import {buildCommitment,verifyRecord} from '/core/commitment.mjs';
import {anchorJobText,verifyJobText} from '/core/job.mjs';
import {CANON_ID} from '/core/canonical.mjs';
import {LEAF_DOMAIN} from '/core/merkle.mjs';
import {checkRecipe,applyRecipe,recipeRecord,describeStep} from '/core/recipe.mjs';
import {buildAiSample,suggestRecipeLocally} from '/core/organize.mjs';

const S={config:null,data:null,schema:[],selected:new Set(),plan:null,validation:null,commitment:null,salts:{},verify:null,
 task:null,view:0,page:0,busy:false,poll:null,aiOpen:false,open:new Set(),
 original:null,organize:null}; // organize: {source,summary,issues,steps,enabled:Set,rejected,applied,applying}
const $=id=>document.getElementById(id);
const PAGE=20,PREVIEW_ROWS=5,PREVIEW_COLS=5;

const STEPS=['Upload data','Organize data','Review data','Choose what to publish','Create proof','Verify a record'];
const PAID='paid';
const SENS_LABEL={none:'Not sensitive',personal:'Personal',confidential:'Confidential'};
const TYPE_LABEL={text:'Text',number:'Number',boolean:'Yes / no',datetime:'Date or time',url:'Web link',identifier:'ID',json:'Structured data'};
const TASK_TEXT={
 awaiting_approval:'Waiting for your approval. Nothing has been sent or paid.',
 approved:'Approved.',
 submitting:'Sending the task to the agent…',
 submitted:'Sent to the agent. Waiting for it to start.',
 awaiting_payment:'Waiting for the test payment to arrive.',
 processing:'The agent is working on it.',
 result_submitted:'The agent delivered its answer. Waiting for Cardano Preprod to confirm.',
 confirmed_on_chain:'The answer\'s fingerprint is confirmed on Cardano Preprod.',
 completed:'Done.',
 settled:'Done. The payment to ChainBridge is confirmed on Cardano Preprod.',
 failed:'This task failed. Nothing more will happen automatically.',
 cancelled:'You declined this task. Nothing was sent or paid.',
 needs_inspection:'We can\'t tell whether this went through. Don\'t try again until you\'ve checked Sokosumi, so you aren\'t charged twice.',
};
const PAY_TEXT={not_required:'None (local demo)',disabled:'None (payments are switched off)',pending_request:'Preparing the payment request',
 requested:'Payment requested',awaiting_buyer:'Waiting for the test payment',funds_locked:'Test payment received and held until the task is done',
 result_submitted:'Test payment held; answer delivered',payout_pending:'Task accepted; payout to ChainBridge pending',
 seller_receipt_verified:'Paid. ChainBridge\'s receipt is confirmed on-chain',unknown:'Unknown'};

// ---------- state helpers ----------
const selectedRecords=()=>S.data?S.data.records.filter(r=>S.selected.has(r.sourceRow)):[];
function invalidate(){S.commitment=null;S.verify=null;if(S.task?.state==='awaiting_approval')S.task=null;stopPoll();}
function revalidate(){S.validation=S.plan?validatePlan(S.plan,S.schema,selectedRecords().length):null;}
function canOpen(i){
 if(i===PAID)return !!S.commitment;
 return [true,!!S.data,!!S.data,!!S.data,!!S.data&&!!S.validation?.ok,!!S.commitment][i];
}
function go(i){
 if(!canOpen(i))return;
 S.view=i;render();
 window.scrollTo({top:0,behavior:'smooth'});
 $('view').querySelector('h2')?.focus({preventScroll:true});
}
function changed(){invalidate();revalidate();render();}

// ---------- small building blocks ----------
// Expandable sections remember whether they are open across re-renders (keyed by step and name).
function expander(cls,key,summary,children){
 const id=`${S.view}:${key}`;
 return h('details',{class:cls,open:S.open.has(id),ontoggle:e=>{e.currentTarget.open?S.open.add(id):S.open.delete(id);}},h('summary',{},summary),h('div',{class:`${cls}-body`},...children));
}
const tech=(...children)=>expander('tech','tech','Details for technical users',children);
const more=(key,summary,...children)=>expander('more',key,summary,children);
const note=(kind,...children)=>h('div',{class:`note ${kind}`,role:kind==='error'?'alert':null},...children);
const heading=(text,sub)=>[h('h2',{tabindex:-1},text),sub&&h('p',{class:'lead'},sub)];
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

// ---------- header, status strip, stepper ----------
function renderHeader(){
 const c=S.config;if(!c)return;
 const mode=c.mode==='demo'?['Local demo: no payments','warn']:c.paid?['Test payments on','ok']:['Agent connected: no payments','info'];
 mount($('badges'),h('span',{class:'badge net'},'Cardano Preprod (test network)'),h('span',{class:`badge ${mode[1]}`,title:c.reason},mode[0]));
}
function publishedText(){
 const t=S.task;
 if(t&&t.mode==='sokosumi'&&t.paymentStatus!=='disabled'&&['confirmed_on_chain','completed','settled'].includes(t.state))
  return ['A fingerprint of the agent\'s answer, on Cardano Preprod','ok'];
 if(t&&t.mode==='sokosumi'&&t.state==='result_submitted')return ['Waiting for Cardano Preprod to confirm','info'];
 return ['Nothing yet',''];
}
function renderStatus(){
 const pub=publishedText();
 const pay=S.task&&S.task.state!=='awaiting_approval'?PAY_TEXT[S.task.paymentStatus]??'Unknown':'None';
 const item=(label,value,cls='')=>h('div',{class:`status-item ${cls}`},h('span',{},label),h('strong',{},value));
 mount($('status'),
  item('Your original data','Stays on this device'),
  S.commitment?item('Fingerprint',`Created on this device (${S.commitment.stats.committed} records)`,'ok'):item('Fingerprint','Not created yet'),
  item('Published to Cardano',pub[0],pub[1]),
  item('Payment',pay));
}
function renderStepper(){
 mount($('stepper'),
  STEPS.map((label,i)=>{
   const done=i<S.view&&S.view!==PAID||(S.view===PAID&&canOpen(i));
   const current=S.view===i;
   return h('li',{class:`${current?'current':''} ${done?'done':''}`},
    h('button',{type:'button','aria-label':`Step ${i+1}: ${label}`,disabled:!canOpen(i),'aria-current':current?'step':null,onclick:()=>go(i)},
     h('span',{class:'dot','aria-hidden':'true'},done&&!current?'✓':i+1),h('span',{class:'label'},label)));
  }),
  h('li',{class:`optional ${S.view===PAID?'current':''}`},
   h('button',{type:'button','aria-label':'Optional: Paid task, Cardano Preprod test',disabled:!canOpen(PAID),'aria-current':S.view===PAID?'step':null,onclick:()=>go(PAID),title:canOpen(PAID)?null:'Create a proof first'},
    h('span',{class:'dot','aria-hidden':'true'},'+'),h('span',{class:'label'},'Optional: Paid task'))));
}
function render(){
 renderHeader();renderStatus();renderStepper();
 const views=[viewUpload,viewOrganize,viewReview,viewPublish,viewProof,viewVerify];
 mount($('view'),h('section',{class:'card'},S.view===PAID?viewPaid():views[S.view]()));
}

// ---------- step 1: upload ----------
async function loadText(name,text,byteLength){
 try{
  const data=ingest({name,text,byteLength});
  S.original=data;S.organize=null;useData(data);S.task=null;S.loadError=null;changed();
  toast(`Loaded ${data.records.length} records`,'ok');
 }catch(e){S.data=null;S.plan=null;S.loadError=e.message;changed();}
}
async function onFile(file){
 if(!file)return;
 const L=S.config.limits;
 if(file.size>L.maxBytes){S.loadError=`This file is ${(file.size/1048576).toFixed(1)} MB. The limit is ${L.maxBytes/1048576} MB.`;return render();}
 if(!/\.(csv|json)$/i.test(file.name)){S.loadError='Please choose a .csv or .json file.';return render();}
 loadText(file.name,await file.text(),file.size);
}
async function loadSample(name){
 try{const res=await fetch(`/samples/${name}`);if(!res.ok)throw new Error();loadText(name,await res.text());}
 catch{S.loadError='Could not load the sample file.';render();}
}
// Make `data` the working dataset and reset everything that depends on it.
function useData(data,labels={}){
 S.data=data;S.schema=analyzeSchema(data.records,data.fields).map(f=>labels[f.name]?applyOverride(f,{sensitivity:labels[f.name]}):f);
 S.selected=new Set(data.records.map(r=>r.sourceRow));S.page=0;S.salts={};S.plan=recommendPlan(S.schema,data.records);
}
function viewUpload(){
 const L=S.config.limits,d=S.data;
 const input=h('input',{type:'file',id:'file',accept:'.csv,.json,text/csv,application/json',class:'visually-hidden',onchange:e=>onFile(e.target.files[0])});
 return [
  ...heading('Upload data'),
  h('div',{class:'intro'},
   h('p',{},'ChainBridge creates a digital fingerprint of your selected data. The original file stays on your device. Later, you can check whether a record matches the fingerprint.')),
  h('div',{class:'upload'},input,
   h('label',{for:'file',class:'drop',ondragover:e=>{e.preventDefault();e.currentTarget.classList.add('over');},ondragleave:e=>e.currentTarget.classList.remove('over'),
    ondrop:e=>{e.preventDefault();e.currentTarget.classList.remove('over');onFile(e.dataTransfer.files[0]);}},
    h('strong',{},'Choose a CSV or JSON file'),h('span',{},'or drag it here'),
    h('small',{},`Up to ${L.maxBytes/1048576} MB and ${L.maxRows.toLocaleString('en')} records. The file is read in this browser. It is not uploaded anywhere.`)),
   h('div',{class:'samples'},h('p',{},'Or try a sample:'),
    h('button',{class:'btn',type:'button',onclick:()=>loadSample('supplier-certificates.csv')},'Supplier inspection certificates'),
    h('button',{class:'btn',type:'button',onclick:()=>loadSample('payroll-export.json')},'Payroll export (contains personal data)'),
    h('button',{class:'btn',type:'button',onclick:()=>loadSample('messy-shipments.csv')},'Messy shipment list (needs tidying)'))),
  S.loadError&&note('error',h('strong',{},'We couldn\'t read that file. '),S.loadError),
  d&&note('ok',h('strong',{},`Loaded ${d.name}. `),`${d.records.length} records, ${d.fields.length} columns.`),
  d?.issues.length?note('warn',`${d.issues.length} row(s) couldn't be read and were skipped.`,
   more('skipped','Show skipped rows',h('ul',{},d.issues.slice(0,50).map(i=>h('li',{},`Row ${i.row}: ${i.message}`))))):null,
  actions({next:1,disabled:!d,nextHint:d?null:'Choose a file or a sample to continue'}),
 ];
}

// ---------- step 2: organize ----------
// Suggestions come from the AI or local rules; ChainBridge validates them and applies only the ticked ones.
function setSuggestions(result){
 const {steps,rejected}=checkRecipe(result.steps,S.original.fields);
 S.organize={source:result.source,provider:result.provider,summary:result.summary,issues:result.issues??[],steps,
  enabled:new Set(steps.map((_,i)=>i)),rejected:[...(result.rejected??[]),...rejected.map(r=>({op:String(r.step?.op??'?'),error:r.error}))],
  applied:S.organize?.applied??null,shareMode:S.organize?.shareMode??'masked',consent:false};
 render();
}
function organizePreview(){
 const o=S.organize;const chosen=o.steps.filter((_,i)=>o.enabled.has(i));
 const {steps,rejected}=checkRecipe(chosen,S.original.fields);
 return {steps,rejected,result:applyRecipe(S.original,steps)};
}
async function askAi(){
 const o=S.organize;
 const schema=analyzeSchema(S.original.records,S.original.fields);
 const sample=buildAiSample(S.original,schema,o.shareMode);
 S.busy=true;render();
 try{setSuggestions(await api('/api/organize/ai',{consent:true,fullConsent:o.shareMode==='full'&&o.fullConsent===true,sample}));toast('Suggestions ready. Review them below.','ok');}
 catch(e){toast(e.message,'error');}
 S.busy=false;render();
}
function aiPanel(){
 const o=S.organize??(S.organize={steps:[],enabled:new Set(),rejected:[],issues:[],shareMode:'masked',applied:null,asking:true});
 const schema=analyzeSchema(S.original.records,S.original.fields);
 const sample=buildAiSample(S.original,schema,o.shareMode);
 const fullBlocked=o.shareMode==='full'&&!o.fullConsent;
 return h('div',{class:'consent'},
  h('h4',{},`Ask the AI (${S.config.aiProvider}) for suggestions`),
  h('p',{},'The AI needs to look at your data to suggest changes. Choose how much it may see. Whatever you choose is sent to the AI service and leaves this computer.'),
  choice('share',o.shareMode,[
   ['masked','A few example rows, private values hidden (recommended)','Up to 10 rows. Columns labelled personal or confidential show [personal] or [confidential] instead of the real value.'],
   ['names','Column names only','The AI sees headings and counts, no values at all. Most private, but it can\'t spot messy dates or number formats.'],
   ['full','A few example rows, nothing hidden','Up to 10 rows exactly as in your file, including names, emails or bank details.']],
   v=>{o.shareMode=v;o.fullConsent=false;render();}),
  o.shareMode==='full'&&h('label',{class:'check warn-check'},h('input',{type:'checkbox',checked:!!o.fullConsent,onchange:e=>{o.fullConsent=e.target.checked;render();}}),
   'I understand that real personal or confidential values in these rows will be sent to the AI service.'),
  more('aisample','Show exactly what will be sent',h('pre',{class:'code'},JSON.stringify(sample,null,2))),
  h('div',{class:'row'},h('button',{class:'btn primary',type:'button',disabled:S.busy||fullBlocked,onclick:askAi},S.busy?'Asking the AI…':'Send and get suggestions'),
   h('button',{class:'btn ghost',type:'button',onclick:()=>{o.asking=false;if(!o.steps.length&&!o.source)S.organize=null;render();}},'Cancel')));
}
function viewOrganize(){
 const o=S.organize;const applied=o?.applied;
 const hasSuggestions=o?.source;
 const preview=hasSuggestions?organizePreview():null;
 const logFor=new Map(preview?preview.result.log.map((l,i)=>[i,l]):[]);
 let enabledIndex=-1;
 return [
  ...heading('Organize data','ChainBridge can suggest how to tidy up and sort your data. You approve every change. ChainBridge then makes the approved changes itself, the same way every time, so the fingerprint can always be re-created from your original file.'),
  applied&&note('ok',h('strong',{},`${applied.length} change(s) applied. `),`Your data now has ${S.data.records.length} records and ${S.data.fields.length} columns. Your original file is untouched.`,
   h('div',{class:'row'},h('button',{class:'btn small',type:'button',onclick:()=>{S.organize={...o,applied:null};useData(S.original);changed();toast('Back to the original data');}},'Undo all changes'))),
  !o?.asking&&h('div',{class:'suggest-actions'},
   h('div',{class:'suggest-card'},h('strong',{},'Suggest with AI'),
    h('p',{class:'small muted'},S.config.ai?`Uses ${S.config.aiProvider}'s AI. You choose what it may see before anything is sent.`:'Not set up yet. Add a Meta API key (MODEL_API_KEY) to the .env file to switch this on.'),
    h('button',{class:'btn primary',type:'button',disabled:!S.config.ai,onclick:()=>{S.organize={...(o??{steps:[],enabled:new Set(),rejected:[],issues:[],applied:null}),asking:true,shareMode:o?.shareMode??'masked'};render();}},'Suggest with AI')),
   h('div',{class:'suggest-card'},h('strong',{},'Suggest with quick rules'),
    h('p',{class:'small muted'},'No AI and nothing leaves this computer. Catches common problems: spaces, date formats, yes/no values, duplicates.'),
    h('button',{class:'btn',type:'button',onclick:()=>{setSuggestions(suggestRecipeLocally(S.original));}},'Suggest with rules'))),
  o?.asking&&aiPanel(),
  hasSuggestions&&!o.asking&&h('div',{class:'suggestions'},
   h('h3',{},o.source==='ai'?`Suggestions from the AI (${o.provider})`:'Suggestions from the quick rules'),
   o.summary&&h('p',{},o.summary),
   o.issues.length?h('ul',{class:'muted'},o.issues.map(i=>h('li',{},i))):null,
   o.steps.length?h('ul',{class:'step-list'},o.steps.map((st,i)=>{
     const on=o.enabled.has(i);if(on)enabledIndex++;
     const log=on?logFor.get(enabledIndex):null;
     const blocked=on&&preview.rejected.some(r=>r.step===st);
     return h('li',{class:on?'on':''},h('label',{class:'check'},
      h('input',{type:'checkbox',checked:on,onchange:e=>{e.target.checked?o.enabled.add(i):o.enabled.delete(i);render();}}),
      h('span',{},h('strong',{},describeStep(st)),st.reason&&h('span',{class:'muted small'},st.reason),
       log&&h('span',{class:'tag count'},st.op==='rename'?'column renamed':st.op==='drop_column'?'column removed':st.op==='mark_sensitive'?'label only':st.op.startsWith('remove')?`${log.changed} row(s) removed`:st.op==='sort'?`${log.changed} row(s) move`:`${log.changed} value(s) change`),
       blocked&&h('span',{class:'tag warn'},'skipped: depends on an unticked step'))));
    })):note('info','No changes suggested. The data already looks tidy.'),
   o.rejected.length?note('warn',`${o.rejected.length} suggestion(s) were ignored because ChainBridge can't apply them safely.`,
    more('rejected','Show ignored suggestions',h('ul',{},o.rejected.map(r=>h('li',{},`${r.op}: ${r.error}`))))):null,
   preview&&preview.steps.length?more('beforeafter','Preview: before and after',beforeAfter(S.original,preview.result,preview.steps)):null,
   preview&&preview.steps.length?h('div',{class:'row'},h('button',{class:'btn primary',type:'button',onclick:()=>{
     o.applied=preview.steps;
     useData({...S.original,records:preview.result.records,fields:preview.result.fields},preview.result.labels);changed();
     toast(`Applied ${preview.steps.length} change(s)`,'ok');}},`Apply ${preview.steps.length} change(s)`),
    h('span',{class:'hint'},'Changes your working copy only. The original file stays as it is.')):null),
  tech(h('p',{},'Allowed steps: rename, trim, lowercase, yes/no to true/false, dates to YYYY-MM-DD, numbers, remove column, remove empty or duplicate rows, sort, change a privacy label. Anything else the AI suggests is ignored.'),
   h('p',{},'Each step is checked against the columns that exist at that point, then applied by ChainBridge\'s own code (not the AI). Sorting compares numbers numerically and text character by character, with no language-specific rules, so it gives the same order on every computer. Every record keeps its original row number.'),
   h('p',{},'The approved steps are saved in the proof file, so anyone with the original file can rebuild the exact same records and fingerprint.')),
  actions({back:0,next:2,nextLabel:applied||!hasSuggestions?'Continue →':'Continue without these changes →'}),
 ];
}
// Before/after tables. Renamed columns are matched back to their original name to highlight changed cells.
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

// ---------- step 3: review ----------
function sensSelect(f,i){
 return h('select',{class:`sens ${f.sensitivity}`,'aria-label':`Privacy label for ${f.name}`,onchange:e=>{S.schema[i]=applyOverride(f,{sensitivity:e.target.value});revalidate();render();}},
  SENSITIVITY.map(s=>h('option',{value:s,selected:s===f.sensitivity},SENS_LABEL[s])));
}
function viewReview(){
 const d=S.data,recs=d.records;
 const cols=d.fields.slice(0,PREVIEW_COLS);
 const flagged=S.schema.map((f,i)=>[f,i]).filter(([f])=>f.sensitivity!=='none'||f.inferred.sensitivity!=='none');
 const pages=Math.ceil(recs.length/PAGE),view=recs.slice(S.page*PAGE,(S.page+1)*PAGE);
 const setAll=on=>{S.selected=on?new Set(recs.map(r=>r.sourceRow)):new Set();changed();};
 return [
  ...heading('Review data','Check that the data looks right, and that personal or confidential columns are labelled correctly.'),
  h('h3',{},'Preview'),
  h('div',{class:'table-wrap'},h('table',{},
   h('thead',{},h('tr',{},cols.map(f=>h('th',{scope:'col'},f)))),
   h('tbody',{},recs.slice(0,PREVIEW_ROWS).map(r=>h('tr',{},cols.map(f=>h('td',{},display(r.values[f]).slice(0,60)))))))),
  h('p',{class:'muted small'},`Showing ${Math.min(PREVIEW_ROWS,recs.length)} of ${recs.length} records and ${cols.length} of ${d.fields.length} columns.`),
  h('h3',{},'Privacy check'),
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
     h('td',{},h('select',{'aria-label':`Kind of data in ${f.name}`,onchange:e=>{S.schema[i]=applyOverride(f,{type:e.target.value});render();}},FIELD_TYPES.map(t=>h('option',{value:t,selected:t===f.type},TYPE_LABEL[t])))),
     h('td',{},sensSelect(f,i)))))))),
  more('records',`Choose which records to include (${S.selected.size} of ${recs.length} selected)`,
   h('div',{class:'row'},h('button',{class:'btn small',type:'button',onclick:()=>setAll(true)},'Select all'),h('button',{class:'btn small',type:'button',onclick:()=>setAll(false)},'Select none')),
   h('ul',{class:'record-list'},view.map(r=>h('li',{},h('label',{class:'check'},
    h('input',{type:'checkbox',checked:S.selected.has(r.sourceRow),onchange:e=>{e.target.checked?S.selected.add(r.sourceRow):S.selected.delete(r.sourceRow);changed();}}),recordLabel(r))))),
   pages>1&&h('div',{class:'row center'},h('button',{class:'btn small',type:'button',disabled:S.page===0,onclick:()=>{S.page--;render();}},'Previous'),
    h('span',{class:'small'},`Page ${S.page+1} of ${pages}`),h('button',{class:'btn small',type:'button',disabled:S.page>=pages-1,onclick:()=>{S.page++;render();}},'Next'))),
  tech(h('p',{},'Kind of data is inferred from the values (numbers, dates, web links, unique IDs) and is used for display and labelling only. Fingerprints use each value exactly as it appears in the file.'),
   h('p',{},'Privacy labels come from column-name patterns (e.g. email, phone, iban, salary) and value patterns (email addresses, IBANs, card numbers checked with the Luhn rule, street addresses).')),
  actions({back:1,next:3,disabled:!S.selected.size,nextHint:S.selected.size?null:'Select at least one record'}),
 ];
}

// ---------- step 4: choose what to publish ----------
function setPlan(patch){S.plan={...S.plan,...patch};changed();}
function choice(name,value,options,onpick){
 return h('div',{class:'choices',role:'radiogroup'},options.map(([v,title,desc])=>h('label',{class:`choice ${v===value?'on':''}`},
  h('input',{type:'radio',name,value:v,checked:v===value,onchange:()=>onpick(v)}),h('span',{},h('strong',{},title),h('span',{class:'muted'},desc)))));
}
function viewPublish(){
 const p=S.plan,v=S.validation,recs=selectedRecords();
 const dup=countDuplicates(recs,p.fields);
 return [
  ...heading('Choose what to publish','Pick which columns the fingerprint should cover. Only a fingerprint could ever be published, never these values, and nothing is published in this step.'),
  note(p.source==='ai'?'info':'ok',p.source==='ai'?'These settings were suggested by AI and checked by ChainBridge. Please review them.':'We\'ve picked safe defaults: confidential columns are left out, and an extra secret value is added where personal data is involved.'),
  h('h3',{},'Columns to cover'),
  h('div',{class:'col-grid'},S.schema.map(f=>h('label',{class:`col ${p.fields.includes(f.name)?'on':''}`},
   h('input',{type:'checkbox',checked:p.fields.includes(f.name),onchange:e=>{
    const set=new Set(p.fields);e.target.checked?set.add(f.name):set.delete(f.name);
    setPlan({fields:S.schema.map(x=>x.name).filter(n=>set.has(n))});}}),
   h('span',{class:'col-name'},f.name),f.sensitivity!=='none'&&h('span',{class:`tag ${f.sensitivity}`},SENS_LABEL[f.sensitivity])))),
  h('p',{class:'muted small'},'Columns you leave out are not protected, so changes to them will not be detected.'),
  h('h3',{},'Extra secret value'),
  choice('salt',p.salt,[
   ['per-record','Add an extra secret value to each record (recommended)','Makes it much harder for anyone to guess your records from the fingerprint. You\'ll need to keep the proof file to check records later.'],
   ['none','Don\'t add one','Anyone who has a record can check it without the proof file, but someone who can guess the values could confirm the guess.']],
   o=>{S.salts={};setPlan({salt:o});}),
  dup>0&&[h('h3',{},`Duplicate records (${dup} found)`),
   choice('dups',p.duplicates,[['keep','Keep every record','Each record counts, even exact copies.'],['drop','Remove exact copies','Only the first of each identical record is covered.']],o=>setPlan({duplicates:o}))],
  v?.errors.length?note('error',h('strong',{},'Please fix this first: '),h('ul',{},v.errors.map(e=>h('li',{},e)))):null,
  h('div',{class:'note warn'},h('strong',{},'Things to know'),h('ul',{},[...(v?.warnings??[]),...p.risks].map(w=>h('li',{},w)))),
  more('why','Why we recommend these settings',h('ul',{},p.rationale.map(r=>h('li',{},r))),h('ul',{class:'muted'},p.assumptions.map(r=>h('li',{},r)))),
  more('options','More options',
   h('h4',{},'How many fingerprints'),
   choice('strategy',p.strategy,[['merkle-root','One fingerprint for all selected records (recommended)','Publishes a single fingerprint, whatever the number of records.'],
    ['per-record-hashes','One fingerprint per record','Publishes a fingerprint for every record (max 50). Reveals how many records you have.']],o=>setPlan({strategy:o})),
   h('h4',{},'Record order'),
   choice('ordering',p.ordering,[['leaf-hash','Sort automatically (recommended)','You get the same fingerprint even if the file is re-sorted later.'],
    ['source','Keep the file\'s order','Re-sorting the file later changes the fingerprint.']],o=>setPlan({ordering:o})),
   h('div',{class:'row'},h('button',{class:'btn small',type:'button',onclick:()=>{S.plan=recommendPlan(S.schema,recs);S.salts={};changed();toast('Back to the recommended settings');}},'Reset to recommended settings'),
    S.config.ai&&h('button',{class:'btn small',type:'button',onclick:()=>{S.aiOpen=true;render();}},'Get an AI suggestion (optional)')),
   S.aiOpen&&aiConsent()),
  tech(facts([['Plan source',p.source==='ai'?'AI suggestion, validated locally':'Local rules (no AI)'],['Strategy',p.strategy],['Ordering',p.ordering],['Salting',p.salt],['Duplicates',p.duplicates],['Fields',p.fields.join(', ')]])),
  actions({back:2,next:4,disabled:!v?.ok,nextHint:v?.ok?null:'Fix the issue above to continue'}),
 ];
}
function aiConsent(){
 const summary=schemaSummary(S.schema,selectedRecords().length);
 return h('div',{class:'consent'},
  h('h4',{},'Send a summary to the AI service?'),
  h('p',{},'Only what\'s shown below would be sent: column names, labels and counts. No record values. The AI service is set up by whoever runs this app, and it may keep a copy. Column names on their own can reveal something.'),
  more('aisend','Show exactly what would be sent',h('pre',{class:'code'},JSON.stringify(summary,null,2))),
  h('div',{class:'row'},h('button',{class:'btn primary',type:'button',onclick:async e=>{
   e.target.disabled=true;e.target.textContent='Asking…';
   try{const r=await api('/api/plan/ai',{consent:true,summary});
    S.plan=normalizePlan({...r.plan,fields:r.plan.fields.filter(f=>S.schema.some(s=>s.name===f)),source:'ai'},S.plan);S.aiOpen=false;changed();toast('AI suggestion applied. Please review it.','ok');}
   catch(err){S.aiOpen=false;render();toast(err.message,'error');}
  }},'Send summary and get a suggestion'),h('button',{class:'btn ghost',type:'button',onclick:()=>{S.aiOpen=false;render();}},'Cancel')));
}

// ---------- step 5: create proof ----------
async function createProof(){
 S.busy=true;render();
 try{
  S.commitment=await buildCommitment({records:selectedRecords(),plan:S.plan,salts:Object.fromEntries(Object.entries(S.salts).filter(([,v])=>v)),
   recipe:S.organize?.applied?recipeRecord(S.organize.applied):null});
  for(const e of S.commitment.entries)if(e.salt)S.salts[e.sourceRow]=e.salt; // keep the same secret values if recreated
  S.verify=null;toast('Proof created on this device','ok');
 }catch(e){toast(e.message,'error');}
 S.busy=false;render();
 document.querySelector('#view .success')?.scrollIntoView({behavior:'smooth',block:'center'});
}
function viewProof(){
 const c=S.commitment,recs=selectedRecords(),p=S.plan;
 const left=S.schema.filter(f=>!p.fields.includes(f.name)).map(f=>f.name);
 return [
  ...heading('Create proof','ChainBridge will create one fingerprint for the selected records, here on your device. This step does not publish or pay anything.'),
  h('div',{class:'split'},
   h('div',{class:'panel private'},h('h3',{},'Stays on your device'),h('ul',{},
    h('li',{},`Your ${recs.length} records and all their values`),
    left.length?h('li',{},`Columns you left out: ${left.join(', ')}`):null,
    p.salt==='per-record'&&h('li',{},'The extra secret values (saved in your proof file)'),
    S.organize?.applied&&h('li',{},`The ${S.organize.applied.length} tidy-up step(s) you approved (saved in your proof file)`),
    h('li',{},'The proof file you\'ll use to check records later'))),
   h('div',{class:'panel public'},h('h3',{},'Could be published to Cardano'),h('ul',{},
    h('li',{},p.strategy==='merkle-root'?'One fingerprint (a 64-character code)':`One fingerprint per record (${recs.length})`),
    h('li',{},`The number of records (${recs.length}) and the settings used`),
    h('li',{},'No column names and no values')),
    h('p',{class:'small'},'Nothing is published in this step. Publishing only happens through the optional paid task, after you approve it. A Cardano network fee would apply, and ChainBridge can\'t estimate it.'))),
  !c&&h('div',{class:'center-action'},h('button',{class:'btn primary big',type:'button',disabled:S.busy,onclick:createProof},S.busy?'Creating…':'Create proof'),
   h('p',{class:'hint'},'Takes a second and runs entirely in this browser.')),
  c&&h('div',{class:'success'},
   h('h3',{},'✓ Proof created on this device'),
   h('p',{},`One fingerprint for ${c.stats.committed} records`+(c.stats.duplicates?` (${c.stats.duplicates} duplicate${c.stats.duplicates>1?'s':''} ${c.stats.dropped?'removed':'kept'})`:'')+'. It has not been published.'),
   h('code',{class:'fingerprint'},c.root),
   h('div',{class:'row'},copyButton(c.root,'Copy fingerprint'),
    h('button',{class:'btn small',type:'button',onclick:()=>download(`chainbridge-proof-${c.root.slice(0,8)}.json`,JSON.stringify(c.bundle,null,2))},'Download proof file')),
   h('p',{class:'small muted'},p.salt==='per-record'?'Keep the proof file private. You need it, along with your original data, to check records later, because it holds the extra secret values.':'Keep the proof file. You need it, along with your original data, to check records later.'),
   more('payload','Show exactly what would be published',h('pre',{class:'code'},JSON.stringify(c.payload,null,2)),
    h('div',{class:'row'},copyButton(c.payloadText,'Copy'),h('span',{class:'small muted'},`${c.payloadBytes} bytes`))),
   h('button',{class:'btn ghost small',type:'button',onclick:createProof},'Create again')),
  tech(facts([
   ['"One fingerprint"','The Merkle root of the record fingerprints (SHA-256, binary tree; an odd node at the end of a level is carried up unchanged, not duplicated)'],
   ['Record fingerprint',`SHA-256(0x00 ‖ "${LEAF_DOMAIN}" ‖ 0x00 ‖ salt ‖ 0x00 ‖ formatted record). Combining two: SHA-256(0x01 ‖ left ‖ right). The prefixes are domain separation, so a record can't be mistaken for a combined node.`],
   ['How records are formatted',`${CANON_ID}: only the chosen columns, keys sorted, Unicode NFC, JSON escaping, no whitespace, values exactly as in the file (CSV values stay text; nothing is trimmed)`],
   ['Extra secret value','A 16-byte random salt per record, stored only in the proof file'],
   ['Order',p.ordering==='leaf-hash'?'Record fingerprints sorted before combining':'File order'],
   c&&['Proof file contents','Fingerprint, record fingerprints, salts, column list, settings, and any approved tidy-up recipe. No record values.'],
   S.organize?.applied&&['Tidy-up recipe','Fingerprints cover the tidied records. Re-running the saved recipe on the original file reproduces them exactly.'],
  ])),
  actions({back:3,next:5,disabled:!c,nextHint:c?null:'Create the proof to continue'}),
 ];
}

// ---------- step 6: verify ----------
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
   h('select',{id:'vrow',onchange:e=>{S.verify={sourceRow:Number(e.target.value)};render();}},
    rows.map(r=>h('option',{value:r,selected:r===current},recordLabel(S.data.records.find(x=>x.sourceRow===r)))))),
  h('div',{class:'vgrid'},S.plan.fields.map((f,i)=>{
   const diff=display(edited[f])!==display(rec.values[f]);
   return h('div',{class:`field ${diff?'changed':''}`},h('label',{for:`vf-${i}`},f,diff&&h('span',{class:'tag warn'},'changed')),
    h('input',{id:`vf-${i}`,type:'text',value:display(edited[f]),oninput:e=>{
     const orig=rec.values[f],raw=e.target.value;
     // Keep JSON types when the text still parses as the same type.
     let val=raw;if(typeof orig==='number'&&raw.trim()!==''&&Number.isFinite(Number(raw)))val=Number(raw);else if(typeof orig==='boolean'&&/^(true|false)$/.test(raw))val=raw==='true';else if(orig!==null&&typeof orig==='object'){try{val=JSON.parse(raw);}catch{}}
     S.verify={sourceRow:current,values:{...edited,[f]:val}};}}));
  })),
  h('div',{class:'row'},h('button',{class:'btn primary',type:'button',onclick:async()=>{
    const values=S.verify?.values??{...rec.values};
    S.verify={sourceRow:current,values,result:await verifyRecord({values,sourceRow:current,bundle:c.bundle})};render();}},'Check this record'),
   isEdited&&h('button',{class:'btn ghost',type:'button',onclick:()=>{S.verify={sourceRow:current};render();}},'Undo my changes'),
   h('span',{class:'hint'},'Runs on this device. Nothing is sent.')),
  res&&h('div',{class:`verdict ${res.match?'ok':'bad'}`,role:'status'},
   h('strong',{},res.match?'✓ Match':'✗ No match'),
   h('p',{},res.match?'This record is unchanged since the proof was created.':res.computedLeaf?'This record is different from when the proof was created. At least one covered column has changed.':res.reason)),
  res?.computedLeaf&&tech(facts([['Fingerprint of this record',h('code',{},res.computedLeaf)],['Fingerprint in the proof',h('code',{},res.expectedLeaf)],
   ['Proof path',`${res.proof.siblings.length} step(s) to the fingerprint ${short(res.root)}`]])),
  h('div',{class:'optional-cta'},h('div',{},h('strong',{},'Optional: Paid task — Cardano Preprod test'),
   h('p',{class:'small muted'},S.config.mode==='demo'?'Try the ChainBridge agent in local demo mode. No payment is possible.':'Ask the ChainBridge agent to double-check your fingerprint.')),
   h('button',{class:'btn',type:'button',onclick:()=>go(PAID)},'Open paid task →')),
  actions({back:4}),
 ];
}

// ---------- paid task ----------
function stopPoll(){if(S.poll){clearInterval(S.poll);S.poll=null;}}
const LIVE=['submitted','awaiting_payment','processing','result_submitted','confirmed_on_chain','completed'];
function startPoll(){
 stopPoll();
 if(S.task?.mode!=='sokosumi'||!LIVE.includes(S.task.state))return;
 S.poll=setInterval(async()=>{try{S.task=await api(`/api/tasks/${S.task.id}`);if(S.view===PAID)render();else renderStatus();if(!LIVE.includes(S.task.state))stopPoll();}catch{}},4000);
}
async function requestTask(jobText){
 try{
  const r=await api('/api/tasks',{jobText});S.task=r.task;
  if(r.reused)toast('You already have this exact task. Showing it instead of creating a duplicate.');
  go(PAID);startPoll();
 }catch(e){toast(e.message,'error');}
}
function modeBanner(){
 const c=S.config;
 if(c.mode==='demo')return note('warn',h('strong',{},'Demo only. '),'No agent is connected, so no payment can be made. The task runs on this device, and the result is labelled as a demo.');
 if(!c.paid)return note('info',h('strong',{},'Agent connected, payments off. '),'The task goes to the ChainBridge agent on Sokosumi, without a payment.');
 return note('ok',h('strong',{},'Real test payment possible. '),'This sends a task to the ChainBridge agent and pays with test tokens on Cardano Preprod. Test tokens have no real value.');
}
function viewPaid(){
 const t=S.task,c=S.commitment;
 return [
  ...heading('Paid task — Cardano Preprod test'),
  modeBanner(),
  h('p',{},'The ChainBridge agent double-checks your fingerprint and returns a certificate. It only receives record fingerprints, never your records or column names.'),
  !t&&h('div',{class:'center-action'},
   c.entries.length>S.config.limits.maxJobLeaves?note('warn',`The paid task accepts up to ${S.config.limits.maxJobLeaves} records. Select fewer records in the Review step.`)
    :h('button',{class:'btn primary big',type:'button',onclick:()=>requestTask(anchorJobText(c))},'Get a price'),
   h('p',{class:'hint'},'Shows the price and exactly what would happen. Nothing is sent or paid until you approve.'),
   S.verify?.result?.match&&h('button',{class:'btn small ghost',type:'button',onclick:()=>requestTask(verifyJobText({root:S.verify.result.root,leaf:S.verify.result.computedLeaf,proof:S.verify.result.proof}))},'Or: ask the agent to check the record you just verified')),
  t&&taskView(t),
  actions({back:5}),
 ];
}
function plainWhat(t){
 const paid=t.quote.charged;
 const what=t.kind==='anchor'?'The agent recalculates your fingerprint from the record fingerprints, confirms it matches, and returns a certificate.':'The agent checks that one record\'s fingerprint belongs to your proof.';
 return paid?`${what} A fingerprint of the agent's answer is recorded on Cardano Preprod as part of the payment.`:what;
}
function taskView(t){
 const q=t.quote,gate=t.state==='awaiting_approval',cfg=S.config;
 const approveLabel=q.charged?`Approve and pay ${q.servicePrice} (test)`:t.mode==='demo'?'Approve and run the demo':'Approve and send to the agent';
 const approve=h('button',{class:'btn primary',type:'button',disabled:true,onclick:async e=>{
  e.target.disabled=true;e.target.textContent=t.mode==='demo'?'Running…':'Sending…';
  try{S.task=await api(`/api/tasks/${t.id}/approve`,{confirm:true,quoteHash:t.quoteHash});render();startPoll();refreshActivity();}
  catch(err){toast(err.message,'error');S.task=await api(`/api/tasks/${t.id}`);render();}
 }},approveLabel);
 const result=parseResult(t.result,t.mode==='demo');
 return h('div',{class:'task'},
  h('div',{class:'task-status'},h('span',{class:`pill state-${t.state}`},t.mode==='demo'&&t.state==='completed'?'Done (local demo)':t.stateLabel),
   h('p',{},t.mode==='demo'&&t.state==='completed'?'Done. This was a local demo: nothing was sent, paid or published.':TASK_TEXT[t.state])),
  t.uncertain&&note('warn','A step is in progress or was interrupted. ChainBridge never repeats payment steps automatically.'),
  facts([
   ['What happens',plainWhat(t)],
   ['What is sent',t.kind==='anchor'?`${t.summary.recordCount} record fingerprints and the settings. No record values.`:'One record fingerprint, its proof steps, and the overall fingerprint. No record values.'],
   ['Service price',h('span',{class:'price'},q.servicePrice)],
   q.charged&&['About the price',q.priceNote],
   ['Cardano network fee','Separate from the service price. ChainBridge does not calculate it.'],
   ['AI cost',q.aiCost],
   ['Who does the work',q.provider],
   ['Network','Cardano Preprod (test network; test tokens have no real value)'],
   !gate&&['Payment',PAY_TEXT[t.paymentStatus]??'Unknown'],
   !gate&&['Published to Cardano',publishedText()[0]],
  ]),
  gate&&h('div',{class:'approve'},
   h('label',{class:'check'},h('input',{type:'checkbox',onchange:e=>{approve.disabled=!e.target.checked;}}),
    q.charged?`I approve this task and the service price of ${q.servicePrice} in test tokens on Cardano Preprod. Network fees are separate.`:'I approve running this task. No payment will be made.'),
   h('div',{class:'row'},approve,h('button',{class:'btn ghost',type:'button',onclick:async()=>{S.task=await api(`/api/tasks/${t.id}/cancel`,{});render();refreshActivity();}},'Decline'))),
  t.state==='needs_inspection'&&note('error','We can\'t tell whether this went through. Check the task in Sokosumi before trying again, so you aren\'t charged twice.'),
  t.mode==='demo'&&t.state==='completed'&&note('info','Local demo: no payment, no transaction, nothing published. Connect a Sokosumi agent to run it for real.'),
  result&&h('div',{class:`verdict ${result.ok?'ok':'bad'}`},h('strong',{},result.title),h('p',{},result.text)),
  t.result&&more('answer','Show the agent\'s full answer',h('pre',{class:'code'},t.result)),
  tech(facts([
   ['Task ID',t.id],t.sokosumiTaskId&&['Sokosumi task ID',t.sokosumiTaskId],
   t.evidence?.blockchainIdentifier&&['Masumi payment ID',t.evidence.blockchainIdentifier],
   t.evidence?.onChainState&&['Payment contract state',t.evidence.onChainState],
   t.evidence?.lastTxHash&&['Latest transaction',`${t.evidence.lastTxHash} (${t.evidence.lastTxStatus??'status unknown'})`],
   t.evidence?.lastTxHash&&['Explorer',`https://preprod.cardanoscan.io/transaction/${t.evidence.lastTxHash}`],
   t.evidence?.settlementTxHash&&['Seller receipt transaction',t.evidence.settlementTxHash],
   t.evidence?.sellerNetAtomicUnits&&['Seller net receipt (smallest units)',t.evidence.sellerNetAtomicUnits],
   ['Operation (as quoted)',q.operation],['Expected result (as quoted)',q.expectedResult],['Quote check',short(t.quoteHash)],
   t.detail&&['Worker detail',t.detail],t.error&&['Error',t.error],
  ]),h('h4',{},'Exact task input sent to the agent'),h('pre',{class:'code'},JSON.stringify(JSON.parse(t.jobText),null,2))),
  ['failed','cancelled','needs_inspection','completed','settled'].includes(t.state)&&h('button',{class:'btn small',type:'button',onclick:()=>{S.task=null;render();}},'Start a new task'));
}
function parseResult(text,demo){
 if(!text)return null;
 const who=demo?'The local demo check':'The agent';
 try{
  const r=JSON.parse(text.slice(text.indexOf('\n')+1));
  if(r.status==='root-verified')return {ok:true,title:`✓ ${who} confirmed your fingerprint`,text:`It recalculated the fingerprint from ${r.leafCount} record fingerprints and got the same result.`};
  if(r.status==='root-mismatch')return {ok:false,title:'✗ The fingerprint did not match',text:'Don\'t use this fingerprint. Create the proof again.'};
  if(r.status==='valid')return {ok:true,title:`✓ ${who} confirmed this record belongs to your proof`,text:'The record fingerprint and proof lead to your fingerprint.'};
  if(r.status==='invalid')return {ok:false,title:`✗ ${who} could not confirm this record`,text:'The record fingerprint and proof do not lead to your fingerprint.'};
 }catch{}
 return null;
}

// ---------- activity log ----------
const EVENT_TEXT={quote_created:'Price shown',approved:'You approved',cancelled:'You declined',submitting:'Sending to agent',submitted:'Sent to agent',
 completed_demo:'Demo finished (local)',status_observed:'Status update',needs_inspection:'Needs checking',failed:'Failed'};
async function refreshActivity(){
 let entries=[];try{entries=await api('/api/audit');}catch{}
 mount($('activity'),h('details',{},h('summary',{},`Activity log (${entries.length})`,h('span',{class:'muted small'},' · task and payment events only, never your data')),
  entries.length?h('div',{class:'table-wrap'},h('table',{},h('thead',{},h('tr',{},['Time','What happened','Task','Status','Payment'].map(x=>h('th',{scope:'col'},x)))),
   h('tbody',{},entries.slice(0,30).map(e=>h('tr',{},h('td',{},e.at.replace('T',' ').slice(0,19)),h('td',{},EVENT_TEXT[e.event]??e.event),h('td',{},(e.taskId??'').slice(0,8)),
    h('td',{},S.config.taskStates[e.state]??e.state??''),h('td',{},PAY_TEXT[e.paymentStatus]??e.paymentStatus??''))))))
  :h('p',{class:'muted'},'No task activity yet.')));
}

// ---------- start ----------
(async()=>{
 try{S.config=await api('/api/config');}catch(e){mount($('view'),note('error',`Can't reach the ChainBridge app server: ${e.message}`));return;}
 render();refreshActivity();
})();
