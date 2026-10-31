// "Check a document" tab of the ChainBridge app: check your copy of a file against a ChainBridge certificate.
// Opened from the tab, or directly from a verification link (/verify/<certificate id>).
//  File match       computed here, in this browser. The file is hashed locally and never uploaded.
//  Cardano record   looked up by the ChainBridge server (Blockfrost); the transaction link lets anyone check it.
//  Issuer signature checked by the ChainBridge server; a valid signature proves control of a key, not identity.
// Each check is shown as valid, not valid or not checked. Nothing is shown as valid unless it was checked.
import {h,mount,api,download,copyButton,spinner} from './ui.js';
import {checkFile,validateCertificate} from '/core/certificate.mjs';
import {sha256Hex} from '/core/documents.mjs';

const EXPLORER='https://preprod.cardanoscan.io/transaction/';
const V={cert:null,link:null,server:null,serverError:null,file:null,fileResult:null,loadError:null,certLoading:false,fileLoading:false};
let root=null;
const note=(kind,...c)=>h('div',{class:`note ${kind}`,role:kind==='error'?'alert':null},...c);
const date=iso=>iso?new Date(iso).toLocaleString('en-GB',{dateStyle:'long',timeStyle:'short'}):'';

// Mounts the checker into `el` (kept by the caller and re-attached on tab switches, so its state survives).
export function mountChecker(el){root=el;root.classList.add('verify-page');render();}
// Keeps a loading state visible long enough to be seen, so fast steps don't flash.
const atLeast=(ms,p)=>Promise.all([p,new Promise(r=>setTimeout(r,ms))]).then(([v])=>v);
export async function openCertificateId(id){
 Object.assign(V,{loadError:null,certLoading:true});render();
 try{const r=await atLeast(500,api(`/api/certificates/${id}`));V.certLoading=false;await useCertificate(r.certificate,r.link);}
 catch(e){Object.assign(V,{loadError:e.message,certLoading:false});render();}
}
const clearCert=()=>{Object.assign(V,{cert:null,link:null,server:null,serverError:null,fileResult:null,loadError:null});render();};
const clearFile=()=>{Object.assign(V,{file:null,fileResult:null});render();};
export function resetChecker(){Object.assign(V,{cert:null,link:null,server:null,serverError:null,file:null,fileResult:null,loadError:null,certLoading:false,fileLoading:false});render();}
// A pasted verification link or bare certificate identifier.
function onPaste(text){
 const m=String(text).trim().match(/(?:^|\/verify\/)([0-9a-f]{32})\/?$/i);
 if(!m){V.loadError='That is not a ChainBridge verification link or certificate ID.';return render();}
 openCertificateId(m[1].toLowerCase());
}
async function useCertificate(cert,link=null){
 try{V.cert=validateCertificate(cert);}catch(e){Object.assign(V,{loadError:e.message,certLoading:false});return render();}
 Object.assign(V,{link,server:null,serverError:null,loadError:null,fileResult:V.file?await checkFile(V.cert,V.file.sha256):null});
 render();
 try{V.server=await atLeast(700,api('/api/verify/check',{certificate:V.cert}));}catch(e){V.serverError=e.message;}
 render();
}
async function onCertificateFile(f){
 if(!f)return;
 V.loadError=null;
 if(f.size>256*1024){V.loadError='That file is too large to be a ChainBridge certificate.';return render();}
 V.certLoading=true;render();
 let json;try{json=JSON.parse(await atLeast(400,f.text()));}catch{Object.assign(V,{loadError:'That file is not a certificate (it is not JSON).',certLoading:false});return render();}
 V.certLoading=false;useCertificate(json);
}
// The file can be added before or after the certificate; it is only hashed, here, and never uploaded.
async function onFile(f){
 if(!f)return;
 V.fileLoading=true;render();
 const sha256=await atLeast(600,f.arrayBuffer().then(b=>sha256Hex(new Uint8Array(b))));
 V.file={name:f.name,size:f.size,sha256};
 V.fileResult=V.cert?await checkFile(V.cert,sha256):null;
 V.fileLoading=false;render();
}

