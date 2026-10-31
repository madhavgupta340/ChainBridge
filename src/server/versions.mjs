// Linked certificate versions, read from Cardano only. Nothing is stored: every answer comes from the transactions.
//
// A certificate series is a random, opaque id (s-<16 hex>). Version 1 is published with no predecessor; version n
// carries "prev tx:" pointing to version n-1's transaction (see cardano-anchor.mjs). Given the latest transaction,
// the chain is rebuilt by following "prev tx" backwards. An older transaction can't reveal newer versions: that would
// need a search of the whole chain or an indexer, which ChainBridge does not run.
import {BLOCKFROST_PREPROD,ANCHOR_LABEL,EXPLORER,SERIES_ID,parseAnchorMessage} from './cardano-anchor.mjs';
import {walkChain} from '../core/versionchain.mjs';

export class VersionError extends Error{constructor(status,message){super(message);this.status=status;this.userMessage=message;}}
const HEX64=/^[0-9a-f]{64}$/;
export {MAX_CHAIN} from '../core/versionchain.mjs';

export function createVersionService({blockfrostKey,fetchImpl=fetch}){
 async function bf(path){
  const r=await fetchImpl(BLOCKFROST_PREPROD+path,{headers:{project_id:blockfrostKey},signal:AbortSignal.timeout(20000)});
  if(r.status===404)return null;
  if(!r.ok)throw new Error(`Blockfrost HTTP ${r.status}`);
  return r.json();
 }
 // One transaction: {found, record (parsed ChainBridge message or null), blockHeight, blockTime}.
 async function lookup(txHash){
  if(!HEX64.test(txHash??''))throw new VersionError(400,'A Cardano transaction ID is 64 hexadecimal characters');
  if(!blockfrostKey)throw new VersionError(503,'This computer has no Cardano data access configured');
  const info=await bf(`/txs/${txHash}`);
  if(!info)return {found:false};
  const meta=await bf(`/txs/${txHash}/metadata`);
  const record=parseAnchorMessage((meta??[]).find(m=>String(m.label)===String(ANCHOR_LABEL))?.json_metadata?.msg);
  return {found:true,record,blockHeight:info.block_height,blockTime:new Date(info.block_time*1000).toISOString()};
 }

 return {
  lookup,
  // The version a new version would follow. Throws a plain explanation if it can't be continued.
  async predecessor(txHash){
   let t;try{t=await lookup(txHash);}catch(e){if(e instanceof VersionError)throw e;throw new VersionError(502,`Cardano could not be reached (${e.message}). Nothing was published; try again later.`);}
   if(!t.found)throw new VersionError(404,'This transaction is not on Cardano Preprod (or is not confirmed yet).');
   if(!t.record)throw new VersionError(400,'This transaction is not a ChainBridge certificate.');
   if(!t.record.series||!SERIES_ID.test(t.record.series)||!Number.isInteger(t.record.version))
    throw new VersionError(400,'This certificate was created before certificate versions existed, so it has no series to continue. Create a new certificate instead.');
   return {txHash,series:t.record.series,version:t.record.version,prevTx:t.record.prevTx,root:t.record.root,blockHeight:t.blockHeight,blockTime:t.blockTime,explorer:EXPLORER+txHash};
  },
  // Rebuilds a series backwards from `txHash`. Each version gets separate results:
  //  tx      found and confirmed on Cardano (valid / not-found / not-checked)
  //  record  carries a ChainBridge commitment, and (for the starting version, when given) the expected one
  //  link    same series, version numbers count down by one, version 1 has no predecessor, no loops or repeats
  async chain(txHash,{expectedRoot=null}={}){return walkChain(lookup,txHash,{expectedRoot});},
 };
}
