// x402 "exact" payments on Cardano Preprod (direct, no escrow): https://developers.cardano.org/x402/
//
// Flow used by ChainBridge:
//  1. The seller (ChainBridge agent) states payment requirements (x402 PaymentRequired).
//  2. The server builds an UNSIGNED payment transaction from the buyer's wallet address: one output of exactly
//     `amount` lovelace to `payTo`, change back to the buyer, a TTL inside maxTimeoutSeconds.
//  3. The buyer's browser wallet (CIP-30) signs it. Nothing is broadcast yet.
//  4. The signed transaction becomes the x402 payment payload; the seller verifies it with the facilitator,
//     runs the paid work, and only then settles (the facilitator broadcasts it). If the work fails, the
//     payment is never broadcast, so the buyer is not charged.
import {createRequire} from 'node:module';
import {x402ResourceServer,HTTPFacilitatorClient} from '@x402/core/server';
import {x402Client} from '@x402/core/client';
import {ExactCardanoScheme as SellerScheme} from '@x402/cardano/exact/server';
import {ExactCardanoScheme as BuyerScheme} from '@x402/cardano/exact/client';

const C=createRequire(import.meta.url)('@emurgo/cardano-serialization-lib-nodejs');
export const X402_NETWORK='cardano:preprod';
export const DEFAULT_FACILITATOR='https://x402.preprod.dev.ecosyseng.cf-deployments.org';
const BF='https://cardano-preprod.blockfrost.io/api/v0';

async function blockfrost(path,key,fetchImpl=fetch){
 const r=await fetchImpl(BF+path,{headers:{project_id:key},signal:AbortSignal.timeout(30000)});
 if(r.status===404)return null;
 if(!r.ok)throw new Error(`Blockfrost ${path.split('?')[0]} HTTP ${r.status}`);
 return r.json();
}

// The seller side: payment requirements, verification and settlement through the facilitator.
export async function createSeller({facilitatorUrl=DEFAULT_FACILITATOR,payTo}){
 const server=new x402ResourceServer(new HTTPFacilitatorClient({url:facilitatorUrl})).register(X402_NETWORK,new SellerScheme());
 await server.initialize();
 return {
  async paymentRequired({lovelace,resource,description,maxTimeoutSeconds=600}){
   const requirements=await server.buildPaymentRequirements({scheme:'exact',payTo,network:X402_NETWORK,maxTimeoutSeconds,
    price:{amount:String(lovelace),asset:'lovelace'},extra:{confirmationPolicy:{l1Confirmations:0}}});
   const paymentRequired=await server.createPaymentRequiredResponse(requirements,{url:resource,description,mimeType:'application/json'});
   return {requirements:requirements[0],paymentRequired};
  },
  verify:(payload,requirements)=>server.verifyPayment(payload,requirements),
  settle:(payload,requirements)=>server.settlePayment(payload,requirements),
 };
}

// Builds the unsigned payment transaction for a buyer address. Returns hex CBOR for CIP-30 signTx and the nonce.
export async function buildUnsignedPayment({buyerAddress,payTo,lovelace,maxTimeoutSeconds=600,blockfrostKey,fetchImpl=fetch}){
 const [params,utxos,tip]=await Promise.all([blockfrost('/epochs/latest/parameters',blockfrostKey,fetchImpl),
  blockfrost(`/addresses/${buyerAddress}/utxos?count=50`,blockfrostKey,fetchImpl),blockfrost('/blocks/latest',blockfrostKey,fetchImpl)]);
 if(!utxos?.length)throw new Error('This wallet has no test ADA on Cardano Preprod. Fund it from the Preprod faucet first.');
 const big=v=>C.BigNum.from_str(String(v));
 const config=C.TransactionBuilderConfigBuilder.new()
  .fee_algo(C.LinearFee.new(big(params.min_fee_a),big(params.min_fee_b)))
  .pool_deposit(big(params.pool_deposit)).key_deposit(big(params.key_deposit))
  .max_value_size(Number(params.max_val_size)).max_tx_size(Number(params.max_tx_size))
  .coins_per_utxo_byte(big(params.coins_per_utxo_size)).build();
 const builder=C.TransactionBuilder.new(config);
 const buyer=C.Address.from_bech32(buyerAddress);
 // Pure-ADA inputs only, largest first, until amount + fee headroom is covered.
 const pure=utxos.filter(u=>u.amount.length===1).sort((a,b)=>Number(BigInt(b.amount[0].quantity)-BigInt(a.amount[0].quantity)));
 let total=0n;const used=[];
 for(const u of pure){used.push(u);total+=BigInt(u.amount[0].quantity);if(total>=BigInt(lovelace)+3_000_000n)break;}
 if(total<BigInt(lovelace)+1_000_000n)throw new Error('Not enough test ADA in this wallet for the payment and fee.');
 for(const u of used)builder.add_regular_input(buyer,C.TransactionInput.new(C.TransactionHash.from_hex(u.tx_hash),u.output_index),C.Value.new(big(u.amount[0].quantity)));
 builder.add_output(C.TransactionOutput.new(C.Address.from_bech32(payTo),C.Value.new(big(lovelace))));
 builder.set_ttl_bignum(big(tip.slot+maxTimeoutSeconds-60));
 builder.add_change_if_needed(buyer);
 const tx=builder.build_tx();
 const body=tx.body();const first=body.inputs().get(0);
 return {unsignedTx:Buffer.from(tx.to_bytes()).toString('hex'),nonce:`${first.transaction_id().to_hex()}#${first.index()}`,
  fee:body.fee().to_str(),ttl:body.ttl_bignum()?.to_str()};
}

// CIP-30 wallets report addresses as hex bytes; x402 and Blockfrost use bech32.
export function addressToBech32(hexOrBech32){
 if(/^addr_test1/.test(hexOrBech32))return hexOrBech32;
 const a=C.Address.from_bytes(Buffer.from(hexOrBech32,'hex'));
 if(a.network_id()!==0)throw new Error('This wallet is on Cardano mainnet. Switch it to Preprod (test network).');
 return a.to_bech32('addr_test');
}

// Combines the buyer's CIP-30 witness set with the unsigned transaction -> base64 signed transaction.
export function attachWitnesses(unsignedTxHex,witnessSetHex){
 const fixed=C.FixedTransaction.from_bytes(Buffer.from(unsignedTxHex,'hex'));
 const ws=C.TransactionWitnessSet.from_bytes(Buffer.from(witnessSetHex,'hex'));
 const vkeys=ws.vkeys();
 if(!vkeys||!vkeys.len())throw new Error('The wallet returned no signature');
 for(let i=0;i<vkeys.len();i++)fixed.add_vkey_witness(vkeys.get(i));
 return Buffer.from(fixed.to_bytes()).toString('base64');
}

// Wraps an already signed transaction into an x402 payment payload using the official client scheme.
export async function paymentPayloadFor(paymentRequired,{transaction,nonce},maxLovelace){
 const signer={getAddress:()=>'',buildAndSignPaymentTransaction:()=>({transaction,nonce})};
 const client=new x402Client().register(X402_NETWORK,new BuyerScheme(signer));
 client.setSpendControls({allowedAssets:[{network:'cardano:*',asset:'lovelace',maxAmountPerPayment:String(maxLovelace)}]});
 return client.createPaymentPayload(paymentRequired);
}
