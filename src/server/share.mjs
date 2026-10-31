// Shareable verification: issues signed file certificates for completed jobs, serves them by identifier with a
// link and QR code, and checks a certificate's Cardano record and issuer signature for the verify page.
//
// The issuer key is the agent's publishing wallet key (the key that signed the Cardano publication). A valid
// signature proves control of that key, nothing more: there is no registry tying it to a real organisation, and
// on Preprod it is always shown as a demo issuer.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {CERT_TYPE,CERT_VERSION,validateCertificate,signingBytes} from '../core/certificate.mjs';
import {fileLeafHash,verifyProof,isHash} from '../core/merkle.mjs';
import {loadPublishingWallet,BLOCKFROST_PREPROD,ANCHOR_LABEL,EXPLORER,parseAnchorMessage} from './cardano-anchor.mjs';

const C=createRequire(import.meta.url)('@emurgo/cardano-serialization-lib-nodejs');
const QR=createRequire(import.meta.url)('qrcode-generator');
export class ShareError extends Error{constructor(status,message){super(message);this.status=status;}}
export const DEMO_ISSUER='ChainBridge demo issuer (Cardano Preprod test network)';
const ISSUER_NOTE='Demo issuer key. A valid signature proves the certificate was signed with this key, which also published the Cardano record. It does not prove which person or organisation owns the key.';

const LOCAL=/^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0|.+\.localhost)$/i;
// Link base: PUBLIC_BASE_URL when it is a real address others can reach; otherwise a local demo link.
export function linkBase(publicBaseUrl,port){
 if(publicBaseUrl){
  let u;try{u=new URL(publicBaseUrl);}catch{u=null;}
  if(u&&/^https?:$/.test(u.protocol)&&!LOCAL.test(u.hostname))return {base:u.origin+u.pathname.replace(/\/$/,''),kind:'public'};
 }
 return {base:`http://127.0.0.1:${port}`,kind:'local-demo'};
}

