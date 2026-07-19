// Vendor bundle — exposes marked and katex on window object
import { marked } from 'marked';
import katex from 'katex';
import renderMathInElement from 'katex/dist/contrib/auto-render.mjs';

window.marked = marked;
window.katex = katex;
window.renderMathInElement = renderMathInElement;
