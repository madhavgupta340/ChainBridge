import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server/main.mjs';
import {buildCommitment} from '../src/core/commitment.mjs';
import {anchorJobText} from '../src/core/job.mjs';

let server,base,dir,aiCalls=0,organizeCalls=0;
before(async()=>{
 dir=mkdtempSync(join(tmpdir(),'cb-server-'));
 server=createApp({config:{mode:'demo',paid:false,ai:true,reason:'test',port:0},dataDir:dir,journalDir:dir,ai:async()=>{aiCalls++;return {plan:{},validation:{ok:true,errors:[],warnings:[]},sent:{}};},
  organize:async()=>{organizeCalls++;return {source:'ai',steps:[],rejected:[]};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${server.address().port}`;
});
after(()=>{server.close();rmSync(dir,{recursive:true});});
const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});

test('Serves the UI with a strict content security policy and only whitelisted files',async()=>{
 const r=await fetch(base+'/');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);
 assert.equal((await fetch(base+'/core/merkle.mjs')).status,200);
 for(const p of ['/core/../server/main.mjs','/package.json','/.env','/samples/../.env','/core/job.mjs.bak'])assert.equal((await fetch(base+p)).status,404,p);
});
test('Config reports demo mode and no price',async()=>{
 const c=await (await fetch(base+'/api/config')).json();
 assert.equal(c.mode,'demo');assert.equal(c.price,null);assert.equal(c.network.id,'Preprod');
});
test('Cross-origin and non-JSON writes are refused',async()=>{
 assert.equal((await post('/api/tasks',{jobText:'x'},{origin:'https://evil.example'})).status,403);
 assert.equal((await fetch(base+'/api/tasks',{method:'POST',body:'jobText=x'})).status,415);
});
test('AI planning requires explicit consent',async()=>{
 assert.equal((await post('/api/plan/ai',{summary:{}})).status,400);assert.equal(aiCalls,0);
 assert.equal((await post('/api/plan/ai',{consent:true,summary:{}})).status,200);assert.equal(aiCalls,1);
});
test('End to end demo task over HTTP: quote, approve, completed unpaid',async()=>{
 const c=await buildCommitment({records:[{sourceRow:2,values:{a:'1'}}],plan:{version:1,fields:['a'],strategy:'merkle-root',ordering:'source',salt:'none',duplicates:'keep'}});
 const q=await (await post('/api/tasks',{jobText:anchorJobText(c)})).json();
 assert.equal(q.task.state,'awaiting_approval');
 assert.equal((await post(`/api/tasks/${q.task.id}/approve`,{quoteHash:q.task.quoteHash})).status,400);
 const done=await (await post(`/api/tasks/${q.task.id}/approve`,{confirm:true,quoteHash:q.task.quoteHash})).json();
 assert.equal(done.state,'completed');assert.equal(done.paymentStatus,'not_required');
 const audit=await (await fetch(base+'/api/audit')).json();
 assert.equal(audit[0].event,'completed_demo');
});
test('AI organizer requires consent, and a second confirmation for unmasked rows',async()=>{
 assert.equal((await post('/api/organize/ai',{sample:{shareMode:'masked'}})).status,400);
 assert.equal((await post('/api/organize/ai',{consent:true,sample:{shareMode:'full'}})).status,400);
 assert.equal(organizeCalls,0);
 assert.equal((await post('/api/organize/ai',{consent:true,sample:{shareMode:'masked'}})).status,200);
 assert.equal((await post('/api/organize/ai',{consent:true,fullConsent:true,sample:{shareMode:'full'}})).status,200);
 assert.equal(organizeCalls,2);
});
