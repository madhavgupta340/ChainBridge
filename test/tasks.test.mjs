import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTaskService} from '../src/server/tasks.mjs';
import {createTaskStore} from '../src/server/store.mjs';
import {createAuditLog,auditEntry} from '../src/server/audit.mjs';
import {canTransition,transition,fromWorkerJournal} from '../src/server/states.mjs';
import {createTaskArgs,taskIdFrom} from '../src/server/sokosumi.mjs';
import {buildCommitment} from '../src/core/commitment.mjs';
import {anchorJobText} from '../src/core/job.mjs';

const records=[{sourceRow:2,values:{name:'Anna Keller',email:'anna@example.org',score:'7'}},{sourceRow:3,values:{name:'Jonas Weber',email:'jonas@example.org',score:'9'}}];
const plan={version:1,fields:['name','email','score'],strategy:'merkle-root',ordering:'leaf-hash',salt:'none',duplicates:'keep'};
const jobText=async()=>anchorJobText(await buildCommitment({records,plan}));

function setup(config={mode:'demo',paid:false},{submit,journal}={}){
 const dir=mkdtempSync(join(tmpdir(),'cb-tasks-'));
 const audit=createAuditLog(join(dir,'audit.jsonl'));
 const calls={submit:0};
 const svc=createTaskService({store:createTaskStore(join(dir,'tasks')),audit,config,
  submit:async t=>{calls.submit++;return submit?submit(t):{sokosumiTaskId:'sk-1'};},readJournal:()=>journal?.()});
 return {svc,audit,dir,calls,done:()=>rmSync(dir,{recursive:true})};
}

test('Approval gate: nothing runs or is submitted without the exact quote and explicit confirmation',async()=>{
 const {svc,calls,done}=setup({mode:'sokosumi',paid:true,coworkerId:'cw'});
 try{
  const {task}=svc.quote({jobText:await jobText()});
  assert.equal(task.state,'awaiting_approval');assert.equal(calls.submit,0);
  assert.equal(task.quote.servicePrice,'1 tUSDM');assert.match(task.quote.networkFee,/unavailable/);
  await assert.rejects(svc.approve(task.id,{quoteHash:task.quoteHash}),/Explicit confirmation/);
  await assert.rejects(svc.approve(task.id,{quoteHash:'0'.repeat(64),confirm:true}),/quote changed/);
  assert.equal(calls.submit,0);
  const approved=await svc.approve(task.id,{quoteHash:task.quoteHash,confirm:true});
  assert.equal(approved.state,'submitted');assert.equal(approved.sokosumiTaskId,'sk-1');assert.equal(calls.submit,1);
  await assert.rejects(svc.approve(task.id,{quoteHash:task.quoteHash,confirm:true}),/cannot be approved again/);
  assert.equal(calls.submit,1);
 }finally{done();}
});
test('Duplicate requests reuse the active task instead of creating a second charge',async()=>{
 const {svc,calls,done}=setup({mode:'sokosumi',paid:true,coworkerId:'cw'});
 try{
  const text=await jobText();
  const a=svc.quote({jobText:text});const b=svc.quote({jobText:text});
  assert.equal(b.reused,true);assert.equal(b.task.id,a.task.id);
  await svc.approve(a.task.id,{quoteHash:a.task.quoteHash,confirm:true});
  assert.equal(svc.quote({jobText:text}).task.id,a.task.id);assert.equal(calls.submit,1);
 }finally{done();}
});
test('Uncertain submission becomes needs_inspection and blocks resubmission',async()=>{
 const {svc,calls,done}=setup({mode:'sokosumi',paid:true,coworkerId:'cw'},{submit:()=>{throw new Error('timeout');}});
 try{
  const text=await jobText();
  const {task}=svc.quote({jobText:text});
  const t=await svc.approve(task.id,{quoteHash:task.quoteHash,confirm:true});
  assert.equal(t.state,'needs_inspection');assert.match(t.error,/unknown/);
  const again=svc.quote({jobText:text});
  assert.equal(again.reused,true);assert.equal(again.task.state,'needs_inspection');assert.equal(calls.submit,1);
 }finally{done();}
});
test('Missing task id from Sokosumi is treated as uncertain, not as success',async()=>{
 const {svc,done}=setup({mode:'sokosumi',paid:false,coworkerId:'cw'},{submit:()=>({sokosumiTaskId:null})});
 try{const {task}=svc.quote({jobText:await jobText()});assert.equal((await svc.approve(task.id,{quoteHash:task.quoteHash,confirm:true})).state,'needs_inspection');}finally{done();}
});
test('Demo mode completes locally, unpaid, and says so',async()=>{
 const {svc,done}=setup();
 try{
  const {task}=svc.quote({jobText:await jobText()});
  assert.equal(task.quote.servicePrice,'Not charged');assert.equal(task.paymentStatus,'not_required');
  const t=await svc.approve(task.id,{quoteHash:task.quoteHash,confirm:true});
  assert.equal(t.state,'completed');assert.match(t.result,/root verified/);assert.equal(t.evidence,undefined);
 }finally{done();}
});
test('Cancel only before approval; invalid job input is refused before a quote',async()=>{
 const {svc,done}=setup();
 try{
  assert.throws(()=>svc.quote({jobText:'{"records":[{"name":"Anna"}]}'}),/ChainBridge v1/);
  const {task}=svc.quote({jobText:await jobText()});
  assert.equal(svc.cancel(task.id).state,'cancelled');
  await assert.rejects(svc.approve(task.id,{quoteHash:task.quoteHash,confirm:true}),/cannot be approved/);
 }finally{done();}
});

