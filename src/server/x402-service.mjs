// The ChainBridge paid service over x402 (direct payment, no escrow).
//
//  quote      free: price from local measurements (src/core/pricing.mjs)
//  402        the seller states the payment requirements for that quote (PAYMENT-REQUIRED)
//  pay        the buyer's signed, unbroadcast payment arrives (PAYMENT-SIGNATURE); the facilitator verifies it.
//             The paid work is now unlocked, but nothing has been charged yet.
//  analyze    paid: AI analysis of a masked sample (suggested tidy-up steps)
//  publish    paid: fingerprint check, publication on Cardano, then settlement of the payment.
//             If the work fails before publication, the payment is never broadcast: the buyer is not charged.
//
// Sessions are journalled to disk before every external write; uncertain outcomes are never retried blindly.
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {encodePaymentRequiredHeader,encodePaymentSignatureHeader,decodePaymentSignatureHeader} from '@x402/core/http';
import {quote as priceQuote} from '../core/pricing.mjs';
import {merkleRoot,isHash} from '../core/merkle.mjs';
import {parseJobInput} from '../core/job.mjs';
import {buildUnsignedPayment,attachWitnesses,paymentPayloadFor,X402_NETWORK} from './x402-pay.mjs';
import {describeDocument,sha256Hex,DOC_LIMITS} from '../core/documents.mjs';
import {versionLines} from './cardano-anchor.mjs';

export class X402Error extends Error{constructor(status,message){super(message);this.status=status;}}
const ID=/^[0-9a-f-]{36}$/;

