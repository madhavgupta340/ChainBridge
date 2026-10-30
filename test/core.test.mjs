import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ingest,parseCsvRows,IngestError} from '../src/core/ingest.mjs';
import {LIMITS} from '../src/core/limits.mjs';
import {canonicalize,canonicalRecord} from '../src/core/canonical.mjs';
import {leafHash,nodeHash,merkleRoot,buildTree,merkleProof,verifyProof,sha256Hex} from '../src/core/merkle.mjs';
import {analyzeSchema,applyOverride,schemaSummary} from '../src/core/schema.mjs';
import {buildCommitment,verifyRecord} from '../src/core/commitment.mjs';

// Values that cannot occur inside hex hashes or protocol text, so a substring match means a real leak.
const distinctive=v=>typeof v==='string'&&/[g-z]/i.test(v)&&v.length>3&&!/^(true|false)$/.test(v);
const sample=name=>readFileSync(new URL(`../samples/${name}`,import.meta.url),'utf8');

test('CSV: quotes, escaped quotes, CRLF, embedded newlines and BOM',()=>{
 const d=ingest({name:'a.csv',text:'﻿id,note\r\n1,"a, ""quoted"" value"\r\n2,"multi\nline"\r\n'});
 assert.deepEqual(d.fields,['id','note']);
 assert.equal(d.records[0].values.note,'a, "quoted" value');
 assert.equal(d.records[1].values.note,'multi\nline');
});
test('CSV: malformed input gives clear errors, bad rows are skipped and reported',()=>{
 assert.throws(()=>ingest({name:'a.csv',text:'id,x\n1,"open'}),/unterminated quoted value/);
 assert.throws(()=>ingest({name:'a.csv',text:'id,id\n1,2'}),/Duplicate field name/);
 assert.throws(()=>ingest({name:'a.csv',text:'id,\n1,2'}),/header is empty/);
 assert.throws(()=>ingest({name:'a.csv',text:'id,x\n1,a"b'}),/quote character inside/);
 assert.throws(()=>ingest({name:'a.csv',text:'__proto__\n1'}),/not allowed/);
 const d=ingest({name:'a.csv',text:'id,x\n1,a\n2\n3,c,extra\n4,d'});
 assert.equal(d.records.length,2);
 assert.deepEqual(d.issues.map(i=>i.row),[3,4]);
});
test('Empty input is rejected',()=>{
 assert.throws(()=>ingest({name:'a.csv',text:''}),IngestError);
 assert.throws(()=>ingest({name:'a.csv',text:'id,x\n'}),/No valid records/);
 assert.throws(()=>ingest({name:'a.json',text:'[]'}),/no records/);
});
test('Size, row and column limits are enforced',()=>{
 assert.throws(()=>ingest({name:'a.csv',text:'a\n1',byteLength:LIMITS.maxBytes+1}),/limit is 2 MB/);
 const rows='x\n'+Array.from({length:LIMITS.maxRows+1},(_,i)=>i).join('\n');
 assert.throws(()=>ingest({name:'a.csv',text:rows}),/limit is 5000/);
 const cols=Array.from({length:LIMITS.maxColumns+1},(_,i)=>`c${i}`).join(',');
 assert.throws(()=>ingest({name:'a.csv',text:`${cols}\n${cols}`}),/Too many fields/);
 const d=ingest({name:'a.csv',text:`a,b\n1,${'x'.repeat(LIMITS.maxCellChars+1)}\n2,ok`});
 assert.equal(d.records.length,1);assert.match(d.issues[0].message,/longer than/);
});
test('JSON: arrays or {records}, non-objects skipped, invalid JSON explained',()=>{
 const d=ingest({name:'a.json',text:'{"records":[{"a":1},5,{"a":2,"b":"x"}]}'});
 assert.deepEqual(d.fields,['a','b']);assert.equal(d.records.length,2);assert.equal(d.issues.length,1);
 assert.throws(()=>ingest({name:'a.json',text:'{"a":1}'}),/Expected a JSON array/);
 assert.throws(()=>ingest({name:'a.json',text:'[{"a":1},'}),/Invalid JSON/);
 const evil=ingest({name:'a.json',text:'[{"a":"<img src=x onerror=alert(1)>"}]'});
 assert.equal(evil.records[0].values.a,'<img src=x onerror=alert(1)>','values are kept as inert text');
});
test('Samples load',()=>{
 assert.equal(ingest({name:'supplier-certificates.csv',text:sample('supplier-certificates.csv')}).records.length,12);
 assert.equal(ingest({name:'payroll-export.json',text:sample('payroll-export.json')}).records.length,5);
});

