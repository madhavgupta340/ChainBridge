import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCommitment,verifyRecord} from '../src/core/commitment.mjs';
import {fileLeafHash,leafHash,merkleRoot,sha256Hex} from '../src/core/merkle.mjs';
import {fileProof,checkFile,validateCertificate,signingBytes} from '../src/core/certificate.mjs';
import {createShareService,linkBase} from '../src/server/share.mjs';
import {createPublishingWallet,loadPublishingWallet,anchorMetadata} from '../src/server/cardano-anchor.mjs';
import {createApp} from '../src/server/main.mjs';

const plan={version:1,fields:['source_file','source_sha256','vin','odometer'],strategy:'merkle-root',ordering:'source',salt:'per-record',duplicates:'keep'};
const fileA=new TextEncoder().encode('%PDF-1.4 inspection report A');
const fileB=new TextEncoder().encode('%PDF-1.4 inspection report B');
async function sealed(){
 const shaA=await sha256Hex(fileA),shaB=await sha256Hex(fileB);
 const records=[{sourceRow:1,values:{source_file:'a.pdf',source_sha256:shaA,vin:'WVW-SECRET-1',odometer:'84210 km'}},
  {sourceRow:2,values:{source_file:'b.pdf',source_sha256:shaB,vin:'WVW-SECRET-2',odometer:'12000 km'}}];
 const c=await buildCommitment({records,plan,files:[{name:'a.pdf',sha256:shaA},{name:'b.pdf',sha256:shaB}]});
 return {c,records,shaA,shaB};
}

test('File leaves: added after the records, salted, domain-separated, and records still verify',async()=>{
 const {c,records,shaA}=await sealed();
 assert.equal(c.payload.leafCount,4);assert.equal(c.stats.committed,2);assert.equal(c.stats.files,2);
 assert.equal(c.files[0].leafIndex,2);assert.match(c.files[0].salt,/^[0-9a-f]{32}$/);
 assert.notEqual(c.files[0].salt,c.files[1].salt);
 assert.equal(c.root,await merkleRoot(c.leaves));
 assert.notEqual(await fileLeafHash(shaA,c.files[0].salt),await leafHash(`{"sha256":"${shaA}"}`,c.files[0].salt),'file and record leaves never collide');
 await assert.rejects(fileLeafHash(shaA,''),/salt/);
 assert.equal((await verifyRecord({values:records[1].values,sourceRow:2,bundle:c.bundle})).match,true);
 const noFiles=await buildCommitment({records,plan,salts:Object.fromEntries(c.entries.map(e=>[e.sourceRow,e.salt]))});
 assert.deepEqual(noFiles.entries.map(e=>e.leafHash),c.entries.map(e=>e.leafHash),'record leaves are unchanged by file leaves');
});

function certFrom(c,i,extra={}){
 const {file,proof}=fileProof(c,i);
 return {type:'chainbridge-file-certificate',version:1,id:'ab'.repeat(16),network:'cardano-preprod',testNetwork:true,file,proof,
  commitment:{root:c.root,leafCount:c.payload.leafCount,files:2},cardano:{transaction:'cd'.repeat(32),metadataLabel:674},issuedAt:'2026-10-31T00:00:00.000Z',...extra};
}
test('File check: right file is valid, a changed file is not, a tampered proof is caught; no records are revealed',async()=>{
 const {c,shaA,shaB}=await sealed();
 const cert=certFrom(c,0);
 assert.equal((await checkFile(cert,shaA)).status,'valid');
 assert.equal((await checkFile(cert,shaB)).status,'no-match');
 assert.equal((await checkFile(cert,await sha256Hex(new TextEncoder().encode('%PDF-1.4 inspection report A ')))).status,'no-match');
 const tampered=structuredClone(cert);tampered.proof.siblings[0].hash='0'.repeat(64);
 assert.equal((await checkFile(tampered,shaA)).status,'broken');
 const text=JSON.stringify(cert);
 for(const secret of ['WVW-SECRET','84210','odometer','vin',shaB,c.files[1].salt,...c.entries.map(e=>e.salt)])assert.ok(!text.includes(secret),`certificate must not contain ${secret.slice(0,12)}`);
 assert.throws(()=>validateCertificate({...cert,proof:{...cert.proof,domain:'chainbridge/v1/leaf'}}),/proof/);
});

