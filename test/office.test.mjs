import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {deflateRawSync,crc32} from 'node:zlib';
import {officeKind,zipRead,docxText,xlsxRows,rowsToCsv,looksLikeXml,OFFICE_LIMITS} from '../src/core/office.mjs';
import {sniffType,describeDocument,DOC_TYPES} from '../src/core/documents.mjs';
import {documentPart} from '../src/server/ai-extract.mjs';
import {ingest} from '../src/core/ingest.mjs';

const sample=n=>new Uint8Array(readFileSync(new URL(`../samples/${n}`,import.meta.url)));
const enc=new TextEncoder();
function zip(entries){
 const parts=[],central=[];let off=0;
 for(const [name,content,{claimSize}={}] of entries){
  const data=Buffer.from(content),comp=deflateRawSync(data),nb=Buffer.from(name);
  const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50,0);l.writeUInt16LE(8,8);l.writeUInt32LE(crc32(data),14);l.writeUInt32LE(comp.length,18);l.writeUInt32LE(claimSize??data.length,22);l.writeUInt16LE(nb.length,26);
  parts.push(l,nb,comp);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(8,10);c.writeUInt32LE(crc32(data),16);c.writeUInt32LE(comp.length,20);c.writeUInt32LE(claimSize??data.length,24);c.writeUInt16LE(nb.length,28);c.writeUInt32LE(off,42);
  central.push(c,nb);off+=30+nb.length+comp.length;
 }
 const dir=Buffer.concat(central),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(entries.length,8);e.writeUInt16LE(entries.length,10);e.writeUInt32LE(dir.length,12);e.writeUInt32LE(off,16);
 return new Uint8Array(Buffer.concat([...parts,dir,e]));
}

test('File types come from the bytes: Word, Excel and XML are recognised; Excel goes the spreadsheet way',()=>{
 assert.equal(sniffType(sample('framework-supply-agreement.docx')),'docx');
 assert.equal(sniffType(sample('cold-chain-temperature-log.xlsx')),'xlsx');
 assert.equal(sniffType(sample('customs-export-declaration.xml')),'xml');
 assert.equal(officeKind(zip([['other.txt','hi']])),null,'a zip that is not Word or Excel is not accepted');
 assert.equal(sniffType(enc.encode('<!doctype html><html><body>x</body></html>')),null,'HTML is not treated as XML');
 assert.equal(looksLikeXml(enc.encode('﻿  <?xml version="1.0"?><a/>')),true);
 assert.throws(()=>describeDocument('log.xlsx',sample('cold-chain-temperature-log.xlsx')),/Excel spreadsheet/);
 const d=describeDocument('agreement.docx',sample('framework-supply-agreement.docx'));
 assert.equal(d.mime,DOC_TYPES.docx);assert.ok(d.pages>=1);
});

test('Word: paragraphs and table cells as text; entities decoded; field codes dropped',async()=>{
 const t=await docxText(sample('framework-supply-agreement.docx'));
 assert.match(t,/FRAMEWORK SUPPLY AGREEMENT/);assert.match(t,/Hüttenstraße 40/);
 assert.match(t,/Heavy plate S355J2\+N \| 20–40 mm \| 3,600 t \| 812\.00/);
 const doc=zip([['word/document.xml','<w:document><w:body><w:p><w:r><w:t>A &amp; B</w:t></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p></w:body></w:document>']]);
 assert.equal(await docxText(doc),'A & B');
});

test('Excel: first worksheet as rows, inline and shared strings, then the normal table parser',async()=>{
 const rows=await xlsxRows(sample('cold-chain-temperature-log.xlsx'));
 assert.deepEqual(rows[0],['Logger ID','Timestamp','Temp','Unit','Location','Door open','Handled by']);
 assert.equal(rows.length,13,'the first sheet only, not the second');
 const d=ingest({name:'log.xlsx',text:rowsToCsv(rows)});
 assert.equal(d.records.length,12);assert.equal(d.records[6].values.Temp,'9.4');
 const shared=zip([['xl/workbook.xml','<workbook><sheets><sheet name="a" r:id="rId1"/></sheets></workbook>'],['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/s.xml"/></Relationships>'],
  ['xl/sharedStrings.xml','<sst><si><t>name</t></si><si><r><t>Ana</t></r><r><t> Lima</t></r></si></sst>'],
  ['xl/worksheets/s.xml','<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>7</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="b"><v>1</v></c></row></sheetData></worksheet>']]);
 assert.deepEqual(await xlsxRows(shared),[['name','','7'],['Ana Lima','TRUE','']]);
});

test('Oversized archive parts are refused before they are unpacked',async()=>{
 const bomb=zip([['word/document.xml','x',{claimSize:OFFICE_LIMITS.maxEntryBytes+1}]]);
 await assert.rejects(zipRead(bomb,'word/document.xml'),/too large/);
});

test('The AI receives Word and XML as text (with a clear label); PDFs and images stay files',async()=>{
 const w=await documentPart({name:'a.docx',mime:DOC_TYPES.docx,data:Buffer.from(sample('framework-supply-agreement.docx')).toString('base64')});
 assert.equal(w.type,'text');assert.match(w.text,/Word document/);assert.match(w.text,/Agreement No\. FSA-2026-NK-0117/);
 const x=await documentPart({name:'c.xml',mime:DOC_TYPES.xml,data:Buffer.from(sample('customs-export-declaration.xml')).toString('base64')});
 assert.equal(x.type,'text');assert.match(x.text,/<MRN>26DE4711E0098211A3<\/MRN>/);
});

test('Every upload sample can be read',async()=>{
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const listed=[...app.matchAll(/\['([a-z0-9-]+\.(?:pdf|docx|xlsx|xml|json|jpg|png))'/g)].map(m=>m[1]);
 assert.equal(listed.length,8);
 for(const n of listed){
  assert.ok(readdirSync(new URL('../samples/',import.meta.url)).includes(n),n);
  if(/\.(json|xlsx)$/.test(n)){
   const text=n.endsWith('.xlsx')?rowsToCsv(await xlsxRows(sample(n))):new TextDecoder().decode(sample(n));
   assert.ok(ingest({name:n,text}).records.length>0,n);
  }else assert.ok(describeDocument(n,sample(n)).pages>=1,n);
 }
});