function drop({id,accept,title,hint,onfile}){
 const input=h('input',{type:'file',id,accept,class:'visually-hidden',onchange:e=>{onfile(e.target.files[0]);e.target.value='';}});
 return [input,h('label',{for:id,class:'drop',ondragover:e=>{e.preventDefault();e.currentTarget.classList.add('over');},ondragleave:e=>e.currentTarget.classList.remove('over'),
  ondrop:e=>{e.preventDefault();e.currentTarget.classList.remove('over');onfile(e.dataTransfer.files[0]);}},h('strong',{},title),h('span',{},hint))];
}

// ---------- checks ----------
const LABEL={valid:'Valid',invalid:'Not valid',mismatch:'Not valid','no-match':'Not valid',broken:'Not valid','not-found':'Not found','not-checked':'Not checked',waiting:'Waiting for your file',checking:'Checking'};
const KIND={valid:'ok',invalid:'bad',mismatch:'bad','no-match':'bad',broken:'bad','not-found':'bad','not-checked':'none',waiting:'none',checking:'none'};
function fileCheck(){
 const r=V.fileResult;
 if(!r)return {status:'waiting',text:'Add your copy of the file to check it.'};
 if(r.status==='valid')return {status:'valid',text:'Your file is identical to the file in the certificate, and it is part of the sealed fingerprint.'};
 if(r.status==='no-match')return {status:'no-match',text:'Your file is different from the file that was sealed. Even a one-character change, re-saving or re-scanning makes it different.'};
 return {status:'broken',text:'Your file has the right fingerprint, but the certificate\'s proof does not lead to the sealed fingerprint. The certificate is damaged or was altered.'};
}
function cardanoCheck(){
 if(V.serverError)return {status:'not-checked',text:`Could not ask the ChainBridge server (${V.serverError}).`};
 const c=V.server?.cardano;if(!c)return {status:'checking',text:'Looking up the Cardano transaction…'};
 const when=c.blockTime?` Recorded ${date(c.blockTime)}${c.confirmations?`, ${c.confirmations.toLocaleString('en')} confirmations`:''}.`:'';
 return {status:c.status,text:c.detail+(c.status==='valid'?when:'')};
}
function issuerCheck(){
 if(V.serverError)return {status:'not-checked',text:'Not checked: the ChainBridge server could not be reached.'};
 const s=V.server?.issuer;if(!s)return {status:'checking',text:'Checking the signature…'};
 return {status:s.status,text:s.detail};
}
function row(title,what,c,who){
 return h('li',{class:`check-row ${KIND[c.status]}`},
  h('div',{class:'check-head'},h('strong',{},title),c.status==='checking'?h('span',{class:'pill checking'},h('span',{class:'spin','aria-hidden':'true'}),'Checking'):h('span',{class:`pill ${KIND[c.status]}`},LABEL[c.status]??c.status)),
  h('p',{class:'muted small'},what),h('p',{},c.text),who&&h('p',{class:'mono-key'},who));
}

function verdict(f,c){
 if(f.status==='waiting')return null;
 if(f.status==='no-match')return h('div',{class:'verdict bad',role:'status'},h('strong',{},'✗ This file is different'),
  h('p',{},'It does not match the file that was sealed. Ask the sender for the original file, or treat this copy as changed.'));
 if(f.status==='broken')return h('div',{class:'verdict bad',role:'status'},h('strong',{},'✗ The certificate is damaged'),h('p',{},'The file could not be confirmed. Ask the sender for a fresh certificate link.'));
 if(c.status==='valid')return h('div',{class:'verdict ok',role:'status'},h('strong',{},'✓ This file matches the sealed version'),
  h('p',{},`It is identical to the file that was fingerprinted and recorded on Cardano${V.server?.cardano?.blockTime?` on ${date(V.server.cardano.blockTime)}`:''}. It has not been changed since.`));
 if(c.status==='checking')return h('div',{class:'verdict',role:'status'},h('strong',{},'Your file matches the certificate'),h('p',{},'Now checking the Cardano record…'));
 return h('div',{class:'verdict warn',role:'status'},h('strong',{},'Your file matches the certificate, but the Cardano record is not confirmed'),
  h('p',{},'Without the Cardano record, this only shows that the file matches the certificate you were sent, not that it was published. See the Cardano check below.'));
}

