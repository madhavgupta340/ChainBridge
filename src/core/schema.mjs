// Field type inference and sensitivity heuristics. Transparent, local, and overridable: every flag carries its reason.

export const FIELD_TYPES=['text','number','boolean','datetime','url','identifier','json'];
export const SENSITIVITY=['none','personal','confidential'];

const isBlank=v=>v===null||v===undefined||(typeof v==='string'&&!v.trim());
const asText=v=>typeof v==='string'?v.trim():typeof v==='object'?JSON.stringify(v):String(v);

const RX={
 number:/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/,
 boolean:/^(true|false|yes|no)$/i,
 isoDate:/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
 slashDate:/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/,
 email:/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
 phone:/^\+?[\d\s().-]{7,20}$/,
 iban:/^[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}$/,
 ssn:/^\d{3}-\d{2}-\d{4}$/,
 card:/^(?:\d[ -]?){13,19}$/,
 street:/\b\d+\s+\w+.*\b(street|st|road|rd|avenue|ave|straße|strasse|str|weg|platz|lane|ln|drive|dr|blvd)\b\.?/i,
};

// Name-based rules. `kind` is what we tell the user; `level` the default sensitivity.
const NAME_RULES=[
 [/(^|_|\b)(e-?mail)/i,'Email address','personal'],
 [/phone|mobile|tel(ephone)?\b|fax/i,'Phone number','personal'],
 [/(first|last|full|given|family|sur)[ _-]?name|^name$|(customer|employee|inspector|contact|person|user|author|buyer|driver|recipient|sender|signer|approver|client|staff|member|holder|manager|agent|technician|auditor|courier|passenger|student|tenant)[ _-]?name|patient|owner/i,'Person name','personal'],
 [/address|street|city|zip|postal|postcode/i,'Street address or location','personal'],
 [/ssn|social[ _-]?sec|passport|national[ _-]?id|tax[ _-]?id|steuer|driver[ _-]?lic|\bid[ _-]?card/i,'Government identifier','confidential'],
 [/iban|bic|swift|account[ _-]?(no|num|number)|card[ _-]?(no|num|number)|routing|bank/i,'Financial account identifier','confidential'],
 [/birth|dob|age\b|gender|ethnic|religion|health|diagnos|medical/i,'Personal attribute (special category)','confidential'],
 [/salary|wage|income|password|secret|token|api[ _-]?key/i,'Confidential value','confidential'],
 [/\bip([ _-]?addr(ess)?)?\b|device[ _-]?id|user[ _-]?id|customer[ _-]?id/i,'Linkable personal identifier','personal'],
];

function luhn(digits){let sum=0,alt=false;for(let i=digits.length-1;i>=0;i--){let n=+digits[i];if(alt){n*=2;if(n>9)n-=9;}sum+=n;alt=!alt;}return sum%10===0;}

function valueSignals(values){
 const n=values.length||1;const share=test=>values.filter(test).length/n;
 const out=[];
 if(share(v=>RX.email.test(v))>=0.6)out.push(['Values look like email addresses','personal']);
 if(share(v=>RX.ssn.test(v))>=0.6)out.push(['Values look like US social security numbers','confidential']);
 if(share(v=>RX.iban.test(v.replace(/\s/g,'').toUpperCase())&&/^[A-Z]{2}\d{2}/.test(v))>=0.6)out.push(['Values look like IBANs','confidential']);
 if(share(v=>RX.card.test(v)&&luhn(v.replace(/\D/g,'')))>=0.6)out.push(['Values look like payment card numbers','confidential']);
 if(share(v=>RX.street.test(v))>=0.5)out.push(['Values look like street addresses','personal']);
 if(share(v=>RX.phone.test(v)&&v.replace(/\D/g,'').length>=8&&/[\s()+-]/.test(v))>=0.6)out.push(['Values look like phone numbers','personal']);
 return out;
}

function inferType(name,values,raw){
 if(raw.some(v=>v!==null&&typeof v==='object'))return 'json';
 if(!values.length)return 'text';
 const all=test=>values.every(test);
 if(raw.every(v=>typeof v==='boolean'||isBlank(v))||all(v=>RX.boolean.test(v)))return 'boolean';
 const idName=/(^|_)(id|uuid|guid|key|code|ref|reference|sku|no|number)$/i.test(name)||/^id$/i.test(name);
 const unique=new Set(values).size===values.length;
 if(idName&&unique&&values.length>1)return 'identifier';
 if(raw.every(v=>typeof v==='number'||isBlank(v))||all(v=>RX.number.test(v)))return 'number';
 if(all(v=>RX.isoDate.test(v)||RX.slashDate.test(v)))return 'datetime';
 if(all(v=>{try{const u=new URL(v);return u.protocol==='http:'||u.protocol==='https:';}catch{return false;}}))return 'url';
 if(idName&&unique)return 'identifier';
 return 'text';
}

const rank=l=>SENSITIVITY.indexOf(l);

export function analyzeField(name,records){
 const raw=records.map(r=>r.values[name]);
 const present=raw.filter(v=>!isBlank(v));
 const values=present.map(asText);
 const type=inferType(name,values,present);
 const reasons=[];let sensitivity='none';
 for(const [rx,kind,level] of NAME_RULES)if(rx.test(name)){reasons.push(`Column name suggests: ${kind}`);if(rank(level)>rank(sensitivity))sensitivity=level;}
 for(const [why,level] of valueSignals(values)){reasons.push(why);if(rank(level)>rank(sensitivity))sensitivity=level;}
 // A "...name" column whose values look like "Firstname Lastname" is treated as personal unless labelled otherwise.
 const personLike=values.length>0&&values.filter(v=>/^\p{Lu}[\p{Ll}'-]+(\s+(van|von|de|der|da|di|le|la|del)?\s*\p{Lu}[\p{Ll}'-]+){1,3}$/u.test(v)).length/values.length>=0.8;
 if(sensitivity==='none'&&/name$/i.test(name.replace(/[^\p{L}]/gu,''))&&personLike){reasons.push('Values look like person names');sensitivity='personal';}
 const distinct=new Set(values).size;
 const lowEntropy=values.length>0&&distinct<=Math.max(2,Math.ceil(values.length*0.1));
 return {name,type,sensitivity,reasons,missing:raw.length-present.length,distinct,lowEntropy,
  inferred:{type,sensitivity}};
}

export function analyzeSchema(records,fields){
 return fields.map(f=>analyzeField(f,records));
}

// Apply user overrides. Overrides are explicit; the inferred value stays visible for transparency.
export function applyOverride(field,{type,sensitivity}={}){
 const next={...field};
 if(type!==undefined){if(!FIELD_TYPES.includes(type))throw new Error(`Unknown type "${type}"`);next.type=type;}
 if(sensitivity!==undefined){if(!SENSITIVITY.includes(sensitivity))throw new Error(`Unknown sensitivity "${sensitivity}"`);next.sensitivity=sensitivity;}
 next.overridden=next.type!==field.inferred.type||next.sensitivity!==field.inferred.sensitivity;
 return next;
}

// Privacy-safe summary for the optional AI planner: no values, only names and labels.
export function schemaSummary(schema,recordCount){
 return {recordCount,fields:schema.map(f=>({name:f.name,type:f.type,sensitivity:f.sensitivity,distinctValues:f.distinct,missingValues:f.missing,lowEntropy:f.lowEntropy}))};
}
