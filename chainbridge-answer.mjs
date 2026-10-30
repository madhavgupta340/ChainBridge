import {writeFileSync} from 'node:fs';
import {runJob} from './src/core/job.mjs';
// Drop-in for client.mjs answer(): the paid result is computed deterministically by ChainBridge, not by the model.
// Afterwards an Eve session is seeded in the background so follow-up comments on the task can be answered.
export async function answer(input,journal,deadline){
 if(deadline!==undefined&&Date.now()>=deadline)throw new Error('Result deadline expired before job');
 const result=await runJob(input);
 seedFollowUps(result,journal).catch(e=>console.error('Follow-up context unavailable:',String(e.message).slice(0,120)));
 return result;
}
async function seedFollowUps(result,journal){
 const {client}=await import('./client.mjs');
 const {session}=await client.sessions.create();
 writeFileSync(journal,JSON.stringify({sessionId:session.state.sessionId,phase:'seeding'}),{mode:0o600});
 const reply=await (await session.send(`You delivered this ChainBridge result. Answer later follow-up questions about it.\n\n${result}`)).result();
 writeFileSync(journal,JSON.stringify({sessionId:session.state.sessionId,phase:'answered',result:reply.message??''}),{mode:0o600});
}
