import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodePaymentSignatureHeader} from '@x402/core/http';
import {quote,measure,PRICING} from '../src/core/pricing.mjs';
import {countTidyIssues} from '../src/core/organize.mjs';
import {ingest} from '../src/core/ingest.mjs';
import {analyzeSchema} from '../src/core/schema.mjs';
import {buildCommitment} from '../src/core/commitment.mjs';
import {createX402Service} from '../src/server/x402-service.mjs';
import {zip,toCsv} from '../public/zip.js';

const sample=n=>ingest({name:n,text:readFileSync(new URL(`../samples/${n}`,import.meta.url),'utf8')});

test('Pricing: deterministic, explained line by line, bounded, and validated',()=>{
 const d=sample('messy-shipments.csv');
 const m=measure(d,analyzeSchema(d.records,d.fields),countTidyIssues);
 assert.deepEqual(m,{records:10,columns:8,privateColumns:3,tidyIssues:6});
 const q=quote(m);
 assert.equal(q.totalLovelace,4_750_000);assert.deepEqual(quote(m),q,'same file, same price');
 assert.equal(q.lines.reduce((s,l)=>s+l.lovelace,0),q.totalLovelace);
 assert.equal(quote({records:1,columns:1,privateColumns:0,tidyIssues:0}).totalLovelace,PRICING.base+PRICING.per1000Records);
 assert.equal(quote({records:900000,columns:500,privateColumns:500,tidyIssues:1000}).totalLovelace,PRICING.maximum);
 for(const bad of [{records:0,columns:1,privateColumns:0,tidyIssues:0},{records:5,columns:2,privateColumns:3,tidyIssues:0},{records:-1,columns:1,privateColumns:0,tidyIssues:0},{records:'x'}])
  assert.throws(()=>quote(bad));
});

async function setup({publishFails=false,settleOk=true,verifyOk=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'cb-x402-'));
 const calls={verify:0,settle:0,publish:0,analyze:0};
 const requirements={scheme:'exact',network:'cardano:preprod',amount:'4750000',asset:'lovelace',payTo:'addr_test1qseller',maxTimeoutSeconds:1800,extra:{}};
 const seller={
  paymentRequired:async()=>({requirements,paymentRequired:{x402Version:2,resource:{url:'x'},accepts:[requirements]}}),
  verify:async()=>{calls.verify++;return verifyOk?{isValid:true,payer:'addr_test1qbuyer'}:{isValid:false,invalidReason:'bad'};},
  settle:async()=>{calls.settle++;return settleOk?{success:true,transaction:'ab'.repeat(32),network:'cardano:preprod',extra:{status:'confirmed'}}:{success:false,errorReason:'utxo_spent'};},
 };
 const svc=createX402Service({dir,seller,resourceBase:'http://127.0.0.1:8787',
  analyze:async()=>{calls.analyze++;return {source:'ai',summary:'ok',issues:[],steps:[]};},
  publish:async a=>{calls.publish++;if(publishFails)throw new Error('wallet empty');return {status:'confirmed',txHash:'cd'.repeat(32),blockHeight:1,explorer:'x',...a};}});
 const d=sample('supplier-certificates.csv');
 const c=await buildCommitment({records:d.records,plan:{version:1,fields:['certificate_id','passed'],strategy:'merkle-root',ordering:'leaf-hash',salt:'per-record',duplicates:'keep'}});
 const header=encodePaymentSignatureHeader({x402Version:2,resource:{url:'x'},accepted:requirements,payload:{transaction:'dHg=',nonce:'aa'.repeat(32)+'#0'}});
 return {svc,calls,c,header,done:()=>rmSync(dir,{recursive:true})};
}
const job=c=>({payload:c.payload,leaves:c.entries.map(e=>e.leafHash)});

