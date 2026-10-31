// SHA-256 hashing with domain separation, and a binary Merkle tree with inclusion proofs.
// Uses WebCrypto (globalThis.crypto.subtle), available in browsers and Node 24.
//
// leaf  = SHA-256( 0x00 || "chainbridge/v1/leaf" || 0x00 || salt || 0x00 || canonicalRecord )
// node  = SHA-256( 0x01 || left || right )                 (32-byte raw digests)
// Prefix bytes separate leaves from inner nodes (RFC 6962 style), blocking second-preimage tricks.
// salt is the lowercase hex per-record salt, or empty when salting is off.
// Leaves keep the order given. An odd node at the end of a level is promoted unchanged
// (never duplicated), so [a,b,c] and [a,b,c,c] produce different roots.
// A single leaf's root is the leaf hash. An empty tree has no root and is rejected.
//
// Proof format: {leafIndex, leafCount, siblings:[{side:'left'|'right', hash}]}, ordered leaf to root.
//
// File leaves (added after the record leaves) commit to one source file's SHA-256 on its own, so that file can
// be checked by anyone holding it, without revealing any record:
// fileLeaf = SHA-256( 0x00 || "chainbridge/v1/file" || 0x00 || salt || 0x00 || {"sha256":"<file hash>"} )
// The salt is always set, so the other files' leaves (seen as proof siblings) cannot be matched by guessing files.

export const HASH_ID='sha-256';
export const LEAF_DOMAIN='chainbridge/v1/leaf';
export const FILE_DOMAIN='chainbridge/v1/file';
const enc=new TextEncoder();
const HEX=/^[0-9a-f]{64}$/;

export const toHex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export function fromHex(hex){
 if(typeof hex!=='string'||!HEX.test(hex))throw new Error('Expected a 64-character lowercase hex hash');
 return Uint8Array.from(hex.match(/../g),h=>parseInt(h,16));
}
export const isHash=h=>typeof h==='string'&&HEX.test(h);

function concat(parts){
 const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let o=0;
 for(const p of parts){out.set(p,o);o+=p.length;}
 return out;
}
export async function sha256Hex(data){
 const bytes=typeof data==='string'?enc.encode(data):data;
 return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)));
}

export function randomSalt(){return toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));}

async function domainLeaf(domain,canonical,salt){
 if(salt&&!/^[0-9a-f]{32}$/.test(salt))throw new Error('Salt must be 32 lowercase hex characters');
 return sha256Hex(concat([Uint8Array.of(0),enc.encode(domain),Uint8Array.of(0),enc.encode(salt),Uint8Array.of(0),enc.encode(canonical)]));
}
export const leafHash=(canonical,salt='')=>domainLeaf(LEAF_DOMAIN,canonical,salt);
export async function fileLeafHash(fileSha256,salt){
 if(!isHash(fileSha256))throw new Error('File hash must be a 64-character lowercase hex SHA-256');
 if(!salt)throw new Error('A file leaf needs a salt');
 return domainLeaf(FILE_DOMAIN,`{"sha256":"${fileSha256}"}`,salt);
}
export async function nodeHash(left,right){
 return sha256Hex(concat([Uint8Array.of(1),fromHex(left),fromHex(right)]));
}

export async function buildTree(leaves){
 if(!leaves.length)throw new Error('Cannot build a Merkle tree with no records');
 leaves.forEach(fromHex);
 const levels=[leaves.slice()];
 while(levels.at(-1).length>1){
  const level=levels.at(-1);const next=[];
  for(let i=0;i<level.length;i+=2)next.push(i+1<level.length?await nodeHash(level[i],level[i+1]):level[i]);
  levels.push(next);
 }
 return {root:levels.at(-1)[0],levels};
}
export const merkleRoot=async leaves=>(await buildTree(leaves)).root;

export function merkleProof(levels,leafIndex){
 const leafCount=levels[0].length;
 if(!Number.isInteger(leafIndex)||leafIndex<0||leafIndex>=leafCount)throw new Error('Leaf index out of range');
 const siblings=[];let i=leafIndex;
 for(const level of levels.slice(0,-1)){
  if(i%2===1)siblings.push({side:'left',hash:level[i-1]});
  else if(i+1<level.length)siblings.push({side:'right',hash:level[i+1]});
  i=Math.floor(i/2);
 }
 return {leafIndex,leafCount,siblings};
}

export async function verifyProof(leaf,proof,root){
 if(!isHash(leaf)||!isHash(root)||!Array.isArray(proof?.siblings))return false;
 let h=leaf;
 for(const s of proof.siblings){
  if(!isHash(s?.hash)||!['left','right'].includes(s.side))return false;
  h=s.side==='left'?await nodeHash(s.hash,h):await nodeHash(h,s.hash);
 }
 return h===root;
}
