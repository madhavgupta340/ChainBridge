// HTTP routes for the x402 paid service. GET/POST /x402/session/:id is the x402-protected resource
// (402 + PAYMENT-REQUIRED without payment, PAYMENT-SIGNATURE to pay); /api/x402/* are helpers for the app.
import {createRequire} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createSeller,buildUnsignedPayment,paymentPayloadFor,addressToBech32,DEFAULT_FACILITATOR} from './x402-pay.mjs';
import {createX402Service,X402Error} from './x402-service.mjs';
import {createPublishingWallet,loadPublishingWallet,BLOCKFROST_PREPROD} from './cardano-anchor.mjs';
import {encodePaymentSignatureHeader} from '@x402/core/http';

const C=createRequire(import.meta.url)('@emurgo/cardano-serialization-lib-nodejs');

export function x402Settings(root,env=process.env){
 let payTo=env.X402_PAY_TO?.trim();
 const state=join(root,'docs/payment-state.json');
 if(!payTo&&existsSync(state))payTo=JSON.parse(readFileSync(state,'utf8')).sellerAddress;
 const blockfrostKey=env.BLOCKFROST_API_KEY_PREPROD?.replace(/"/g,'').trim();
 const publishingWallet=join(root,'.local/publishing-wallet.json');
 const enabled=Boolean(payTo&&blockfrostKey&&existsSync(publishingWallet));
 return {enabled,payTo,blockfrostKey,publishingWallet,demoWallet:join(root,'.local/demo-buyer-wallet.json'),
  facilitator:env.X402_FACILITATOR_URL?.trim()||DEFAULT_FACILITATOR,
  reason:enabled?'x402 payments on Cardano Preprod':!payTo?'No ChainBridge receiving address (docs/payment-state.json or X402_PAY_TO)':!blockfrostKey?'BLOCKFROST_API_KEY_PREPROD is not set':'No publishing wallet (npm run publish-wallet)'};
}

// Read-only: finds the buyer's signed payment on Cardano by its own transaction ID (the signed transaction is exactly
// what settlement broadcasts). paid: confirmed and pays at least the quoted amount to ChainBridge; not-found: not on
// Cardano, inputs still unspent; cannot-settle: its inputs were spent by another transaction; mismatch: wrong amount.
export function paymentFinder(blockfrostKey,fetchImpl=fetch){
 const bf=async path=>{
  const r=await fetchImpl(BLOCKFROST_PREPROD+path,{headers:{project_id:blockfrostKey},signal:AbortSignal.timeout(20000)});
  if(r.status===404)return null;
  if(!r.ok)throw new Error(`Blockfrost HTTP ${r.status}`);
  return r.json();
 };
 return async({payment,requirements})=>{
  const tx=C.FixedTransaction.from_bytes(Buffer.from(String(payment?.payload?.transaction??''),'base64'));
  const txHash=tx.transaction_hash().to_hex();
  const info=await bf(`/txs/${txHash}`);
  if(info){
   const u=await bf(`/txs/${txHash}/utxos`);
   const paid=(u?.outputs??[]).filter(o=>o.address===requirements.payTo).reduce((n,o)=>n+Number(o.amount.find(a=>a.unit==='lovelace')?.quantity??0),0);
   return paid>=Number(requirements.amount)?{status:'paid',txHash,blockHeight:info.block_height}:{status:'mismatch',txHash};
  }
  const inputs=tx.body().inputs();
  for(let i=0;i<inputs.len();i++){
   const inp=inputs.get(i),u=await bf(`/txs/${inp.transaction_id().to_hex()}/utxos`);
   const out=(u?.outputs??[]).find(o=>o.output_index===inp.index());
   if(out?.consumed_by_tx&&out.consumed_by_tx!==txHash)return {status:'cannot-settle',txHash,spentBy:out.consumed_by_tx};
  }
  return {status:'not-found',txHash};
 };
}

async function balance(address,key){
 const r=await fetch(`${BLOCKFROST_PREPROD}/addresses/${address}`,{headers:{project_id:key},signal:AbortSignal.timeout(15000)});
 if(r.status===404)return 0;
 const j=await r.json();return Number(j.amount?.find(a=>a.unit==='lovelace')?.quantity??0)/1e6;
}

export function createX402Routes({settings,dataDir,audit,analyze,extract,publish,resourceBase,shares,versions}){
 let service;
 async function svc(){
  if(!settings.enabled)throw new X402Error(503,`x402 payments are not set up: ${settings.reason}`);
  if(!service)service=createX402Service({dir:join(dataDir,'x402'),seller:await createSeller({facilitatorUrl:settings.facilitator,payTo:settings.payTo}),
   blockfrostKey:settings.blockfrostKey,analyze,extract,publish,audit,resourceBase,findPayment:settings.blockfrostKey?paymentFinder(settings.blockfrostKey):undefined});
  return service;
 }
 const json=(res,status,data,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(data));};

 return async function handle(req,res,url,readBody){
  const p=url.pathname;
  if(!p.startsWith('/x402/')&&!p.startsWith('/api/x402/'))return false;
  try{
   if(req.method==='GET'&&p==='/api/x402/info'){
    const info={enabled:settings.enabled,reason:settings.reason,network:'cardano:preprod',payTo:settings.payTo??null,facilitator:settings.facilitator,currency:'tADA'};
    if(existsSync(settings.demoWallet)&&settings.blockfrostKey){const w=loadPublishingWallet(settings.demoWallet);info.demoWallet={address:w.address,balance:await balance(w.address,settings.blockfrostKey).catch(()=>null)};}
    return json(res,200,info),true;
   }
   // The x402-protected resource itself.
   let m=p.match(/^\/x402\/session\/([0-9a-f-]{36})$/);
   if(m){
    const s=await svc();const sig=req.headers['payment-signature'];
    if(!sig){
     const view=s.get(m[1]);
     if(view.status!=='quoted')return json(res,200,view),true;
     const {paymentRequired,header}=await s.paymentRequired(m[1]);
     return json(res,402,paymentRequired,{'PAYMENT-REQUIRED':header}),true;
    }
    if(req.method!=='POST')throw new X402Error(405,'Send the payment with POST');
    await readBody();
    return json(res,200,await s.pay(m[1],String(sig))),true;
   }
   if(req.method!=='POST'&&!/^\/api\/x402\/session\/[0-9a-f-]{36}$/.test(p))throw new X402Error(405,'Method not allowed');
   if(req.method==='GET'){m=p.match(/^\/api\/x402\/session\/([0-9a-f-]{36})$/);return json(res,200,(await svc()).get(m[1])),true;}
   const data=await readBody(/\/extract$/.test(p)?36*1024*1024:64*1024);
   if(p==='/api/x402/quote')return json(res,201,(await svc()).quote(data.measurements)),true;
   m=p.match(/^\/api\/x402\/session\/([0-9a-f-]{36})\/(build|signature|demo-pay|analyze|extract|publish|share|check-payment)$/);
   if(!m)return json(res,404,{error:'Not found'}),true;
   const s=await svc();const [,id,action]=m;
   if(action==='build')return json(res,200,await s.buildPayment(id,{buyerAddress:addressToBech32(String(data.buyerAddress||''))})),true;
   if(action==='signature')return json(res,200,await s.signatureHeader(id,data)),true;
   if(action==='analyze')return json(res,200,await s.analyze(id,data.sample)),true;
   if(action==='extract')return json(res,200,await s.extract(id,{documents:data.documents,consent:data.consent})),true;
   if(action==='publish'){
    // Certificate version (optional). For version 2+, the predecessor is read from Cardano and must be the same
    // series and the previous version number, before anything is published or charged.
    const v=data.version??null;
    if(v&&v.n>1&&s.raw(id).status!=='complete'){
     const p=await versions.predecessor(v.prevTx);
     if(p.series!==v.series)throw new X402Error(409,'The previous version belongs to a different certificate series. Nothing was published or charged.');
     if(p.version!==v.n-1)throw new X402Error(409,`The previous transaction is version ${p.version}, so the next one is version ${p.version+1}, not ${v.n}. Nothing was published or charged.`);
    }
    return json(res,200,await s.publish(id,{payload:data.payload,leaves:data.leaves,files:data.files??0,version:v})),true;
   }
   if(action==='check-payment')return json(res,200,await s.reconcile(id)),true;
   if(action==='share'){
    // A signed certificate for one source file of this completed job (file hash + proof only, no records).
    const r=await shares.issue(s.raw(id),{file:data.file,proof:data.proof});
    audit?.append({event:'certificate_issued',taskId:id,kind:'x402',mode:'x402',network:'Preprod',certificateId:r.certificate.id,linkKind:r.link.kind});
    return json(res,200,r),true;
   }
   if(action==='demo-pay'){
    // Demo buyer wallet on this laptop (test network only), for demos without a browser wallet extension.
    if(!existsSync(settings.demoWallet))throw new X402Error(400,'No demo test wallet. Run: npm run demo-wallet');
    const w=loadPublishingWallet(settings.demoWallet);
    const {paymentRequired}=await s.paymentRequired(id);
    const u=await s.buildPayment(id,{buyerAddress:w.address});
    const fixed=C.FixedTransaction.from_bytes(Buffer.from(u.unsignedTx,'hex'));fixed.sign_and_add_vkey_signature(w.signingKey);
    const payload=await paymentPayloadFor(paymentRequired,{transaction:Buffer.from(fixed.to_bytes()).toString('base64'),nonce:u.nonce},paymentRequired.accepts[0].amount);
    return json(res,200,await s.pay(id,encodePaymentSignatureHeader(payload))),true;
   }
  }catch(e){
   if(e instanceof X402Error||Number.isInteger(e?.status))return json(res,e.status,{error:e.message}),true;
   console.error('x402 request failed:',e.message);return json(res,500,{error:`Request failed: ${e.message}. Check the session before retrying.`}),true;
  }
  return false;
 };
}
export {createPublishingWallet as createWalletFile};
