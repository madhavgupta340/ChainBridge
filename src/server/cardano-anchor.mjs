// Publishes a ChainBridge fingerprint (Merkle root) on Cardano Preprod as transaction metadata.
// The agent pays the network fee from its own dedicated "publishing" wallet. Only the fingerprint, record
// count and job reference are published: never record values, column names or salts.
//
// Metadata uses label 674 (CIP-20 transaction message), as a list of strings of at most 64 bytes:
//   {"674":{"msg":["ChainBridge data fingerprint v1","sha-256 merkle root:","<64 hex>","records: N","salted: true","job: <id>"]}}
//
// Safety: one publication per (fingerprint, job). The journal is written before submitting; an interrupted
// submission is never retried automatically (it may already be on-chain).
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

const C=createRequire(import.meta.url)('@emurgo/cardano-serialization-lib-nodejs');
export const BLOCKFROST_PREPROD='https://cardano-preprod.blockfrost.io/api/v0';
export const ANCHOR_LABEL=674;
export const EXPLORER='https://preprod.cardanoscan.io/transaction/';
const harden=n=>0x80000000+n;
const HEX64=/^[0-9a-f]{64}$/;

export function anchorMetadata({root,leafCount,salted,jobRef}){
 if(!HEX64.test(root))throw new Error('Fingerprint must be a 64-character hex hash');
 return {msg:['ChainBridge data fingerprint v1','sha-256 merkle root:',root,`records: ${Number(leafCount)}`,`salted: ${Boolean(salted)}`,`job: ${String(jobRef).slice(0,58)}`]};
}

// Standard Cardano wallet derivation (CIP-1852), account 0, first address, Preprod.
export function walletFromEntropy(entropyHex){
 const root=C.Bip32PrivateKey.from_bip39_entropy(Buffer.from(entropyHex,'hex'),Buffer.from(''));
 const account=root.derive(harden(1852)).derive(harden(1815)).derive(harden(0));
 const pay=account.derive(0).derive(0),stake=account.derive(2).derive(0);
 const address=C.BaseAddress.new(C.NetworkInfo.testnet_preprod().network_id(),
  C.Credential.from_keyhash(pay.to_public().to_raw_key().hash()),C.Credential.from_keyhash(stake.to_public().to_raw_key().hash())).to_address();
 return {address:address.to_bech32('addr_test'),addressObj:address,signingKey:pay.to_raw_key()};
}

// Creates the publishing wallet once. The key file is private (600) and must never be committed or shared.
export function createPublishingWallet(path){
 if(existsSync(path))throw new Error('Publishing wallet already exists; refusing to overwrite it');
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const entropy=randomBytes(32).toString('hex');
 const {address}=walletFromEntropy(entropy);
 writeFileSync(path,JSON.stringify({network:'Preprod',purpose:'ChainBridge fingerprint publishing (test network only)',address,entropy,createdAt:new Date().toISOString()},null,1),{mode:0o600});
 return {address};
}
export function loadPublishingWallet(path){
 if(!existsSync(path))return null;
 const w=JSON.parse(readFileSync(path,'utf8'));
 if(w.network!=='Preprod')throw new Error('Publishing wallet is not a Preprod wallet');
 return {...walletFromEntropy(w.entropy),file:path};
}

async function blockfrost(path,{key,fetchImpl,method='GET',body}){
 const r=await fetchImpl(BLOCKFROST_PREPROD+path,{method,headers:{project_id:key,...(body?{'content-type':'application/cbor'}:{})},body,signal:AbortSignal.timeout(30000)});
 if(r.status===404)return null;
 const data=await r.json().catch(()=>null);
 if(!r.ok)throw new Error(`Blockfrost ${path.split('?')[0]} HTTP ${r.status}${data?.message?`: ${data.message}`:''}`);
 return data;
}

