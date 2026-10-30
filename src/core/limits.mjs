// Shared by the browser UI, local server and paid agent job. Keep values in sync with README.
export const LIMITS=Object.freeze({
 maxBytes:2*1024*1024,   // uploaded file size
 maxRows:5000,           // parsed records
 maxColumns:100,         // detected fields
 maxCellChars:10000,     // characters per value
 maxJobChars:16000,      // Sokosumi/MIP-003 task input (template limit)
 maxJobLeaves:200,       // leaf hashes per paid anchoring job (fits maxJobChars)
 maxPublishedLeaves:50,  // per-record strategy: hashes listed in the public payload
});
