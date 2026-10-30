// Task and payment states. Task state is what ChainBridge did; payment status is what the payment service reported.
// Both are derived only from local actions or saved worker/MPS responses, never assumed.

export const TASK_STATES={
 awaiting_approval:'Awaiting your approval',
 approved:'Approved',
 submitting:'Submitting to agent',
 submitted:'Submitted, waiting for agent',
 awaiting_payment:'Awaiting payment',
 processing:'Processing',
 result_submitted:'Result hash submitted, awaiting confirmation',
 confirmed_on_chain:'Result hash confirmed on-chain',
 completed:'Completed',
 settled:'Completed, seller receipt verified',
 failed:'Failed',
 cancelled:'Cancelled',
 needs_inspection:'Outcome uncertain: inspect before retrying',
};

const NEXT={
 awaiting_approval:['approved','cancelled'],
 approved:['processing','submitting','failed'],
 submitting:['submitted','needs_inspection','failed'],
 submitted:['awaiting_payment','processing','completed','failed','needs_inspection'],
 awaiting_payment:['processing','failed','needs_inspection'],
 processing:['result_submitted','completed','failed','needs_inspection'],
 result_submitted:['confirmed_on_chain','failed','needs_inspection'],
 confirmed_on_chain:['completed','needs_inspection'],
 completed:['settled'],
 settled:[],failed:[],cancelled:[],needs_inspection:[],
};

// Forward-only: a state may be skipped (e.g. we observe the worker after several steps) but never reversed.
const ORDER=['awaiting_approval','approved','submitting','submitted','awaiting_payment','processing','result_submitted','confirmed_on_chain','completed','settled'];
export function canTransition(from,to){
 if(from===to)return true;
 if(NEXT[from]?.includes(to))return true;
 const a=ORDER.indexOf(from),b=ORDER.indexOf(to);
 return a>=ORDER.indexOf('submitted')&&b>a;
}
export function transition(task,to,patch={}){
 if(!canTransition(task.state,to))throw new Error(`Invalid task transition ${task.state} -> ${to}`);
 return {...task,...patch,state:to,updatedAt:new Date().toISOString()};
}
export const TERMINAL=new Set(['settled','failed','cancelled','needs_inspection']);
export const ACTIVE=new Set(Object.keys(TASK_STATES).filter(s=>!['failed','cancelled'].includes(s)));

export const PAYMENT_STATUS={
 not_required:'Not charged (demo mode)',
 disabled:'Not charged (paid tasks disabled)',
 pending_request:'Payment request being created',
 requested:'Payment requested',
 awaiting_buyer:'Waiting for buyer funds in escrow',
 funds_locked:'Funds locked in escrow (confirmed)',
 result_submitted:'Result submitted to escrow',
 payout_pending:'Task accepted; seller payout pending',
 seller_receipt_verified:'Seller receipt verified on-chain',
 unknown:'Unknown',
};

// Map the template worker's private journal (.local/<taskId>.json) to ChainBridge states.
// Only fields the worker saved from real Sokosumi/MPS responses are surfaced as evidence.
export function fromWorkerJournal(journal){
 if(!journal)return {state:'submitted',payment:null,uncertain:false,detail:'Waiting for the worker to pick up the task.'};
 if(journal.phase==='input-rejected')return {state:'failed',payment:'disabled',uncertain:false,detail:journal.reason||'The agent rejected the task input without charging.'};
 const p=journal.paid;
 if(!p){
  const map={starting:'processing',started:'processing','model-pending':'processing','result-saved':'processing','complete-pending':'processing',completed:'completed'};
  return {state:map[journal.phase]??'processing',payment:'disabled',uncertain:/-pending$|^starting$/.test(journal.phase)&&journal.phase!=='completed',detail:`Worker phase: ${journal.phase}`};
 }
 const stage=p.stage;
 const map={
  'terms-pending':['awaiting_payment','pending_request'],'terms-saved':['awaiting_payment','requested'],
  'purchase-pending':['awaiting_payment','requested'],'awaiting-escrow':['awaiting_payment','awaiting_buyer'],
  'model-pending':['processing','funds_locked'],'result-saved':['processing','funds_locked'],'submit-pending':['processing','funds_locked'],
  'awaiting-result':['result_submitted','result_submitted'],'complete-ready':['confirmed_on_chain','result_submitted'],
  'complete-pending':['confirmed_on_chain','result_submitted'],'awaiting-withdrawal':['completed','payout_pending'],
  settled:['settled','seller_receipt_verified'],
 };
 const [state,payment]=map[stage]??['processing','unknown'];
 const tx=p.observed?.CurrentTransaction;
 return {state,payment,uncertain:/-pending$/.test(stage),detail:`Worker payment stage: ${stage}`,
  evidence:{blockchainIdentifier:p.payment?.blockchainIdentifier??null,onChainState:p.observed?.onChainState??null,
   lastTxHash:tx?.txHash??null,lastTxStatus:tx?.status??null,resultHash:p.resultHash??null,
   settlementTxHash:p.settlement?.verified?p.settlement.txHash:null,sellerNetAtomicUnits:p.settlement?.verified?p.settlement.netAtomicUnits:null,
   payByTime:p.payment?.payByTime??null,submitResultTime:p.payment?.submitResultTime??null}};
}
