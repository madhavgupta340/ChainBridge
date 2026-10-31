import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodePaymentSignatureHeader} from '@x402/core/http';
import {anchorMetadata,versionLines,parseAnchorMessage,createPublishingWallet} from '../src/server/cardano-anchor.mjs';
import {createVersionService} from '../src/server/versions.mjs';
import {createX402Service} from '../src/server/x402-service.mjs';
import {createShareService} from '../src/server/share.mjs';
import {createApp} from '../src/server/main.mjs';
import {buildCommitment} from '../src/core/commitment.mjs';
import {fileProof,validateCertificate} from '../src/core/certificate.mjs';

const SERIES='s-0123456789abcdef';
const tx=n=>String(n).repeat(64).slice(0,64);
const root=n=>`${n}f`.repeat(32).slice(0,64);
const tmp=t=>{const d=mkdtempSync(join(tmpdir(),'cb-ver-'));t.after(()=>rmSync(d,{recursive:true}));return d;};

test('On-chain version lines: random series, version number, previous transaction; validated and within 64 bytes',()=>{
 const m=anchorMetadata({root:root(3),leafCount:3,files:1,salted:true,jobRef:'x402-c',version:{series:SERIES,n:3,prevTx:tx(2)}}).msg;
 assert.ok(m.includes(`series: ${SERIES}`)&&m.includes('version: 3')&&m[m.indexOf('prev tx:')+1]===tx(2));
 assert.ok(m.every(x=>Buffer.byteLength(x)<=64));
 assert.deepEqual(parseAnchorMessage(m),{root:root(3),records:2,files:1,series:SERIES,version:3,prevTx:tx(2),job:'x402-c'});
 assert.equal(parseAnchorMessage(anchorMetadata({root:root(1),leafCount:1,salted:false,jobRef:'j'}).msg).series,null,'unversioned jobs are unchanged');
 for(const bad of [{series:'WVWZZZ1KZ6W000001',n:1},{series:SERIES,n:0},{series:SERIES,n:1,prevTx:tx(1)},{series:SERIES,n:2},{series:SERIES,n:2,prevTx:'x'}])
  assert.throws(()=>versionLines(bad),undefined,JSON.stringify(bad));
});

// A fake Cardano: transactions by hash, each with a ChainBridge message (or none) and a block time.
function cardano(txs,{down=false}={}){
 return async url=>{
  if(down)throw new Error('offline');
  const p=new URL(url).pathname.replace('/api/v0','');const ok=d=>({ok:true,status:200,json:async()=>d});
  const t=txs.find(x=>p.includes(x.hash));if(!t)return {ok:false,status:404,json:async()=>({})};
  if(p.endsWith('/metadata'))return ok(t.msg?[{label:'674',json_metadata:{msg:t.msg}}]:[]);
  return ok({block:'b',block_height:5000000+t.time,block_time:1793400000+t.time*60});
 };
}
const v=(n,{series=SERIES,prevTx=n>1?tx(n-1):null,time=n,rootN=n}={})=>({hash:tx(n),time,msg:anchorMetadata({root:root(rootN),leafCount:2,files:1,salted:true,jobRef:`j${n}`,version:{series,n:typeof n==='number'?n:1,prevTx}}).msg});

test('Predecessor lookup: must exist on Cardano, be a ChainBridge certificate, and have a series',async()=>{
 const svc=createVersionService({blockfrostKey:'k',fetchImpl:cardano([v(1),v(2),{hash:tx(7),time:7,msg:null},{hash:tx(8),time:8,msg:anchorMetadata({root:root(8),leafCount:1,salted:true,jobRef:'old'}).msg}])});
 const p=await svc.predecessor(tx(2));
 assert.deepEqual([p.series,p.version,p.prevTx,p.root],[SERIES,2,tx(1),root(2)]);
 await assert.rejects(svc.predecessor(tx(9)),/not on Cardano/);
 await assert.rejects(svc.predecessor(tx(7)),/not a ChainBridge certificate/);
 await assert.rejects(svc.predecessor(tx(8)),/before certificate versions existed/);
 await assert.rejects(svc.predecessor('nothex'),/64 hexadecimal/);
 await assert.rejects(createVersionService({blockfrostKey:'k',fetchImpl:cardano([],{down:true})}).predecessor(tx(1)),/could not be reached/);
});

