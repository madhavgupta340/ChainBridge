// Optional AI planner over an OpenAI-compatible endpoint (Meta Model API or the template's ZAI_* settings; see ai-config.mjs).
// Receives a schema summary only (names, labels, counts), never record values, and only after explicit opt-in.
// Its output is untrusted: normalizePlan keeps known keys and validatePlan decides acceptability.
import {normalizePlan,recommendPlan,validatePlan} from '../core/plan.mjs';
import {aiSettings,chat,extractJson} from './ai-config.mjs';
export {extractJson};

const SYSTEM=`You help prepare privacy-aware blockchain commitments for tabular data.
You receive a schema summary (field names, inferred types, sensitivity labels, counts). You never see values.
Reply with ONE JSON object and nothing else, with keys:
fields (array of field names to include), strategy ("merkle-root" or "per-record-hashes"), ordering ("leaf-hash" or "source"),
salt ("per-record" or "none"), duplicates ("keep" or "drop"), rationale (array of short strings), risks (array), assumptions (array).
Prefer leaving personal or confidential data out of public payloads. Hashing does not anonymize data. State uncertainty. Do not give legal advice.`;

// Rebuild the summary from an allow-list so nothing else the browser sends can reach the provider.
export function sanitizeSummary(s){
 const fields=(Array.isArray(s?.fields)?s.fields:[]).slice(0,100).map(f=>({name:String(f.name).slice(0,100),type:String(f.type).slice(0,20),
  sensitivity:String(f.sensitivity).slice(0,20),distinctValues:Number(f.distinctValues)||0,missingValues:Number(f.missingValues)||0,lowEntropy:Boolean(f.lowEntropy)}));
 return {recordCount:Number(s?.recordCount)||0,fields};
}

export async function aiPlan(summary,{env=process.env,fetchImpl=fetch,settings=aiSettings(env)}={}){
 const sent=sanitizeSummary(summary);
 const schema=sent.fields.map(f=>({...f,distinct:f.distinctValues,missing:f.missingValues,reasons:[],inferred:{type:f.type,sensitivity:f.sensitivity}}));
 const base=recommendPlan(schema,[]);
 if(!settings)throw new Error('No AI provider configured');
 const text=await chat(settings,[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify(sent)}],{fetchImpl,timeoutMs:45000});
 const plan=normalizePlan({...extractJson(text),source:'ai'},{...base,source:'ai'});
 return {plan,validation:validatePlan(plan,schema,sent.recordCount),sent};
}
