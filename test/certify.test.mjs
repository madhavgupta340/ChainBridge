import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {ingest} from '../src/core/ingest.mjs';
import {analyzeSchema} from '../src/core/schema.mjs';
import {buildAiSample} from '../src/core/organize.mjs';
import {buildCommitment} from '../src/core/commitment.mjs';
import {parseJobInput,runJob,certifyJobText} from '../src/core/job.mjs';
import {anchorMetadata,walletFromEntropy,buildPublishTx,createPublishingWallet,publishFingerprint} from '../src/server/cardano-anchor.mjs';

const C=createRequire(import.meta.url)('@emurgo/cardano-serialization-lib-nodejs');
const plan={version:1,fields:['certificate_id','product','passed','inspector_name'],strategy:'merkle-root',ordering:'leaf-hash',salt:'per-record',duplicates:'keep'};
async function job(){
 const d=ingest({name:'s.csv',text:readFileSync(new URL('../samples/supplier-certificates.csv',import.meta.url),'utf8')});
 const c=await buildCommitment({records:d.records,plan});
 return {d,c,text:certifyJobText(c,buildAiSample(d,analyzeSchema(d.records,d.fields),'masked'))};
}
const params={min_fee_a:44,min_fee_b:155381,pool_deposit:'500000000',key_deposit:'2000000',max_val_size:'5000',max_tx_size:16384,coins_per_utxo_size:'4310'};

