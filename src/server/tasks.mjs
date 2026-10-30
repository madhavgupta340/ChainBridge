// Agent task service: quote -> explicit approval -> execution -> honest status.
// Nothing is submitted, charged or published until approve() receives the exact quote the user saw.
import {createHash,randomUUID} from 'node:crypto';
import {parseJobInput,runJob} from '../core/job.mjs';
import {canonicalize} from '../core/canonical.mjs';
import {NETWORK,quoteFor} from './config.mjs';
import {ACTIVE,TASK_STATES,fromWorkerJournal,transition} from './states.mjs';

const sha=t=>createHash('sha256').update(t,'utf8').digest('hex');
export class TaskError extends Error{constructor(status,message){super(message);this.status=status;}}

function describe(job){
 if(job.task==='anchor')return {operation:`Independently recompute the Merkle root of ${job.leaves.length} leaf hash(es), check it against your commitment, and return an anchoring certificate.`,
  expectedResult:'A certificate stating whether the supplied root matches, with the exact public payload. In paid mode the hash of this result is submitted to the Masumi escrow contract on Cardano Preprod.',
  sent:'Leaf hashes and the public payload only. No record values leave your browser.',
  summary:{recordCount:job.payload.leafCount,strategy:job.payload.strategy,salted:job.payload.salted,commitment:job.payload.root}};
 return {operation:'Check a Merkle inclusion proof for one record hash against a commitment root.',
  expectedResult:'A verification result: valid or invalid.',sent:'One leaf hash, its proof and the root. No record values.',
  summary:{recordCount:job.proof.leafCount??null,strategy:'merkle-root',commitment:job.root}};
}

export function createTaskService({store,audit,config,submit,readJournal,run=runJob}){
 const log=(task,event,extra={})=>audit.append({event,taskId:task.id,kind:task.kind,mode:task.mode,network:NETWORK.id,
  commitment:task.summary.commitment,strategy:task.summary.strategy,recordCount:task.summary.recordCount,salted:task.summary.salted,
  price:task.quote.servicePrice,paymentStatus:task.paymentStatus,state:task.state,...extra});

 function quote({jobText}){
  let job;try{job=parseJobInput(jobText);}catch(e){throw new TaskError(400,e.message);}
  const jobDigest=sha(jobText);
  // Idempotency: an identical job that is still active (or uncertain) is returned, never duplicated.
  const existing=store.list().find(t=>t.jobDigest===jobDigest&&ACTIVE.has(t.state)&&t.mode===config.mode);
  if(existing)return {task:existing,reused:true};
  const d=describe(job);
  const q={...quoteFor(config),operation:d.operation,expectedResult:d.expectedResult,dataSent:d.sent,network:NETWORK.label,
   networkFee:'Estimate unavailable. Cardano network fees for the escrow transactions are separate from the service price and are not calculated by ChainBridge.',
   aiCost:config.mode==='demo'?'None. No AI is used.':'None for the result: it is calculated without AI. Follow-up questions on the Sokosumi task use your AI provider, which bills you separately.',
   jobDigest};
  const task={id:randomUUID(),kind:job.task,mode:config.mode,state:'awaiting_approval',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
   jobText,jobDigest,summary:d.summary,quote:q,quoteHash:sha(canonicalize(q)),paymentStatus:config.mode==='demo'?'not_required':config.paid?'pending_request':'disabled',
   approval:'pending',history:[]};
  store.save(task);log(task,'quote_created',{approval:'pending'});
  return {task,reused:false};
 }

 async function approve(id,{quoteHash,confirm}={}){
  let task=store.get(id);if(!task)throw new TaskError(404,'Task not found');
  if(task.state!=='awaiting_approval')throw new TaskError(409,`Task is ${TASK_STATES[task.state]}; it cannot be approved again`);
  if(confirm!==true)throw new TaskError(400,'Explicit confirmation is required');
  if(quoteHash!==task.quoteHash)throw new TaskError(409,'The quote changed. Review the new quote before approving.');
  task=store.save(transition(task,'approved',{approval:'approved',approvedAt:new Date().toISOString()}));log(task,'approved',{approval:'approved'});
  return execute(task);
 }

 async function execute(task){
  if(task.mode==='demo'){
   task=store.save(transition(task,'processing'));
   try{
    const result=await run(task.jobText);
    task=store.save(transition(task,'completed',{result,resultHash:sha(result)}));log(task,'completed_demo');
   }catch(e){task=store.save(transition(task,'failed',{error:e.message}));log(task,'failed',{reason:'job error'});}
   return task;
  }
  // Persist intent before the external write: an interrupted submit becomes needs_inspection, never a silent retry.
  task=store.save(transition(task,'submitting'));log(task,'submitting');
  try{
   const out=await submit(task);
   if(!out.sokosumiTaskId){task=store.save(transition(task,'needs_inspection',{error:'Sokosumi did not return a task ID. A task may still have been created: run `sokosumi --preprod tasks list --json` before trying again.'}));log(task,'needs_inspection',{reason:'no task id'});return task;}
   task=store.save(transition(task,'submitted',{sokosumiTaskId:out.sokosumiTaskId}));log(task,'submitted',{sokosumiTaskId:out.sokosumiTaskId});
  }catch(e){
   const notSent=e.code==='ENOENT';
   task=store.save(transition(task,notSent?'failed':'needs_inspection',{error:notSent?'Sokosumi CLI not found; nothing was submitted.':`Submission outcome unknown (${e.message.slice(0,160)}). Check Sokosumi before retrying.`}));
   log(task,task.state,{reason:notSent?'cli missing':'submit error'});
  }
  return task;
 }

 function refresh(id){
  let task=store.get(id);if(!task)throw new TaskError(404,'Task not found');
  if(task.mode!=='sokosumi'||!task.sokosumiTaskId||['settled','failed','cancelled'].includes(task.state))return task;
  const obs=fromWorkerJournal(readJournal(task.sokosumiTaskId));
  const changed=obs.state!==task.state||obs.payment&&obs.payment!==task.paymentStatus||JSON.stringify(obs.evidence)!==JSON.stringify(task.evidence);
  if(!changed)return task;
  const next={...task,paymentStatus:obs.payment??task.paymentStatus,evidence:obs.evidence??task.evidence,uncertain:obs.uncertain,detail:obs.detail};
  if(obs.state!==task.state){
   try{task=transition(next,obs.state);}catch{task={...next,detail:`${obs.detail} (unexpected state change from ${task.state}; inspect the worker log)`};}
  }else task=next;
  store.save(task);
  log(task,'status_observed',{txHash:task.evidence?.settlementTxHash??task.evidence?.lastTxHash??undefined,blockchainIdentifier:task.evidence?.blockchainIdentifier?'present':undefined});
  return task;
 }

 function cancel(id){
  let task=store.get(id);if(!task)throw new TaskError(404,'Task not found');
  if(task.state!=='awaiting_approval')throw new TaskError(409,'Only tasks awaiting approval can be cancelled here');
  task=store.save(transition(task,'cancelled',{approval:'declined'}));log(task,'cancelled',{approval:'declined'});return task;
 }

 return {quote,approve,refresh,cancel,list:()=>store.list(),get:id=>store.get(id)};
}

// Tasks hold no secrets or record values (job text is hashes only), so the full task is shown to the user.
export const publicTask=t=>t&&({...t,stateLabel:TASK_STATES[t.state]});
