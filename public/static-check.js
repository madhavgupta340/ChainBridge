// Checks for the public, static check page (GitHub Pages): no ChainBridge server, no API keys.
//  Cardano record    read in the browser from the public Koios API (Cardano Preprod)
//  Issuer signature  verified in the browser (WebCrypto Ed25519 + BLAKE2b key hash), and whether that key's address
//                    published the transaction
//  Version history   the same chain walk as the server (src/core/versionchain.mjs), over Koios
// When Koios can't be reached or is busy, results are "not checked", never "valid".
import {signingBytes} from './core/certificate.mjs';
import {parseAnchorMessage,EXPLORER} from './core/anchor-message.mjs';
import {walkChain} from './core/versionchain.mjs';
import {keyHash,paymentKeyHash,fromHex} from './core/cardano-address.mjs';

export const KOIOS='https://preprod.koios.rest/api/v1';
const BY='Your browser, using the public Koios API (Cardano Preprod)';
const HEX64=/^[0-9a-f]{64}$/;

export function createStaticBackend({fetchImpl=fetch.bind(globalThis),base=KOIOS,subtle=globalThis.crypto?.subtle}={}){
 async function koios(path,body){
  // A refused or rate-limited request often reaches the page only as a network error (no CORS headers on the reply).
  let r;try{r=await fetchImpl(base+path,{method:body?'POST':'GET',headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});}
  catch{throw new Error('the public Cardano service could not be reached or is busy right now');}
  if(r.status===429)throw new Error('the public Cardano service is busy (rate limit)');
  if(!r.ok)throw new Error(`public Cardano service HTTP ${r.status}`);
  return r.json();
 }
 // One transaction: {found, record, blockHeight, blockTime, inputs, message}.
 async function tx(hash){
  if(!HEX64.test(hash??''))throw Object.assign(new Error('bad id'),{userMessage:'A Cardano transaction ID is 64 hexadecimal characters.'});
  const [t]=await koios('/tx_info',{_tx_hashes:[hash],_inputs:true,_metadata:true,_assets:false,_withdrawals:false,_certs:false,_scripts:false,_bytecode:false});
  if(!t)return {found:false};
  const meta=t.metadata;
  const msg=(Array.isArray(meta)?meta.find(m=>String(m.key??m.label)==='674')?.json:meta?.['674'])?.msg;
  return {found:true,record:parseAnchorMessage(msg),message:Array.isArray(msg)?msg:null,blockHeight:t.block_height,
   blockTime:new Date(Number(t.tx_timestamp)*1000).toISOString(),inputs:(t.inputs??[]).map(i=>i.payment_addr?.bech32).filter(Boolean)};
 }

 return {
  label:'public',
  chain:(txHash,{expectedRoot=null}={})=>walkChain(tx,txHash,{expectedRoot}),
  async check(c){
   const hash=c.cardano.transaction;
   const cardano={status:'not-checked',transaction:hash,explorer:EXPLORER+hash,checkedBy:BY};
   let t=null;
   try{
    t=await tx(hash);
    if(!t.found){cardano.status='not-found';cardano.detail='No transaction with this ID exists on Cardano Preprod (or it is not confirmed yet).';}
    else{
     let tip=null;try{tip=(await koios('/tip'))?.[0]?.block_no??null;}catch{}
     Object.assign(cardano,{blockHeight:t.blockHeight,blockTime:t.blockTime,confirmations:tip?tip-t.blockHeight+1:null,message:t.message});
     const r=t.record;
     if(!r){cardano.status='mismatch';cardano.detail='The transaction exists but carries no ChainBridge fingerprint.';}
     else if(r.root!==c.commitment.root){cardano.status='mismatch';cardano.detail='The transaction carries a different fingerprint than this certificate.';}
     else if(r.records===null||r.records+(r.files??0)!==c.commitment.leafCount){cardano.status='mismatch';cardano.detail='The fingerprint matches but the record count in the transaction does not.';}
     else{cardano.status='valid';cardano.detail='The transaction contains exactly this fingerprint.';}
    }
   }catch(e){cardano.detail=`Cardano could not be checked from this page: ${e.message}. Nothing was concluded; open the transaction link to check it yourself.`;}

   let version=null;
   if(c.series){
    const r=t?.record,s=c.series;
    version=!r?{status:'not-checked',detail:'The Cardano record could not be read, so the version was not checked.'}
     :r.series!==s.id?{status:'mismatch',detail:'On Cardano this transaction belongs to a different certificate series.'}
     :r.version!==s.version?{status:'mismatch',detail:`On Cardano this is version ${r.version}, not ${s.version}.`}
     :(r.prevTx??null)!==(s.previousTransaction??null)?{status:'mismatch',detail:'On Cardano this version points to a different previous version.'}
     :{status:'valid',detail:s.version===1?'Version 1 of its series, as recorded on Cardano.':`Version ${s.version}, pointing to version ${s.version-1}, as recorded on Cardano.`};
   }

   const issuer={status:'not-checked',checkedBy:'Your browser'};
   if(!c.issuer||!c.signature)issuer.detail='This certificate is not signed.';
   else if(!subtle)issuer.detail='This browser cannot verify signatures.';
   else try{
    const key=await subtle.importKey('raw',fromHex(c.issuer.publicKey),{name:'Ed25519'},false,['verify']);
    const sigOk=await subtle.verify({name:'Ed25519'},key,fromHex(c.signature),signingBytes(c));
    const keyOk=paymentKeyHash(c.issuer.address)===keyHash(c.issuer.publicKey);
    const published=t?.found&&t.inputs?.length?t.inputs.every(a=>a===c.issuer.address):null;
    Object.assign(issuer,{name:c.issuer.name,demo:c.issuer.demo===true,publicKey:c.issuer.publicKey,address:c.issuer.address,publishedByThisKey:published});
    if(!sigOk){issuer.status='invalid';issuer.detail='The signature does not match this certificate: it was changed after signing, or signed with another key.';}
    else if(!keyOk){issuer.status='invalid';issuer.detail='The signing key does not belong to the issuer address stated in the certificate.';}
    else if(published===false){issuer.status='invalid';issuer.detail='The signature is valid, but the Cardano record was published by a different wallet.';}
    else{issuer.status='valid';issuer.detail=published?'Signed with the key that also published the Cardano record.':'The signature is valid. Whether this key published the Cardano record was not checked.';}
   }catch(e){
    if(e?.name==='NotSupportedError')issuer.detail='This browser does not support Ed25519 signatures yet, so the signature was not checked.';
    else{issuer.status='invalid';issuer.detail=`The issuer key or signature is malformed (${e.message}).`;}
   }
   return {cardano,issuer,version};
  },
 };
}
