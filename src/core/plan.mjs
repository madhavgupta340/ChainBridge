// Anchoring plans: deterministic recommendation, normalization of untrusted (AI or user) input, and validation.
// The application, not a language model, decides whether a plan is acceptable.
import {LIMITS} from './limits.mjs';
import {canonicalRecord} from './canonical.mjs';

export const STRATEGIES=['merkle-root','per-record-hashes'];
export const ORDERINGS=['leaf-hash','source'];
export const SALTING=['per-record','none'];
export const DUPLICATES=['keep','drop'];
const NOTE_MAX=400,NOTES_MAX=10;

export function countDuplicates(records,fields){
 if(!fields.length)return 0;
 const seen=new Set();let dupes=0;
 for(const r of records){const c=canonicalRecord(r.values,fields);if(seen.has(c))dupes++;else seen.add(c);}
 return dupes;
}

// Local, explainable fallback planner. Always available; no network.
export function recommendPlan(schema,records){
 const fields=schema.filter(f=>f.sensitivity!=='confidential').map(f=>f.name);
 const excluded=schema.filter(f=>f.sensitivity==='confidential');
 const included=schema.filter(f=>fields.includes(f.name));
 const personal=included.filter(f=>f.sensitivity==='personal');
 const lowEntropy=included.filter(f=>f.lowEntropy);
 const salt=personal.length||lowEntropy.length||included.length<=2?'per-record':'none';
 const duplicates=countDuplicates(records,fields);
 const rationale=[
  `Include ${fields.length} of ${schema.length} columns from ${records.length} records.`,
  'Create one fingerprint for all selected records. Only that single fingerprint would ever be published, however many records you have, and any record can still be checked on its own later.',
  'Sort the record fingerprints before combining them, so re-sorting your file later gives the same result.',
 ];
 if(excluded.length)rationale.push(`Leave out ${excluded.map(f=>`"${f.name}"`).join(', ')}: they look confidential. Columns you leave out are not protected, so changes to them will not be detected.`);
 if(salt==='per-record')rationale.push(`Add an extra secret value to each record${personal.length?` because ${personal.map(f=>`"${f.name}"`).join(', ')} may contain personal data`:' because the selected values are short or repetitive'}. This makes it much harder for anyone to guess records from their fingerprints. Keep the proof file: it holds these secret values, which you need to check records later.`);
 else rationale.push('No extra secret values: the selected columns look hard to guess, and anyone who has a record can check it without the proof file.');
 const risks=[
  'A fingerprint is not anonymization: hashing does not anonymize data. Someone who can guess a record\'s values could confirm the guess, unless extra secret values are added.',
  'A proof shows records have not changed since it was created. It does not show they were correct or complete to begin with.',
 ];
 if(duplicates)risks.push(`${duplicates} record(s) are exact copies of another record in the selected columns. ${salt==='per-record'?'Each still gets its own fingerprint.':'Copies get identical fingerprints.'}`);
 if(personal.length)risks.push('Personal-data detection uses simple rules and can be wrong. Check the labels yourself. This is not legal or compliance advice.');
 return {version:1,source:'deterministic',fields,strategy:'merkle-root',ordering:'leaf-hash',salt,duplicates:'keep',rationale,risks,
  assumptions:['Your original records stay with you, on your device. ChainBridge does not store record values.','Column types and privacy labels are as you reviewed them.']};
}

const notes=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.trim()).slice(0,NOTES_MAX).map(x=>x.trim().slice(0,NOTE_MAX)):[];
const pick=(v,allowed,fallback)=>allowed.includes(v)?v:fallback;

// Treat any incoming plan (AI output, browser state) as untrusted data: keep only known keys with valid values.
export function normalizePlan(input,base){
 const p=input&&typeof input==='object'?input:{};
 return {version:1,source:p.source==='ai'?'ai':base.source,
  fields:Array.isArray(p.fields)?[...new Set(p.fields.filter(f=>typeof f==='string'))]:base.fields,
  strategy:pick(p.strategy,STRATEGIES,base.strategy),ordering:pick(p.ordering,ORDERINGS,base.ordering),
  salt:pick(p.salt,SALTING,base.salt),duplicates:pick(p.duplicates,DUPLICATES,base.duplicates),
  rationale:notes(p.rationale).length?notes(p.rationale):base.rationale,
  risks:notes(p.risks).length?notes(p.risks):base.risks,
  assumptions:notes(p.assumptions).length?notes(p.assumptions):base.assumptions};
}

export function validatePlan(plan,schema,recordCount){
 const errors=[],warnings=[];
 const byName=new Map(schema.map(f=>[f.name,f]));
 if(plan?.version!==1)errors.push('Unsupported plan version');
 if(!Array.isArray(plan?.fields)||!plan.fields.length)errors.push('Choose at least one column to include');
 for(const f of plan?.fields??[])if(!byName.has(f))errors.push(`Unknown column "${f}"`);
 if(new Set(plan?.fields).size!==(plan?.fields??[]).length)errors.push('A column is listed twice');
 if(!STRATEGIES.includes(plan?.strategy))errors.push('Unknown fingerprint strategy');
 if(!ORDERINGS.includes(plan?.ordering))errors.push('Unknown ordering');
 if(!SALTING.includes(plan?.salt))errors.push('Unknown secret-value setting');
 if(!DUPLICATES.includes(plan?.duplicates))errors.push('Unknown duplicate setting');
 if(!(recordCount>=1))errors.push('Choose at least one record. An empty dataset cannot be fingerprinted.');
 if(plan?.strategy==='per-record-hashes'&&recordCount>LIMITS.maxPublishedLeaves)errors.push(`One fingerprint per record is limited to ${LIMITS.maxPublishedLeaves} records. Use one fingerprint for all records instead.`);
 if(recordCount>LIMITS.maxJobLeaves)warnings.push(`More than ${LIMITS.maxJobLeaves} records: you can create the proof here, but the paid task accepts at most ${LIMITS.maxJobLeaves} records.`);
 const included=(plan?.fields??[]).map(f=>byName.get(f)).filter(Boolean);
 if(plan?.salt==='none'){
  const sensitive=included.filter(f=>f.sensitivity!=='none');
  if(sensitive.length)warnings.push(`Without extra secret values, someone who can guess the values in ${sensitive.map(f=>`"${f.name}"`).join(', ')} could confirm their guess from the fingerprints.`);
  const low=included.filter(f=>f.lowEntropy);
  if(low.length===included.length&&included.length)warnings.push('The selected columns have only a few different values, so records may be easy to guess without extra secret values.');
 }
 const confidential=included.filter(f=>f.sensitivity==='confidential');
 if(confidential.length)warnings.push(`Confidential column(s) ${confidential.map(f=>`"${f.name}"`).join(', ')} are included. Their values stay on your device, but consider whether they need to be covered.`);
 if(plan?.strategy==='per-record-hashes')warnings.push('One fingerprint per record publishes a fingerprint for every record. This reveals how many records you have and lets others check records one by one.');
 const excluded=schema.filter(f=>!(plan?.fields??[]).includes(f.name));
 if(excluded.length&&!errors.length)warnings.push(`Not protected by the proof: ${excluded.map(f=>`"${f.name}"`).join(', ')}.`);
 return {ok:!errors.length,errors,warnings};
}
