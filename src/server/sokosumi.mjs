// Sokosumi adapter. Uses only the CLI commands documented in the TUM guide (`tasks create`),
// and reads the template worker's private journal for status. No credentials pass through ChainBridge.
import {execFile} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';

// Without an organization slug the CLI's login session targets the personal Workspace by default.
// `--personal` is not passed: in CLI 1.0.4 it first calls a Core route that Preprod no longer serves (404).
export function createTaskArgs({coworkerId,organizationSlug,name,description}){
 return ['--preprod','tasks','create',...(organizationSlug?['--organization-slug',organizationSlug]:[]),
  '--coworker-id',coworkerId,'--name',name,'--description',description,'--status','READY','--json'];
}

// Response shape is not documented; accept the common locations of an id and report none otherwise.
export function taskIdFrom(out){
 const id=out?.task?.id??out?.data?.id??out?.id;
 return typeof id==='string'&&/^[\w-]{1,100}$/.test(id)?id:null;
}

export function createSokosumiSubmitter(config,run=execFile){
 return task=>new Promise((resolve,reject)=>{
  const args=createTaskArgs({coworkerId:config.coworkerId,organizationSlug:config.organizationSlug,
   name:`ChainBridge ${task.kind} ${task.summary.commitment?.slice(0,12)??''}`.trim(),description:task.jobText});
  run('sokosumi',args,{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024},(err,stdout)=>{
   if(err)return reject(err);
   let out;try{out=JSON.parse(stdout);}catch{return resolve({sokosumiTaskId:null});}
   resolve({sokosumiTaskId:taskIdFrom(out)});
  });
 });
}

export function readWorkerJournal(taskId,dir='.local'){
 if(!/^[\w-]{1,100}$/.test(taskId))return null;
 const path=`${dir}/${taskId}.json`;
 return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
}