test('Certify job carries a masked sample only; unmasked samples are refused',async()=>{
 const {text}=await job();
 assert.ok(text.length<=16000);
 assert.ok(!text.includes('Anna Keller')&&!text.includes('anna.keller@example.org'),'private values are masked');
 assert.equal(parseJobInput(text).task,'certify');
 const j=JSON.parse(text);
 assert.throws(()=>parseJobInput(JSON.stringify({...j,sample:{...j.sample,shareMode:'full'}})),/masked or names-only/);
 assert.throws(()=>parseJobInput(JSON.stringify({...j,records:[]})),/Unexpected key/);
 assert.throws(()=>parseJobInput(JSON.stringify({...j,sample:{...j.sample,sampleRows:Array(11).fill({})}})),/at most 10 rows/);
});
test('Certify publishes only when the fingerprint matches; AI output never decides',async()=>{
 const {text}=await job();
 const calls=[];
 const publish=async a=>{calls.push(a);return {status:'confirmed',txHash:'f'.repeat(64),explorer:'x',blockHeight:1};};
 const analyze=async()=>({provider:'Meta',model:'m',summary:'Looks fine',issues:['ok'],steps:[{op:'trim',column:'*'}]});
 const out=await runJob(text,{analyze,publish,describeStep:s=>s.op});
 assert.match(out,/verified and published on Cardano Preprod \(confirmed\)/);
 assert.equal(calls.length,1);assert.equal(calls[0].leafCount,12);assert.match(calls[0].jobRef,/^cb-[0-9a-f]{24}$/);
 const r=JSON.parse(out.slice(out.indexOf('\n')+1));
 assert.equal(r.analysis.summary,'Looks fine');assert.equal(r.publication.txHash,'f'.repeat(64));
 const bad=JSON.parse(text);bad.leaves[0]=bad.leaves[1];
 calls.length=0;
 assert.match(await runJob(JSON.stringify(bad),{analyze,publish}),/MISMATCH, nothing published/);
 assert.equal(calls.length,0);
 const failingAi=await runJob(text,{analyze:async()=>{throw new Error('provider down')},publish});
 assert.match(failingAi,/AI analysis unavailable/);assert.equal(calls.length,1,'AI failure does not block publishing');
 assert.match(await runJob(text,{}),/not published/);
});
test('On-chain message holds only the fingerprint, count and job reference, within the 64-byte string limit',()=>{
 const m=anchorMetadata({root:'a'.repeat(64),leafCount:12,salted:true,jobRef:'cb-'+'1'.repeat(24)});
 assert.ok(m.msg.every(s=>Buffer.byteLength(s)<=64));
 assert.ok(m.msg.includes('a'.repeat(64)));
 assert.throws(()=>anchorMetadata({root:'nothex',leafCount:1,salted:false,jobRef:'x'}),/64-character/);
});
test('Publishing transaction is signed, carries label 674 and returns change to the wallet',()=>{
 const w=walletFromEntropy('11'.repeat(32));
 assert.match(w.address,/^addr_test1/);
 const utxos=[{tx_hash:'a'.repeat(64),output_index:0,amount:[{unit:'lovelace',quantity:'5000000'}]}];
 const t=buildPublishTx({wallet:w,utxos,params,metadata:anchorMetadata({root:'b'.repeat(64),leafCount:3,salted:false,jobRef:'cb-x'})});
 const tx=C.Transaction.from_bytes(t.cbor);
 assert.equal(tx.witness_set().vkeys().len(),1);
 const meta=tx.auxiliary_data().metadata().get(C.BigNum.from_str('674'));
 assert.match(C.decode_metadatum_to_json_str(meta,C.MetadataJsonSchema.NoConversions),/b{64}/);
 assert.equal(tx.body().outputs().get(0).address().to_bech32('addr_test'),w.address);
 assert.ok(Number(t.fee)>150000&&Number(t.fee)<300000);
 assert.throws(()=>buildPublishTx({wallet:w,utxos:null,params,metadata:{msg:[]}}),/no test ADA/);
});
test('Publishing wallet file is private and never overwritten',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cb-wallet-'));const p=join(dir,'w.json');
 try{const {address}=createPublishingWallet(p);assert.match(address,/^addr_test1/);
  assert.equal(statSync(p).mode&0o777,0o600);assert.throws(()=>createPublishingWallet(p),/refusing to overwrite/);}
 finally{rmSync(dir,{recursive:true});}
});
test('Publication is idempotent per job and never retried after an uncertain submit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cb-pub-'));const walletPath=join(dir,'w.json');createPublishingWallet(walletPath);
 let submits=0,failSubmit=false;
 const fetchImpl=async(url,opts={})=>{
  const ok=d=>({ok:true,status:200,json:async()=>d});
  if(url.includes('/epochs/latest/parameters'))return ok(params);
  if(url.includes('/utxos'))return ok([{tx_hash:'c'.repeat(64),output_index:1,amount:[{unit:'lovelace',quantity:'9000000'}]}]);
  if(url.endsWith('/tx/submit')){submits++;if(failSubmit)throw new Error('network down');
   const hash=C.FixedTransaction.from_bytes(opts.body).transaction_hash().to_hex();return ok(hash);}
  if(url.includes('/txs/'))return ok({block:'blk',block_height:42,block_time:1});
  return {ok:false,status:404,json:async()=>({})};
 };
 const cfg={walletPath,blockfrostKey:'preprodTEST',journalDir:join(dir,'anchors'),fetchImpl,pollMs:1};
 try{
  const a=await publishFingerprint({root:'d'.repeat(64),leafCount:2,salted:true,jobRef:'cb-1'},cfg);
  assert.equal(a.status,'confirmed');assert.equal(a.blockHeight,42);assert.match(a.explorer,/cardanoscan/);
  const again=await publishFingerprint({root:'d'.repeat(64),leafCount:2,salted:true,jobRef:'cb-1'},cfg);
  assert.equal(again.txHash,a.txHash);assert.equal(submits,1,'same job is published once');
  failSubmit=true;
  await assert.rejects(publishFingerprint({root:'e'.repeat(64),leafCount:2,salted:true,jobRef:'cb-2'},cfg),/network down/);
  await assert.rejects(publishFingerprint({root:'e'.repeat(64),leafCount:2,salted:true,jobRef:'cb-2'},cfg),/outcome uncertain/);
  assert.equal(submits,2,'uncertain submission is not retried');
  await assert.rejects(publishFingerprint({root:'f'.repeat(64),leafCount:1,salted:true,jobRef:'cb-3',deadline:Date.now()-1},cfg),/deadline/);
 }finally{rmSync(dir,{recursive:true});}
});