// Builds and signs the publishing transaction. Pure apart from its inputs: used directly by tests.
export function buildPublishTx({wallet,utxos,params,metadata}){
 if(!utxos?.length)throw new Error(`The publishing wallet has no test ADA. Fund ${wallet.address} from the Cardano Preprod faucet.`);
 const big=v=>C.BigNum.from_str(String(v));
 const config=C.TransactionBuilderConfigBuilder.new()
  .fee_algo(C.LinearFee.new(big(params.min_fee_a),big(params.min_fee_b)))
  .pool_deposit(big(params.pool_deposit)).key_deposit(big(params.key_deposit))
  .max_value_size(Number(params.max_val_size)).max_tx_size(Number(params.max_tx_size))
  .coins_per_utxo_byte(big(params.coins_per_utxo_size??params.coins_per_utxo_word))
  .build();
 const builder=C.TransactionBuilder.new(config);
 for(const u of utxos){
  const value=C.Value.new(big(u.amount.find(a=>a.unit==='lovelace').quantity));
  const assets=u.amount.filter(a=>a.unit!=='lovelace');
  if(assets.length){ // carry tokens over to change
   const ma=C.MultiAsset.new();
   for(const a of assets){const policy=C.ScriptHash.from_hex(a.unit.slice(0,56));const name=C.AssetName.new(Buffer.from(a.unit.slice(56),'hex'));
    const set=ma.get(policy)??C.Assets.new();set.insert(name,big(a.quantity));ma.insert(policy,set);}
   value.set_multiasset(ma);
  }
  builder.add_regular_input(wallet.addressObj,C.TransactionInput.new(C.TransactionHash.from_hex(u.tx_hash),u.output_index),value);
 }
 const general=C.GeneralTransactionMetadata.new();
 general.insert(big(ANCHOR_LABEL),C.encode_json_str_to_metadatum(JSON.stringify(metadata),C.MetadataJsonSchema.NoConversions));
 builder.set_metadata(general);
 builder.add_change_if_needed(wallet.addressObj);
 const fixed=C.FixedTransaction.from_bytes(builder.build_tx().to_bytes());
 fixed.sign_and_add_vkey_signature(wallet.signingKey);
 return {txHash:fixed.transaction_hash().to_hex(),cbor:Buffer.from(fixed.to_bytes()),fee:fixed.body().fee().to_str()};
}

export async function publishFingerprint({root,leafCount,salted,jobRef,deadline},{walletPath,blockfrostKey,journalDir,fetchImpl=fetch,confirmTimeoutMs=150000,pollMs=8000}){
 if(!blockfrostKey)throw new Error('BLOCKFROST_API_KEY_PREPROD is not set');
 const wallet=loadPublishingWallet(walletPath);
 if(!wallet)throw new Error('No publishing wallet. Run: npm run publish-wallet');
 const metadata=anchorMetadata({root,leafCount,salted,jobRef});
 mkdirSync(journalDir,{recursive:true,mode:0o700});
 const journalFile=join(journalDir,createHash('sha256').update(`${root}:${jobRef}`).digest('hex')+'.json');
 const save=j=>writeFileSync(journalFile,JSON.stringify(j),{mode:0o600});
 let journal=existsSync(journalFile)?JSON.parse(readFileSync(journalFile,'utf8')):null;
 if(journal?.phase==='submit-pending')throw new Error(`Publication outcome uncertain (journal ${journalFile}). Check the wallet on an explorer before retrying.`);
 const opts={key:blockfrostKey,fetchImpl};
 if(!journal?.txHash){
  if(deadline!==undefined&&Date.now()>=deadline)throw new Error('Result deadline reached before publishing');
  const [params,utxos]=await Promise.all([blockfrost('/epochs/latest/parameters',opts),blockfrost(`/addresses/${wallet.address}/utxos?count=50`,opts)]);
  const tx=buildPublishTx({wallet,utxos,params,metadata});
  journal={phase:'submit-pending',txHash:tx.txHash,fee:tx.fee,address:wallet.address,root,jobRef};save(journal);
  const submitted=await blockfrost('/tx/submit',{...opts,method:'POST',body:tx.cbor});
  if(submitted!==tx.txHash)throw new Error('Submitted transaction hash does not match the signed transaction');
  journal={...journal,phase:'submitted',submittedAt:new Date().toISOString()};save(journal);
 }
 // Wait (bounded) for confirmation; report honestly if it is still pending.
 const until=Date.now()+confirmTimeoutMs;
 while(journal.phase!=='confirmed'&&Date.now()<until){
  const info=await blockfrost(`/txs/${journal.txHash}`,opts).catch(()=>null);
  if(info?.block){journal={...journal,phase:'confirmed',block:info.block,blockHeight:info.block_height,blockTime:info.block_time};save(journal);break;}
  await new Promise(r=>setTimeout(r,pollMs));
 }
 return {network:'Preprod',label:ANCHOR_LABEL,status:journal.phase==='confirmed'?'confirmed':'submitted',txHash:journal.txHash,
  explorer:EXPLORER+journal.txHash,feeLovelace:journal.fee,blockHeight:journal.blockHeight??null,publisher:journal.address,metadata};
}
