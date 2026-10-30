// CSV and JSON ingestion. Pure data parsing: uploaded content is never evaluated or rendered as HTML.
import {LIMITS} from './limits.mjs';

const FORBIDDEN_KEYS=new Set(['__proto__','constructor','prototype']);

export class IngestError extends Error{constructor(message){super(message);this.name='IngestError';}}

export function detectFormat(name='',text=''){
 const lower=name.toLowerCase();
 if(lower.endsWith('.csv'))return 'csv';
 if(lower.endsWith('.json'))return 'json';
 const first=text.trimStart()[0];
 return first==='['||first==='{'?'json':'csv';
}

// RFC 4180 style parser: quoted fields, escaped quotes (""), CRLF/LF, embedded newlines.
export function parseCsvRows(text){
 const rows=[];let row=[];let field='';let i=0;let quoted=false;let line=1;let rowLine=1;
 const pushField=()=>{row.push(field);field='';};
 const pushRow=()=>{pushField();rows.push({line:rowLine,cells:row});row=[];rowLine=line;};
 while(i<text.length){
  const c=text[i];
  if(quoted){
   if(c==='"'){if(text[i+1]==='"'){field+='"';i+=2;continue;}quoted=false;i++;continue;}
   if(c==='\n')line++;
   field+=c;i++;continue;
  }
  if(c==='"'){
   if(field.length)throw new IngestError(`Line ${line}: quote character inside an unquoted value`);
   quoted=true;i++;continue;
  }
  if(c===','){pushField();i++;continue;}
  if(c==='\r'&&text[i+1]==='\n'){i++;continue;}
  if(c==='\n'||c==='\r'){line++;pushRow();i++;continue;}
  field+=c;i++;
 }
 if(quoted)throw new IngestError(`Line ${rowLine}: unterminated quoted value`);
 if(field.length||row.length)pushRow();
 return rows.filter(r=>!(r.cells.length===1&&r.cells[0]===''));
}

function checkFields(fields){
 if(!fields.length)throw new IngestError('No fields found');
 if(fields.length>LIMITS.maxColumns)throw new IngestError(`Too many fields: ${fields.length} (limit ${LIMITS.maxColumns})`);
 const seen=new Set();
 for(const f of fields){
  if(!f.trim())throw new IngestError('A header is empty. Give every column a name.');
  if(FORBIDDEN_KEYS.has(f))throw new IngestError(`Field name "${f}" is not allowed`);
  if(seen.has(f))throw new IngestError(`Duplicate field name "${f}"`);
  seen.add(f);
 }
}

function checkCell(value,where,issues){
 if(typeof value==='string'&&value.length>LIMITS.maxCellChars){issues.push({row:where,message:`Value longer than ${LIMITS.maxCellChars} characters`});return false;}
 return true;
}

export function parseCsv(text){
 const rows=parseCsvRows(text);
 if(!rows.length)throw new IngestError('The file is empty');
 const fields=rows[0].cells.map(h=>h.trim());
 checkFields(fields);
 const records=[];const issues=[];
 for(const {line,cells} of rows.slice(1)){
  if(cells.length!==fields.length){issues.push({row:line,message:`Expected ${fields.length} values, found ${cells.length}. Row skipped.`});continue;}
  if(!cells.every(c=>checkCell(c,line,issues)))continue;
  records.push({sourceRow:line,values:Object.fromEntries(fields.map((f,k)=>[f,cells[k]]))});
 }
 return {fields,records,issues};
}

function plainObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}

function checkJsonValue(value,depth=0){
 if(depth>8)throw new IngestError('JSON nesting deeper than 8 levels');
 if(typeof value==='number'&&!Number.isFinite(value))throw new IngestError('Non-finite number');
 if(Array.isArray(value))value.forEach(v=>checkJsonValue(v,depth+1));
 else if(plainObject(value))for(const [k,v] of Object.entries(value)){if(FORBIDDEN_KEYS.has(k))throw new IngestError(`Key "${k}" is not allowed`);checkJsonValue(v,depth+1);}
}

export function parseJson(text){
 let data;
 try{data=JSON.parse(text);}catch(e){throw new IngestError(`Invalid JSON: ${e.message}`);}
 const list=Array.isArray(data)?data:plainObject(data)&&Array.isArray(data.records)?data.records:null;
 if(!list)throw new IngestError('Expected a JSON array of objects, or an object with a "records" array');
 if(!list.length)throw new IngestError('The file contains no records');
 const fields=[];const seen=new Set();const records=[];const issues=[];
 list.forEach((item,index)=>{
  const row=index+1;
  if(!plainObject(item)){issues.push({row,message:'Not an object. Record skipped.'});return;}
  try{checkJsonValue(item);}catch(e){issues.push({row,message:`${e.message}. Record skipped.`});return;}
  if(!Object.values(item).every(v=>checkCell(typeof v==='string'?v:JSON.stringify(v),row,issues)))return;
  for(const k of Object.keys(item))if(!seen.has(k)){seen.add(k);fields.push(k);}
  records.push({sourceRow:row,values:item});
 });
 checkFields(fields);
 return {fields,records,issues};
}

// Entry point. `byteLength` is the size reported by the file picker (or text length for samples).
export function ingest({name='data',text,byteLength}){
 if(typeof text!=='string')throw new IngestError('No file content');
 const size=byteLength??new TextEncoder().encode(text).length;
 if(size>LIMITS.maxBytes)throw new IngestError(`File is ${(size/1048576).toFixed(2)} MB; the limit is ${LIMITS.maxBytes/1048576} MB`);
 const clean=text.charCodeAt(0)===0xfeff?text.slice(1):text;
 if(!clean.trim())throw new IngestError('The file is empty');
 const format=detectFormat(name,clean);
 const parsed=format==='csv'?parseCsv(clean):parseJson(clean);
 if(parsed.records.length>LIMITS.maxRows)throw new IngestError(`File has ${parsed.records.length} records; the limit is ${LIMITS.maxRows}`);
 if(!parsed.records.length)throw new IngestError('No valid records. See the row issues for details.');
 return {name,format,byteLength:size,...parsed};
}