test('Audit entries never contain raw records, job text or secrets',async()=>{
 const {svc,dir,done}=setup();
 try{
  const {task}=svc.quote({jobText:await jobText()});
  await svc.approve(task.id,{quoteHash:task.quoteHash,confirm:true});
  const log=readFileSync(join(dir,'audit.jsonl'),'utf8');
  for(const r of records)for(const v of [r.values.name,r.values.email])assert.ok(!log.includes(v),`audit leaked ${v}`);
  assert.ok(!log.includes('"leaves"'));
  const events=log.trim().split('\n').map(l=>JSON.parse(l).event);
  assert.deepEqual(events,['quote_created','approved','completed_demo']);
  const e=auditEntry({event:'x',reason:'Anna Keller <anna@example.org>',records:[1],commitment:{a:1}});
  assert.equal(e.reason,'[omitted]');assert.equal(e.records,undefined);assert.equal(e.commitment,'[omitted]');
 }finally{done();}
});

test('State transitions move forward only',()=>{
 assert.equal(canTransition('awaiting_approval','approved'),true);
 assert.equal(canTransition('awaiting_approval','processing'),false);
 assert.equal(canTransition('submitted','completed'),true);
 assert.equal(canTransition('completed','processing'),false);
 assert.equal(canTransition('failed','processing'),false);
 assert.throws(()=>transition({state:'cancelled'},'approved'),/Invalid task transition/);
});
test('Worker journal maps to honest task and payment states',()=>{
 assert.equal(fromWorkerJournal(null).state,'submitted');
 assert.deepEqual([fromWorkerJournal({phase:'completed'}).state,fromWorkerJournal({phase:'completed'}).payment],['completed','disabled']);
 assert.equal(fromWorkerJournal({phase:'input-rejected',reason:'bad'}).state,'failed');
 const escrow=fromWorkerJournal({phase:'started',paid:{stage:'awaiting-escrow',payment:{blockchainIdentifier:'bid'},observed:{onChainState:null}}});
 assert.equal(escrow.state,'awaiting_payment');assert.equal(escrow.payment,'awaiting_buyer');assert.equal(escrow.evidence.settlementTxHash,null);
 assert.equal(fromWorkerJournal({paid:{stage:'submit-pending'}}).uncertain,true);
 const withdrawal=fromWorkerJournal({paid:{stage:'awaiting-withdrawal',settlement:{verified:false,txHash:'unverified'}}});
 assert.equal(withdrawal.state,'completed');assert.equal(withdrawal.payment,'payout_pending');assert.equal(withdrawal.evidence.settlementTxHash,null,'unverified receipts are not shown as evidence');
 const settled=fromWorkerJournal({paid:{stage:'settled',settlement:{verified:true,txHash:'abc',netAtomicUnits:'1000000'}}});
 assert.equal(settled.state,'settled');assert.equal(settled.evidence.settlementTxHash,'abc');
});
test('Status refresh follows the worker journal without skipping backwards',async()=>{
 let journal={phase:'started',paid:{stage:'awaiting-escrow',payment:{blockchainIdentifier:'bid'}}};
 const {svc,done}=setup({mode:'sokosumi',paid:true,coworkerId:'cw'},{journal:()=>journal});
 try{
  const {task}=svc.quote({jobText:await jobText()});await svc.approve(task.id,{quoteHash:task.quoteHash,confirm:true});
  assert.equal(svc.refresh(task.id).state,'awaiting_payment');
  journal={paid:{stage:'awaiting-result',resultHash:'r',payment:{blockchainIdentifier:'bid'},observed:{onChainState:'ResultSubmitted',CurrentTransaction:{txHash:'tx1',status:'Pending'}}}};
  const t=svc.refresh(task.id);assert.equal(t.state,'result_submitted');assert.equal(t.evidence.lastTxHash,'tx1');
  journal={paid:{stage:'awaiting-escrow'}};
  const back=svc.refresh(task.id);assert.equal(back.state,'result_submitted');assert.match(back.detail,/unexpected state change/);
 }finally{done();}
});
test('Sokosumi CLI arguments follow the documented create command',()=>{
 assert.deepEqual(createTaskArgs({coworkerId:'cw',organizationSlug:null,name:'n',description:'d'}),['--preprod','tasks','create','--personal','--coworker-id','cw','--name','n','--description','d','--status','READY','--json']);
 assert.deepEqual(createTaskArgs({coworkerId:'cw',organizationSlug:'tum',name:'n',description:'d'}).slice(3,5),['--organization-slug','tum']);
 assert.equal(taskIdFrom({task:{id:'abc-1'}}),'abc-1');assert.equal(taskIdFrom({}),null);assert.equal(taskIdFrom({id:'../etc'}),null);
});