test('Chain: rebuilt backwards from the latest transaction; gaps, repeats, other series, missing and loops are explained',async()=>{
 const run=(txs,start,opts)=>createVersionService({blockfrostKey:'k',fetchImpl:cardano(txs)}).chain(start,opts);
 let r=await run([v(1),v(2),v(3)],tx(3),{expectedRoot:root(3)});
 assert.equal(r.complete,true);assert.deepEqual(r.versions.map(x=>x.version),[3,2,1]);
 assert.ok(r.versions.every(x=>x.tx.status==='valid'&&x.record.status==='valid'&&x.link.status==='valid'));
 assert.equal((await run([v(1),v(2),v(3)],tx(3),{expectedRoot:root(9)})).versions[0].record.status,'mismatch','the starting version must carry the certificate\'s fingerprint');
 // version 2 missing from Cardano
 r=await run([v(1),v(3)],tx(3));assert.equal(r.complete,false);assert.equal(r.versions[1].tx.status,'not-found');assert.match(r.versions[1].tx.detail,/missing/);
 // gap: version 3 points straight to version 1
 r=await run([v(1),v(3,{prevTx:tx(1)})],tx(3));assert.match(r.versions[1].link.detail,/Expected version 2 here, found version 1/);
 // repeated version number
 const twice={hash:tx(5),time:5,msg:anchorMetadata({root:root(5),leafCount:2,files:1,salted:true,jobRef:'j',version:{series:SERIES,n:2,prevTx:tx(2)}}).msg};
 r=await run([v(1),v(2),twice],tx(5));assert.match(r.versions[1].link.detail,/appears twice/);
 // different series
 r=await run([v(1,{series:'s-ffffffffffffffff'}),v(2)],tx(2));assert.match(r.versions[1].link.detail,/different certificate series/);
 // loop
 const a={hash:tx(4),time:4,msg:anchorMetadata({root:root(4),leafCount:1,salted:true,jobRef:'j',version:{series:SERIES,n:3,prevTx:tx(6)}}).msg};
 const b={hash:tx(6),time:3,msg:anchorMetadata({root:root(6),leafCount:1,salted:true,jobRef:'j',version:{series:SERIES,n:2,prevTx:tx(4)}}).msg};
 r=await run([a,b],tx(4));assert.equal(r.stop,'loop');assert.match(r.versions.at(-1).tx.detail,/loop/);
 // an older version recorded after the one pointing to it
 r=await run([v(1,{time:9}),v(2,{time:2})],tx(2));assert.match(r.versions[1].link.detail,/recorded after/);
 // outage: never "valid"
 r=await createVersionService({blockfrostKey:'k',fetchImpl:cardano([],{down:true})}).chain(tx(3));
 assert.equal(r.versions[0].tx.status,'not-checked');assert.equal(r.complete,false);
});

test('x402 publish: the version goes into the Cardano record once; invalid versions are refused before publishing',async t=>{
 const published=[];
 const requirements={scheme:'exact',network:'cardano:preprod',amount:'3250000',asset:'lovelace',payTo:'addr_test1qseller',maxTimeoutSeconds:1800,extra:{}};
 const svc=createX402Service({dir:tmp(t),resourceBase:'x',
  seller:{paymentRequired:async()=>({requirements,paymentRequired:{x402Version:2,accepts:[requirements]}}),verify:async()=>({isValid:true,payer:'p'}),settle:async()=>({success:true,transaction:'ab'.repeat(32)})},
  publish:async a=>{published.push(a);return {status:'confirmed',txHash:tx(4),metadata:anchorMetadata(a)};}});
 const c=await buildCommitment({records:[{sourceRow:1,values:{a:'1'}}],plan:{version:1,fields:['a'],strategy:'merkle-root',ordering:'source',salt:'per-record',duplicates:'keep'},files:[{name:'r.pdf',sha256:'ab'.repeat(32)}]});
 const q=svc.quote({kind:'documents',documents:1,pages:1});await svc.paymentRequired(q.id);
 await svc.pay(q.id,encodePaymentSignatureHeader({x402Version:2,accepted:requirements,payload:{transaction:'dHg=',nonce:'aa'.repeat(32)+'#0'}}));
 const job={payload:c.payload,leaves:c.leaves,files:1};
 await assert.rejects(svc.publish(q.id,{...job,version:{series:'bad',n:1}}),/Invalid certificate series/);
 await assert.rejects(svc.publish(q.id,{...job,version:{series:SERIES,n:3}}),/previous transaction/);
 assert.equal(published.length,0);
 const version={series:SERIES,n:3,prevTx:tx(2)};
 const done=await svc.publish(q.id,{...job,version});
 assert.deepEqual(done.version,version);assert.deepEqual(parseAnchorMessage(done.publication.metadata.msg).version,3);
 assert.equal((await svc.publish(q.id,{...job,version})).status,'complete');assert.equal(published.length,1,'published and charged once');
});

