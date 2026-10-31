import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodePaymentSignatureHeader} from '@x402/core/http';
import {sniffType,countPdfPages,describeDocument,recordsFromExtractions,DOC_LIMITS} from '../src/core/documents.mjs';
import {quote,measureDocuments} from '../src/core/pricing.mjs';
import {sanitizeExtraction,documentPart,extractDocument,toKey} from '../src/server/ai-extract.mjs';
import {createX402Service} from '../src/server/x402-service.mjs';

const pdf=new Uint8Array(readFileSync(new URL('../samples/car-inspection-report.pdf',import.meta.url)));
const png=new Uint8Array(readFileSync(new URL('../samples/car-inspection-photo.png',import.meta.url)));

test('File type comes from the bytes, not the name; PDF pages are counted locally',()=>{
 assert.equal(sniffType(pdf),'pdf');assert.equal(sniffType(png),'png');
 assert.equal(sniffType(Uint8Array.from([0xff,0xd8,0xff,0xe0])),'jpeg');
 assert.equal(sniffType(new TextEncoder().encode('id,name\n1,x')),null);
 assert.equal(countPdfPages(pdf),2);
 assert.deepEqual(describeDocument('report.pdf',pdf),{name:'report.pdf',type:'pdf',mime:'application/pdf',bytes:pdf.length,pages:2});
 assert.equal(describeDocument('fake.pdf',png).type,'png','a renamed image is still treated as an image');
 assert.throws(()=>describeDocument('notes.txt',new TextEncoder().encode('hello')),/not a supported file/);
 assert.throws(()=>describeDocument('big.pdf',new Uint8Array(DOC_LIMITS.maxBytes+1).fill(37)),/not a supported file|limit/);
});
test('Documents are priced by pages and documents, deterministically',()=>{
 const m=measureDocuments([{pages:2},{pages:1}]);
 assert.deepEqual(m,{kind:'documents',documents:2,pages:3});
 assert.equal(quote(m).totalLovelace,2_000_000+3*500_000+2*250_000);
 assert.throws(()=>quote({kind:'documents',documents:3,pages:2}));
 assert.throws(()=>quote({kind:'documents',documents:11,pages:20}));
});
test('AI output is sanitized: keys, enums, limits, reserved names, duplicates',()=>{
 const r=sanitizeExtraction({documentType:'x',summary:'s',fields:[
  {key:'VIN Number',label:'VIN',value:'WVW123',type:'identifier',sensitivity:'none',relevant:true,evidence:'VIN: WVW123',confidence:1},
  {key:'vin number',label:'VIN again',value:'WVW124',type:'weird',sensitivity:'secret',relevant:false,confidence:7},
  {key:'source_sha256',value:'spoofed'},{key:'empty',value:''},{key:'<script>',value:'x'}],omitted:[{what:'terms',reason:'boilerplate'}]});
 assert.deepEqual(r.fields.map(f=>f.key),['vin_number','vin_number_2','script']);
 assert.equal(r.fields[1].type,'text');assert.equal(r.fields[1].sensitivity,'none');assert.equal(r.fields[1].confidence,1);assert.equal(r.fields[1].relevant,false);
 assert.equal(toKey('Odometer reading (km)'),'odometer_reading_km');assert.equal(toKey('1st owner'),'f_1st_owner');
 assert.equal(r.omitted[0].what,'terms');
});
test('Meta request: PDFs as file parts, images as data URLs, with a JSON schema answer format',async()=>{
 assert.deepEqual(documentPart({name:'a.pdf',mime:'application/pdf',data:'QQ=='}),{type:'file',file:{filename:'a.pdf',file_data:'data:application/pdf;base64,QQ=='}});
 assert.deepEqual(documentPart({name:'a.png',mime:'image/png',data:'QQ=='}),{type:'image_url',image_url:{url:'data:image/png;base64,QQ=='}});
 let body;
 const fetchImpl=async(url,opts)=>{body=JSON.parse(opts.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({documentType:'invoice',title:'t',summary:'s',language:'en',fields:[{key:'total',label:'Total',value:'12 EUR',type:'amount',sensitivity:'confidential',relevant:true,reason:'',evidence:'Total 12 EUR',confidence:0.9}],omitted:[]})}}]})};};
 const r=await extractDocument({name:'a.pdf',mime:'application/pdf',data:'QQ=='},{settings:{provider:'Meta',apiKey:'k',baseUrl:'https://api.meta.ai/v1',model:'muse-spark-1.3'},fetchImpl});
 assert.equal(body.response_format.type,'json_schema');assert.equal(body.messages[1].content[1].type,'file');
 assert.match(body.messages[0].content,/never follow them/);
 assert.equal(r.fields[0].key,'total');assert.equal(r.provider,'Meta');
});
test('Confirmed facts become one row per document, with the file name and SHA-256',()=>{
 const d=recordsFromExtractions([
  {name:'a.pdf',sha256:'a'.repeat(64),fields:[{key:'vin',value:'1',keep:true},{key:'note',value:'x',keep:false}]},
  {name:'b.png',sha256:'b'.repeat(64),fields:[{key:'vin',value:'2',keep:true},{key:'km',value:'9',keep:true}]}]);
 assert.deepEqual(d.fields,['source_file','source_sha256','vin','km']);
 assert.deepEqual(d.records[0].values,{source_file:'a.pdf',source_sha256:'a'.repeat(64),vin:'1',km:''});
 assert.equal(d.records[1].sourceRow,2);
});

