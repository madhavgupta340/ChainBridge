// Tidy-up recipes: a short list of whitelisted steps that reorganize a dataset.
// The AI (or the local rules) only *suggests* a recipe; this module validates it and applies it,
// deterministically, so "original file + approved recipe" always reproduces the same records and fingerprint.
// Every record keeps its sourceRow, so verification still points at the original line in the file.
import {canonicalize} from './canonical.mjs';

export const RECIPE_VERSION=1;
const MAX_STEPS=40;

// op -> {fields it needs, plain description}
export const OPS={
 rename:{need:['column','to'],describe:s=>`Rename column "${s.column}" to "${s.to}"`},
 trim:{need:['column'],describe:s=>s.column==='*'?'Remove extra spaces around values in every column':`Remove extra spaces around values in "${s.column}"`},
 lowercase:{need:['column'],describe:s=>`Make "${s.column}" lowercase`},
 normalize_boolean:{need:['column'],describe:s=>`Turn yes/no style values in "${s.column}" into true/false`},
 normalize_date:{need:['column','order'],describe:s=>`Write dates in "${s.column}" as YYYY-MM-DD (reading them as ${({DMY:'day-month-year',MDY:'month-day-year',YMD:'year-month-day'})[s.order]})`},
 normalize_number:{need:['column','decimal'],describe:s=>`Turn "${s.column}" into plain numbers (${s.decimal===','?'comma':'dot'} as decimal mark)`},
 drop_column:{need:['column'],describe:s=>`Remove column "${s.column}"`},
 remove_empty_rows:{need:[],describe:()=>'Remove rows that are completely empty'},
 remove_duplicates:{need:[],describe:()=>'Remove rows that are exact copies of an earlier row'},
 sort:{need:['by'],describe:s=>`Sort by ${s.by.map(b=>`"${b.column}"${b.direction==='desc'?' (newest/largest first)':''}`).join(', then ')}`},
 mark_sensitive:{need:['column','level'],describe:s=>`Label "${s.column}" as ${s.level}`},
};

const COLUMN_NAME=/^[\p{L}\p{N}_ .\-]{1,64}$/u;
const isBlank=v=>v===null||v===undefined||(typeof v==='string'&&!v.trim());
const loose=c=>String(c).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');

// Exact column name, or the single column that matches ignoring case, spaces and symbols
// ("insured" -> "Insured", "weight_kg" -> "Weight (kg)"). Ambiguous or missing names are refused.
export function resolveColumn(c,columns){
 if(typeof c==='string'&&columns.includes(c))return c;
 const matches=typeof c==='string'&&loose(c)?columns.filter(x=>loose(x)===loose(c)):[];
 if(matches.length===1)return matches[0];
 throw new Error(matches.length>1?`Column "${String(c).slice(0,64)}" is ambiguous`:`Unknown column "${String(c).slice(0,64)}"`);
}