test('x402 session: free quote, 402 requirements, verified payment unlocks the paid work',async()=>{
 const {svc,calls,c,header,done}=await setup();
 try{
  const q=svc.quote({records:12,columns:10,privateColumns:3,tidyIssues:0});
  assert.equal(q.status,'quoted');
  await assert.rejects(svc.analyze(q.id,{shareMode:'masked',columns:[]}),/Payment required/);
  await assert.rejects(svc.publish(q.id,job(c)),/Payment required/);
  const {paymentRequired,header:required}=await svc.paymentRequired(q.id);
  assert.equal(paymentRequired.accepts[0].amount,'4750000');assert.ok(required.length>20);
  const paid=await svc.pay(q.id,header);
  assert.equal(paid.status,'paid');assert.equal(calls.verify,1);assert.equal(calls.settle,0,'not charged at payment time');
  await assert.rejects(svc.pay(q.id,header),/already paid/);
  await assert.rejects(svc.analyze(q.id,{shareMode:'full',columns:[]}),/masked or names-only/);
  assert.equal((await svc.analyze(q.id,{shareMode:'masked',columns:[]})).status,'analyzed');
  const done1=await svc.publish(q.id,job(c));
  assert.equal(done1.status,'complete');assert.equal(calls.publish,1);assert.equal(calls.settle,1,'settled once, after publication');
  assert.equal((await svc.publish(q.id,job(c))).status,'complete');assert.equal(calls.settle,1,'never settled twice');
 }finally{done();}
});
test('x402 session: failed publication is never charged; wrong or oversized fingerprints are refused',async()=>{
 const {svc,calls,c,header,done}=await setup({publishFails:true});
 try{
  const q=svc.quote({records:12,columns:10,privateColumns:3,tidyIssues:0});await svc.paymentRequired(q.id);await svc.pay(q.id,header);
  const bad=job(c);bad.leaves=bad.leaves.slice();bad.leaves[0]=bad.leaves[1];
  await assert.rejects(svc.publish(q.id,bad),/does not match/);
  const small=svc.quote({records:3,columns:10,privateColumns:3,tidyIssues:0});await svc.paymentRequired(small.id);await svc.pay(small.id,header);
  await assert.rejects(svc.publish(small.id,job(c)),/quote covered 3 records/);
  await assert.rejects(svc.publish(q.id,job(c)),/nothing was charged/);
  assert.equal(calls.settle,0);assert.equal(svc.get(q.id).status,'failed');
 }finally{done();}
});
test('x402 session: invalid payments are rejected; settlement problems are reported honestly',async()=>{
 const a=await setup({verifyOk:false});
 try{const q=a.svc.quote({records:12,columns:10,privateColumns:0,tidyIssues:0});await a.svc.paymentRequired(q.id);
  await assert.rejects(a.svc.pay(q.id,a.header),/Payment not accepted/);assert.equal(a.svc.get(q.id).status,'quoted');
  await assert.rejects(a.svc.pay(q.id,'not-a-header'),/Invalid PAYMENT-SIGNATURE/);}finally{a.done();}
 const b=await setup({settleOk:false});
 try{const q=b.svc.quote({records:12,columns:10,privateColumns:0,tidyIssues:0});await b.svc.paymentRequired(q.id);await b.svc.pay(q.id,b.header);
  const r=await b.svc.publish(q.id,job(b.c));
  assert.equal(r.status,'settle-failed');assert.match(r.error,/could not be settled \(utxo_spent\)/);}finally{b.done();}
});
test('x402 session: a table fingerprint may add one source-file leaf beyond the quoted records, and it is published as such',async()=>{
 const {svc,calls,header,done}=await setup();
 try{
  const d=sample('supplier-certificates.csv');
  const c=await buildCommitment({records:d.records,plan:{version:1,fields:['certificate_id','passed'],strategy:'merkle-root',ordering:'leaf-hash',salt:'per-record',duplicates:'keep'},
   files:[{name:'supplier-certificates.csv',sha256:'ab'.repeat(32)},{name:'extra.csv',sha256:'cd'.repeat(32)}]});
  const q=svc.quote({records:d.records.length,columns:10,privateColumns:3,tidyIssues:0});await svc.paymentRequired(q.id);await svc.pay(q.id,header);
  await assert.rejects(svc.publish(q.id,{payload:c.payload,leaves:c.leaves,files:2}),/At most 1 source file/);
  await assert.rejects(svc.publish(q.id,{payload:c.payload,leaves:c.leaves,files:0}),/quote covered/,'file leaves are not free records');
  const one=await buildCommitment({records:d.records,plan:{version:1,fields:['certificate_id','passed'],strategy:'merkle-root',ordering:'leaf-hash',salt:'per-record',duplicates:'keep'},files:[{name:'s.csv',sha256:'ab'.repeat(32)}]});
  const r=await svc.publish(q.id,{payload:one.payload,leaves:one.leaves,files:1});
  assert.equal(r.status,'complete');assert.deepEqual(r.fingerprint,{root:one.root,leafCount:d.records.length+1,files:1,salted:true});
  assert.equal(r.publication.files,1);assert.equal(calls.settle,1);
 }finally{done();}
});
test('Package ZIP and CSV: valid archive, quoting of commas and quotes',async()=>{
 const bytes=new Uint8Array(await zip([{name:'a.txt',text:'hi'}]).arrayBuffer());
 assert.deepEqual([...bytes.slice(0,4)],[0x50,0x4b,0x03,0x04]);
 assert.equal(toCsv(['a','b'],[{values:{a:'x,1',b:'say "hi"'}}]),'a,b\r\n"x,1","say ""hi"""\r\n');
});