test('File certificates carry the series and version, and the check compares them with Cardano',async t=>{
 const dir=tmp(t);const walletPath=join(dir,'w.json');createPublishingWallet(walletPath);
 const c=await buildCommitment({records:[{sourceRow:1,values:{a:'1'}}],plan:{version:1,fields:['a'],strategy:'merkle-root',ordering:'source',salt:'per-record',duplicates:'keep'},files:[{name:'r.pdf',sha256:'ab'.repeat(32)}]});
 const msg=anchorMetadata({root:c.root,leafCount:2,files:1,salted:true,jobRef:'j',version:{series:SERIES,n:2,prevTx:tx(1)}}).msg;
 const fake=(m)=>async url=>{const p=new URL(url).pathname;const ok=d=>({ok:true,status:200,json:async()=>d});
  if(p.endsWith('/metadata'))return ok([{label:'674',json_metadata:{msg:m}}]);if(p.endsWith('/utxos'))return ok({inputs:[]});if(p.endsWith('/latest'))return ok({height:5000010});return ok({block:'b',block_height:5000000,block_time:1793400000});};
 const session={id:'11111111-2222-3333-4444-555555555555',status:'complete',fingerprint:{root:c.root,leafCount:2,files:1},version:{series:SERIES,n:2,prevTx:tx(1)},publication:{txHash:tx(5),label:674}};
 const share=createShareService({dir:join(dir,'c'),walletPath,blockfrostKey:'k',fetchImpl:fake(msg)});
 const {certificate}=await share.issue(session,fileProof(c,0));
 assert.deepEqual(certificate.series,{id:SERIES,version:2,previousTransaction:tx(1)});validateCertificate(certificate);
 assert.equal((await share.check(certificate)).version.status,'valid');
 const other=createShareService({dir:join(dir,'c'),walletPath,blockfrostKey:'k',fetchImpl:fake(anchorMetadata({root:c.root,leafCount:2,files:1,salted:true,jobRef:'j',version:{series:SERIES,n:3,prevTx:tx(1)}}).msg)});
 assert.match((await other.check(certificate)).version.detail,/version 3, not 2/);
 assert.throws(()=>validateCertificate({...certificate,series:{id:SERIES,version:2,previousTransaction:null}}),/series or version/);
});