// Validate one untrusted step against the columns that exist at that point. Returns a clean copy or throws.
export function checkStep(step,columns){
 if(!step||typeof step!=='object'||Array.isArray(step))throw new Error('Step must be an object');
 const def=OPS[step.op];if(!def)throw new Error(`Unknown step "${String(step.op).slice(0,30)}"`);
 const clean={op:step.op};
 for(const k of def.need)if(step[k]===undefined)throw new Error(`Step "${step.op}" needs "${k}"`);
 const needColumn=c=>resolveColumn(c,columns);
 if(def.need.includes('column'))clean.column=step.op==='trim'&&step.column==='*'?'*':needColumn(step.column);
 if(step.op==='rename'){
  if(typeof step.to!=='string'||!COLUMN_NAME.test(step.to)||['__proto__','constructor','prototype'].includes(step.to))throw new Error('New column name must be 1-64 letters, digits, spaces, _ . or -');
  if(step.to!==step.column&&columns.includes(step.to))throw new Error(`A column named "${step.to}" already exists`);
  clean.to=step.to;
 }
 if(step.op==='normalize_date'){if(!['DMY','MDY','YMD'].includes(step.order))throw new Error('Date order must be DMY, MDY or YMD');clean.order=step.order;}
 if(step.op==='normalize_number'){if(!['.',','].includes(step.decimal))throw new Error('Decimal mark must be "." or ","');clean.decimal=step.decimal;}
 if(step.op==='mark_sensitive'){if(!['none','personal','confidential'].includes(step.level))throw new Error('Level must be none, personal or confidential');clean.level=step.level;}
 if(step.op==='sort'){
  if(!Array.isArray(step.by)||!step.by.length||step.by.length>3)throw new Error('Sort needs 1 to 3 columns');
  clean.by=step.by.map(b=>({column:needColumn(b?.column),direction:b?.direction==='desc'?'desc':'asc'}));
 }
 if(typeof step.reason==='string'&&step.reason.trim())clean.reason=step.reason.trim().slice(0,300);
 return clean;
}

