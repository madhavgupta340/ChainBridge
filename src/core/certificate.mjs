// Shareable file certificates. Used in the browser (create, check a file) and on the server (sign, check issuer).
//
// A certificate lets someone holding one source file check it against the published fingerprint (Merkle root)
// without the uploader's private proof file. It contains only:
//  - the file's name and SHA-256 (anyone with the file can compute that hash anyway),
//  - the salt of that file's own leaf and the sibling hashes up to the root (opaque hashes: they reveal no
//    records, no other files and no salts),
//  - the root, the leaf count and the Cardano transaction that published the root,
//  - for versioned certificates, the series id, version number and previous version's transaction,
//  - optionally an issuer block and an Ed25519 signature over everything else.
// It never contains record values, extracted facts, other files' hashes or other salts.
import {canonicalize} from './canonical.mjs';
import {FILE_DOMAIN,fileLeafHash,isHash,merkleProof,verifyProof} from './merkle.mjs';

export const CERT_TYPE='chainbridge-file-certificate';
export const CERT_VERSION=1;
export const SIGN_DOMAIN='chainbridge/v1/certificate';
const enc=new TextEncoder();
const SALT=/^[0-9a-f]{32}$/;

// The part of a certificate the browser can build from its commitment: file + proof.
export function fileProof(commitment,index){
 const f=commitment.files?.[index];
 if(!f)throw new Error('No such source file in this fingerprint');
 const {siblings,leafCount}=merkleProof(commitment.levels,f.leafIndex);
 return {file:{name:f.name,sha256:f.sha256},proof:{domain:FILE_DOMAIN,salt:f.salt,leafHash:f.leafHash,leafIndex:f.leafIndex,leafCount,siblings}};
}

// Shape checks shared by the browser and the server. Throws with a plain message.
export function validateCertificate(c){
 const fail=m=>{throw new Error(`Not a valid ChainBridge certificate: ${m}`);};
 if(!c||typeof c!=='object'||Array.isArray(c))fail('expected a JSON object');
 if(c.type!==CERT_TYPE||c.version!==CERT_VERSION)fail('unknown type or version');
 if(typeof c.id!=='string'||!/^[0-9a-f]{32}$/.test(c.id))fail('bad identifier');
 if(!c.file||!isHash(c.file.sha256)||typeof c.file.name!=='string')fail('missing file hash');
 const p=c.proof;
 if(!p||p.domain!==FILE_DOMAIN||!SALT.test(p.salt??'')||!isHash(p.leafHash))fail('missing or unknown proof');
 if(!Number.isInteger(p.leafIndex)||!Number.isInteger(p.leafCount)||p.leafIndex<0||p.leafIndex>=p.leafCount)fail('bad proof position');
 if(!Array.isArray(p.siblings)||p.siblings.length>64||!p.siblings.every(s=>isHash(s?.hash)&&['left','right'].includes(s.side)))fail('bad proof path');
 if(!c.commitment||!isHash(c.commitment.root)||c.commitment.leafCount!==p.leafCount)fail('missing fingerprint');
 if(!c.cardano||!isHash(c.cardano.transaction))fail('missing Cardano transaction');
 if(c.series!==undefined&&(!/^s-[0-9a-f]{16}$/.test(c.series?.id??'')||!Number.isInteger(c.series.version)||c.series.version<1||
  (c.series.version===1)!==(c.series.previousTransaction===null)||(c.series.previousTransaction!==null&&!isHash(c.series.previousTransaction))))fail('bad series or version');
 if(c.signature!==undefined&&!/^[0-9a-f]{128}$/.test(c.signature))fail('bad signature format');
 return c;
}

// Bytes the issuer signs: a domain tag plus the canonical JSON of the certificate without its signature.
export function signingBytes(c){
 const {signature,...body}=c;
 return enc.encode(`${SIGN_DOMAIN}\u0000${canonicalize(body)}`);
}

// File match: computed wherever this runs (in the recipient's browser on the verify page). The file itself is
// only hashed, never uploaded.
//   valid        the file's SHA-256 equals the certificate's, and its leaf leads to the certificate's root
//   no-match     the file is different from the sealed one
//   broken       the hash matches but the proof does not lead to the root (damaged or forged certificate)
export async function checkFile(certificate,fileSha256){
 const c=validateCertificate(certificate);
 if(fileSha256!==c.file.sha256)return {status:'no-match',fileSha256,expected:c.file.sha256};
 const leaf=await fileLeafHash(fileSha256,c.proof.salt);
 const ok=leaf===c.proof.leafHash&&await verifyProof(leaf,c.proof,c.commitment.root);
 return {status:ok?'valid':'broken',fileSha256,expected:c.file.sha256,leaf,root:c.commitment.root,steps:c.proof.siblings.length};
}