function fakeBlockfrost({root,leafCount,files,inputs,metaMsg,missing=false,down=false}){
 return async url=>{
  if(down)throw new Error('network down');
  const path=new URL(url).pathname.replace('/api/v0','');
  const ok=data=>({ok:true,status:200,json:async()=>data});
  if(missing&&path.startsWith('/txs/'))return {ok:false,status:404,json:async()=>({})};
  if(path==='/blocks/latest')return ok({height:5355400});
  if(path.endsWith('/metadata'))return ok([{label:'674',json_metadata:metaMsg??anchorMetadata({root,leafCount,files,salted:true,jobRef:'x402-test'})}]);
  if(path.endsWith('/utxos'))return ok({inputs:inputs.map(address=>({address}))});
  if(path.startsWith('/txs/'))return ok({block:'b',block_height:5355379,block_time:1793450000});
  return {ok:false,status:404,json:async()=>({})};
 };
}
async function shareSetup(t,opts={}){
 const dir=mkdtempSync(join(tmpdir(),'cb-share-'));t.after(()=>rmSync(dir,{recursive:true}));
 const walletPath=join(dir,'wallet.json');createPublishingWallet(walletPath);
 const w=loadPublishingWallet(walletPath);
 const {c,shaA}=await sealed();
 const session={id:'11111111-2222-3333-4444-555555555555',status:'complete',fingerprint:{root:c.root,leafCount:4,files:2,salted:true},
  publication:{txHash:'cd'.repeat(32),label:674,blockHeight:5355379}};
 const fetchImpl=fakeBlockfrost({root:c.root,leafCount:4,files:2,inputs:[w.address],...opts});
 const svc=createShareService({dir:join(dir,'certs'),walletPath,blockfrostKey:opts.noKey?undefined:'preprodTEST',port:8787,fetchImpl,publicBaseUrl:opts.publicBaseUrl});
 return {svc,session,c,shaA,w};
}
test('Issuing: only for complete jobs and files really in the fingerprint; idempotent; signed by the publishing key',async t=>{
 const {svc,session,c,shaA,w}=await shareSetup(t);
 await assert.rejects(svc.issue({...session,status:'publishing'},fileProof(c,0)),/only after/);
 const forged=fileProof(c,0);forged.file.sha256='e'.repeat(64);
 await assert.rejects(svc.issue(session,forged),/not part of the published fingerprint/);
 const {certificate,link}=await svc.issue(session,fileProof(c,0));
 assert.equal((await svc.issue(session,fileProof(c,0))).certificate.id,certificate.id,'same file, same certificate');
 assert.equal(certificate.issuer.demo,true);assert.match(certificate.issuer.name,/demo/i);assert.equal(certificate.issuer.address,w.address);
 assert.match(certificate.signature,/^[0-9a-f]{128}$/);
 assert.equal((await checkFile(certificate,shaA)).status,'valid');
 assert.equal(link.kind,'local-demo');assert.match(link.url,/^http:\/\/127\.0\.0\.1:8787\/verify\/[0-9a-f]{32}$/);assert.match(link.note,/Local demo link/);
 assert.deepEqual(svc.get(certificate.id).certificate,certificate);
 assert.match(svc.qrSvg(certificate.id),/^<svg/);
 assert.throws(()=>svc.get('0'.repeat(32)),/No certificate/);
 assert.ok(signingBytes(certificate).length>100);
});
test('Checking: Cardano record and issuer signature are valid, tampering and mismatches are reported, and outages are "not checked"',async t=>{
 const {svc,session,c}=await shareSetup(t);
 const {certificate}=await svc.issue(session,fileProof(c,0));
 let r=await svc.check(certificate);
 assert.equal(r.cardano.status,'valid');assert.equal(r.cardano.confirmations,22);assert.equal(r.issuer.status,'valid');
 assert.equal(r.issuer.publishedByThisKey,true);assert.equal(r.issuer.thisServersKey,true);
 r=await svc.check({...certificate,file:{...certificate.file,name:'renamed.pdf'}});
 assert.equal(r.issuer.status,'invalid','any change after signing breaks the signature');
 r=await svc.check({...certificate,commitment:{...certificate.commitment,root:'f'.repeat(64)},signature:undefined,issuer:undefined});
 assert.equal(r.cardano.status,'mismatch');assert.equal(r.issuer.status,'not-checked');

 const other=await shareSetup(t,{inputs:['addr_test1qsomeoneelse']});
 const c2=(await other.svc.issue(other.session,fileProof(other.c,0))).certificate;
 assert.equal((await other.svc.check(c2)).issuer.status,'invalid','signature valid but the record was published by another wallet');

 const down=await shareSetup(t,{down:true});
 r=await down.svc.check((await down.svc.issue(down.session,fileProof(down.c,0))).certificate);
 assert.equal(r.cardano.status,'not-checked');assert.match(r.issuer.detail,/was not checked/);
 const noKey=await shareSetup(t,{noKey:true});
 assert.equal((await noKey.svc.check((await noKey.svc.issue(noKey.session,fileProof(noKey.c,0))).certificate)).cardano.status,'not-checked');
 const missing=await shareSetup(t,{missing:true});
 assert.equal((await missing.svc.check((await missing.svc.issue(missing.session,fileProof(missing.c,0))).certificate)).cardano.status,'not-found');
 const badCount=await shareSetup(t,{leafCount:5});
 assert.equal((await badCount.svc.check((await badCount.svc.issue(badCount.session,fileProof(badCount.c,0))).certificate)).cardano.status,'mismatch');
 await assert.rejects(svc.check({type:'x'}),/Not a valid ChainBridge certificate/);
});
test('Links: public only for a configured non-local address; never a localhost link presented as public',()=>{
 assert.deepEqual(linkBase('https://chainbridge.example.org/',8787),{base:'https://chainbridge.example.org',kind:'public'});
 for(const u of [undefined,'','http://localhost:8787','http://127.0.0.1:8787','http://app.localhost','http://[::1]:8787','not a url','ftp://x.org'])
  assert.equal(linkBase(u,8787).kind,'local-demo',String(u));
});
test('On-chain message lists source files separately from records',()=>{
 const m=anchorMetadata({root:'a'.repeat(64),leafCount:5,files:2,salted:true,jobRef:'j'}).msg;
 assert.ok(m.includes('records: 3')&&m.includes('files: 2'));
 assert.ok(!anchorMetadata({root:'a'.repeat(64),leafCount:5,salted:true,jobRef:'j'}).msg.some(x=>x.startsWith('files')),'unchanged without files');
});
test('Verify page routes: page, certificate lookup, QR and the public check endpoint',async t=>{
 const {svc,session,c}=await shareSetup(t);
 const {certificate}=await svc.issue(session,fileProof(c,0));
 const dir=mkdtempSync(join(tmpdir(),'cb-share-app-'));t.after(()=>rmSync(dir,{recursive:true}));
 const server=createApp({config:{mode:'demo',paid:false,ai:false,reason:'test',port:0},dataDir:dir,journalDir:dir,shares:svc,
  x402:{enabled:false,reason:'test'}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const p of ['/verify',`/verify/${certificate.id}`,'/verify.js','/core/certificate.mjs'])assert.equal((await fetch(base+p)).status,200,p);
 assert.equal((await fetch(base+'/verify/not-an-id')).status,404);
 assert.equal((await (await fetch(`${base}/api/certificates/${certificate.id}`)).json()).certificate.id,certificate.id);
 assert.equal((await fetch(`${base}/api/certificates/${'0'.repeat(32)}`)).status,404);
 assert.match((await fetch(`${base}/api/certificates/${certificate.id}/qr.svg`)).headers.get('content-type'),/svg/);
 const r=await fetch(base+'/api/verify/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({certificate})});
 assert.equal((await r.json()).cardano.status,'valid');
 assert.equal((await fetch(base+'/api/verify/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({certificate:{}})})).status,400);
});
