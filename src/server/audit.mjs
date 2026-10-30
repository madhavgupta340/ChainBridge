// Append-only operation history. Entries are built from an allow-list of privacy-safe keys:
// never raw records, job text, secrets, or free-form user input.
import {appendFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';

const KEYS=['event','taskId','kind','mode','network','commitment','strategy','recordCount','fieldCount','salted','price','paymentStatus','state','approval','txHash','blockchainIdentifier','sokosumiTaskId','reason'];
const HEXISH=/^[0-9a-zA-Z_.:\- ()/,]{0,200}$/;

export function auditEntry(fields){
 const entry={at:new Date().toISOString()};
 for(const k of KEYS){
  const v=fields[k];
  if(v===undefined||v===null)continue;
  if(typeof v==='number'||typeof v==='boolean')entry[k]=v;
  else if(typeof v==='string'&&HEXISH.test(v))entry[k]=v;
  else entry[k]='[omitted]';
 }
 return entry;
}

export function createAuditLog(path){
 return {
  append(fields){const e=auditEntry(fields);mkdirSync(dirname(path),{recursive:true,mode:0o700});appendFileSync(path,JSON.stringify(e)+'\n',{mode:0o600});return e;},
  list(limit=200){if(!existsSync(path))return [];return readFileSync(path,'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l=>JSON.parse(l)).reverse();},
 };
}
