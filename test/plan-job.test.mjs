import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ingest} from '../src/core/ingest.mjs';
import {analyzeSchema} from '../src/core/schema.mjs';
import {recommendPlan,normalizePlan,validatePlan} from '../src/core/plan.mjs';
import {buildCommitment} from '../src/core/commitment.mjs';
import {buildTree,merkleProof,leafHash} from '../src/core/merkle.mjs';
import {parseJobInput,runJob,anchorJobText,verifyJobText} from '../src/core/job.mjs';
import {aiPlan,sanitizeSummary,extractJson} from '../src/server/ai-planner.mjs';

const load=name=>{const d=ingest({name,text:readFileSync(new URL(`../samples/${name}`,import.meta.url),'utf8')});return {d,schema:analyzeSchema(d.records,d.fields)};};

test('Local planner excludes confidential fields, salts personal data and explains itself',()=>{
 const {d,schema}=load('payroll-export.json');
 const p=recommendPlan(schema,d.records);
 assert.ok(!p.fields.includes('iban'));assert.ok(!p.fields.includes('gross_salary'));
 assert.ok(p.fields.includes('employee_id'));
 assert.equal(p.salt,'per-record');assert.equal(p.strategy,'merkle-root');
 assert.ok(p.rationale.some(r=>/iban/.test(r)));
 assert.ok(p.risks.some(r=>/does not anonymize/.test(r)));
 assert.equal(validatePlan(p,schema,d.records.length).ok,true);
});
test('Plan validation rejects bad plans and warns about privacy tradeoffs',()=>{
 const {d,schema}=load('payroll-export.json');
 const base=recommendPlan(schema,d.records);
 assert.match(validatePlan({...base,fields:[]},schema,5).errors.join(),/at least one column/);
 assert.match(validatePlan({...base,fields:['nope']},schema,5).errors.join(),/Unknown column/);
 assert.match(validatePlan({...base,strategy:'publish-raw'},schema,5).errors.join(),/strategy/);
 assert.match(validatePlan(base,schema,0).errors.join(),/empty dataset/);
 assert.match(validatePlan({...base,strategy:'per-record-hashes'},schema,51).errors.join(),/limited to 50/);
 const w=validatePlan({...base,fields:['email','iban'],salt:'none'},schema,5).warnings.join(' ');
 assert.match(w,/Without extra secret values/);assert.match(w,/Confidential/);
});
test('Untrusted plan input is normalized: unknown keys and invalid values are dropped',()=>{
 const {d,schema}=load('payroll-export.json');
 const base=recommendPlan(schema,d.records);
 const n=normalizePlan({fields:['email',7],strategy:'rm -rf',salt:'none',execute:'transfer funds',rationale:['ok',{}]},base);
 assert.deepEqual(n.fields,['email']);assert.equal(n.strategy,base.strategy);assert.equal(n.salt,'none');
 assert.equal(n.execute,undefined);assert.deepEqual(n.rationale,['ok']);
});
test('AI planner sends only the sanitized summary and its output is validated',async()=>{
 let sent;
 const fetchImpl=async(url,opts)=>{sent=JSON.parse(opts.body);return {ok:true,json:async()=>({choices:[{message:{content:'Sure: {"fields":["email","department","bogus"],"strategy":"merkle-root","salt":"none","rationale":["r"]}'}}]})};};
 const env={ZAI_BASE_URL:'https://ai.invalid/v1/',ZAI_API_KEY:'k',ZAI_MODEL:'m'};
 const summary={recordCount:5,fields:[{name:'email',type:'text',sensitivity:'personal',distinctValues:5,missingValues:0,lowEntropy:false,sample:'m.schmidt@example.com'},{name:'department',type:'text',sensitivity:'none',distinctValues:3}],extra:'secret'};
 const r=await aiPlan(summary,{env,fetchImpl});
 assert.ok(!JSON.stringify(sent).includes('m.schmidt'));assert.ok(!JSON.stringify(sent).includes('secret'));
 assert.equal(r.plan.source,'ai');
 assert.equal(r.validation.ok,false,'unknown field from the model is caught by validation');
 assert.ok(r.validation.warnings.some(w=>/Without extra secret values/.test(w)));
 assert.deepEqual(Object.keys(sanitizeSummary(summary)),['recordCount','fields']);
 assert.throws(()=>extractJson('no json'),/no JSON/);
});

test('Agent job: anchor recomputes the root; tampered input is detected; output is deterministic',async()=>{
 const {d}=load('supplier-certificates.csv');
 const plan={version:1,fields:['certificate_id','passed'],strategy:'merkle-root',ordering:'leaf-hash',salt:'per-record',duplicates:'keep'};
 const c=await buildCommitment({records:d.records,plan});
 const text=anchorJobText(c);
 assert.ok(!text.includes('Anna'));
 const out=await runJob(text);
 assert.match(out,/root verified/);assert.equal(out,await runJob(text));
 const job=JSON.parse(text);job.leaves[0]=job.leaves[1];
 assert.match(await runJob(JSON.stringify(job)),/ROOT MISMATCH/);
});
test('Agent job: verify task checks proofs',async()=>{
 const leaves=await Promise.all(['a','b','c'].map(x=>leafHash(x)));
 const {root,levels}=await buildTree(leaves);
 const proof=merkleProof(levels,2);
 assert.match(await runJob(verifyJobText({root,leaf:leaves[2],proof})),/VALID/);
 assert.match(await runJob(verifyJobText({root,leaf:leaves[0],proof})),/INVALID/);
});
test('Agent job input is strictly validated before any payment request',()=>{
 const ok={service:'chainbridge',version:1,task:'verify',root:'a'.repeat(64),leaf:'b'.repeat(64),proof:{siblings:[]}};
 assert.doesNotThrow(()=>parseJobInput(JSON.stringify(ok)));
 for(const [bad,rx] of [
  ['Suggest names for our team',/JSON/],['',/empty/],[JSON.stringify({...ok,service:'x'}),/not a ChainBridge/],
  [JSON.stringify({...ok,records:[{name:'Anna'}]}),/Unexpected key/],[JSON.stringify({...ok,root:'XYZ'}),/hashes/],
  [JSON.stringify({...ok,task:'transfer'}),/anchor.*verify/],['x'.repeat(16001),/exceeds/],
 ])assert.throws(()=>parseJobInput(bad),rx);
 const anchor={service:'chainbridge',version:1,task:'anchor',leaves:['a'.repeat(64)],
  payload:{protocol:'chainbridge/1',hash:'sha-256',canonicalization:'CB-CANON-1',strategy:'merkle-root',ordering:'source',salted:false,leafCount:2,root:'a'.repeat(64)}};
 assert.throws(()=>parseJobInput(JSON.stringify(anchor)),/leafCount/);
 assert.throws(()=>parseJobInput(JSON.stringify({...anchor,leaves:Array(201).fill('a'.repeat(64))})),/At most 200/);
});