// ---------- page ----------
const kb=n=>n<1024*1024?`${Math.max(1,Math.round(n/1024))} KB`:`${(n/1048576).toFixed(1)} MB`;
function slot(n,title,state,...body){
 return h('section',{class:`slot ${state}`},
  h('div',{class:'slot-head'},h('span',{class:'slot-num'},state==='done'?'✓':n),h('strong',{},title),state==='done'&&h('span',{class:'pill ok'},'Added')),
  ...body);
}
function certSlot(){
 const c=V.cert;
 if(V.certLoading)return slot('1','The certificate','busy',h('div',{class:'slot-wait'},spinner('Opening the certificate…')));
 if(c)return slot('1','The certificate','done',
  h('dl',{class:'slot-facts'},h('dt',{},'For the file'),h('dd',{},c.file.name),h('dt',{},'Issued'),h('dd',{},date(c.issuedAt)),h('dt',{},'Network'),h('dd',{},c.testNetwork?'Cardano Preprod (test network)':'Cardano')),
  h('button',{class:'btn ghost small',type:'button',onclick:clearCert},'Use a different certificate'));
 const field=h('input',{type:'text',id:'certlink',class:'grow',placeholder:'Verification link or certificate ID',autocomplete:'off',spellcheck:'false',
  onkeydown:e=>{if(e.key==='Enter')onPaste(e.target.value);}});
 return slot('1','The certificate','empty',
  drop({id:'cert',accept:'.json,application/json',title:'Open the certificate',hint:'The .json file you were sent',onfile:onCertificateFile}),
  h('div',{class:'field paste'},h('label',{for:'certlink'},'Or paste the link'),
   h('div',{class:'row'},field,h('button',{class:'btn',type:'button',onclick:()=>onPaste(field.value)},'Open'))),
  V.loadError&&note('error',h('strong',{},'Could not open it. '),V.loadError));
}
function fileSlot(){
 const c=V.cert,f=V.file;
 if(V.fileLoading)return slot('2','Your copy of the file','busy',h('div',{class:'slot-wait'},spinner('Calculating your file\'s fingerprint on this device…')));
 if(f)return slot('2','Your copy of the file','done',
  h('dl',{class:'slot-facts'},h('dt',{},'File'),h('dd',{},f.name),h('dt',{},'Size'),h('dd',{},kb(f.size)),h('dt',{},'Fingerprint'),h('dd',{class:'mono-key'},`${f.sha256.slice(0,16)}…${f.sha256.slice(-8)}`)),
  h('button',{class:'btn ghost small',type:'button',onclick:clearFile},'Choose a different file'));
 return slot('2','Your copy of the file','empty',
  drop({id:'mine',accept:'',title:c?`Add ${c.file.name}`:'Add the file',hint:'Checked on this device, never uploaded',onfile:onFile}));
}
function render(){
 if(!root)return;
 const c=V.cert,both=c&&V.file&&!V.fileLoading;
 const f=fileCheck(),ca=cardanoCheck(),is=issuerCheck(),srv=V.server;
 return mount(root,
  h('div',{class:'eyebrow'},h('span',{class:'num'},'Check'),h('span',{},'Free, your file is not uploaded')),
  h('h2',{tabindex:-1},'Check a document',h('span',{class:'dot'},'.')),
  h('p',{class:'lead'},'Someone sent you a document sealed with ChainBridge? Add the certificate they sent and your copy of the file. ChainBridge tells you whether it is exactly the version that was sealed on the Cardano blockchain.'),
  h('div',{class:'slots'},certSlot(),fileSlot()),
  !both&&h('p',{class:'slots-hint'},!c&&!V.file?'Add both to see the result.':!c?'Now add the certificate.':'Now add your copy of the file.'),
  c?.testNetwork&&both&&note('info',h('strong',{},'Test network. '),'This certificate uses Cardano Preprod, a public test network. It works like the real Cardano network, but its tokens have no value.'),
  both&&verdict(f,ca),
  c&&h('ol',{class:'checks'},
   row('File match','Does your file match the fingerprint in the certificate?',f,'Checked in this browser'),
   row('Cardano record','Does the Cardano transaction contain this fingerprint?',ca,srv?.cardano?.checkedBy),
   row('Issuer signature','Was the certificate signed by the key named as its issuer?',is,srv?.issuer?.checkedBy)),
  both&&h('div',{class:'split'},
   h('div',{class:'panel public'},h('h3',{},'What a match proves'),h('ul',{},
    h('li',{},'Your file is byte-for-byte the file that was sealed.'),
    h('li',{},'With a valid Cardano record: it was sealed no later than the date of that record, and has not changed since.'))),
   h('div',{class:'panel private'},h('h3',{},'What it does not prove'),h('ul',{},
    h('li',{},'That what the document says is true.'),
    h('li',{},'Who the issuer is in real life. A valid signature proves the certificate was signed with a certain key, not which person or company owns that key.'),
    c.issuer?.demo&&h('li',{},'This certificate is signed by a demo issuer on a test network.')))),
  c&&details(c,srv),
  (c||V.file)&&h('div',{class:'row'},h('button',{class:'btn ghost small',type:'button',onclick:resetChecker},'Start over')));
}