export function createX402Service({dir,seller,blockfrostKey,analyze,extract,publish,audit,resourceBase,maxTimeoutSeconds=1800}){
 mkdirSync(dir,{recursive:true,mode:0o700});
 const file=id=>{if(!ID.test(id))throw new X402Error(400,'Invalid session');return join(dir,`${id}.json`);};
 const load=id=>{const f=file(id);if(!existsSync(f))throw new X402Error(404,'Unknown quote or session');return JSON.parse(readFileSync(f,'utf8'));};
 const save=s=>{s.updatedAt=new Date().toISOString();writeFileSync(file(s.id),JSON.stringify(s),{mode:0o600});return s;};
 const log=(s,event,extra={})=>audit?.append({event,taskId:s.id,kind:'x402',mode:'x402',network:'Preprod',price:`${s.quote.totalLovelace/1e6} tADA`,
  paymentStatus:s.status,recordCount:s.quote.measurements.records??s.quote.measurements.documents,...extra});
 const view=s=>({id:s.id,status:s.status,quote:s.quote,payer:s.payer??null,fingerprint:s.fingerprint??null,version:s.version??null,analysis:s.analysis??null,extraction:s.extraction??null,publication:s.publication??null,
  settlement:s.settlement??null,error:s.error??null,createdAt:s.createdAt,paidAt:s.paidAt??null,expiresAt:s.expiresAt??null});
 const needPaid=s=>{
  if(!['paid','analyzed'].includes(s.status))throw new X402Error(402,s.status==='quoted'?'Payment required':`Session is ${s.status}`);
  if(s.expiresAt&&Date.now()>Date.parse(s.expiresAt))throw new X402Error(410,'The signed payment has expired. Nothing was charged. Start a new quote.');
 };

 return {
  get:id=>view(load(id)),
  // Saved session for the certificate issuer (it only reads status, fingerprint and publication).
  raw:id=>{const {payment,...rest}=load(id);return rest;},

  // 1. Free quote. Only measurements (counts) are sent, no data.
  quote(measurements){
   let q;try{q=priceQuote(measurements);}catch(e){throw new X402Error(400,e.message);}
   const s=save({id:randomUUID(),status:'quoted',quote:q,createdAt:new Date().toISOString()});
   log(s,'x402_quote');return view(s);
  },

  // 2. HTTP 402: payment requirements for the quoted price.
  async paymentRequired(id){
   const s=load(id);
   if(s.status!=='quoted')throw new X402Error(409,`Session is ${s.status}`);
   if(!s.requirements){
    const r=await seller.paymentRequired({lovelace:s.quote.totalLovelace,maxTimeoutSeconds,resource:`${resourceBase}/x402/session/${s.id}`,
     description:`ChainBridge service for ${s.quote.measurements.records} records`});
    s.requirements=r.requirements;s.paymentRequired=r.paymentRequired;save(s);
   }
   return {paymentRequired:s.paymentRequired,header:encodePaymentRequiredHeader(s.paymentRequired)};
  },

  // Helper for browser wallets: an unsigned payment transaction exactly matching the requirements.
  async buildPayment(id,{buyerAddress}){
   const s=load(id);
   if(s.status!=='quoted'||!s.requirements)throw new X402Error(409,'Request the payment requirements first');
   if(!/^addr_test1[0-9a-z]+$/.test(buyerAddress||''))throw new X402Error(400,'The wallet must be a Cardano Preprod (test network) wallet');
   try{return await buildUnsignedPayment({buyerAddress,payTo:s.requirements.payTo,lovelace:s.requirements.amount,maxTimeoutSeconds,blockfrostKey});}
   catch(e){throw new X402Error(400,e.message);}
  },
  // Helper: wallet witness + unsigned tx -> PAYMENT-SIGNATURE header value (official x402 client scheme).
  async signatureHeader(id,{unsignedTx,witnessSet,nonce}){
   const s=load(id);
   if(!s.paymentRequired)throw new X402Error(409,'Request the payment requirements first');
   let transaction;try{transaction=attachWitnesses(unsignedTx,witnessSet);}catch(e){throw new X402Error(400,e.message);}
   const payload=await paymentPayloadFor(s.paymentRequired,{transaction,nonce},s.requirements.amount);
   return {header:encodePaymentSignatureHeader(payload)};
  },

  // 3. Payment: verified by the facilitator, not yet broadcast. Unlocks the paid work.
  async pay(id,header){
   const s=load(id);
   if(s.status!=='quoted')throw new X402Error(409,`Session is already ${s.status}`);
   if(!s.requirements)throw new X402Error(402,'Payment required');
   let payload;try{payload=decodePaymentSignatureHeader(header);}catch{throw new X402Error(400,'Invalid PAYMENT-SIGNATURE header');}
   const v=await seller.verify(payload,s.requirements);
   if(!v?.isValid){log(s,'x402_verify_failed',{reason:'invalid payment'});throw new X402Error(402,`Payment not accepted: ${v?.invalidReason??'invalid'}`);}
   s.status='paid';s.payment=payload;s.payer=v.payer;s.paidAt=new Date().toISOString();
   s.expiresAt=new Date(Date.now()+(maxTimeoutSeconds-120)*1000).toISOString();
   save(s);log(s,'x402_payment_verified',{approval:'signed by buyer'});
   return view(s);
  },

  // 4. Paid: AI analysis of the masked sample.
  async analyze(id,sample){
   const s=load(id);needPaid(s);
   if((s.analysisCalls??0)>=3)throw new X402Error(429,'Analysis limit reached for this session');
   if(!sample||!['masked','names'].includes(sample.shareMode))throw new X402Error(400,'Only a masked or names-only sample is accepted');
   s.analysisCalls=(s.analysisCalls??0)+1;save(s);
   if(!analyze)throw new X402Error(503,'No AI provider is configured for the agent');
   try{s.analysis=await analyze(sample);}catch(e){throw new X402Error(502,`AI analysis failed: ${e.message}. Nothing has been charged.`);}
   s.status='analyzed';save(s);log(s,'x402_analyzed');
   return view(s);
  },

  // 4b. Paid: AI extraction from documents (PDFs, images). Documents are processed in memory and never stored.
  async extract(id,{documents,consent}){
   const s=load(id);needPaid(s);
   if(s.quote.measurements.kind!=='documents')throw new X402Error(400,'This job was quoted for a table, not for documents');
   if(consent!==true)throw new X402Error(400,'Sending the documents to the AI service needs your consent');
   if(!Array.isArray(documents)||!documents.length)throw new X402Error(400,'No documents');
   if(documents.length>s.quote.measurements.documents)throw new X402Error(400,`The quote covered ${s.quote.measurements.documents} document(s)`);
   if((s.extractionRuns??0)>=2)throw new X402Error(429,'Extraction limit reached for this job');
   if(!extract)throw new X402Error(503,'No AI provider is configured for the agent');
   const parsed=[];let pages=0,total=0;
   for(const d of documents){
    const bytes=Buffer.from(String(d?.data??''),'base64');total+=bytes.length;
    let info;try{info=describeDocument(d?.name??'document',new Uint8Array(bytes));}catch(e){throw new X402Error(400,e.message);}
    pages+=info.pages;parsed.push({...info,data:bytes.toString('base64'),sha256:await sha256Hex(new Uint8Array(bytes))});
   }
   if(total>DOC_LIMITS.maxTotalBytes)throw new X402Error(413,'Documents too large in total');
   if(pages>s.quote.measurements.pages)throw new X402Error(400,`The quote covered ${s.quote.measurements.pages} page(s); these documents have ${pages}. Request a new quote.`);
   s.extractionRuns=(s.extractionRuns??0)+1;save(s);
   const results=[];
   for(const d of parsed){
    try{results.push({name:d.name,type:d.type,pages:d.pages,bytes:d.bytes,sha256:d.sha256,...await extract({name:d.name,mime:d.mime,data:d.data})});}
    catch(e){throw new X402Error(502,`AI extraction failed for ${d.name}: ${e.message}. Nothing has been charged.`);}
   }
   s.extraction=results;s.status='analyzed';save(s);log(s,'x402_extracted');
   return view(s);
  },

  // 5. Paid: check the fingerprint, publish it on Cardano, then settle the payment.
  // `files`: how many of the leaves are source-file leaves (after the record leaves), for shareable certificates.
  // `version` (optional): {series, n, prevTx} makes this job version n of a certificate series (see versions.mjs).
  async publish(id,{payload,leaves,files=0,version=null}){
   const s=load(id);
   if(s.status==='complete')return view(s);
   if(['publishing','settling'].includes(s.status))throw new X402Error(409,`A previous ${s.status} step was interrupted. It needs inspection before retrying.`);
   needPaid(s);
   try{parseJobInput(JSON.stringify({service:'chainbridge',version:1,task:'anchor',payload,leaves}));}catch(e){throw new X402Error(400,e.message);}
   const quoted=s.quote.measurements.kind==='documents'?s.quote.measurements.documents:s.quote.measurements.records;
   const maxFiles=s.quote.measurements.kind==='documents'?s.quote.measurements.documents:1;
   if(!Number.isInteger(files)||files<0||files>maxFiles||files>=leaves.length)throw new X402Error(400,`At most ${maxFiles} source file(s) can be added to this fingerprint`);
   if(leaves.length-files>quoted)throw new X402Error(400,`The quote covered ${quoted} records; this fingerprint has ${leaves.length-files}. Request a new quote.`);
   if(version){
    version={series:version.series,n:version.n,prevTx:version.prevTx??null};
    try{versionLines(version);}catch(e){throw new X402Error(400,e.message);}
    if(s.version&&JSON.stringify(s.version)!==JSON.stringify(version))throw new X402Error(409,'This job is already a different certificate version');
   }
   const root=await merkleRoot(leaves);
   if(root!==payload.root||!isHash(root))throw new X402Error(400,'The fingerprint does not match the record fingerprints. Nothing was published or charged.');
   s.status='publishing';s.fingerprint={root,leafCount:leaves.length,files,salted:payload.salted};if(version)s.version=version;save(s);
   try{s.publication=await publish({root,leafCount:leaves.length,files,salted:payload.salted,version,jobRef:`x402-${s.id.slice(0,24)}`});}
   catch(e){s.status='failed';s.error=`Publishing failed: ${e.message}. The payment was not broadcast, so nothing was charged.`;save(s);log(s,'x402_publish_failed');throw new X402Error(502,s.error);}
   s.status='settling';save(s);log(s,'x402_published',{commitment:root,txHash:s.publication.txHash});
   try{
    const r=await seller.settle(s.payment,s.requirements);
    s.settlement={success:!!r.success,transaction:r.transaction??null,network:r.network??X402_NETWORK,status:r.extra?.status??null,errorReason:r.errorReason??null};
    s.status=r.success?'complete':'settle-failed';
    if(!r.success)s.error=`The fingerprint was published, but the payment could not be settled (${r.errorReason??'unknown'}).`;
   }catch(e){s.status='needs-inspection';s.error=`Settlement outcome unknown: ${e.message}. Check the payer wallet before retrying.`;}
   save(s);log(s,s.status==='complete'?'x402_settled':'x402_settle_problem',{txHash:s.settlement?.transaction??undefined});
   return view(s);
  },
 };
}
