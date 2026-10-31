// Which AI provider ChainBridge's own features use (organizer and plan suggestions).
// Preferred: Meta Model API (OpenAI-compatible Chat Completions, https://dev.meta.ai/docs/protocols/chat-completions).
// Fallback: the template's ZAI_* settings, which also drive the Eve follow-up agent.
export const META_BASE_URL='https://api.meta.ai/v1';
export const META_DEFAULT_MODEL='muse-spark-1.3';

export function aiSettings(env=process.env){
 if(env.MODEL_API_KEY?.trim())return {provider:'Meta',apiKey:env.MODEL_API_KEY.trim(),
  baseUrl:(env.MODEL_API_BASE_URL?.trim()||META_BASE_URL).replace(/\/$/,''),model:env.MODEL_API_MODEL?.trim()||META_DEFAULT_MODEL};
 if(env.ZAI_API_KEY&&env.ZAI_BASE_URL&&env.ZAI_MODEL)return {provider:'Z.ai-compatible',apiKey:env.ZAI_API_KEY,baseUrl:env.ZAI_BASE_URL.replace(/\/$/,''),model:env.ZAI_MODEL};
 return null;
}

// One chat call. Returns the reply text. Only documented, widely supported parameters are sent.
export async function chat(settings,messages,{fetchImpl=fetch,timeoutMs=60000,responseFormat}={}){
 const response=await fetchImpl(`${settings.baseUrl}/chat/completions`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
  headers:{'content-type':'application/json',authorization:`Bearer ${settings.apiKey}`},
  body:JSON.stringify({model:settings.model,messages,...(responseFormat?{response_format:responseFormat}:{})})});
 if(!response.ok)throw new Error(`${settings.provider} AI returned HTTP ${response.status}`);
 const data=await response.json();
 const text=data?.choices?.[0]?.message?.content;
 if(typeof text!=='string'||!text.trim())throw new Error(`${settings.provider} AI returned no answer`);
 return text;
}

export function extractJson(text){
 const start=text.indexOf('{'),end=text.lastIndexOf('}');
 if(start<0||end<=start)throw new Error('The AI reply contained no JSON object');
 return JSON.parse(text.slice(start,end+1));
}
