// Rebuilds a certificate series backwards from one transaction, following each version's "prev tx" link.
// `lookup(txHash)` reads one transaction and returns {found, record (parsed message or null), blockHeight, blockTime};
// it is Blockfrost on the server (src/server/versions.mjs) and the public Koios API on the static check page.
// Each version gets separate results:
//  tx      found and confirmed on Cardano (valid / not-found / not-checked)
//  record  carries a ChainBridge commitment, and (for the starting version, when given) the expected one
//  link    same series, version numbers count down by one, version 1 has no predecessor, no loops or repeats
import {EXPLORER} from './anchor-message.mjs';
export const MAX_CHAIN=50;

export async function walkChain(lookup,txHash,{expectedRoot=null}={}){
   const out=[];const seen=new Set();let cur=txHash;let series=null;let stop=null;
   while(cur&&out.length<MAX_CHAIN){
    const v={txHash:cur,explorer:EXPLORER+cur};
    if(seen.has(cur)){v.tx={status:'mismatch',detail:'This transaction already appeared later in the chain: the links form a loop.'};out.push(v);stop='loop';break;}
    seen.add(cur);
    let t;
    try{t=await lookup(cur);}catch(e){v.tx={status:'not-checked',detail:e.userMessage??`Cardano could not be reached (${e.message}).`};out.push(v);stop='not-checked';break;}
    if(!t.found){v.tx={status:'not-found',detail:out.length?'The previous version this chain points to is missing from Cardano Preprod.':'This transaction is not on Cardano Preprod (or is not confirmed yet).'};out.push(v);stop='missing';break;}
    Object.assign(v,{blockHeight:t.blockHeight,blockTime:t.blockTime});
    v.tx={status:'valid',detail:'Confirmed on Cardano.'};
    const r=t.record;
    if(!r){v.record={status:'mismatch',detail:'The transaction carries no ChainBridge certificate.'};out.push(v);stop='not-chainbridge';break;}
    Object.assign(v,{version:r.version,series:r.series,prevTx:r.prevTx,root:r.root});
    v.record=out.length===0&&expectedRoot?(r.root===expectedRoot?{status:'valid',detail:'Carries exactly the fingerprint in your certificate.'}:{status:'mismatch',detail:'Carries a different fingerprint than your certificate.'})
     :{status:'valid',detail:'Carries a ChainBridge fingerprint (shown below).'};
    const newer=out.at(-1);
    if(!r.series){v.link={status:'mismatch',detail:'This transaction has no certificate series.'};}
    else if(series&&r.series!==series){v.link={status:'mismatch',detail:'It belongs to a different certificate series.'};}
    else if(newer&&r.version!==newer.version-1){v.link={status:'mismatch',detail:r.version===newer.version?`Version ${r.version} appears twice in this chain.`:`Expected version ${newer.version-1} here, found version ${r.version}: a version is missing or out of order.`};}
    else if(r.version===1&&r.prevTx){v.link={status:'mismatch',detail:'Version 1 should not point to an earlier transaction.'};}
    else if(r.version>1&&!r.prevTx){v.link={status:'mismatch',detail:`Version ${r.version} does not point to a previous version, so versions 1–${r.version-1} can't be found.`};}
    else if(newer&&t.blockTime>newer.blockTime){v.link={status:'mismatch',detail:'This earlier version was recorded after the version that points to it.'};}
    else v.link={status:'valid',detail:r.version===1?'Version 1: the start of this series.':`Points to version ${r.version-1}.`};
    series=series??r.series;
    out.push(v);
    cur=r.prevTx;
   }
   if(cur&&out.length>=MAX_CHAIN&&!stop)stop='too-long';
   const ok=out.every(v=>v.tx?.status==='valid'&&v.record?.status==='valid'&&v.link?.status==='valid');
   return {series,start:txHash,versions:out,complete:ok&&out.at(-1)?.version===1,stop,
    note:'Rebuilt from Cardano by following each version\'s link to the one before it. Newer versions than the one you started from can\'t be found this way.'};
}
