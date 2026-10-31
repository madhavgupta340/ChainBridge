// Payment confirmation overlay (Apple Pay–style): a working ring with live steps, then a drawn check (success)
// or cross (failure). It only ever states what the server confirmed: "Authorised" after the signed payment is
// verified, "Paid" after settlement, "Not charged" when the work failed before settlement.
import {h,svg} from './ui.js';

export function paymentOverlay({title,amount,steps}){
 const items=steps.map(t=>h('li',{class:'pending'},h('span',{class:'payfx-dot','aria-hidden':'true'}),t));
 const titleEl=h('p',{class:'payfx-title'},title);
 const detailEl=h('div',{class:'payfx-detail'});
 const actionsEl=h('div',{class:'payfx-actions'});
 const mark=svg('svg',{class:'payfx-mark',viewBox:'0 0 120 120','aria-hidden':'true'},
  svg('circle',{class:'payfx-track',cx:60,cy:60,r:52}),
  svg('circle',{class:'payfx-ring',cx:60,cy:60,r:52}),
  svg('path',{class:'payfx-check',d:'M38 62 L54 77 L84 45'}),
  svg('path',{class:'payfx-cross',d:'M44 44 L76 76 M76 44 L44 76'}));
 const card=h('div',{class:'payfx-card',tabindex:-1},
  h('div',{class:'payfx-visual'},h('span',{class:'payfx-burst','aria-hidden':'true'}),mark),
  h('div',{class:'payfx-amount'},amount),titleEl,h('ol',{class:'payfx-steps'},items),detailEl,actionsEl);
 const root=h('div',{class:'payfx working',role:'dialog','aria-modal':'true','aria-live':'assertive','aria-label':title},card);
 document.body.append(root);
 requestAnimationFrame(()=>{root.classList.add('in');card.focus();});
 let timers=[];
 const setStep=(i,before='done')=>items.forEach((li,j)=>{li.className=j<i?before:j===i?'active':'pending';});
 setStep(0);
 const close=()=>{timers.forEach(clearTimeout);root.classList.remove('in');setTimeout(()=>root.remove(),250);};
 const finish=(cls,{headline,detail,buttons=[]})=>{
  timers.forEach(clearTimeout);timers=[];
  root.classList.remove('working');root.classList.add(cls);root.setAttribute('aria-label',headline);
  titleEl.textContent=headline;detailEl.replaceChildren(...[].concat(detail??[]).filter(Boolean));
  actionsEl.replaceChildren(...buttons.map(([label,fn,primary])=>h('button',{class:`btn ${primary?'primary':'ghost'}`,type:'button',onclick:()=>{close();fn?.();}},label)));
  actionsEl.querySelector('.btn')?.focus();
 };
 card.addEventListener('keydown',e=>{if(e.key==='Escape'&&!root.classList.contains('working'))close();});
 return {
  step:setStep,
  // Shows steps as "in progress" over time while one long request runs; never marks them done early.
  pace(ms){steps.forEach((_,i)=>{if(i)timers.push(setTimeout(()=>setStep(i,'past'),i*ms));});},
  success(opts){items.forEach((li,j)=>setTimeout(()=>{li.className='done';},j*140));setTimeout(()=>finish('is-success',opts),items.length*140+120);},
  fail(opts){finish('is-fail',opts);},
  close,
 };
}