test('Canonicalization is stable across key order, Unicode form and number spelling',()=>{
 assert.equal(canonicalize({b:1,a:'x'}),canonicalize({a:'x',b:1}));
 assert.equal(canonicalize({a:'é'}),canonicalize({a:'é'}));
 assert.equal(canonicalize({n:1.0,z:-0}),'{"n":1,"z":0}');
 assert.equal(canonicalize({a:[1,{c:null,b:true}]}),'{"a":[1,{"b":true,"c":null}]}');
 assert.throws(()=>canonicalize({n:NaN}),/non-finite/);
 assert.equal(canonicalRecord({a:'1',b:'2',c:'3'},['c','a']),'{"a":"1","c":"3"}');
 assert.equal(canonicalRecord({a:'1'},['a','missing']),'{"a":"1","missing":null}');
 assert.notEqual(canonicalRecord({a:'1'},['a']),canonicalRecord({a:1},['a']),'CSV string and JSON number differ by design');
});
test('Hashing: known vectors and domain separation',async()=>{
 assert.equal(await sha256Hex('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 const leaf=await leafHash('{"a":"1"}');
 assert.equal(leaf,await leafHash('{"a":"1"}'));
 assert.notEqual(leaf,await sha256Hex('{"a":"1"}'));
 assert.notEqual(leaf,await leafHash('{"a":"1"}','0'.repeat(32)));
 await assert.rejects(leafHash('x','nothex'),/Salt/);
});
test('Merkle: odd nodes are promoted, never duplicated; proofs verify for every leaf',async()=>{
 const leaves=await Promise.all(['a','b','c','d','e'].map(x=>leafHash(x)));
 assert.equal(await merkleRoot([leaves[0]]),leaves[0]);
 const abc=await merkleRoot(leaves.slice(0,3));
 assert.equal(abc,await nodeHash(await nodeHash(leaves[0],leaves[1]),leaves[2]));
 assert.notEqual(abc,await merkleRoot([...leaves.slice(0,3),leaves[2]]),'duplicating the last leaf changes the root');
 await assert.rejects(merkleRoot([]),/no records/);
 const {root,levels}=await buildTree(leaves);
 for(let i=0;i<leaves.length;i++)assert.equal(await verifyProof(leaves[i],merkleProof(levels,i),root),true);
 const p=merkleProof(levels,1);
 assert.equal(await verifyProof(leaves[2],p,root),false);
 assert.equal(await verifyProof(leaves[1],{...p,siblings:p.siblings.map(s=>({...s,side:s.side==='left'?'right':'left'}))},root),false);
 assert.equal(await verifyProof(leaves[1],{siblings:[{side:'up',hash:leaves[0]}]},root),false);
});

test('Sensitivity heuristics flag personal and confidential fields; users can override',()=>{
 const d=ingest({name:'p.json',text:sample('payroll-export.json')});
 const s=Object.fromEntries(analyzeSchema(d.records,d.fields).map(f=>[f.name,f]));
 assert.equal(s.email.sensitivity,'personal');
 assert.equal(s.full_name.sensitivity,'personal');
 assert.equal(s.iban.sensitivity,'confidential');
 assert.equal(s.gross_salary.sensitivity,'confidential');
 assert.equal(s.department.sensitivity,'none');
 assert.equal(s.employee_id.type,'identifier');
 assert.equal(s.approved.type,'boolean');
 assert.equal(s.gross_salary.type,'number');
 assert.ok(s.email.reasons.some(r=>/email/i.test(r)));
 const o=applyOverride(s.department,{sensitivity:'confidential',type:'identifier'});
 assert.equal(o.sensitivity,'confidential');assert.equal(o.overridden,true);assert.equal(o.inferred.sensitivity,'none');
 assert.throws(()=>applyOverride(s.department,{sensitivity:'secret'}),/Unknown sensitivity/);
 const csv=ingest({name:'c.csv',text:sample('supplier-certificates.csv')});
 const cs=Object.fromEntries(analyzeSchema(csv.records,csv.fields).map(f=>[f.name,f]));
 assert.equal(cs.inspector_email.sensitivity,'personal');assert.equal(cs.inspection_date.type,'datetime');assert.equal(cs.lab_report_url.type,'url');
 assert.equal(cs.certificate_id.type,'identifier');assert.equal(cs.product.sensitivity,'none');
});
test('Schema summary for the AI planner contains no record values',()=>{
 const d=ingest({name:'p.json',text:sample('payroll-export.json')});
 const text=JSON.stringify(schemaSummary(analyzeSchema(d.records,d.fields),d.records.length));
 for(const r of d.records)for(const v of Object.values(r.values))if(typeof v==='string')assert.ok(!text.includes(v),`leaked ${v}`);
});

const plan=(over={})=>({version:1,source:'deterministic',fields:['certificate_id','product','passed'],strategy:'merkle-root',ordering:'leaf-hash',salt:'none',duplicates:'keep',rationale:[],risks:[],assumptions:[],...over});
test('Commitment: deterministic, order-independent with leaf-hash ordering, no raw values public',async()=>{
 const d=ingest({name:'c.csv',text:sample('supplier-certificates.csv')});
 const a=await buildCommitment({records:d.records,plan:plan()});
 const b=await buildCommitment({records:d.records.slice().reverse(),plan:plan()});
 assert.equal(a.root,b.root);
 const src=await buildCommitment({records:d.records.slice().reverse(),plan:plan({ordering:'source'})});
 assert.notEqual(src.root,a.root);
 assert.equal(a.payload.leafCount,12);assert.equal(a.payload.leaves,undefined);
 for(const r of d.records)for(const v of Object.values(r.values).filter(distinctive)){assert.ok(!a.payloadText.includes(v));assert.ok(!JSON.stringify(a.bundle).includes(`"${v}"`));}
 const per=await buildCommitment({records:d.records.slice(0,3),plan:plan({strategy:'per-record-hashes'})});
 assert.equal(per.payload.leaves.length,3);
});
test('Commitment: salts change leaves, are reusable, and verification needs them',async()=>{
 const d=ingest({name:'c.csv',text:sample('supplier-certificates.csv')});
 const a=await buildCommitment({records:d.records,plan:plan({salt:'per-record'})});
 const b=await buildCommitment({records:d.records,plan:plan({salt:'per-record'})});
 assert.notEqual(a.root,b.root,'fresh random salts');
 const salts=Object.fromEntries(a.entries.map(e=>[e.sourceRow,e.salt]));
 assert.equal((await buildCommitment({records:d.records,plan:plan({salt:'per-record'}),salts})).root,a.root);
 const r=d.records[3];
 assert.equal((await verifyRecord({values:r.values,sourceRow:r.sourceRow,bundle:a.bundle})).match,true);
});
test('Verification: unchanged record matches, modified record fails, excluded field changes are not detected',async()=>{
 const d=ingest({name:'c.csv',text:sample('supplier-certificates.csv')});
 const c=await buildCommitment({records:d.records,plan:plan()});
 const r=d.records[5];
 const ok=await verifyRecord({values:r.values,sourceRow:r.sourceRow,bundle:c.bundle});
 assert.equal(ok.match,true);assert.equal(ok.computedLeaf,ok.expectedLeaf);
 const bad=await verifyRecord({values:{...r.values,passed:'false'},sourceRow:r.sourceRow,bundle:c.bundle});
 assert.equal(bad.match,false);assert.match(bad.reason,/differs/);
 const excluded=await verifyRecord({values:{...r.values,supplier:'Someone else'},sourceRow:r.sourceRow,bundle:c.bundle});
 assert.equal(excluded.match,true,'supplier is not in the committed fields');
 const missing=await verifyRecord({values:r.values,sourceRow:9999,bundle:c.bundle});
 assert.equal(missing.match,false);
});
test('Duplicates: kept as distinct leaves, or dropped; empty selection rejected',async()=>{
 const records=[{sourceRow:2,values:{a:'x'}},{sourceRow:3,values:{a:'x'}},{sourceRow:4,values:{a:'y'}}];
 const keep=await buildCommitment({records,plan:plan({fields:['a']})});
 assert.equal(keep.stats.duplicates,1);assert.equal(keep.payload.leafCount,3);
 const drop=await buildCommitment({records,plan:plan({fields:['a'],duplicates:'drop'})});
 assert.equal(drop.payload.leafCount,2);assert.equal(drop.stats.dropped,1);
 const salted=await buildCommitment({records,plan:plan({fields:['a'],salt:'per-record'})});
 assert.equal(new Set(salted.entries.map(e=>e.leafHash)).size,3);
 await assert.rejects(buildCommitment({records:[],plan:plan()}),/empty dataset/);
});
test('CSV row parser keeps line numbers for multi-line values',()=>{
 assert.deepEqual(parseCsvRows('a\n"x\ny"\nz').map(r=>r.line),[1,2,4]);
});
