import {writeFileSync} from 'node:fs';
import {runJob} from './src/core/job.mjs';
import {describeStep} from './src/core/recipe.mjs';
import {aiSettings} from './src/server/ai-config.mjs';
import {aiOrganize} from './src/server/ai-organizer.mjs';
import {publishFingerprint} from './src/server/cardano-anchor.mjs';

// What the paid agent can do: AI analysis (Meta, if configured) and publishing on Cardano Preprod.
export function agentDeps({deadline}={}){
 const settings=aiSettings();
 return {describeStep,
  analyze:settings?sample=>aiOrganize(sample,{settings}):undefined,
  publish:args=>publishFingerprint({...args,deadline},{walletPath:'.local/publishing-wallet.json',
   blockfrostKey:process.env.BLOCKFROST_API_KEY_PREPROD,journalDir:'.local/anchors'})};
}

// Drop-in for client.mjs answer(): the result is produced by ChainBridge's job code, with the model used only
// for the advisory analysis. Afterwards an Eve session is seeded in the background so follow-up comments on the
// task can be answered.
export async function answer(input,journal,deadline){
 if(deadline!==undefined&&Date.now()>=deadline)throw new Error('Result deadline expired before job');
 const result=await runJob(input,agentDeps({deadline}));
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
