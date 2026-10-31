// The paid ChainBridge service jobs. Used by the Sokosumi worker, the MIP-003 agent API and the local demo mode.
//  anchor:  recompute the Merkle root from leaf hashes (deterministic)
//  verify:  check one inclusion proof (deterministic)
//  certify: the full paid service. AI analysis of a masked sample, root check, and publication of the
//           fingerprint on Cardano. AI output is advisory only: the root check and the decision to publish never
//           depend on it. Input is a masked sample plus leaf hashes, never full records.
// Network-dependent steps (AI, publishing) are injected by the caller, so this module stays usable in the browser.
import {LIMITS} from './limits.mjs';
import {CANON_ID} from './canonical.mjs';
import {HASH_ID,isHash,merkleRoot,verifyProof} from './merkle.mjs';
import {PROTOCOL} from './commitment.mjs';
import {STRATEGIES,ORDERINGS} from './plan.mjs';

export class JobInputError extends Error{constructor(m){super(m);this.name='JobInputError';}}
const fail=m=>{throw new JobInputError(m);};
const exactKeys=(o,keys,what)=>{for(const k of Object.keys(o))if(!keys.includes(k))fail(`Unexpected key "${k}" in ${what}`);};

export function parseJobInput(text){
 if(typeof text!=='string'||!text.trim())fail('Task input is empty');
 if(text.length>LIMITS.maxJobChars)fail(`Task input exceeds ${LIMITS.maxJobChars} characters`);
 let job;try{job=JSON.parse(text);}catch{fail('Task input must be the JSON produced by the ChainBridge app');}
 if(!job||typeof job!=='object'||Array.isArray(job))fail('Task input must be a JSON object');
 if(job.service!=='chainbridge'||job.version!==1)fail('Task input is not a ChainBridge v1 job');
 if(job.task==='anchor'){
  exactKeys(job,['service','version','task','payload','leaves'],'anchor job');
  const p=job.payload;if(!p||typeof p!=='object')fail('Missing payload');
  exactKeys(p,['protocol','hash','canonicalization','strategy','ordering','salted','leafCount','root','leaves'],'payload');
  if(p.protocol!==PROTOCOL||p.hash!==HASH_ID||p.canonicalization!==CANON_ID)fail('Unsupported protocol, hash or canonicalization');
  if(!STRATEGIES.includes(p.strategy)||!ORDERINGS.includes(p.ordering)||typeof p.salted!=='boolean')fail('Invalid strategy, ordering or salting flag');
  if(!Array.isArray(job.leaves)||!job.leaves.length)fail('At least one leaf hash is required');
  if(job.leaves.length>LIMITS.maxJobLeaves)fail(`At most ${LIMITS.maxJobLeaves} leaf hashes per task`);
  if(!job.leaves.every(isHash))fail('Every leaf must be a 64-character lowercase hex SHA-256 hash');
  if(!isHash(p.root))fail('Payload root must be a hash');
  if(p.leafCount!==job.leaves.length)fail('Payload leafCount does not match the number of leaves');
  if(p.strategy==='per-record-hashes'&&(!Array.isArray(p.leaves)||p.leaves.join()!==job.leaves.join()))fail('Per-record payload must list the same leaves');
  if(p.strategy==='merkle-root'&&p.leaves!==undefined)fail('Merkle-root payload must not list leaves');
  return job;
 }
 if(job.task==='certify'){
  exactKeys(job,['service','version','task','payload','leaves','sample'],'certify job');
  parseJobInput(JSON.stringify({service:'chainbridge',version:1,task:'anchor',payload:job.payload,leaves:job.leaves}));
  const sm=job.sample;
  if(!sm||typeof sm!=='object'||Array.isArray(sm))fail('Missing data sample');
  exactKeys(sm,['rowCount','shareMode','columns','sampleRows'],'sample');
  if(!['masked','names'].includes(sm.shareMode))fail('The paid agent only accepts a masked or names-only sample');
  if(!Array.isArray(sm.columns)||!sm.columns.length||sm.columns.length>100)fail('Sample must describe 1 to 100 columns');
  if(sm.sampleRows!==undefined&&(!Array.isArray(sm.sampleRows)||sm.sampleRows.length>10))fail('Sample may contain at most 10 rows');
  if(sm.shareMode==='names'&&sm.sampleRows!==undefined)fail('A names-only sample must not contain rows');
  return job;
 }
 if(job.task==='verify'){
  exactKeys(job,['service','version','task','root','leaf','proof'],'verify job');
  if(!isHash(job.root)||!isHash(job.leaf))fail('Root and leaf must be hashes');
  if(!job.proof||!Array.isArray(job.proof.siblings)||job.proof.siblings.length>64)fail('Proof must contain a siblings array');
  return job;
 }
 fail('Task must be "anchor", "verify" or "certify"');
}

const DISCLAIMER='A commitment shows whether data matches what was anchored. It does not prove the source data is accurate.';

// A stable reference for a job, used to make publication idempotent and shown in the on-chain message.
export async function jobReference(text){
 const bytes=new TextEncoder().encode(text);
 const hash=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes));
 return 'cb-'+Array.from(hash.slice(0,12),b=>b.toString(16).padStart(2,'0')).join('');
}

