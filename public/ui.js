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

// SVG elements (namespaced). Text still goes through text nodes only.
export function svg(tag,attrs={},...children){
 const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
 for(const [k,v] of Object.entries(attrs??{}))if(v!==undefined&&v!==null&&v!==false)el.setAttribute(k,String(v));
 for(const c of children.flat(Infinity)){if(c===null||c===undefined||c===false)continue;el.append(c instanceof Node?c:document.createTextNode(String(c)));}
 return el;
}

// Dropdown in the app's own style (replaces native <select>). Keyboard: Enter/Space/Arrows open,
// Arrows/Home/End move, Enter/Space choose, Escape/Tab close. options: [[value,label],...]
export function dropdown({value,options,onChange,label,cls='',disabled=false,id}){
 const index=Math.max(0,options.findIndex(o=>o[0]===value));
 const listId=`dd-${Math.random().toString(36).slice(2,9)}`;
 const button=h('button',{type:'button',class:'dd-btn',id,disabled,'aria-haspopup':'listbox','aria-expanded':'false','aria-controls':listId,
  'aria-label':label?`${label}: ${options[index][1]}`:null},h('span',{class:'dd-value'},options[index][1]),h('span',{class:'dd-chev','aria-hidden':'true'}));
 const items=options.map(([,text],i)=>h('li',{role:'option',tabindex:-1,'aria-selected':i===index?'true':'false',class:i===index?'sel':''},text));
 const list=h('ul',{class:'dd-list',role:'listbox',id:listId,'aria-label':label,hidden:true},items);
 const wrap=h('div',{class:`dd ${cls}`},button,list);
 const outside=e=>{if(!wrap.contains(e.target))close(false);};
 function open(at=index){
  if(disabled)return;
  list.hidden=false;button.setAttribute('aria-expanded','true');wrap.classList.add('open');
  wrap.classList.toggle('up',button.getBoundingClientRect().bottom+list.offsetHeight+12>window.innerHeight&&button.getBoundingClientRect().top>list.offsetHeight);
  items[at]?.focus();document.addEventListener('mousedown',outside);
 }
 function close(refocus=true){
  if(list.hidden)return;
  list.hidden=true;button.setAttribute('aria-expanded','false');wrap.classList.remove('open','up');
  document.removeEventListener('mousedown',outside);if(refocus)button.focus();
 }
 function choose(i){close();if(i!==index)onChange(options[i][0]);}
 button.addEventListener('click',()=>list.hidden?open():close());
 button.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','Enter',' '].includes(e.key)){e.preventDefault();open(e.key==='ArrowUp'?Math.max(0,index-1):index);}});
 items.forEach((li,i)=>{
  li.addEventListener('click',()=>choose(i));
  li.addEventListener('keydown',e=>{
   const move=j=>{e.preventDefault();items[(j+items.length)%items.length].focus();};
   if(e.key==='ArrowDown')move(i+1);else if(e.key==='ArrowUp')move(i-1);
   else if(e.key==='Home')move(0);else if(e.key==='End')move(items.length-1);
   else if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(i);}
   else if(e.key==='Escape'){e.preventDefault();close();}
   else if(e.key==='Tab')close(false);
  });
 });
 return wrap;
}
