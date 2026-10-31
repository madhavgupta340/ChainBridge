// Minimal ZIP writer (stored, no compression) for the downloadable package. Files: [{name, text}].
const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=CRC_TABLE[(c^b)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}

export function zip(files,date=new Date()){
 const enc=new TextEncoder();const parts=[];const central=[];let offset=0;
 const time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1);
 const day=((date.getFullYear()-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
 for(const f of files){
  const name=enc.encode(f.name),data=enc.encode(f.text),crc=crc32(data);
  const local=new DataView(new ArrayBuffer(30));
  local.setUint32(0,0x04034b50,true);local.setUint16(4,20,true);local.setUint16(6,0x0800,true);local.setUint16(8,0,true);
  local.setUint16(10,time,true);local.setUint16(12,day,true);local.setUint32(14,crc,true);
  local.setUint32(18,data.length,true);local.setUint32(22,data.length,true);local.setUint16(26,name.length,true);local.setUint16(28,0,true);
  parts.push(new Uint8Array(local.buffer),name,data);
  const cd=new DataView(new ArrayBuffer(46));
  cd.setUint32(0,0x02014b50,true);cd.setUint16(4,20,true);cd.setUint16(6,20,true);cd.setUint16(8,0x0800,true);cd.setUint16(10,0,true);
  cd.setUint16(12,time,true);cd.setUint16(14,day,true);cd.setUint32(16,crc,true);cd.setUint32(20,data.length,true);cd.setUint32(24,data.length,true);
  cd.setUint16(28,name.length,true);cd.setUint32(42,offset,true);
  central.push(new Uint8Array(cd.buffer),name);
  offset+=30+name.length+data.length;
 }
 const size=central.reduce((n,p)=>n+p.length,0);
 const end=new DataView(new ArrayBuffer(22));
 end.setUint32(0,0x06054b50,true);end.setUint16(8,files.length,true);end.setUint16(10,files.length,true);
 end.setUint32(12,size,true);end.setUint32(16,offset,true);
 return new Blob([...parts,...central,new Uint8Array(end.buffer)],{type:'application/zip'});
}

export function toCsv(fields,records){
 const cell=v=>{const s=v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
 return [fields.map(cell).join(','),...records.map(r=>fields.map(f=>cell(r.values[f])).join(','))].join('\r\n')+'\r\n';
}
