import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const ID=/^[0-9a-f-]{36}$/;
export function createTaskStore(dir){
 mkdirSync(dir,{recursive:true,mode:0o700});
 const file=id=>{if(!ID.test(id))throw new Error('Invalid task id');return join(dir,`${id}.json`);};
 return {
  get:id=>existsSync(file(id))?JSON.parse(readFileSync(file(id),'utf8')):null,
  save:task=>{writeFileSync(file(task.id),JSON.stringify(task,null,1),{mode:0o600});return task;},
  list:()=>readdirSync(dir).filter(f=>ID.test(f.replace('.json',''))).map(f=>JSON.parse(readFileSync(join(dir,f),'utf8'))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),
 };
}