export function createShareService({dir,walletPath,blockfrostKey,publicBaseUrl,port=8787,fetchImpl=fetch,now=()=>new Date()}){
 mkdirSync(dir,{recursive:true,mode:0o700});
 const file=id=>{if(!/^[0-9a-f]{32}$/.test(id??''))throw new ShareError(400,'Invalid certificate identifier');return join(dir,`${id}.json`);};
 const wallet=()=>walletPath?loadPublishingWallet(walletPath):null;
 const {base,kind}=linkBase(publicBaseUrl,port);
 const link=id=>({url:`${base}/verify/${id}`,kind,
  note:kind==='public'?'Anyone with this link can open the verification page.':'Local demo link: it only opens on a computer running this ChainBridge app. Set PUBLIC_BASE_URL to a public address to share it with other people.'});

 async function bf(path){
  const r=await fetchImpl(BLOCKFROST_PREPROD+path,{headers:{project_id:blockfrostKey},signal:AbortSignal.timeout(20000)});
  if(r.status===404)return null;
  if(!r.ok)throw new Error(`Blockfrost HTTP ${r.status}`);
  return r.json();
 }

 return {
  link,
  // Issue (or return the existing) certificate for one source file of a completed, published job.
  async issue(session,{file:f,proof}){
   if(session?.status!=='complete'||!session.publication?.txHash||!session.fingerprint?.root)throw new ShareError(409,'Certificates can be created only after the fingerprint is published and the job is complete');
   if(!f||!isHash(f.sha256)||!proof||!isHash(proof.leafHash))throw new ShareError(400,'Missing file hash or proof');
   const id=createHash('sha256').update(`${session.id}:${f.sha256}:${proof.salt}`).digest('hex').slice(0,32);
   if(existsSync(file(id)))return {certificate:JSON.parse(readFileSync(file(id),'utf8')),link:link(id)};
   const {root,leafCount}=session.fingerprint;
   const leaf=await fileLeafHash(f.sha256,proof.salt).catch(()=>null);
   if(leaf!==proof.leafHash||proof.leafCount!==leafCount||!await verifyProof(leaf,proof,root))
    throw new ShareError(400,'This file is not part of the published fingerprint');
   const pub=session.publication,w=wallet();
   const cert={type:CERT_TYPE,version:CERT_VERSION,id,network:'cardano-preprod',testNetwork:true,
    file:{name:String(f.name??'file').slice(0,120),sha256:f.sha256},
    commitment:{root,leafCount,files:session.fingerprint.files??null},
    proof:{domain:proof.domain,salt:proof.salt,leafHash:proof.leafHash,leafIndex:proof.leafIndex,leafCount:proof.leafCount,siblings:proof.siblings},
    cardano:{transaction:pub.txHash,metadataLabel:pub.label??ANCHOR_LABEL,blockHeight:pub.blockHeight??null},
    ...(session.version?{series:{id:session.version.series,version:session.version.n,previousTransaction:session.version.prevTx??null}}:{}),
    issuedAt:now().toISOString(),
    statement:'This file matched the fingerprint published in the Cardano transaction when the certificate was issued. A match shows the file is unchanged since it was sealed, not that its contents are true.',
    ...(w?{issuer:{name:DEMO_ISSUER,demo:true,keyType:'ed25519',publicKey:Buffer.from(w.signingKey.to_public().as_bytes()).toString('hex'),address:w.address,note:ISSUER_NOTE}}:{})};
   validateCertificate(cert);
   if(w)cert.signature=w.signingKey.sign(signingBytes(cert)).to_hex();
   writeFileSync(file(id),JSON.stringify(cert),{mode:0o600});
   return {certificate:cert,link:link(id)};
  },
  get(id){
   const f=file(id);
   if(!existsSync(f))throw new ShareError(404,'No certificate with this identifier on this ChainBridge server');
   return {certificate:JSON.parse(readFileSync(f,'utf8')),link:link(id)};
  },
  qrSvg(id){
   this.get(id);
   const q=QR(0,'M');q.addData(link(id).url);q.make();
   return q.createSvgTag({cellSize:6,margin:3,scalable:true});
  },

  // Cardano record and issuer signature. File match is checked in the recipient's browser, not here.
  async check(certificate){
   let c;try{c=validateCertificate(certificate);}catch(e){throw new ShareError(400,e.message);}
   const tx=c.cardano.transaction;
   const cardano={status:'not-checked',transaction:tx,explorer:EXPLORER+tx,checkedBy:'This ChainBridge server, using Blockfrost (Cardano Preprod)'};
   let inputs=null,parsed=null;
   if(!blockfrostKey)cardano.detail='This server has no Cardano data access configured, so the record was not looked up.';
   else try{
    const info=await bf(`/txs/${tx}`);
    if(!info){cardano.status='not-found';cardano.detail='No transaction with this ID exists on Cardano Preprod (or it is not confirmed yet).';}
    else{
     const [meta,latest,utxos]=await Promise.all([bf(`/txs/${tx}/metadata`),bf('/blocks/latest'),bf(`/txs/${tx}/utxos`)]);
     inputs=(utxos?.inputs??[]).map(i=>i.address);
     Object.assign(cardano,{blockHeight:info.block_height,blockTime:new Date(info.block_time*1000).toISOString(),confirmations:latest?.height?latest.height-info.block_height+1:null});
     const msg=(meta??[]).find(m=>String(m.label)===String(ANCHOR_LABEL))?.json_metadata?.msg;
     const num=p=>{const l=Array.isArray(msg)?msg.find(x=>typeof x==='string'&&x.startsWith(p)):null;return l?Number(l.slice(p.length)):null;};
     const records=num('records: '),files=num('files: ');
     cardano.message=Array.isArray(msg)?msg:null;parsed=parseAnchorMessage(msg);
     if(!Array.isArray(msg)||msg[0]!=='ChainBridge data fingerprint v1'){cardano.status='mismatch';cardano.detail='The transaction exists but carries no ChainBridge fingerprint.';}
     else if(msg[2]!==c.commitment.root){cardano.status='mismatch';cardano.detail='The transaction carries a different fingerprint than this certificate.';}
     else if(records===null||records+(files??0)!==c.commitment.leafCount){cardano.status='mismatch';cardano.detail='The fingerprint matches but the record count in the transaction does not.';}
     else{cardano.status='valid';cardano.detail='The transaction contains exactly this fingerprint.';}
    }
   }catch(e){cardano.status='not-checked';cardano.detail=`Cardano could not be reached (${e.message}). Nothing was concluded; try again later or open the transaction yourself.`;}

   const issuer={status:'not-checked',checkedBy:'This ChainBridge server'};
   if(!c.issuer||!c.signature)issuer.detail='This certificate is not signed.';
   else try{
    const pk=C.PublicKey.from_hex(c.issuer.publicKey);
    const sigOk=pk.verify(signingBytes(c),C.Ed25519Signature.from_hex(c.signature));
    const base=C.BaseAddress.from_address(C.Address.from_bech32(c.issuer.address));
    const keyOk=Boolean(base)&&base.payment_cred().to_keyhash()?.to_hex()===pk.hash().to_hex();
    const w=wallet();
    Object.assign(issuer,{name:c.issuer.name,demo:c.issuer.demo===true,publicKey:c.issuer.publicKey,address:c.issuer.address,
     thisServersKey:Boolean(w)&&Buffer.from(w.signingKey.to_public().as_bytes()).toString('hex')===c.issuer.publicKey,
     publishedByThisKey:inputs===null?null:inputs.length>0&&inputs.every(a=>a===c.issuer.address)});
    if(!sigOk){issuer.status='invalid';issuer.detail='The signature does not match this certificate: it was changed after signing, or signed with another key.';}
    else if(!keyOk){issuer.status='invalid';issuer.detail='The signing key does not belong to the issuer address stated in the certificate.';}
    else if(issuer.publishedByThisKey===false){issuer.status='invalid';issuer.detail='The signature is valid, but the Cardano record was published by a different wallet.';}
    else{issuer.status='valid';issuer.detail=issuer.publishedByThisKey?'Signed with the key that also published the Cardano record.':'The signature is valid. Whether this key published the Cardano record was not checked.';}
   }catch(e){issuer.status='invalid';issuer.detail=`The issuer key or signature is malformed (${e.message}).`;}
   // Version link: the series, version number and predecessor in the certificate must match the transaction.
   let version=null;
   if(c.series){
    const s=c.series;
    version=!parsed?{status:'not-checked',detail:'The Cardano record could not be read, so the version was not checked.'}
     :parsed.series!==s.id?{status:'mismatch',detail:'On Cardano this transaction belongs to a different certificate series.'}
     :parsed.version!==s.version?{status:'mismatch',detail:`On Cardano this is version ${parsed.version}, not ${s.version}.`}
     :(parsed.prevTx??null)!==(s.previousTransaction??null)?{status:'mismatch',detail:'On Cardano this version points to a different previous version.'}
     :{status:'valid',detail:s.version===1?'Version 1 of its series, as recorded on Cardano.':`Version ${s.version}, pointing to version ${s.version-1}, as recorded on Cardano.`};
   }
   return {cardano,issuer,version};
  },
 };
}
