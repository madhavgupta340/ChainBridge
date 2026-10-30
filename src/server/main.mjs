// ChainBridge local web app. Serves the UI and a small JSON API on 127.0.0.1 only.
// Record parsing, hashing and proofs run in the browser; this server sees only hashes and task metadata.
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {LIMITS} from '../core/limits.mjs';
import {NETWORK,SERVICE_PRICE,loadConfig,quoteFor} from './config.mjs';
import {createAuditLog} from './audit.mjs';
import {createTaskStore} from './store.mjs';
import {TaskError,createTaskService,publicTask} from './tasks.mjs';
import {createSokosumiSubmitter,readWorkerJournal} from './sokosumi.mjs';
import {aiPlan,sanitizeSummary} from './ai-planner.mjs';
import {aiOrganize} from './ai-organizer.mjs';
import {aiSettings} from './ai-config.mjs';
import {PAYMENT_STATUS,TASK_STATES} from './states.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const STATIC={'/':'public/index.html','/app.js':'public/app.js','/ui.js':'public/ui.js','/styles.css':'public/styles.css'};
const TYPES={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',csv:'text/csv; charset=utf-8',json:'application/json; charset=utf-8'};
const HEADERS={'x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY',
 'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"};

function staticPath(pathname){
 if(STATIC[pathname])return STATIC[pathname];
 let m=pathname.match(/^\/core\/([a-z-]+\.mjs)$/);if(m)return `src/core/${m[1]}`;
 m=pathname.match(/^\/samples\/([a-z0-9-]+\.(csv|json))$/);if(m)return `samples/${m[1]}`;
 return null;
}

export function createApp({config=loadConfig(),dataDir=join(root,'.local/chainbridge'),journalDir=join(root,'.local'),submit,ai=aiPlan,organize=sample=>aiOrganize(sample,{settings:aiSettings()})}={}){
 const audit=createAuditLog(join(dataDir,'audit.jsonl'));
 const tasks=createTaskService({store:createTaskStore(join(dataDir,'tasks')),audit,config,
  submit:submit??createSokosumiSubmitter(config),readJournal:id=>readWorkerJournal(id,journalDir)});
 const send=(res,status,data)=>{res.writeHead(status,{...HEADERS,'content-type':TYPES.json,'cache-control':'no-store'});res.end(JSON.stringify(data));};
 async function body(req){
  if(!(req.headers['content-type']||'').startsWith('application/json'))throw new TaskError(415,'Expected application/json');
  let size=0,text='';for await(const c of req){size+=c.length;if(size>64*1024)throw new TaskError(413,'Request too large');text+=c;}
  try{return JSON.parse(text||'{}');}catch{throw new TaskError(400,'Invalid JSON');}
 }
 return createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://127.0.0.1');
   if(req.method==='GET'){
    const file=staticPath(url.pathname);
    if(file&&existsSync(join(root,file))){res.writeHead(200,{...HEADERS,'content-type':TYPES[file.split('.').pop()],'cache-control':'no-cache'});return res.end(readFileSync(join(root,file)));}
    if(url.pathname==='/api/config')return send(res,200,{mode:config.mode,paid:config.paid,reason:config.reason,ai:config.ai,aiProvider:config.aiProvider??null,network:NETWORK,limits:LIMITS,
     price:config.paid?SERVICE_PRICE:null,quote:quoteFor(config),taskStates:TASK_STATES,paymentStatus:PAYMENT_STATUS});
    if(url.pathname==='/api/tasks')return send(res,200,tasks.list().map(publicTask));
    let m=url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})$/);
    if(m){const t=tasks.refresh(m[1]);return send(res,200,publicTask(t));}
    if(url.pathname==='/api/audit')return send(res,200,audit.list());
    return send(res,404,{error:'Not found'});
   }
   if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
   // Same-origin only: blocks other sites from driving the local API.
   const origin=req.headers.origin;
   if(origin&&origin!==`http://${req.headers.host}`)return send(res,403,{error:'Cross-origin request refused'});
   const data=await body(req);
   if(url.pathname==='/api/plan/ai'){
    if(!config.ai)return send(res,400,{error:'No AI provider configured. The local planner is in use.'});
    if(data.consent!==true)return send(res,400,{error:'Sending the schema summary to the AI provider requires your consent'});
    try{return send(res,200,await ai(sanitizeSummary(data.summary)));}catch(e){return send(res,502,{error:`AI planner unavailable: ${e.message}. Use the local plan.`});}
   }
   if(url.pathname==='/api/organize/ai'){
    if(!config.ai)return send(res,400,{error:'No AI provider is set up. Use the quick rules instead.'});
    if(data.consent!==true)return send(res,400,{error:'Sharing the sample with the AI service needs your consent'});
    if(data.sample?.shareMode==='full'&&data.fullConsent!==true)return send(res,400,{error:'Sharing unmasked rows needs a separate confirmation'});
    try{return send(res,200,await organize(data.sample));}catch(e){return send(res,502,{error:`The AI service didn't answer (${e.message}). You can use the quick rules instead.`});}
   }
   if(url.pathname==='/api/tasks'){const {task,reused}=tasks.quote({jobText:data.jobText});return send(res,reused?200:201,{task:publicTask(task),reused});}
   let m=url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/(approve|cancel)$/);
   if(m){const t=m[2]==='approve'?await tasks.approve(m[1],data):tasks.cancel(m[1]);return send(res,200,publicTask(t));}
   return send(res,404,{error:'Not found'});
  }catch(e){
   if(e instanceof TaskError)return send(res,e.status,{error:e.message});
   console.error('Request failed:',e.message);return send(res,500,{error:'Request failed. Check task status before retrying.'});
  }
 });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const config=loadConfig();
 createApp({config}).listen(config.port,'127.0.0.1',()=>{
  console.log(`ChainBridge running at http://127.0.0.1:${config.port}`);
  console.log(`Mode: ${config.mode}${config.paid?' (paid Preprod tasks)':''}: ${config.reason}`);
 });
}