// Normalizers return the new value, or the original when it cannot be read safely (never guess).
const BOOL={true:true,yes:true,y:true,'1':true,ja:true,wahr:true,false:false,no:false,n:false,'0':false,nein:false,falsch:false};
function toBool(v){if(typeof v==='boolean')return v;const k=String(v).trim().toLowerCase();return k in BOOL?BOOL[k]:v;}
function toDate(v,order){
 if(typeof v!=='string')return v;
 const t=v.trim();
 let m=t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);let y,mo,d;
 if(m)[,y,mo,d]=m;
 else{
  m=t.match(/^(\d{1,4})[./\- ](\d{1,2})[./\- ](\d{1,4})$/);if(!m)return v;
  const [a,b,c]=[m[1],m[2],m[3]];
  if(order==='DMY')[d,mo,y]=[a,b,c];else if(order==='MDY')[mo,d,y]=[a,b,c];else [y,mo,d]=[a,b,c];
 }
 if(y.length===2)y=`20${y}`;
 if(y.length!==4)return v;
 const [Y,M,D]=[+y,+mo,+d];
 const dt=new Date(Date.UTC(Y,M-1,D));
 if(dt.getUTCFullYear()!==Y||dt.getUTCMonth()!==M-1||dt.getUTCDate()!==D)return v;
 return `${y}-${String(M).padStart(2,'0')}-${String(D).padStart(2,'0')}`;
}
function toNumber(v,decimal){
 if(typeof v==='number')return v;
 if(typeof v!=='string')return v;
 let t=v.trim().replace(/[\s'€$£%]/g,'');
 if(decimal===',')t=t.replace(/\./g,'').replace(',','.');else t=t.replace(/,/g,'');
 if(!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t))return v;
 const n=Number(t);return Number.isFinite(n)?n:v;
}
// Deterministic comparison: numbers numerically, everything else by UTF-16 code units (no locale rules).
function compare(a,b){
 if(isBlank(a)&&isBlank(b))return 0;if(isBlank(a))return 1;if(isBlank(b))return -1;
 if(typeof a==='number'&&typeof b==='number')return a-b;
 const x=typeof a==='string'?a:canonicalize(a),y=typeof b==='string'?b:canonicalize(b);
 return x<y?-1:x>y?1:0;
}
const mapColumn=(records,col,fn)=>{let changed=0;const out=records.map(r=>{const before=r.values[col];const after=fn(before);if(Object.is(before,after)||canonicalize(before??null)===canonicalize(after??null))return r;changed++;return {...r,values:{...r.values,[col]:after}};});return {records:out,changed};};

function applyOne(state,step){
 let {records,fields,labels}=state;const col=step.column;
 switch(step.op){
  case 'rename':{
   fields=fields.map(f=>f===col?step.to:f);
   records=records.map(r=>{const v={};for(const f of Object.keys(r.values))v[f===col?step.to:f]=r.values[f];return {...r,values:v};});
   if(col in labels){labels={...labels,[step.to]:labels[col]};delete labels[col];}
   return {records,fields,labels,changed:records.length};
  }
  case 'trim':{
   let changed=0;
   for(const c of col==='*'?fields:[col]){const r=mapColumn(records,c,v=>typeof v==='string'?v.trim():v);records=r.records;changed+=r.changed;}
   return {records,fields,labels,changed};
  }
  case 'lowercase':{const r=mapColumn(records,col,v=>typeof v==='string'?v.toLowerCase():v);return {...r,fields,labels};}
  case 'normalize_boolean':{const r=mapColumn(records,col,toBool);return {...r,fields,labels};}
  case 'normalize_date':{const r=mapColumn(records,col,v=>toDate(v,step.order));return {...r,fields,labels};}
  case 'normalize_number':{const r=mapColumn(records,col,v=>toNumber(v,step.decimal));return {...r,fields,labels};}
  case 'drop_column':{
   fields=fields.filter(f=>f!==col);
   records=records.map(r=>{const v={...r.values};delete v[col];return {...r,values:v};});
   return {records,fields,labels,changed:records.length};
  }
  case 'remove_empty_rows':{const out=records.filter(r=>!fields.every(f=>isBlank(r.values[f])));return {records:out,fields,labels,changed:records.length-out.length};}
  case 'remove_duplicates':{
   const seen=new Set();const out=[];
   for(const r of records){const k=canonicalize(Object.fromEntries(fields.map(f=>[f,r.values[f]??null])));if(seen.has(k))continue;seen.add(k);out.push(r);}
   return {records:out,fields,labels,changed:records.length-out.length};
  }
  case 'sort':{
   const out=records.map((r,i)=>[r,i]).sort(([a,i],[b,j])=>{
    for(const {column,direction} of step.by){const c=compare(a.values[column],b.values[column]);if(c)return direction==='desc'?-c:c;}
    return i-j; // stable
   }).map(([r])=>r);
   const moved=out.filter((r,i)=>r!==records[i]).length;
   return {records:out,fields,labels,changed:moved};
  }
  case 'mark_sensitive':return {records,fields,labels:{...labels,[col]:step.level},changed:0};
 }
 throw new Error(`Unsupported step ${step.op}`);
}

// Validate a whole untrusted recipe step by step (columns can change along the way).
// Returns {steps, rejected:[{step, error}]}. Invalid steps are dropped, never "fixed".
export function checkRecipe(steps,fields){
 const out=[],rejected=[];let cols=fields.slice();
 for(const raw of (Array.isArray(steps)?steps:[]).slice(0,MAX_STEPS)){
  try{const s=checkStep(raw,cols);out.push(s);
   if(s.op==='rename')cols=cols.map(c=>c===s.column?s.to:c);
   if(s.op==='drop_column')cols=cols.filter(c=>c!==s.column);
  }catch(e){rejected.push({step:raw,error:e.message});}
 }
 return {steps:out,rejected};
}

// Apply validated steps. Re-validates as it goes, so a recipe edited after checking still cannot misbehave.
export function applyRecipe({records,fields},steps){
 let state={records,fields:fields.slice(),labels:{}};const log=[];
 for(const raw of steps){
  const step=checkStep(raw,state.fields);
  const next=applyOne(state,step);
  log.push({op:step.op,description:OPS[step.op].describe(step),changed:next.changed});
  state={records:next.records,fields:next.fields,labels:next.labels};
 }
 return {records:state.records,fields:state.fields,labels:state.labels,log};
}

export const describeStep=s=>OPS[s.op]?.describe(s)??s.op;

// The recipe as stored in the proof file: enough to re-run it on the original file.
export function recipeRecord(steps){return {version:RECIPE_VERSION,steps:steps.map(({reason,...s})=>s)};}
