import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
const dom=new JSDOM(await readFile('index.html','utf8'),{url:'https://example.test',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent','localStorage','location'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const {bindUi}=await import('../src/ui/app-ui.js');bindUi();
const {runGroupScenarios}=await import('./group-ui-scenarios.mjs');
try{const results=await runGroupScenarios();console.log(`GROUP UI: ${results.length} scenarios OK`);process.exit(0);}catch(error){console.error(error);process.exit(1);}
