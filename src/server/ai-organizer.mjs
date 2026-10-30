// AI organizer: the model reads a (by default masked) sample and proposes a tidy-up recipe.
// Its reply is untrusted data: only whitelisted steps that pass checkRecipe survive, and the browser
// applies them with deterministic code after the user approves each one.
import {chat,extractJson} from './ai-config.mjs';
import {OPS,checkRecipe} from '../core/recipe.mjs';
import {SHARE_MODES} from '../core/organize.mjs';

const SYSTEM=`You help tidy up tabular business data before it is fingerprinted for blockchain verification.
You receive a description of one table: columns (name, kind, privacy label, value formats) and, unless withheld, a few sample rows.
Values shown as [personal] or [confidential] are hidden from you on purpose. Never try to guess them.
Suggest a short recipe of steps that makes the table consistent and well ordered. Use ONLY these step types:
- {"op":"rename","column":C,"to":NEW} clear snake_case column names
- {"op":"trim","column":C or "*"} remove surrounding spaces
- {"op":"lowercase","column":C} e.g. email addresses
- {"op":"normalize_boolean","column":C} yes/no/1/0/ja/nein -> true/false
- {"op":"normalize_date","column":C,"order":"DMY"|"MDY"|"YMD"} -> YYYY-MM-DD
- {"op":"normalize_number","column":C,"decimal":"."|","} e.g. "1.250,5" with decimal "," -> 1250.5
- {"op":"drop_column","column":C} only for columns that are clearly empty or useless
- {"op":"remove_empty_rows"}
- {"op":"remove_duplicates"} exact duplicate rows
- {"op":"sort","by":[{"column":C,"direction":"asc"|"desc"}]} up to 3 columns, e.g. group by a category then order by date
- {"op":"mark_sensitive","column":C,"level":"personal"|"confidential"|"none"} when a column's privacy label looks wrong
Steps run in order. Use column names exactly as given; after a rename, use the new name. If you rename columns, put all renames first. Add a short plain-English "reason" to every step.
Reply with ONE JSON object only: {"summary": one or two plain sentences about the data, "issues": [short plain strings], "steps": [...]}.
Prefer few, clearly useful steps. Do not invent columns. This is not legal advice.`;

const MAX_COLUMNS=100,MAX_ROWS=20,MAX_VALUE=200;
const str=(v,n=MAX_VALUE)=>String(v??'').slice(0,n);

// Rebuild the payload from an allow-list so nothing else the browser sends can reach the provider.
export function sanitizeSample(sample){
 const mode=SHARE_MODES.includes(sample?.shareMode)?sample.shareMode:'names';
 const columns=(Array.isArray(sample?.columns)?sample.columns:[]).slice(0,MAX_COLUMNS).map(c=>({
  name:str(c?.name,64),kind:str(c?.kind,20),privacy:['none','personal','confidential'].includes(c?.privacy)?c.privacy:'none',
  distinctValues:Number(c?.distinctValues)||0,emptyValues:Number(c?.emptyValues)||0,
  ...(mode!=='names'&&Array.isArray(c?.formats)?{formats:c.formats.slice(0,5).map(f=>str(f,40))}:{})}));
 const names=columns.map(c=>c.name);
 const out={rowCount:Number(sample?.rowCount)||0,shareMode:mode,columns};
 if(mode!=='names'&&Array.isArray(sample?.sampleRows))
  out.sampleRows=sample.sampleRows.slice(0,MAX_ROWS).map(r=>Object.fromEntries(names.map(n=>[n,str(r?.[n])])));
 return out;
}

export async function aiOrganize(sample,{settings,fetchImpl}={}){
 const sent=sanitizeSample(sample);
 const reply=extractJson(await chat(settings,[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify(sent)}],{fetchImpl}));
 const {steps,rejected}=checkRecipe(reply.steps,sent.columns.map(c=>c.name));
 const notes=v=>Array.isArray(v)?v.filter(x=>typeof x==='string').slice(0,10).map(x=>x.slice(0,300)):[];
 return {source:'ai',provider:settings.provider,model:settings.model,
  summary:typeof reply.summary==='string'?reply.summary.slice(0,600):'',issues:notes(reply.issues),
  steps,rejected:rejected.map(r=>({op:String(r.step?.op??'?').slice(0,30),error:r.error})),sent};
}
export const SUPPORTED_STEPS=Object.keys(OPS);
