/* =====================================================================
   Hover tips (2.4). With a mouse or trackpad, resting the pointer on a button for a moment shows a small card:
   a bold title, one line on what it does and its keyboard shortcut. Touch, Pencil (also Pencil hover) and devices
   without hover never see it. Text comes from TIP_TEXT (matched by CSS selector, first match wins), else from the
   button's own title ("Name: what it does (Key)") or aria-label. While the card shows, the native title is moved
   to data-tip-save so the browser's own grey tooltip doesn't pop up on top; it is put back on leave.
   ===================================================================== */
'use strict';
const TIP_TEXT = [
  // top bar / side
  ['#settingsBtn', 'Sync and settings', 'Account, sync, backups, storage and app options'],
  ['#addNb', 'New notebook', 'Add a notebook to the list'],
  ['#editSec', 'Rename section', 'Change the name or colour of this section'],
  ['#newPage', 'New page', 'Add an empty page to this section'],
  ['#newMore', 'From template', 'Start a new page from a saved template'],
  ['#status', 'Sync status', 'Open sync and settings'],
  ['#undo', 'Undo', 'Take back the last change', 'Ctrl+Z'],
  ['#redo', 'Redo', 'Bring back what you undid', 'Ctrl+Y'],
  ['#barMore', 'More buttons', 'Import, Shapes, Ask Claude and the rest'],
  ['#barHide', 'Hide toolbar', 'Fold the toolbar away for more room'],
  ['#barShow', 'Show toolbar', 'Bring the toolbar back'],
  ['#sideBtn', 'Notebooks', 'Show or hide the notebook and page lists'],
  ['#backLink', 'Back', 'Return to the page you came from'],
  ['#continueBtn', 'Continue', 'Go back to where you left off'],
  ['#insertBtn', 'Import', 'Put a PDF, picture, Word file or camera scan on the page'],
  ['#shapeBtn, #shapeRail', 'Shapes', 'Lines, arrows, shapes, compass, grids and graphs'],
  ['#askBtn', 'Ask Claude', 'Ask about a question on the page'],
  ['#laterBtn', 'Later', 'Spots you marked to come back to'],
  ['#hwBtn', 'Homework', 'What you marked to do, with due dates'],
  ['#calcBtn', 'Calculator', 'Open the calculator beside the page'],
  ['#paperBtn', 'Paper', 'Blank, lined, grid, dots or hex, plus a margin line'],
  ['#moreBtn', 'More', 'Page history, export, templates and other page options'],
  // tools
  ['[data-tool="pen"]', 'Pen', 'Write and draw; pressure changes the thickness', 'P'],
  ['[data-tool="hl"]', 'Highlighter', 'Mark text in see-through colour', 'H'],
  ['[data-tool="eraser"]', 'Eraser', 'Remove whole strokes or rub out parts', 'E'],
  ['[data-tool="lasso"]', 'Select (lasso)', 'Pick things to move, copy, resize or delete', 'L'],
  ['[data-tool="text"]', 'Text box', 'Tap the page to type', 'T'],
  ['[data-tool="math"]', 'Formula', 'Type a maths formula (LaTeX)', 'M'],
  ['[data-tool="tape"]', 'Hide-answer tape', 'Cover answers; tap the tape to show what is under it'],
  ['[data-tool="space"]', 'Space', 'Drag down to make room, up to close a gap', 'S'],
  ['[data-tool="mark"]', 'Mark for later', 'Mark a spot to come back to; it shows under Later', 'K'],
  ['#askQuick', 'Scan with Claude', 'Draw a box around a question to ask about it'],
  ['#lassoMode [data-m="free"]', 'Free select', 'Draw a loop around what you want'],
  ['#lassoMode [data-m="box"]', 'Box select', 'Drag a rectangle; can also be copied as a picture'],
  ['#lassoMode [data-m="tap"]', 'Tap select', 'Tap things to add them, tap again to drop them'],
  ['#eraseMode [data-m="stroke"]', 'Stroke eraser', 'Removes whole strokes'],
  ['#eraseMode [data-m="area"]', 'Partial eraser', 'Rubs out only the ink under it'],
  ['#swatches .swatch', 'Colour', 'Tap to use it. Hold to swap it for the colour picked under More colours'],
  ['#colorBtn', 'More colours', 'All colours and a custom one'],
  ['#assistBtn', 'Writing', 'Write to text and the reference line'],
  ['#hlSnap', 'Stick to text', 'Highlights land straight on the line of text under them'],
  ['#layerBtn', 'Layers', 'Choose the layer you draw on, hide or show layers'],
  ['#techBtn', 'Line type', 'Thick, thin, hidden or centre lines, and mm snapping'],
  ['#pasteBtn, #freshPaste', 'Paste', 'What you copied, or a picture or text from another app', 'Ctrl+V'],
  ['#rulerBtn', 'Ruler', 'Lay a ruler on the page to draw straight along it'],
  ['#fingerBtn', 'Finger draws', 'On: a finger writes like the Pencil. Off: fingers move and zoom'],
  ['#zoomBtn', 'Zoom', 'Tap: 100%. Hold: lock max zoom. Double-tap: lock zoom'],
  // text formatting bar
  ['[data-cmd="bold"]', 'Bold', 'Thicker letters'],
  ['[data-cmd="italic"]', 'Italic', 'Slanted letters'],
  ['[data-cmd="underline"]', 'Underline', 'Line under the text'],
  ['[data-block="h1"]', 'Heading 1', 'Big heading'],
  ['[data-block="h2"]', 'Heading 2', 'Smaller heading'],
  ['[data-block="p"]', 'Normal text', 'Back to plain text'],
  ['[data-act="tsize"]', 'Text size', 'Make the text bigger or smaller'],
  ['[data-act="bullet"]', 'Bullet list', 'Start a list with dots'],
  ['[data-act="check"]', 'Checklist', 'A list with boxes to tick'],
  ['[data-act="mark"]', 'Highlight text', 'Yellow background behind the selected text'],
  ['[data-act="tcolor"]', 'Text colour', 'Colour of the selected text'],
  ['[data-act="link"]', 'Link to page', 'Turn the selected text into a link to another page'],
  ['[data-act="spell"]', 'Spell check', 'Turn it on or off and choose the language'],
  ['[data-act="done"]', 'Done', 'Finish typing in this text box'],
  // selection menu
  ['#selGraph', 'Formulas', 'Add, change or remove the functions on this graph'],
  ['#selMath', 'To formula', 'Claude turns your handwritten formula into a typed one'],
  ['#selGroup', 'Group', 'Keep the selected things together as one'],
  ['#selUngroup', 'Ungroup', 'Split the group back into its parts'],
  ['#selSize', 'Size', 'Type an exact size in mm'],
  ['#selRot90', 'Rotate 90°', 'Turn the selection a quarter clockwise'],
  ['#selText', 'Text', 'The imported page text inside your selection'],
  ['#selShot, #tsShot', 'Copy as picture', 'Copy the box as a picture, like a screenshot'],
  ['#selHw, #tsHw', 'Homework', 'Add the selection to your Homework list with a due date'],
  ['#selFade', 'Fade', 'Make the selection lighter'],
  ['#selCopy, #tsCopy', 'Copy', 'Copy to paste here or in another app', 'Ctrl+C'],
  ['#selDup', 'Duplicate', 'Make a copy right next to it'],
  ['#selDel', 'Delete', 'Remove the selection', 'Delete'],
  ['#tsOpen', 'Text', 'See the text, copy part of it or put it on the page'],
  // more menu
  ['#mHistory', 'Page history', 'Older versions of this page, to look at or bring back'],
  ['#mExport', 'Export as PDF', 'Save or share pages as a PDF file'],
  ['#mPractice', 'Practice from notes', 'Claude quizzes you on pages you pick'],
  ['#mTemplate', 'Save as template', 'Reuse this page\'s layout for new pages'],
  ['#mSnap', 'Snap text to lines', 'Text boxes near worksheet lines sit on them'],
  ['#mFit', 'Fit on screen', 'Zoom so everything on the page is visible'],
  ['#mDelete', 'Delete page', 'Remove this page'],
  // paper
  ['#paperPop [data-v="blank"]', 'Blank', 'Plain paper'],
  ['#paperPop [data-v="lined"]', 'Lined', 'Ruled lines for writing'],
  ['#paperPop [data-v="grid"]', 'Grid', 'Squares, for maths and sketches'],
  ['#paperPop [data-v="dots"]', 'Dots', 'Dot grid'],
  ['#paperPop [data-v="hex"]', 'Hex', 'Hexagons for chemistry: rings and zig-zag chains'],
  ['#mlOn', 'Margin line', 'A coloured line down the left side'],
  ['#hexSnap, #hexSnap2', 'Straighten lines', 'Lines snap to the hexagon corners; curves stay as drawn'],
  ['#paperDefault', 'Use for new pages', 'New pages start with this paper'],
  // shapes
  ['#compassOpen', 'Compass', 'Circles and arcs from a centre point'],
  ['#gridOpen', 'Grid', 'Choose rows and columns, then draw it'],
  ['#hcOpen', 'Honeycomb', 'Choose rows and columns, then draw it'],
  ['#graphOpen', 'Graph / axes', 'Axes with a scale, and curves from formulas'],
  ['#snapShapes', 'Snap to angles', 'Lines click into 0°, 15°, 45°, 90° when close'],
  ['#partsBtn', 'Parts list', 'A list of the robotics parts on this page that updates itself'],
  ['#scribeBtn', 'Write to text', 'Handwriting becomes typed text when you pause'],
  ['#waRef', 'Reference line', 'A faint guide under the line you are writing'],
  ['#rulerSnap', 'Snap', 'Turning the ruler clicks into 0°, 15°, 45°, 90°'],
  ['#calcDeg', 'Degrees / radians', 'Switch how angles are measured'],
];
const Tip = {
  el: null, on: null, timer: 0, hideTimer: 0, shownAt: 0, mq: null,
  ok(e){
    if(e.pointerType !== 'mouse') return false;
    if(!this.mq) this.mq = matchMedia('(hover:hover)');
    return this.mq.matches;
  },
  // what to show for an element: {t, d, k} or null
  text(b){
    for(const [sel, t, d, k] of TIP_TEXT) if(b.matches(sel)) return {t, d, k};
    const raw = (b.dataset.tipSave || b.getAttribute('title') || '').trim();
    if(raw){
      let t = raw, d = '', k = '';
      const km = t.match(/\s*\(([A-Za-z0-9+]{1,10})\)$/);
      if(km){ k = km[1]; t = t.slice(0, km.index); }
      const ci = t.indexOf(': ');
      if(ci > 0 && ci <= 40){ d = t.slice(ci + 2); t = t.slice(0, ci); }
      return {t, d: d ? d[0].toUpperCase() + d.slice(1) : '', k};
    }
    const al = b.getAttribute('aria-label');
    // only icon buttons need a name card; a button whose words are already visible gets nothing
    if(al && !b.textContent.trim()) return {t: al, d: '', k: ''};
    return null;
  },
  target(n){
    const b = n && n.closest ? n.closest('button, [role="button"], .ruler-grip, .ruler-turn, [data-tip]') : null;
    return b && !b.disabled ? b : null;
  },
  over(e){
    if(!this.ok(e)) return;
    const b = this.target(e.target);
    if(b === this.on) return;
    this.leave();
    if(!b) return;
    const tx = this.text(b);
    if(!tx) return;
    this.on = b;
    if(b.hasAttribute('title')){ b.dataset.tipSave = b.getAttribute('title'); b.removeAttribute('title'); }
    // a card already open moves straight to the next button; otherwise wait a moment
    const quick = this.el && !this.el.hidden || Date.now() - this.shownAt < 300;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show(b, tx), quick ? 0 : 450);
  },
  show(b, tx){
    if(this.on !== b || !b.isConnected || !b.offsetWidth) return;
    if(!this.el){
      this.el = document.createElement('div');
      this.el.className = 'tip'; this.el.id = 'tip'; this.el.setAttribute('role', 'tooltip'); this.el.hidden = true;
      document.body.appendChild(this.el);
    }
    const E = this.el;
    E.innerHTML = `<b class="tip-t">${esc(tx.t)}</b>${tx.k ? `<kbd class="tip-k">${esc(tx.k)}</kbd>` : ''}${tx.d ? `<span class="tip-d">${esc(tx.d)}</span>` : ''}`;
    E.hidden = false; E.style.left = '0px'; E.style.top = '0px';
    const r = b.getBoundingClientRect(), w = E.offsetWidth, h = E.offsetHeight, vw = innerWidth, vh = innerHeight, g = 8;
    let x = r.left + r.width / 2 - w / 2, y = r.bottom + g;
    if(y + h > vh - 4) y = r.top - g - h;                    // no room below → above
    if(y < 4){                                                // a side toolbar: put it beside the button
      y = clamp(r.top + r.height / 2 - h / 2, 4, vh - h - 4);
      x = r.right + g + w <= vw - 4 ? r.right + g : r.left - g - w;
    }
    E.style.left = Math.round(clamp(x, 4, vw - w - 4)) + 'px';
    E.style.top = Math.round(y) + 'px';
    this.shownAt = Date.now();
  },
  leave(){
    clearTimeout(this.timer);
    const b = this.on;
    if(b && b.dataset.tipSave !== undefined){
      if(!b.hasAttribute('title')) b.setAttribute('title', b.dataset.tipSave);   // code may have set a new title meanwhile
      delete b.dataset.tipSave;
    }
    this.on = null;
    if(this.el && !this.el.hidden){ this.el.hidden = true; this.shownAt = Date.now(); }
  },
  hideNow(){ this.leave(); this.shownAt = 0; },
};
document.addEventListener('pointerover', e => Tip.over(e), true);
document.addEventListener('pointerout', e => { if(Tip.on && (!e.relatedTarget || !Tip.on.contains(e.relatedTarget))) Tip.leave(); }, true);
document.addEventListener('pointerdown', () => Tip.hideNow(), true);
document.addEventListener('keydown', () => Tip.hideNow(), true);
document.addEventListener('wheel', () => Tip.hideNow(), {capture: true, passive: true});
window.addEventListener('blur', () => Tip.hideNow());
