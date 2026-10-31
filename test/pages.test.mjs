import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPages} from '../scripts/build-pages.mjs';
import {buildCommitment} from '../src/core/commitment.mjs';
import {fileProof} from '../src/core/certificate.mjs';
import {createShareService} from '../src/server/share.mjs';
import {createPublishingWallet,loadPublishingWallet,anchorMetadata,walletFromEntropy} from '../src/server/cardano-anchor.mjs';
import {blake2b,toHex,keyHash,paymentKeyHash,bech32Decode} from '../src/core/cardano-address.mjs';
import {createHash} from 'node:crypto';

const tx=n=>String(n).repeat(64).slice(0,64);
const SERIES='s-0123456789abcdef';

test('BLAKE2b and address decoding match Node and the Cardano library',()=>{
 for(const data of [new Uint8Array(0),new TextEncoder().encode('abc'),new Uint8Array(300).map((_,i)=>i&255)])
  assert.equal(toHex(blake2b(data,64)),createHash('blake2b512').update(data).digest('hex'));
 const w=walletFromEntropy('ab'.repeat(32)),pk=w.signingKey.to_public();
 assert.equal(keyHash(Buffer.from(pk.as_bytes()).toString('hex')),pk.hash().to_hex());
 assert.equal(paymentKeyHash(w.address),pk.hash().to_hex());
 assert.throws(()=>bech32Decode(w.address.slice(0,-1)+(w.address.endsWith('q')?'p':'q')),/checksum/);
});

test('The public page build contains only static files: no server code, keys or absolute paths',t=>{
 const out=buildPages(mkdtempSync(join(tmpdir(),'cb-pages-')));t.after(()=>rmSync(out,{recursive:true}));
 const files=readdirSync(out,{recursive:true}).map(String);
 assert.ok(files.includes('index.html')&&files.includes('main.js')&&files.includes(join('core','certificate.mjs')));
 assert.ok(!files.some(f=>/server|\.env|wallet|\.local/.test(f)),'no server code or secrets');
 for(const f of files.filter(f=>/\.(js|mjs|css|html)$/.test(f))){
  const text=readFileSync(join(out,f),'utf8');
  assert.ok(!/['"]\/core\/|url\(\/fonts\//.test(text),`${f} has an absolute path`);
  assert.ok(!/BLOCKFROST|MODEL_API_KEY|preprod[A-Za-z0-9]{20,}/.test(text),`${f} mentions a secret`);
 }
 assert.match(readFileSync(join(out,'index.html'),'utf8'),/connect-src https:\/\/preprod\.koios\.rest/);
});

// Fake Koios: tx_info by hash (metadata as an object keyed by label, like Koios), tip, optional rate limit.
function koios(txs,{limited=false,arrayMeta=false}={}){
 return async(url,opts)=>{
  if(limited)return {ok:false,status:429,json:async()=>({})};
  const p=new URL(url).pathname;const ok=d=>({ok:true,status:200,json:async()=>d});
  if(p.endsWith('/tip'))return ok([{block_no:5000100}]);
  const hash=JSON.parse(opts.body)._tx_hashes[0];const t=txs.find(x=>x.hash===hash);
  if(!t)return ok([]);
  return ok([{tx_hash:hash,block_height:5000000+t.n,tx_timestamp:1793400000+t.n*60,inputs:(t.inputs??[]).map(a=>({payment_addr:{bech32:a}})),
   metadata:arrayMeta?[{key:'674',json:{msg:t.msg}}]:{674:{msg:t.msg}}}]);
 };
}
async function setup(t){
 const out=buildPages(mkdtempSync(join(tmpdir(),'cb-pages-')));t.after(()=>rmSync(out,{recursive:true}));
 const {createStaticBackend}=await import(pathToFileURL(join(out,'static-check.js')).href);
 const dir=mkdtempSync(join(tmpdir(),'cb-pages-w-'));t.after(()=>rmSync(dir,{recursive:true}));
 const wp=join(dir,'w.json');createPublishingWallet(wp);const w=loadPublishingWallet(wp);
 const c=await buildCommitment({records:[{sourceRow:1,values:{a:'1'}}],plan:{version:1,fields:['a'],strategy:'merkle-root',ordering:'source',salt:'per-record',duplicates:'keep'},files:[{name:'r.pdf',sha256:'ab'.repeat(32)}]});
 const share=createShareService({dir:join(dir,'c'),walletPath:wp});
 const {certificate}=await share.issue({id:'11111111-2222-3333-4444-555555555555',status:'complete',fingerprint:{root:c.root,leafCount:2,files:1},
  version:{series:SERIES,n:2,prevTx:tx(1)},publication:{txHash:tx(2),label:674}},fileProof(c,0));
 const chain=[{hash:tx(1),n:1,inputs:[w.address],msg:anchorMetadata({root:'1e'.repeat(32),leafCount:2,files:1,salted:true,jobRef:'j1',version:{series:SERIES,n:1,prevTx:null}}).msg},
  {hash:tx(2),n:2,inputs:[w.address],msg:anchorMetadata({root:c.root,leafCount:2,files:1,salted:true,jobRef:'j2',version:{series:SERIES,n:2,prevTx:tx(1)}}).msg}];
 return {createStaticBackend,certificate,chain,w};
}

test('Public page checks: Cardano record, version link and the issuer signature, all in the browser',async t=>{
 const {createStaticBackend,certificate,chain}=await setup(t);
 for(const arrayMeta of [false,true]){
  const r=await createStaticBackend({fetchImpl:koios(chain,{arrayMeta})}).check(certificate);
  assert.equal(r.cardano.status,'valid');assert.equal(r.cardano.confirmations,99);
  assert.equal(r.version.status,'valid');
  assert.equal(r.issuer.status,'valid');assert.equal(r.issuer.publishedByThisKey,true);
 }
 let r=await createStaticBackend({fetchImpl:koios(chain)}).check({...certificate,file:{...certificate.file,name:'edited.pdf'}});
 assert.equal(r.issuer.status,'invalid','a changed certificate fails the signature check in the browser');
 r=await createStaticBackend({fetchImpl:koios(chain.map(x=>({...x,inputs:['addr_test1qsomeoneelse']})))}).check(certificate);
 assert.match(r.issuer.detail,/different wallet/);
 const ch=await createStaticBackend({fetchImpl:koios(chain)}).chain(tx(2),{expectedRoot:certificate.commitment.root});
 assert.equal(ch.complete,true);assert.deepEqual(ch.versions.map(v=>v.version),[2,1]);
});

test('When the public Cardano service is busy or missing the transaction, nothing is shown as valid',async t=>{
 const {createStaticBackend,certificate,chain}=await setup(t);
 let r=await createStaticBackend({fetchImpl:koios(chain,{limited:true})}).check(certificate);
 assert.equal(r.cardano.status,'not-checked');assert.match(r.cardano.detail,/busy/);
 assert.equal(r.version.status,'not-checked');
 assert.equal(r.issuer.status,'valid');assert.equal(r.issuer.publishedByThisKey,null,'signature still checked offline; publisher not checked');
 assert.equal((await createStaticBackend({fetchImpl:koios(chain,{limited:true})}).chain(tx(2))).versions[0].tx.status,'not-checked');
 r=await createStaticBackend({fetchImpl:koios([])}).check(certificate);
 assert.equal(r.cardano.status,'not-found');
});