test('Version API: lookup and chain over HTTP, and nothing is stored',async t=>{
 const dir=tmp(t);
 const server=createApp({config:{mode:'demo',paid:false,ai:false,reason:'t',port:0},dataDir:dir,journalDir:dir,x402:{enabled:false,reason:'t'},
  versions:createVersionService({blockfrostKey:'k',fetchImpl:cardano([v(1),v(2)])})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 const before=readdirSync(dir).sort().join();
 assert.equal((await (await fetch(`${base}/api/versions/${tx(2)}`)).json()).version,2);
 const ch=await (await fetch(`${base}/api/versions/${tx(2)}/chain?root=${root(2)}`)).json();
 assert.equal(ch.complete,true);assert.deepEqual(ch.versions.map(x=>x.version),[2,1]);
 assert.equal((await fetch(`${base}/api/versions/${tx(9)}`)).status,404);
 assert.equal((await fetch(`${base}/versions.js`)).status,200);
 assert.equal(readdirSync(dir).sort().join(),before,'looking up versions writes nothing to disk');
});

// ---------- checking an unconfirmed payment on Cardano (read-only) ----------
import {paymentFinder} from '../src/server/x402-routes.mjs';
import {buildPublishTx,walletFromEntropy} from '../src/server/cardano-anchor.mjs';
const params={min_fee_a:44,min_fee_b:155381,pool_deposit:'500000000',key_deposit:'2000000',max_val_size:'5000',max_tx_size:16384,coins_per_utxo_size:'4310'};

test('Payment check: finds the signed payment by its own ID; not on chain, spent elsewhere or wrong amount are reported',async()=>{
 const w=walletFromEntropy('22'.repeat(32));
 const t=buildPublishTx({wallet:w,utxos:[{tx_hash:'c'.repeat(64),output_index:1,amount:[{unit:'lovelace',quantity:'9000000'}]}],params,metadata:{msg:['x']}});
 const payment={payload:{transaction:t.cbor.toString('base64')}};
 const requirements={payTo:w.address,amount:'1000000'};
 const chain=({onChain,spentBy=null})=>async url=>{
  const p=new URL(url).pathname.replace('/api/v0','');const ok=d=>({ok:true,status:200,json:async()=>d});
  if(p===`/txs/${t.txHash}`)return onChain?ok({block_height:5000001}):{ok:false,status:404,json:async()=>({})};
  if(p===`/txs/${t.txHash}/utxos`)return ok({outputs:[{address:w.address,amount:[{unit:'lovelace',quantity:'8800000'}]}]});
  if(p===`/txs/${'c'.repeat(64)}/utxos`)return ok({outputs:[{output_index:1,consumed_by_tx:spentBy}]});
  return {ok:false,status:404,json:async()=>({})};
 };
 assert.deepEqual(await paymentFinder('k',chain({onChain:true}))({payment,requirements}),{status:'paid',txHash:t.txHash,blockHeight:5000001});
 assert.equal((await paymentFinder('k',chain({onChain:true}))({payment,requirements:{...requirements,amount:'99000000'}})).status,'mismatch');
 assert.equal((await paymentFinder('k',chain({onChain:false}))({payment,requirements})).status,'not-found');
 assert.equal((await paymentFinder('k',chain({onChain:false,spentBy:'d'.repeat(64)}))({payment,requirements})).status,'cannot-settle');
});

test('Reconcile: completes a published job only when its payment is found on Cardano; never resubmits; refuses other states',async t=>{
 const requirements={scheme:'exact',network:'cardano:preprod',amount:'3250000',asset:'lovelace',payTo:'addr_test1qseller',maxTimeoutSeconds:1800,extra:{}};
 let found={status:'not-found',txHash:tx(6)},settles=0;
 const svc=createX402Service({dir:tmp(t),resourceBase:'x',
  seller:{paymentRequired:async()=>({requirements,paymentRequired:{x402Version:2,accepts:[requirements]}}),verify:async()=>({isValid:true,payer:'p'}),
   settle:async()=>{settles++;throw new Error('Facilitator settle failed (504)');}},
  publish:async a=>({status:'confirmed',txHash:tx(5),metadata:anchorMetadata(a)}),
  findPayment:async()=>{if(found==='down')throw new Error('offline');return found;}});
 const c=await buildCommitment({records:[{sourceRow:1,values:{a:'1'}}],plan:{version:1,fields:['a'],strategy:'merkle-root',ordering:'source',salt:'per-record',duplicates:'keep'}});
 const q=svc.quote({kind:'documents',documents:1,pages:1});
 await assert.rejects(svc.reconcile(q.id),/Only a published job/);
 await svc.paymentRequired(q.id);
 await svc.pay(q.id,encodePaymentSignatureHeader({x402Version:2,accepted:requirements,payload:{transaction:'dHg=',nonce:'aa'.repeat(32)+'#0'}}));
 assert.equal((await svc.publish(q.id,{payload:c.payload,leaves:c.leaves})).status,'needs-inspection');
 let r=await svc.reconcile(q.id);assert.equal(r.status,'needs-inspection');assert.equal(r.paymentCheck.status,'not-found');
 found='down';await assert.rejects(svc.reconcile(q.id),/could not be reached/);assert.equal(svc.get(q.id).status,'needs-inspection');
 found={status:'paid',txHash:tx(6),blockHeight:7};
 r=await svc.reconcile(q.id);
 assert.equal(r.status,'complete');assert.equal(r.settlement.transaction,tx(6));assert.equal(r.error,null);
 assert.equal(settles,1,'reconcile only reads Cardano: settlement is never retried');
 assert.equal((await svc.reconcile(q.id)).status,'complete','checking again is harmless');
});
