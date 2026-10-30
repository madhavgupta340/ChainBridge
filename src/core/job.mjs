// The paid ChainBridge service job. Deterministic and independent of any language model.
// Input is leaf hashes or a proof, never raw records. Used by the Sokosumi worker, the MIP-003 agent API,
// and the local demo mode, so all three produce byte-identical results.
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
 if(job.task==='verify'){
  exactKeys(job,['service','version','task','root','leaf','proof'],'verify job');
  if(!isHash(job.root)||!isHash(job.leaf))fail('Root and leaf must be hashes');
  if(!job.proof||!Array.isArray(job.proof.siblings)||job.proof.siblings.length>64)fail('Proof must contain a siblings array');
  return job;
 }
 fail('Task must be "anchor" or "verify"');
}

const DISCLAIMER='A commitment shows whether data matches what was anchored. It does not prove the source data is accurate.';

// Returns the result text. Same input, same output: the Masumi result hash covers exactly this text.
export async function runJob(text){
 const job=parseJobInput(text);
 let result;
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
export function verifyJobText({root,leaf,proof}){
 return JSON.stringify({service:'chainbridge',version:1,task:'verify',root,leaf,proof:{leafIndex:proof.leafIndex,leafCount:proof.leafCount,siblings:proof.siblings}});
}
