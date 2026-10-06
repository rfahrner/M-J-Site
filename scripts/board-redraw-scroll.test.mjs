import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync('loadboard.js', 'utf8');
const render = source.match(/  function renderBoardTable\([^]*?\n  \}/)[0];
const dom = new JSDOM('<div class="grid-scroll"><table id="board-table"></table></div>', {runScripts:'outside-only'});
const w = dom.window;
w.$ = s => w.document.querySelector(s);
w.$all = s => [...w.document.querySelectorAll(s)];
w.state = {boardSort:{}, activeLocation:'atlanta'};
w.getVisibleBoardRows = () => Array.from({length:100}, (_,id) => ({id}));
w.getOrderedTripSubcols = () => [];
w.rowsToHtml = r => `<tr><td><input id="cell-${r.id}" value="1600"></td></tr>`;
w.updateBulkActionButtonsVisibility = () => {};
w.updateBoardSelectCount = () => {};
const grid = w.$('.grid-scroll');
// Model a layout read applying the browser's new scroll anchor during redraw.
w.refreshDriverDatalist = () => { grid.scrollTop = 0; grid.scrollLeft = 0; };
w.eval(render + ';window.redraw=renderBoardTable;');
for(let i=0; i<12; i++) {
  grid.scrollTop = 480+i*36;
  grid.scrollLeft = 700;
  const before=[grid.scrollTop,grid.scrollLeft];
  w.redraw();
  assert.deepEqual([grid.scrollTop,grid.scrollLeft],before);
}
assert.match(fs.readFileSync('loadboard.css','utf8'), /#board-view \.grid-scroll\s*\{\s*overflow-anchor:\s*none;/);
console.log('12 full redraws preserve both scroll axes through layout changes.');
