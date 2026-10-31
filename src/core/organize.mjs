// What the AI is allowed to see, and a local (no-AI) fallback that suggests a tidy-up recipe with simple rules.
import {analyzeSchema} from './schema.mjs';

export const SHARE_MODES=['masked','names','full'];
export const SAMPLE_ROWS=10;
const MAX_VALUE=200;
const PLACEHOLDER={personal:'[personal]',confidential:'[confidential]'};

const isBlank=v=>v===null||v===undefined||(typeof v==='string'&&!v.trim());
const text=v=>v===null||v===undefined?'':typeof v==='string'?v:JSON.stringify(v);
// "02.09.26" -> "99.99.99", "Anna Keller" -> "Aaaa Aaaaaa": the format without the content.
export const shape=v=>text(v).slice(0,40).replace(/\p{Lu}/gu,'A').replace(/\p{Ll}/gu,'a').replace(/\d/g,'9');

// Build the exact payload the AI receives. `mode`:
//  masked: column names, labels, value formats, and sample rows with personal/confidential values replaced
//  names:  column names, labels and counts only, no values or formats
//  full:   sample rows unmasked (the UI requires an extra explicit consent for this)
export function buildAiSample({records,fields},schema,mode='masked'){
 if(!SHARE_MODES.includes(mode))throw new Error('Unknown sharing mode');
 const byName=new Map(schema.map(f=>[f.name,f]));
 const columns=fields.map(name=>{
  const f=byName.get(name);const vals=records.map(r=>r.values[name]).filter(v=>!isBlank(v));
  const col={name,kind:f?.type??'text',privacy:f?.sensitivity??'none',distinctValues:new Set(vals.map(text)).size,emptyValues:records.length-vals.length};
  // Formats show the layout of values (e.g. 99.99.99). Hidden for private columns in masked mode.
 if(mode==='full'||(mode==='masked'&&col.privacy==='none'))col.formats=[...new Set(vals.map(shape))].slice(0,5);
  return col;
 });
 const out={rowCount:records.length,shareMode:mode,columns};
 if(mode!=='names'){
  out.sampleRows=records.slice(0,SAMPLE_ROWS).map(r=>Object.fromEntries(fields.map(name=>{
   const level=byName.get(name)?.sensitivity??'none';
   const v=r.values[name];
   return [name,mode==='masked'&&level!=='none'&&!isBlank(v)?PLACEHOLDER[level]:text(v).slice(0,MAX_VALUE)];
  })));
 }
 return out;
}

const snake=s=>s.trim().replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'_').replace(/^_+|_+$/g,'').slice(0,64);
const BOOLISH=/^(true|false|yes|no|y|n|1|0|ja|nein)$/i;

function guessDateOrder(values){
 // Look for an unambiguous value: a first part > 12 means day first, a second part > 12 means month first.
 let dmy=false,mdy=false,ymd=false,dated=0;
 for(const v of values){
  const m=String(v).trim().match(/^(\d{1,4})[./\- ](\d{1,2})[./\- ](\d{1,4})$/);if(!m)continue;dated++;
  if(m[1].length===4){ymd=true;continue;}
  if(+m[1]>12)dmy=true;if(+m[2]>12)mdy=true;
 }
 if(dated<values.length*0.8||!dated)return null;
 if(ymd&&!dmy&&!mdy)return 'YMD';
 if(dmy&&!mdy)return 'DMY';if(mdy&&!dmy)return 'MDY';
 return values.some(v=>/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(String(v).trim()))?'DMY':null; // dotted dates are day-first in Europe
}

// Local rules. Transparent and conservative: only suggests a step when the data clearly calls for it.
export function suggestRecipeLocally({records,fields}){
 const steps=[];const names=new Map();
 for(const f of fields){const s=snake(f);if(s&&s!==f&&!fields.includes(s)&&![...names.values()].includes(s)){names.set(f,s);steps.push({op:'rename',column:f,to:s,reason:'Column name has spaces or capitals; a simple name is easier to work with.'});}}
 const col=f=>names.get(f)??f;
 const strings=f=>records.map(r=>r.values[f]).filter(v=>typeof v==='string'&&v!=='');
 if(fields.some(f=>strings(f).some(v=>v!==v.trim())))steps.push({op:'trim',column:'*',reason:'Some values have spaces at the start or end, which would make identical values look different.'});
 if(records.some(r=>fields.every(f=>isBlank(r.values[f]))))steps.push({op:'remove_empty_rows',reason:'Some rows are completely empty.'});
 let dateCol=null;
 for(const f of fields){
  const vals=strings(f).map(v=>v.trim());if(!vals.length)continue;
  if(vals.every(v=>BOOLISH.test(v))&&new Set(vals.map(v=>v.toLowerCase())).size>2)steps.push({op:'normalize_boolean',column:col(f),reason:'The same yes/no answer is written in different ways.'});
  const order=guessDateOrder(vals);
  if(order&&vals.some(v=>!/^\d{4}-\d{2}-\d{2}$/.test(v))){steps.push({op:'normalize_date',column:col(f),order,reason:'Dates are written in mixed or local formats.'});}
  if(order&&!dateCol)dateCol=col(f);
  if(!order&&vals.every(v=>/^\d{4}-\d{2}-\d{2}/.test(v))&&!dateCol)dateCol=col(f);
  if(/e-?mail/i.test(f)&&vals.some(v=>v!==v.toLowerCase()))steps.push({op:'lowercase',column:col(f),reason:'Email addresses are not case-sensitive; lowercase avoids false differences.'});
 }
 const seen=new Set();let dup=false;
 for(const r of records){const k=JSON.stringify(fields.map(f=>typeof r.values[f]==='string'?r.values[f].trim():r.values[f]));if(seen.has(k)){dup=true;break;}seen.add(k);}
 if(dup)steps.push({op:'remove_duplicates',reason:'Some rows are exact copies of another row.'});
 const schema=analyzeSchema(records,fields);
 const group=schema.find(f=>f.type==='text'&&f.sensitivity==='none'&&f.distinct>1&&f.distinct<=Math.max(2,records.length/2));
 if(dateCol)steps.push({op:'sort',by:[...(group?[{column:col(group.name),direction:'asc'}]:[]),{column:dateCol,direction:'asc'}],reason:group?`Group rows by "${col(group.name)}", then put them in date order.`:'Put rows in date order.'});
 return {summary:steps.length?`Found ${steps.length} thing(s) to tidy up using simple rules.`:'The data already looks tidy. No changes suggested.',steps,source:'rules'};
}

// Number of concrete clean-up problems (used for pricing): every suggested step except cosmetic renames and sorting.
export const countTidyIssues=data=>suggestRecipeLocally(data).steps.filter(s=>s.op!=='rename'&&s.op!=='sort').length;
