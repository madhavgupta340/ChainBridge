// Builds the public check page for GitHub Pages: static files only, no server code and no secrets.
// Usage: node scripts/build-pages.mjs [out dir]   (default dist/pages)
import {cpSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=['verify.js','versions.js','ui.js','static-check.js','styles.css'];
const PAGES=['index.html','main.js'];
const CORE=['certificate','canonical','merkle','documents','office','anchor-message','versionchain','cardano-address'];

export function buildPages(out=join(root,'dist/pages')){
 rmSync(out,{recursive:true,force:true});mkdirSync(join(out,'core'),{recursive:true});
 // The app loads modules from /core and fonts from /fonts; a project site lives under /<repo>/, so make them relative.
 const relative=text=>text.replace(/(['"])\/core\//g,'$1./core/').replace(/url\(\/fonts\//g,'url(./fonts/');
 for(const f of PUBLIC)writeFileSync(join(out,f),relative(readFileSync(join(root,'public',f),'utf8')));
 for(const f of PAGES)writeFileSync(join(out,f),readFileSync(join(root,'pages',f),'utf8'));
 for(const f of CORE)writeFileSync(join(out,'core',`${f}.mjs`),readFileSync(join(root,'src/core',`${f}.mjs`),'utf8'));
 cpSync(join(root,'public/fonts'),join(out,'fonts'),{recursive:true});
 writeFileSync(join(out,'.nojekyll'),'');
 return out;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(`Built ${buildPages(process.argv[2]?resolve(process.argv[2]):undefined)}`);
