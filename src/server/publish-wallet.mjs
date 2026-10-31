// npm run publish-wallet: create (once) and show the agent's Preprod publishing wallet and its test ADA balance.
import {createPublishingWallet,loadPublishingWallet,BLOCKFROST_PREPROD} from './cardano-anchor.mjs';

export const WALLET_PATH='.local/publishing-wallet.json';
let wallet=loadPublishingWallet(WALLET_PATH);
if(!wallet){createPublishingWallet(WALLET_PATH);wallet=loadPublishingWallet(WALLET_PATH);console.log('Created a new Preprod publishing wallet (key saved privately in',WALLET_PATH+').');}
console.log('Publishing wallet address (Cardano Preprod, test network):');
console.log(wallet.address);
const key=process.env.BLOCKFROST_API_KEY_PREPROD;
if(key){
 const r=await fetch(`${BLOCKFROST_PREPROD}/addresses/${wallet.address}`,{headers:{project_id:key}});
 const data=r.status===404?null:await r.json();
 const lovelace=data?.amount?.find(a=>a.unit==='lovelace')?.quantity??'0';
 console.log(`Balance: ${Number(lovelace)/1e6} test ADA${lovelace==='0'?' (fund it from https://docs.cardano.org/cardano-testnets/tools/faucet, network: Preprod)':''}`);
}
