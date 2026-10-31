// Cardano browser wallets (CIP-30: Lace, Eternl, ...). The wallet shows the payment and the user approves it there;
// ChainBridge never sees the wallet's keys or recovery phrase.
export function availableWallets(){
 const c=globalThis.cardano||{};
 return Object.entries(c).filter(([,w])=>w&&typeof w.enable==='function'&&w.name).map(([key,w])=>({key,name:w.name,icon:w.icon}));
}

export async function connect(key){
 const api=await globalThis.cardano[key].enable();
 const networkId=await api.getNetworkId();
 if(networkId!==0)throw new Error('Your wallet is on Cardano mainnet. Switch it to Preprod (test network) and try again.');
 return {api,address:await api.getChangeAddress()};
}

// Asks the wallet to sign (not submit) the payment. Returns the witness set (hex CBOR).
export async function signPayment(api,unsignedTx){
 try{return await api.signTx(unsignedTx,false);}
 catch(e){throw new Error(e?.info||e?.message||'The wallet did not sign the payment');}
}
