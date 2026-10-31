// Documents (PDFs, photos, screenshots, Word files, XML) for AI extraction. Used in the browser and on the server.
// Word and XML are sent to the AI as text (extracted by src/core/office.mjs); PDFs and images as files.
// The file type is decided from the file's own bytes, never from its name, and pages are counted locally
// so the price is known before anything is sent to the AI.
export const DOC_LIMITS=Object.freeze({maxFiles:10,maxBytes:10*1024*1024,maxPages:40,maxTotalBytes:25*1024*1024});
import {officeKind,looksLikeXml,docxPages,xmlPages} from './office.mjs';
export const DOC_TYPES={pdf:'application/pdf',png:'image/png',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',
 docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xml:'application/xml'};
export const TEXT_TYPES=new Set(['docx','xml']);

export function sniffType(bytes){
 const b=bytes,s=(i,n)=>String.fromCharCode(...b.slice(i,i+n));
 if(b.length>4&&s(0,5)==='%PDF-')return 'pdf';
 if(b.length>8&&b[0]===0x89&&s(1,3)==='PNG')return 'png';
 if(b.length>3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return 'jpeg';
 if(b.length>12&&s(0,4)==='RIFF'&&s(8,4)==='WEBP')return 'webp';
 if(b.length>6&&(s(0,6)==='GIF87a'||s(0,6)==='GIF89a'))return 'gif';
 const office=officeKind(b);if(office)return office;
 if(looksLikeXml(b))return 'xml';
 return null;
}

// Page count without a PDF library: page objects, or the largest /Count in a page tree (compressed PDFs).
export function countPdfPages(bytes){
 let text='';for(let i=0;i<bytes.length;i+=65536)text+=String.fromCharCode(...bytes.subarray(i,i+65536));
 const pages=(text.match(/\/Type\s*\/Page(?![a-z])/g)||[]).length;
 const counts=[...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map(m=>Number(m[1]??m[2]));
 return Math.max(pages,...counts,1);
}

export function describeDocument(name,bytes){
 const type=sniffType(bytes);
 if(type==='xlsx')throw new Error(`${name}: this is an Excel spreadsheet. Load it on its own, as a spreadsheet.`);
 if(!type)throw new Error(`${name}: not a supported file. Use PDF, Word (.docx), XML, PNG, JPEG, WebP or GIF.`);
 if(bytes.length>DOC_LIMITS.maxBytes)throw new Error(`${name}: ${(bytes.length/1048576).toFixed(1)} MB. The limit is ${DOC_LIMITS.maxBytes/1048576} MB per document.`);
 // Word and XML pages are estimated from their size (for the price).
 const pages=type==='pdf'?countPdfPages(bytes):type==='docx'?docxPages(bytes):type==='xml'?xmlPages(bytes):1;
 if(pages>DOC_LIMITS.maxPages)throw new Error(`${name}: ${pages} pages. The limit is ${DOC_LIMITS.maxPages} pages per document.`);
 return {name:String(name).slice(0,120),type,mime:DOC_TYPES[type],bytes:bytes.length,pages};
}

export async function sha256Hex(bytes){
 const d=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes));
 return Array.from(d,x=>x.toString(16).padStart(2,'0')).join('');
}

// Turns confirmed extractions into records: one row per document, plus the source file's name and hash.
export function recordsFromExtractions(docs){
 const fields=['source_file','source_sha256'];const seen=new Set(fields);
 const records=docs.map((d,i)=>{
  const values={source_file:d.name,source_sha256:d.sha256};
  for(const f of d.fields.filter(f=>f.keep)){values[f.key]=f.value;if(!seen.has(f.key)){seen.add(f.key);fields.push(f.key);}}
  return {sourceRow:i+1,values};
 });
 for(const r of records)for(const f of fields)if(!(f in r.values))r.values[f]='';
 return {name:docs.length===1?docs[0].name:`${docs.length} documents`,format:'documents',fields,records,issues:[]};
}
