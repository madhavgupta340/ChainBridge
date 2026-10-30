// CB-CANON-1: deterministic record canonicalization (JCS-style, RFC 8785 subset).
//  - Only the selected fields are kept; a selected field missing from a record becomes null.
//  - Object keys and strings are Unicode NFC-normalized; keys sorted by UTF-16 code units.
//  - Strings are serialized with JSON.stringify escaping; values are NOT trimmed or type-coerced
//    (CSV values stay strings exactly as in the file, JSON values keep their JSON type).
//  - Numbers use ECMAScript shortest round-trip form; -0 becomes 0; NaN/Infinity are rejected.
//  - No whitespace between tokens.
export const CANON_ID='CB-CANON-1';

export function canonicalize(value){
 if(value===null||value===undefined)return 'null';
 if(typeof value==='boolean')return value?'true':'false';
 if(typeof value==='number'){
  if(!Number.isFinite(value))throw new Error('Cannot canonicalize a non-finite number');
  return Object.is(value,-0)?'0':String(value);
 }
 if(typeof value==='string')return JSON.stringify(value.normalize('NFC'));
 if(Array.isArray(value))return `[${value.map(canonicalize).join(',')}]`;
 if(typeof value==='object'){
  const entries=Object.entries(value).map(([k,v])=>[k.normalize('NFC'),v]);
  const keys=new Set(entries.map(([k])=>k));
  if(keys.size!==entries.length)throw new Error('Keys collide after Unicode normalization');
  entries.sort(([a],[b])=>a<b?-1:a>b?1:0);
  return `{${entries.map(([k,v])=>`${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
 }
 throw new Error(`Cannot canonicalize ${typeof value}`);
}

export function projectRecord(values,fields){
 return Object.fromEntries(fields.map(f=>[f,Object.hasOwn(values,f)?values[f]:null]));
}

export const canonicalRecord=(values,fields)=>canonicalize(projectRecord(values,fields));
