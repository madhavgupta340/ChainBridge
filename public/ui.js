// Tiny DOM helpers. All text goes through textContent: uploaded values are never parsed as HTML.
export function h(tag,attrs={},...children){
 const el=document.createElement(tag);
 for(const [k,v] of Object.entries(attrs??{})){
  if(v===undefined||v===null||v===false)continue;
  if(k==='class')el.className=v;
  else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);
  else if(k==='value')el.value=v;
  else if(k==='checked'||k==='disabled'||k==='hidden'||k==='selected')el[k]=Boolean(v);
  else el.setAttribute(k,v===true?'':String(v));
 }
 for(const c of children.flat(Infinity)){
  if(c===null||c===undefined||c===false)continue;
  el.append(c instanceof Node?c:document.createTextNode(String(c)));
 }
 return el;
}
export const mount=(el,...children)=>{el.replaceChildren(...children.flat(Infinity).filter(c=>c!==null&&c!==undefined&&c!==false));return el;};
export const display=v=>v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);
export function toast(message,kind='info'){
 const t=document.getElementById('toast');
 t.replaceChildren(h('div',{class:`toast ${kind}`},message));
 clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.replaceChildren(),5000);
}
export async function api(path,body){
 const res=await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const data=await res.json().catch(()=>({error:`HTTP ${res.status}`}));
 if(!res.ok)throw Object.assign(new Error(data.error||`HTTP ${res.status}`),{status:res.status});
 return data;
}
export function download(name,text,type='application/json'){
 const url=URL.createObjectURL(new Blob([text],{type}));
 const a=h('a',{href:url,download:name});document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export const short=hash=>hash?`${hash.slice(0,10)}…${hash.slice(-6)}`:'';
export function copyButton(text,label='Copy'){
 return h('button',{class:'btn ghost small',type:'button',onclick:async()=>{try{await navigator.clipboard.writeText(text);toast('Copied');}catch{toast('Copy failed','error');}}},label);
}
