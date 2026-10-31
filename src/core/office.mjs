// Reads Excel (.xlsx), Word (.docx) and XML files without a library, in the browser and in Node 24.
// .xlsx and .docx are zip archives of XML: the central directory is read directly, and entries are inflated with the
// built-in DecompressionStream ('deflate-raw'). Limits stop oversized or malicious archives ("zip bombs").
// Content is only ever treated as text or table cells: nothing is evaluated or rendered as HTML.
export const OFFICE_LIMITS=Object.freeze({maxEntries:2000,maxEntryBytes:20*1024*1024,maxTextChars:120000});
const dec=new TextDecoder('utf-8');

function u16(b,o){return b[o]|b[o+1]<<8;}
function u32(b,o){return (b[o]|b[o+1]<<8|b[o+2]<<16|b[o+3]<<24)>>>0;}

// Entries from the zip central directory (names are stored uncompressed, so this is synchronous).
export function zipEntries(bytes){
 const b=bytes;let eocd=-1;
 for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(u32(b,i)===0x06054b50){eocd=i;break;}
 if(eocd<0)throw new Error('Not a zip archive');
 const count=u16(b,eocd+10),dirOffset=u32(b,eocd+16);
 if(count>OFFICE_LIMITS.maxEntries)throw new Error('The file has too many parts');
 const out=[];let p=dirOffset;
 for(let n=0;n<count;n++){
  if(u32(b,p)!==0x02014b50)throw new Error('Damaged zip directory');
  const method=u16(b,p+10),compSize=u32(b,p+20),size=u32(b,p+24),nameLen=u16(b,p+28),extraLen=u16(b,p+30),commentLen=u16(b,p+32),offset=u32(b,p+42);
  out.push({name:dec.decode(b.subarray(p+46,p+46+nameLen)),method,compSize,size,offset});
  p+=46+nameLen+extraLen+commentLen;
 }
 return out;
}
const isZip=b=>b.length>4&&b[0]===0x50&&b[1]===0x4b&&b[2]===3&&b[3]===4;
// 'xlsx', 'docx' or null, from the archive's part names.
export function officeKind(bytes){
 if(!isZip(bytes))return null;
 let names;try{names=new Set(zipEntries(bytes).map(e=>e.name));}catch{return null;}
 if(names.has('word/document.xml'))return 'docx';
 if(names.has('xl/workbook.xml'))return 'xlsx';
 return null;
}
export async function zipRead(bytes,name){
 const e=zipEntries(bytes).find(x=>x.name===name);
 if(!e)return null;
 if(e.size>OFFICE_LIMITS.maxEntryBytes)throw new Error(`${name} is too large`);
 if(u32(bytes,e.offset)!==0x04034b50)throw new Error('Damaged zip entry');
 const start=e.offset+30+u16(bytes,e.offset+26)+u16(bytes,e.offset+28);
 const data=bytes.subarray(start,start+e.compSize);
 if(e.method===0)return data;
 if(e.method!==8)throw new Error('Unsupported compression in this file');
 const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
 const parts=[];let total=0;
 for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;
  if(total>OFFICE_LIMITS.maxEntryBytes){await reader.cancel();throw new Error(`${name} unpacks to more than ${OFFICE_LIMITS.maxEntryBytes/1048576} MB`);}
  parts.push(value);}
 const out=new Uint8Array(total);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}
 return out;
}

export const xmlDecode=s=>s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi,(m,e)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[e.toLowerCase()]
 ??(e[1]==='x'||e[1]==='X'?String.fromCodePoint(parseInt(e.slice(2),16)):String.fromCodePoint(Number(e.slice(1)))));
const cap=t=>t.length>OFFICE_LIMITS.maxTextChars?`${t.slice(0,OFFICE_LIMITS.maxTextChars)}\n[… truncated]`:t;

