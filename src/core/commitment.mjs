// Builds the commitment from a validated plan. Raw values never appear in the public payload or the proof bundle.
import {CANON_ID,canonicalRecord,canonicalize} from './canonical.mjs';
import {HASH_ID,LEAF_DOMAIN,buildTree,leafHash,merkleProof,randomSalt,verifyProof} from './merkle.mjs';

export const PROTOCOL='chainbridge/1';

// `recipe` (optional) records the approved tidy-up steps, so the records can be rebuilt from the original file.
export async function buildCommitment({records,plan,salts={},recipe=null}){
 if(!records.length)throw new Error('Select at least one record. An empty dataset cannot be committed.');
 const seen=new Map();let dropped=0,duplicates=0;const entries=[];
 for(const r of records){
  const canonical=canonicalRecord(r.values,plan.fields);
  if(seen.has(canonical)){duplicates++;if(plan.duplicates==='drop'){dropped++;continue;}}
  else seen.set(canonical,r.sourceRow);
  const salt=plan.salt==='per-record'?(salts[r.sourceRow]??randomSalt()):'';
  entries.push({sourceRow:r.sourceRow,salt,leafHash:await leafHash(canonical,salt)});
 }
 if(plan.ordering==='leaf-hash')entries.sort((a,b)=>a.leafHash<b.leafHash?-1:a.leafHash>b.leafHash?1:a.sourceRow-b.sourceRow);
 const {root,levels}=await buildTree(entries.map(e=>e.leafHash));
 const payload={protocol:PROTOCOL,hash:HASH_ID,canonicalization:CANON_ID,strategy:plan.strategy,ordering:plan.ordering,
  salted:plan.salt==='per-record',leafCount:entries.length,root,
  ...(plan.strategy==='per-record-hashes'?{leaves:entries.map(e=>e.leafHash)}:{})};
 const payloadText=canonicalize(payload);
 // Private proof bundle: everything needed to verify later except the records themselves.
 const bundle={protocol:PROTOCOL,hash:HASH_ID,canonicalization:CANON_ID,leafDomain:LEAF_DOMAIN,fields:plan.fields.slice(),
  salt:plan.salt,ordering:plan.ordering,duplicates:plan.duplicates,...(recipe?{recipe}:{}),root,leaves:entries};
 return {payload,payloadText,payloadBytes:new TextEncoder().encode(payloadText).length,root,levels,entries,bundle,
  stats:{selected:records.length,committed:entries.length,duplicates,dropped}};
}

// Verify one record (possibly edited) against a proof bundle produced above.
export async function verifyRecord({values,sourceRow,bundle}){
 const index=bundle.leaves.findIndex(e=>e.sourceRow===sourceRow);
 if(index<0)return {match:false,reason:'This record is not part of the commitment (it was not selected, or was dropped as a duplicate).'};
 const entry=bundle.leaves[index];
 const computed=await leafHash(canonicalRecord(values,bundle.fields),entry.salt);
 const {levels}=await buildTree(bundle.leaves.map(e=>e.leafHash));
 const proof=merkleProof(levels,index);
 const inTree=await verifyProof(entry.leafHash,proof,bundle.root);
 const match=inTree&&computed===entry.leafHash&&await verifyProof(computed,proof,bundle.root);
 return {match,computedLeaf:computed,expectedLeaf:entry.leafHash,proof,root:bundle.root,
  reason:match?'The record matches the committed root.':computed!==entry.leafHash?'The record differs from what was committed (at least one included field changed).':'The proof does not lead to the root.'};
}
