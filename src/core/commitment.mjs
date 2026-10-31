// Builds the commitment from a validated plan. Raw values never appear in the public payload or the proof bundle.
import {CANON_ID,canonicalRecord,canonicalize} from './canonical.mjs';
import {HASH_ID,LEAF_DOMAIN,FILE_DOMAIN,buildTree,leafHash,fileLeafHash,isHash,merkleProof,randomSalt,verifyProof} from './merkle.mjs';

export const PROTOCOL='chainbridge/1';

// `recipe` (optional) records the approved tidy-up steps, so the records can be rebuilt from the original file.
// `files` (optional): the source files [{name, sha256}]. Each gets a salted file leaf after the record leaves, so a
// single file can later be shown to match the root without revealing records (see src/core/certificate.mjs).
export async function buildCommitment({records,plan,salts={},recipe=null,files=[]}){
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
 const fileEntries=[];
 for(const f of files){
  if(!isHash(f?.sha256))throw new Error('Each source file needs its SHA-256');
  const salt=f.salt??randomSalt();
  fileEntries.push({name:String(f.name??'file').slice(0,120),sha256:f.sha256,salt,leafHash:await fileLeafHash(f.sha256,salt),leafIndex:entries.length+fileEntries.length});
 }
 const allLeaves=[...entries,...fileEntries].map(e=>e.leafHash);
 const {root,levels}=await buildTree(allLeaves);
 const payload={protocol:PROTOCOL,hash:HASH_ID,canonicalization:CANON_ID,strategy:plan.strategy,ordering:plan.ordering,
  salted:plan.salt==='per-record',leafCount:allLeaves.length,root,
  ...(plan.strategy==='per-record-hashes'?{leaves:allLeaves}:{})};
 const payloadText=canonicalize(payload);
 // Private proof bundle: everything needed to verify later except the records themselves.
 const bundle={protocol:PROTOCOL,hash:HASH_ID,canonicalization:CANON_ID,leafDomain:LEAF_DOMAIN,fields:plan.fields.slice(),
  salt:plan.salt,ordering:plan.ordering,duplicates:plan.duplicates,...(recipe?{recipe}:{}),root,leaves:entries,
  ...(fileEntries.length?{fileDomain:FILE_DOMAIN,files:fileEntries}:{})};
 return {payload,payloadText,payloadBytes:new TextEncoder().encode(payloadText).length,root,levels,entries,files:fileEntries,leaves:allLeaves,bundle,
  stats:{selected:records.length,committed:entries.length,files:fileEntries.length,duplicates,dropped}};
}

// Verify one record (possibly edited) against a proof bundle produced above.
export async function verifyRecord({values,sourceRow,bundle}){
 const index=bundle.leaves.findIndex(e=>e.sourceRow===sourceRow);
 if(index<0)return {match:false,reason:'This record is not part of the commitment (it was not selected, or was dropped as a duplicate).'};
 const entry=bundle.leaves[index];
 const computed=await leafHash(canonicalRecord(values,bundle.fields),entry.salt);
 const {levels}=await buildTree([...bundle.leaves,...(bundle.files??[])].map(e=>e.leafHash));
 const proof=merkleProof(levels,index);
 const inTree=await verifyProof(entry.leafHash,proof,bundle.root);
 const match=inTree&&computed===entry.leafHash&&await verifyProof(computed,proof,bundle.root);
 return {match,computedLeaf:computed,expectedLeaf:entry.leafHash,proof,root:bundle.root,
  reason:match?'The record matches the committed root.':computed!==entry.leafHash?'The record differs from what was committed (at least one included field changed).':'The proof does not lead to the root.'};
}
