// The ChainBridge label-674 message, read back from a Cardano transaction. Shared by the server and the browser.
// Format (written by src/server/cardano-anchor.mjs): "ChainBridge data fingerprint v1", "sha-256 merkle root:", <root>,
// "records: N", optional "files: F", optional "series: s-…", "version: N", "prev tx:" <hash>, "salted: …", "job: …".
export const EXPLORER='https://preprod.cardanoscan.io/transaction/';
// Reads a ChainBridge label-674 message back (null if it is not one).
export function parseAnchorMessage(msg){
 if(!Array.isArray(msg)||msg[0]!=='ChainBridge data fingerprint v1')return null;
 const line=p=>{const l=msg.find(x=>typeof x==='string'&&x.startsWith(p));return l===undefined?null:l.slice(p.length);};
 const num=p=>{const v=line(p);return v===null?null:Number(v);};
 const i=msg.indexOf('prev tx:');
 return {root:msg[2]??null,records:num('records: '),files:num('files: ')??0,series:line('series: '),version:num('version: '),prevTx:i>=0?msg[i+1]??null:null,job:line('job: ')};
}
