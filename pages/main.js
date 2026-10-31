// Public check page (GitHub Pages): the "Check a document" screen with browser-only checks, no ChainBridge server.
import {mountChecker} from './verify.js';
import {createStaticBackend} from './static-check.js';

mountChecker(document.getElementById('view'),{backend:createStaticBackend()});
