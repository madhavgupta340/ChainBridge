import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ingest} from '../src/core/ingest.mjs';
import {analyzeSchema} from '../src/core/schema.mjs';
import {checkStep,checkRecipe,applyRecipe,recipeRecord} from '../src/core/recipe.mjs';
import {buildAiSample,suggestRecipeLocally} from '../src/core/organize.mjs';
import {buildCommitment,verifyRecord} from '../src/core/commitment.mjs';
import {aiOrganize,sanitizeSample} from '../src/server/ai-organizer.mjs';
import {aiSettings,META_BASE_URL,META_DEFAULT_MODEL} from '../src/server/ai-config.mjs';

const messy=()=>ingest({name:'messy-shipments.csv',text:readFileSync(new URL('../samples/messy-shipments.csv',import.meta.url),'utf8')});
const payroll=()=>ingest({name:'p.json',text:readFileSync(new URL('../samples/payroll-export.json',import.meta.url),'utf8')});

test('Recipe steps are whitelisted and checked against existing columns',()=>{
 const cols=['a','b'];
 assert.throws(()=>checkStep({op:'eval',code:'process.exit()'},cols),/Unknown step/);
 assert.throws(()=>checkStep({op:'trim',column:'zzz'},cols),/Unknown column/);
 assert.throws(()=>checkStep({op:'rename',column:'a',to:'b'},cols),/already exists/);
 assert.throws(()=>checkStep({op:'rename',column:'a',to:'__proto__'},cols),/New column name/);
 assert.throws(()=>checkStep({op:'normalize_date',column:'a',order:'guess'},cols),/Date order/);
 assert.throws(()=>checkStep({op:'sort',by:[]},cols),/Sort needs/);
 assert.deepEqual(checkStep({op:'trim',column:'a',extra:'ignored',reason:' why '},cols),{op:'trim',column:'a',reason:'why'});
 assert.equal(checkStep({op:'trim',column:'WEIGHT_KG'},['Weight (kg)']).column,'Weight (kg)','near-miss names resolve to the one matching column');
 assert.throws(()=>checkStep({op:'trim',column:'ab'},['a b','A_B']),/ambiguous/);
 const {steps,rejected}=checkRecipe([{op:'rename',column:'a',to:'x'},{op:'trim',column:'a'},{op:'trim',column:'x'}],cols);
 assert.equal(steps.length,2);assert.equal(rejected.length,1,'steps after a rename must use the new name');
});
test('Normalizers convert clear values and leave unreadable ones untouched',()=>{
 const data={fields:['d','b','n'],records:[
  {sourceRow:2,values:{d:'02.09.26',b:'yes',n:'1.250,5'}},{sourceRow:3,values:{d:'31.02.26',b:'maybe',n:'abc'}},{sourceRow:4,values:{d:'2026-9-3',b:'NEIN',n:'2.100'}}]};
 const r=applyRecipe(data,[{op:'normalize_date',column:'d',order:'DMY'},{op:'normalize_boolean',column:'b'},{op:'normalize_number',column:'n',decimal:','}]);
 assert.deepEqual(r.records.map(x=>x.values),[{d:'2026-09-02',b:true,n:1250.5},{d:'31.02.26',b:'maybe',n:'abc'},{d:'2026-09-03',b:false,n:2100}]);
 assert.deepEqual(r.log.map(l=>l.changed),[2,2,2]);
});
test('Sorting is stable and locale-independent; rows keep their source row numbers',()=>{
 const data={fields:['g','v'],records:[{sourceRow:2,values:{g:'b',v:2}},{sourceRow:3,values:{g:'a',v:10}},{sourceRow:4,values:{g:'b',v:1}},{sourceRow:5,values:{g:'a',v:10}},{sourceRow:6,values:{g:'',v:0}}]};
 const r=applyRecipe(data,[{op:'sort',by:[{column:'g'},{column:'v',direction:'desc'}]}]);
 assert.deepEqual(r.records.map(x=>x.sourceRow),[3,5,2,4,6]);
});
test('Same original file and recipe always give the same records and fingerprint',async()=>{
 const d=messy();const {steps}=checkRecipe(suggestRecipeLocally(d).steps,d.fields);
 const a=applyRecipe(d,steps),b=applyRecipe(messy(),steps);
 assert.deepEqual(a.records,b.records);
 const plan={version:1,fields:a.fields,strategy:'merkle-root',ordering:'source',salt:'none',duplicates:'keep'};
 const ca=await buildCommitment({records:a.records,plan,recipe:recipeRecord(steps)});
 const cb=await buildCommitment({records:b.records,plan});
 assert.equal(ca.root,cb.root);
 assert.equal(ca.bundle.recipe.steps.length,steps.length);assert.ok(!JSON.stringify(ca.bundle.recipe).includes('reason'));
 const rec=a.records[0];
 assert.equal((await verifyRecord({values:rec.values,sourceRow:rec.sourceRow,bundle:ca.bundle})).match,true);
});
test('Local rules tidy the messy sample: names, spaces, dates, yes/no, empty and duplicate rows',()=>{
 const d=messy();const s=suggestRecipeLocally(d);
 const ops=s.steps.map(x=>x.op);
 for(const op of ['rename','trim','remove_empty_rows','normalize_date','normalize_boolean','remove_duplicates','sort','lowercase'])assert.ok(ops.includes(op),op);
 const r=applyRecipe(d,checkRecipe(s.steps,d.fields).steps);
 assert.equal(r.records.length,8);
 assert.ok(r.records.every(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.values.ship_date)));
 assert.ok(r.records.every(x=>typeof x.values.insured==='boolean'));
 assert.equal(suggestRecipeLocally(payroll()).steps.filter(x=>x.op!=='sort').length,0,'tidy data gets no clean-up steps');
});
test('Masked sample hides private values and their formats; names-only shares no values',()=>{
 const d=payroll();const schema=analyzeSchema(d.records,d.fields);
 const masked=JSON.stringify(buildAiSample(d,schema,'masked'));
 for(const r of d.records)for(const k of ['full_name','email','iban'])assert.ok(!masked.includes(r.values[k]),`leaked ${k}`);
 assert.ok(masked.includes('[personal]')&&masked.includes('[confidential]'));
 assert.ok(masked.includes('Logistics'),'non-private values are shared');
 const names=buildAiSample(d,schema,'names');
 assert.equal(names.sampleRows,undefined);assert.ok(names.columns.every(c=>c.formats===undefined));
 assert.ok(JSON.stringify(buildAiSample(d,schema,'full')).includes('Maria Schmidt'));
});
test('Server sanitizes the sample: names-only mode can never carry rows',()=>{
 const s=sanitizeSample({shareMode:'names',columns:[{name:'a',formats:['x']}],sampleRows:[{a:'secret'}],extra:'x'});
 assert.equal(s.sampleRows,undefined);assert.equal(s.columns[0].formats,undefined);assert.equal(s.extra,undefined);
 assert.equal(sanitizeSample({shareMode:'bogus'}).shareMode,'names');
});
test('AI organizer: only valid whitelisted steps survive the model reply',async()=>{
 const d=messy();const sample=buildAiSample(d,analyzeSchema(d.records,d.fields),'masked');
 let sent;
 const fetchImpl=async(url,opts)=>{sent={url,body:JSON.parse(opts.body),auth:opts.headers.authorization};return {ok:true,json:async()=>({choices:[{message:{content:'Here you go: '+JSON.stringify({summary:'Shipments with mixed formats.',issues:['Dates are mixed'],steps:[
  {op:'rename',column:'Ship Date',to:'ship_date',reason:'clearer'},{op:'normalize_date',column:'ship_date',order:'DMY'},
  {op:'normalize_number',column:'Weight (kg)',decimal:','},{op:'delete_everything'},{op:'trim',column:'Nope'},{op:'sort',by:[{column:'ship_date'}]}]})}}]})};};
 const settings=aiSettings({MODEL_API_KEY:'LLM_test'});
 const r=await aiOrganize(sample,{settings,fetchImpl});
 assert.equal(sent.url,`${META_BASE_URL}/chat/completions`);assert.equal(sent.body.model,META_DEFAULT_MODEL);assert.equal(sent.auth,'Bearer LLM_test');
 assert.ok(!JSON.stringify(sent.body).includes('Lena Braun'),'masked names never reach the AI');
 assert.deepEqual(r.steps.map(s=>s.op),['rename','normalize_date','normalize_number','sort']);
 assert.equal(r.rejected.length,2);assert.equal(r.summary,'Shipments with mixed formats.');
});
test('AI settings prefer Meta, fall back to the template ZAI settings, else none',()=>{
 assert.equal(aiSettings({MODEL_API_KEY:'k'}).provider,'Meta');
 assert.equal(aiSettings({MODEL_API_KEY:'k',MODEL_API_MODEL:'muse-wonder-1.0'}).model,'muse-wonder-1.0');
 assert.equal(aiSettings({ZAI_API_KEY:'k',ZAI_BASE_URL:'https://x/v1/',ZAI_MODEL:'m'}).baseUrl,'https://x/v1');
 assert.equal(aiSettings({}),null);
});