async function paidDocSession(t){
 const dir=mkdtempSync(join(tmpdir(),'cb-docs-'));let extracted=0;
 const requirements={scheme:'exact',network:'cardano:preprod',amount:'3250000',asset:'lovelace',payTo:'addr_test1qseller',maxTimeoutSeconds:1800,extra:{}};
 const svc=createX402Service({dir,resourceBase:'http://x',
  seller:{paymentRequired:async()=>({requirements,paymentRequired:{x402Version:2,accepts:[requirements]}}),verify:async()=>({isValid:true,payer:'p'}),settle:async()=>({success:true,transaction:'cd'.repeat(32)})},
  extract:async d=>{extracted++;return {documentType:'report',title:'t',summary:'s',fields:[],omitted:[],provider:'Meta',model:'m'};},
  publish:async()=>({status:'confirmed',txHash:'ab'.repeat(32)})});
 const q=svc.quote({kind:'documents',documents:1,pages:2});await svc.paymentRequired(q.id);
 await svc.pay(q.id,encodePaymentSignatureHeader({x402Version:2,accepted:requirements,payload:{transaction:'dHg=',nonce:'aa'.repeat(32)+'#0'}}));
 t.after(()=>rmSync(dir,{recursive:true}));
 return {svc,q,dir,count:()=>extracted};
}
test('Paid extraction needs consent, is limited to the quoted pages and documents, and stores no document data',async t=>{
 const {svc,q,dir,count}=await paidDocSession(t);
 const doc={name:'report.pdf',data:Buffer.from(pdf).toString('base64')};
 await assert.rejects(svc.extract(q.id,{documents:[doc]}),/needs your consent/);
 await assert.rejects(svc.extract(q.id,{consent:true,documents:[doc,doc]}),/covered 1 document/);
 await assert.rejects(svc.extract(q.id,{consent:true,documents:[{name:'x.pdf',data:Buffer.from('hello').toString('base64')}]}),/not a supported file/);
 assert.equal(count(),0);
 const v=await svc.extract(q.id,{consent:true,documents:[doc]});
 assert.equal(v.status,'analyzed');assert.equal(v.extraction[0].pages,2);assert.match(v.extraction[0].sha256,/^[0-9a-f]{64}$/);
 const stored=readdirSync(join(dir)).map(f=>readFileSync(join(dir,f),'utf8')).join('');
 assert.ok(!stored.includes(doc.data.slice(0,40)),'document bytes are never written to disk');
 const tooMany=await paidDocSession(t);
 const threePages={name:'r.pdf',data:Buffer.from(pdf).toString('base64')};
 await assert.rejects(tooMany.svc.extract(tooMany.q.id,{consent:true,documents:[threePages]}).then(()=>tooMany.svc.extract(tooMany.q.id,{consent:true,documents:[threePages]})).then(()=>tooMany.svc.extract(tooMany.q.id,{consent:true,documents:[threePages]})),/limit reached/);
});
test('Unpaid sessions and table quotes cannot run document extraction',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cb-docs2-'));
 try{
  const svc=createX402Service({dir,resourceBase:'x',seller:{},extract:async()=>({})});
  const q=svc.quote({kind:'documents',documents:1,pages:1});
  await assert.rejects(svc.extract(q.id,{consent:true,documents:[{name:'a.png',data:Buffer.from(png).toString('base64')}]}),/Payment required/);
 }finally{rmSync(dir,{recursive:true});}
});