// Plain text of a Word document: paragraphs on their own lines, table cells separated by " | ".
export async function docxText(bytes){
 const raw=await zipRead(bytes,'word/document.xml');
 if(!raw)throw new Error('This Word file has no document body');
 const xml=dec.decode(raw);
 // Inside a table cell, paragraphs are joined with spaces so each table row stays on one line.
 const text=xml.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g,'').replace(/<w:tab\/>/g,'\t').replace(/<w:br[^>]*\/>/g,'\n')
  .replace(/<w:tc\b[\s\S]*?<\/w:tc>/g,cell=>`${cell.replace(/<\/w:p>/g,' ').replace(/<[^>]+>/g,'').trim()} | `)
  .replace(/<\/w:tr>/g,'\n').replace(/<\/w:p>/g,'\n').replace(/<[^>]+>/g,'');
 return cap(xmlDecode(text).replace(/ \| \n/g,'\n').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim());
}
// Estimated pages of a Word document, from the size of its body (used for the price; no unpacking needed).
export function docxPages(bytes){
 const e=zipEntries(bytes).find(x=>x.name==='word/document.xml');
 return Math.max(1,Math.ceil((e?.size??0)/30000));
}

const colIndex=ref=>{let n=0;for(const ch of ref.replace(/\d+$/,''))n=n*26+(ch.charCodeAt(0)-64);return n-1;};
// Cell values of the first worksheet, as rows of strings. Shared, inline and formula strings are resolved.
// Numbers are kept as written (dates stored as Excel serial numbers stay numbers).
export async function xlsxRows(bytes){
 const shared=[];
 const ss=await zipRead(bytes,'xl/sharedStrings.xml');
 if(ss)for(const m of dec.decode(ss).matchAll(/<si>([\s\S]*?)<\/si>/g))shared.push(xmlDecode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t=>t[1]).join('')));
 const wb=dec.decode(await zipRead(bytes,'xl/workbook.xml')??new Uint8Array());
 const firstRel=wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
 const rels=dec.decode(await zipRead(bytes,'xl/_rels/workbook.xml.rels')??new Uint8Array());
 let target=firstRel?rels.match(new RegExp(`<Relationship\\b[^>]*Id="${firstRel}"[^>]*Target="([^"]+)"`))?.[1]??rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${firstRel}"`))?.[1]:null;
 target=target?(target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`):'xl/worksheets/sheet1.xml';
 const sheet=await zipRead(bytes,target);
 if(!sheet)throw new Error('This Excel file has no worksheet');
 const rows=[];
 for(const r of dec.decode(sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){
  const row=[];
  for(const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
   const attrs=c[1],body=c[2]??'';
   const ref=attrs.match(/\br="([A-Z]+\d+)"/)?.[1],type=attrs.match(/\bt="([^"]+)"/)?.[1];
   const v=body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
   let value=type==='s'?shared[Number(v)]??'':type==='inlineStr'?xmlDecode([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t=>t[1]).join('')):type==='b'?(v==='1'?'TRUE':'FALSE'):xmlDecode(v??'');
   row[ref?colIndex(ref):row.length]=value;
  }
  rows.push(Array.from(row,x=>x??''));
 }
 const width=Math.max(0,...rows.map(r=>r.length));
 return rows.filter(r=>r.some(x=>String(x).trim()!=='')).map(r=>Array.from({length:width},(_,i)=>r[i]??''));
}
// Rows to CSV text (RFC 4180 quoting), so a worksheet goes through the same parser as a CSV file.
export const rowsToCsv=rows=>rows.map(r=>r.map(v=>/[",\r\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:String(v)).join(',')).join('\n');

// XML: the text as written (the AI reads the structure), after a basic check that it is XML.
export function looksLikeXml(bytes){
 const head=dec.decode(bytes.subarray(0,512)).replace(/^﻿/,'').trimStart();
 return /^<\?xml\b/.test(head)||/^<[A-Za-z_][\w.:-]*[\s>]/.test(head)&&!/^<!doctype html|^<html/i.test(head);
}
export const xmlText=bytes=>cap(dec.decode(bytes).replace(/^﻿/,''));
export const xmlPages=bytes=>Math.max(1,Math.ceil(bytes.length/6000));