// Returns the result text. The Masumi result hash covers exactly this text.
// deps.analyze(sample) -> {summary, issues, steps, provider, model}   (optional AI analysis)
// deps.publish({root, leafCount, salted, jobRef}) -> publication record (optional; omitted in demo mode)
export async function runJob(text,deps={}){
 const job=parseJobInput(text);
 let result;
 if(job.task==='certify'){
  const root=await merkleRoot(job.leaves);
  const match=root===job.payload.root;
  let analysis;
  if(deps.analyze){
   try{const a=await deps.analyze(job.sample);analysis={by:a.provider?`${a.provider} AI (${a.model})`:'AI',summary:a.summary??'',issues:a.issues??[],suggestedSteps:(a.steps??[]).map(st=>({...st,description:deps.describeStep?deps.describeStep(st):st.op}))};}
   catch(e){analysis={by:'none',error:`AI analysis unavailable: ${String(e.message).slice(0,160)}`};}
  }else analysis={by:'none',error:'No AI provider configured for this agent.'};
  let publication;
  if(!match)publication={status:'skipped',reason:'The fingerprint did not match the record fingerprints, so nothing was published.'};
  else if(!deps.publish)publication={status:'skipped',reason:'Publishing is not available in this mode (local demo). Nothing was published.'};
  else publication=await deps.publish({root,leafCount:job.leaves.length,salted:job.payload.salted,jobRef:await jobReference(text)});
  result={service:'ChainBridge',version:1,task:'certify',status:match?(publication.status==='skipped'?'certified-not-published':'certified-and-published'):'root-mismatch',
   commitment:{leafCount:job.leaves.length,recomputedRoot:root,suppliedRoot:job.payload.root,match,publicPayload:match?job.payload:null},
   analysis,publication,
   notes:['ChainBridge received a masked sample and record fingerprints only, never the full records.',
    'The AI analysis is advice. The fingerprint check and publication do not depend on it.',DISCLAIMER]};
  const headline=result.status==='certified-and-published'?`ChainBridge certificate: fingerprint verified and published on Cardano Preprod (${publication.status}).`:
   result.status==='certified-not-published'?'ChainBridge certificate: fingerprint verified (not published).':'ChainBridge check: FINGERPRINT MISMATCH, nothing published.';
  return `${headline}\n${JSON.stringify(result,null,2)}`;
 }
 if(job.task==='anchor'){
  const root=await merkleRoot(job.leaves);
  const match=root===job.payload.root;
  result={service:'ChainBridge',version:1,task:'anchor',status:match?'root-verified':'root-mismatch',
   leafCount:job.leaves.length,recomputedRoot:root,suppliedRoot:job.payload.root,
   publicPayload:match?job.payload:null,
   notes:[match?'ChainBridge independently recomputed the Merkle root from the supplied leaf hashes and it matches. The public payload above is ready to anchor.':'The supplied root does not match the leaf hashes. Do not anchor this payload; recompute it in the app.',
    'ChainBridge received leaf hashes only, never the underlying records.',DISCLAIMER]};
 }else{
  const valid=await verifyProof(job.leaf,job.proof,job.root);
  result={service:'ChainBridge',version:1,task:'verify',status:valid?'valid':'invalid',root:job.root,leaf:job.leaf,proofLength:job.proof.siblings.length,
   notes:[valid?'The leaf hash and proof lead to the root: the record is included in the commitment.':'The leaf hash and proof do not lead to the root.',DISCLAIMER]};
 }
 const headline=result.status==='root-verified'?'ChainBridge anchoring certificate: root verified.':result.status==='root-mismatch'?'ChainBridge anchoring check: ROOT MISMATCH.':`ChainBridge verification: ${result.status.toUpperCase()}.`;
 return `${headline}\n${JSON.stringify(result,null,2)}`;
}

// The exact job text the app sends to the agent. Built here so the browser and tests share one definition.
export function anchorJobText(commitment){
 return JSON.stringify({service:'chainbridge',version:1,task:'anchor',payload:commitment.payload,leaves:commitment.entries.map(e=>e.leafHash)});
}
// The full paid service: masked sample + leaf hashes. Drops sample rows until the job fits the task size limit.
export function certifyJobText(commitment,sample){
 const base={service:'chainbridge',version:1,task:'certify',payload:commitment.payload,leaves:commitment.entries.map(e=>e.leafHash)};
 const s={...sample,sampleRows:sample.sampleRows?.slice()};
 const fits=()=>JSON.stringify({...base,sample:s}).length<=LIMITS.maxJobChars;
 while(!fits()&&s.sampleRows?.length)s.sampleRows.pop();
 if(s.sampleRows&&!s.sampleRows.length)delete s.sampleRows;
 if(!fits())return null;
 return JSON.stringify({...base,sample:s});
}
export function verifyJobText({root,leaf,proof}){
 return JSON.stringify({service:'chainbridge',version:1,task:'verify',root,leaf,proof:{leafIndex:proof.leafIndex,leafCount:proof.leafCount,siblings:proof.siblings}});
}
