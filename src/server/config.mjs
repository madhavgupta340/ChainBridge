// Runtime mode, network and pricing. Pricing mirrors the template's signed Masumi quote (paid-task.mjs):
// the worker rejects any other amount, so the price shown here is the price the payment service requests.
import {execFileSync} from 'node:child_process';
import {USDM,isPaidReady} from '../../paid-task.mjs';
import {aiSettings} from './ai-config.mjs';

export const NETWORK={id:'Preprod',label:'Cardano Preprod (test network: test tokens have no real value)'};
export const SERVICE_PRICE={amount:'1000000',unit:USDM,decimals:6,symbol:'tUSDM',display:'1 tUSDM',
 description:'1 test USDM (Preprod stablecoin token), the amount fixed by the Masumi TUM template'};

function sokosumiInstalled(){
 try{execFileSync('sokosumi',['--version'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','ignore']});return true;}catch{return false;}
}

export function loadConfig(env=process.env){
 const coworkerId=env.COWORKER_ID?.trim()||null;
 const cli=coworkerId?sokosumiInstalled():false;
 const paid=Boolean(coworkerId&&cli&&env.PAID_TASKS_ENABLED==='true'&&isPaidReady());
 const mode=coworkerId&&cli?'sokosumi':'demo';
 return {mode,paid,coworkerId,cli,
  organizationSlug:env.SOKOSUMI_ORGANIZATION_SLUG?.trim()||null,
  ai:Boolean(aiSettings(env)),aiProvider:aiSettings(env)?.provider??null,
  port:Number(env.CHAINBRIDGE_PORT||8787),
  reason:mode==='demo'?(coworkerId?'Sokosumi CLI not found on PATH':'COWORKER_ID is not set'):paid?'Paid Preprod tasks enabled':'PAID_TASKS_ENABLED is not true or payment registration is incomplete'};
}

export function quoteFor(config){
 if(config.mode==='demo')return {charged:false,servicePrice:'Not charged',priceNote:'Demo mode: runs locally, no agent, no payment, nothing published.',provider:'Local demo (no Sokosumi/Masumi connection)'};
 if(!config.paid)return {charged:false,servicePrice:'Not charged',priceNote:'Paid tasks are disabled for this agent. The Sokosumi task runs without a Masumi payment.',provider:`ChainBridge agent on Sokosumi Preprod (Coworker ${config.coworkerId})`};
 return {charged:true,servicePrice:SERVICE_PRICE.display,priceUnit:SERVICE_PRICE.unit,priceAmountAtomic:SERVICE_PRICE.amount,
  priceNote:`${SERVICE_PRICE.description}. Paid to ChainBridge's Masumi seller wallet through Masumi escrow, released after the result is submitted.`,
  provider:`ChainBridge agent on Sokosumi Preprod (Coworker ${config.coworkerId}), paid via Masumi Payment Service`};
}
