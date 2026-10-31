// ChainBridge pricing model (placeholder values: edit PRICING to change prices).
// The quote is computed from simple, explainable measurements of the file, never by the AI, so it is free to
// compute, reproducible (same file, same price) and cannot be talked down. All amounts are in lovelace
// (1 ADA = 1,000,000 lovelace). Cardano cannot send less than about 1 ADA, so the minimum is 2 ADA.
export const PRICING=Object.freeze({
 currency:'tADA',
 base:2_000_000,                 // the service: AI analysis, fingerprint, publication on Cardano
 per1000Records:500_000,          // per started block of 1,000 records
 perPrivateColumn:250_000,        // columns labelled personal or confidential (masking and care)
 perTidyIssue:250_000,            // concrete tidy-up problems found (spaces, mixed dates, yes/no variants, duplicates, ...)
 perColumnOver10:100_000,         // wide tables
 perDocumentPage:500_000,         // documents: each PDF page or image the AI reads
 perDocument:250_000,             // documents: each file extracted and sealed
 minimum:2_000_000,
 maximum:20_000_000,
});

export const ada=lovelace=>(Number(lovelace)/1e6).toLocaleString('en',{maximumFractionDigits:2});

// Measurements taken locally from the uploaded file. Only these numbers are sent for the quote.
// countTidyIssues(data) -> number of concrete clean-up problems (the local rules in organize.mjs).
export function measure(data,schema,countTidyIssues){
 const privateColumns=schema.filter(f=>f.sensitivity!=='none').length;
 return {records:data.records.length,columns:data.fields.length,privateColumns,tidyIssues:countTidyIssues(data)};
}

// Documents (PDFs, photos): the AI reads every page, so the price follows the page count.
export function measureDocuments(docs){return {kind:'documents',documents:docs.length,pages:docs.reduce((n,d)=>n+d.pages,0)};}

// Validates untrusted measurements and returns the price with a line-by-line breakdown.
export function quote(m){
 if(m?.kind==='documents')return quoteDocuments(m);
 const n=(v,max)=>{const x=Number(v);if(!Number.isInteger(x)||x<0||x>max)throw new Error('Invalid measurement');return x;};
 const records=n(m.records,1_000_000),columns=n(m.columns,1000),privateColumns=n(m.privateColumns,columns),tidyIssues=n(m.tidyIssues,1000);
 if(!records)throw new Error('The file has no records');
 const lines=[{label:'ChainBridge service: AI analysis, fingerprint and publication on Cardano',lovelace:PRICING.base}];
 const blocks=Math.ceil(records/1000);
 lines.push({label:`${records.toLocaleString('en')} records (${blocks} × 1,000)`,lovelace:blocks*PRICING.per1000Records});
 if(privateColumns)lines.push({label:`${privateColumns} private column(s) to protect`,lovelace:privateColumns*PRICING.perPrivateColumn});
 if(tidyIssues)lines.push({label:`${tidyIssues} tidy-up problem(s) found`,lovelace:tidyIssues*PRICING.perTidyIssue});
 if(columns>10)lines.push({label:`${columns-10} column(s) beyond 10`,lovelace:(columns-10)*PRICING.perColumnOver10});
 let total=lines.reduce((s,l)=>s+l.lovelace,0);
 if(total<PRICING.minimum)total=PRICING.minimum;
 if(total>PRICING.maximum){lines.push({label:'Price cap',lovelace:PRICING.maximum-total});total=PRICING.maximum;}
 return {measurements:{records,columns,privateColumns,tidyIssues},lines,totalLovelace:total,currency:PRICING.currency};
}

function quoteDocuments(m){
 const n=(v,max)=>{const x=Number(v);if(!Number.isInteger(x)||x<1||x>max)throw new Error('Invalid measurement');return x;};
 const documents=n(m.documents,10),pages=n(m.pages,400);
 if(pages<documents)throw new Error('Invalid measurement');
 const lines=[{label:'ChainBridge service: AI extraction, fingerprint and publication on Cardano',lovelace:PRICING.base},
  {label:`${pages} page(s) or image(s) for the AI to read`,lovelace:pages*PRICING.perDocumentPage},
  {label:`${documents} document(s) to extract and seal`,lovelace:documents*PRICING.perDocument}];
 let total=lines.reduce((s,l)=>s+l.lovelace,0);
 if(total>PRICING.maximum){lines.push({label:'Price cap',lovelace:PRICING.maximum-total});total=PRICING.maximum;}
 return {measurements:{kind:'documents',documents,pages},lines,totalLovelace:total,currency:PRICING.currency};
}