function details(c,srv){
 const r=V.fileResult,ca=srv?.cardano,is=srv?.issuer;
 const facts=rows=>h('dl',{class:'facts'},rows.filter(Boolean).flatMap(([k,v])=>[h('dt',{},k),h('dd',{},v)]));
 const code=t=>h('code',{class:'break'},t);
 return h('details',{class:'tech'},h('summary',{},'Technical details'),h('div',{class:'tech-body'},
  h('h4',{},'File'),
  facts([['File in certificate',c.file.name],['Expected SHA-256',code(c.file.sha256)],V.file&&['Your file\'s SHA-256',code(V.file.sha256)],
   r?.leaf&&['File leaf',code(r.leaf)],['Proof',`Leaf ${c.proof.leafIndex+1} of ${c.proof.leafCount}, ${c.proof.siblings.length} step(s) to the fingerprint. Sibling hashes reveal nothing about other records or files.`],
   ['Fingerprint (Merkle root)',code(c.commitment.root)],['Leaf formula','SHA-256(0x00 ‖ "chainbridge/v1/file" ‖ 0x00 ‖ salt ‖ 0x00 ‖ {"sha256":"<file hash>"}); nodes SHA-256(0x01 ‖ left ‖ right)']]),
  h('h4',{},'Cardano'),
  facts([['Transaction',h('a',{href:EXPLORER+c.cardano.transaction,target:'_blank',rel:'noopener'},`${c.cardano.transaction} ↗`)],
   ['Network','Cardano Preprod (test network)'],ca?.blockHeight&&['Block',String(ca.blockHeight)],ca?.blockTime&&['Recorded',date(ca.blockTime)],
   ca?.message&&['On-chain message (label 674)',h('pre',{class:'code'},ca.message.join('\n'))],
   ['Check it yourself','Open the transaction link, look at its metadata (label 674), and compare the fingerprint with the one above.']]),
  h('h4',{},'Issuer'),
  c.issuer?facts([['Name in certificate',`${c.issuer.name}`],['Public key (Ed25519)',code(c.issuer.publicKey)],['Issuer address',code(c.issuer.address)],
   is&&['Published the Cardano record',is.publishedByThisKey===null?'Not checked':is.publishedByThisKey?'Yes, the transaction was paid from this address':'No'],
   is&&['This server\'s demo key',is.thisServersKey?'Yes':'No'],['Signature',code(c.signature)],['Note',c.issuer.note]]):h('p',{},'Not signed.'),
  h('div',{class:'row'},h('button',{class:'btn small',type:'button',onclick:()=>download(`chainbridge-certificate-${c.id.slice(0,8)}.json`,JSON.stringify(c,null,2))},'Download certificate (.json)'),
   V.link&&copyButton(V.link.url,'Copy link'))));
}

