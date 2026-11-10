/* FORMS (Forms tab): fill your program's own forms in the app, with no AI.
   The student adds a blank form once (fillable PDF, typed PDF, Word .docx, or a photo/scan). The app finds the places to write
   with fixed rules (form fields, ruled lines, table cells, check boxes, "Label:" blanks, rating tables), the student checks the
   list once, and then fills it as often as needed: text boxes, rating buttons, check boxes and a finger signature.
   Export writes the answers back INTO the student's own file and hands it to the share sheet.
   Templates and fills are stored on this device under anespilot:forms:* (so Export Backup includes them); the original file
   is kept in IndexedDB (if that is unavailable or cleared, the app asks for the file again at export). Nothing leaves the device,
   not even with Send to preceptor (PRECEPTOR-LINK-V2 below): the link itself carries the form to the preceptor's device. */
var FF = (function(){
'use strict';
var P = 'anespilot:forms:';

/* ---------- storage ---------- */
function get(k, d){ try{ var r = localStorage.getItem(P + k); return r ? JSON.parse(r) : d; }catch(e){ return d; } }
function put(k, v){
  try{ localStorage.setItem(P + k, JSON.stringify(v)); return true; }
  catch(e){
    if(typeof showSaveFailureBanner === 'function') showSaveFailureBanner('Not enough storage on this device to save that. Delete an old form or fill, or export a backup and free up space.');
    return false;
  }
}
function del(k){ try{ localStorage.removeItem(P + k); }catch(e){} }
function esc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function toast(m){ if(typeof apToast === 'function') apToast(m); }
function fileSafe(s){ return String(s || 'form').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'form'; }
function clean(t){ return String(t || '').replace(/\[\[S\d+\]\]/g, ' ').replace(/[|_]+/g, ' ').replace(/[☐□▢❏☑☒]/g, ' ').replace(/\s+/g, ' ').trim(); }
function labelOf(t){ return clean(t).replace(/[:\s]+$/, '').slice(0, 90); }
function overlap(a, b){ var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; }
// Helvetica (WinAnsi) cannot draw every character: swap the common ones and replace the rest
function latin(s){ return String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/→/g, '->').replace(/↑/g, 'up').replace(/↓/g, 'down').replace(/μ/g, 'u').replace(/•/g, '-').replace(/…/g, '...').replace(/\r/g, '').replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, '?'); }
function waitFor(name, ms){ return new Promise(function(res){ var t0 = Date.now(); (function poll(){ if(window[name]) return res(window[name]); if(Date.now() - t0 > ms) return res(null); setTimeout(poll, 40); })(); }); }
async function pdfjs(){ var l = await waitFor('pdfjsLib', 15000); if(!l) throw new Error('The PDF reader did not start. Close and reopen the app, then try again.'); return l; }
async function pdflib(){ var l = await waitFor('PDFLib', 5000); if(!l) throw new Error('The PDF writer did not start. Close and reopen the app, then try again.'); return l; }
function openPdf(lib, bytes){ return lib.getDocument({data: new Uint8Array(bytes.slice(0)), isEvalSupported: false}).promise; }
var SIG_RE = /\bsignature\b|\bsign here\b|\bsigned\b|\bsign\b/i, DATE_RE = /\bdate\b|\bdob\b/i,
    LONG_RE = /comment|narrative|reflect|objective|goal|plan\b|summary|describe|strength|improve|feedback|notes?\b|remediation plan/i;
function guessType(label, tall){ return SIG_RE.test(label) ? 'signature' : (DATE_RE.test(label) && !/update/i.test(label)) ? 'date' : (tall || LONG_RE.test(label)) ? 'long' : 'text'; }

/* ---------- the original file, kept on this device ---------- */
var DBN = 'anespilot-forms';
function db(){ return new Promise(function(res, rej){ try{ var r = indexedDB.open(DBN, 1); r.onupgradeneeded = function(){ r.result.createObjectStore('files'); }; r.onsuccess = function(){ res(r.result); }; r.onerror = function(){ rej(r.error); }; }catch(e){ rej(e); } }); }
async function fileSave(id, buf, name){ try{ var d = await db(); await new Promise(function(res, rej){ var t = d.transaction('files', 'readwrite'); t.objectStore('files').put({buf: buf, name: name}, id); t.oncomplete = res; t.onerror = function(){ rej(t.error); }; }); return true; }catch(e){ return false; } }
async function fileLoad(id){ try{ var d = await db(); return await new Promise(function(res){ var r = d.transaction('files').objectStore('files').get(id); r.onsuccess = function(){ res(r.result || null); }; r.onerror = function(){ res(null); }; }); }catch(e){ return null; } }
async function fileDrop(id){ try{ var d = await db(); d.transaction('files', 'readwrite').objectStore('files').delete(id); }catch(e){} }

/* ---------- page geometry: boxes are kept in page points from the top left; t is pdf.js's viewport transform at scale 1 ---------- */
function toPdfRect(pg, b){
  var t = pg.t, det = t[0] * t[3] - t[1] * t[2];
  var inv = function(x, y){ var X = x - t[4], Y = y - t[5]; return [(t[3] * X - t[2] * Y) / det, (t[0] * Y - t[1] * X) / det]; };
  var p = inv(b.x, b.y), q = inv(b.x + b.w, b.y + b.h);
  return {x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(q[0] - p[0]), h: Math.abs(q[1] - p[1])};
}
function fromPdfRect(pg, r){
  var t = pg.t, f = function(x, y){ return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]]; };
  var p = f(r.x, r.y), q = f(r.x + r.width, r.y + r.height);
  return {x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(q[0] - p[0]), h: Math.abs(q[1] - p[1])};
}

/* =========================== reading a PDF page (rules, cells, lines, boxes, text) =========================== */
var S2 = 2;                                  // detection render scale: 1 pt = 2 px
var RANK = {box: 0, cell: 1, line: 2, gap: 4};
async function pageText(pg, vp){
  var tc = await pg.getTextContent(), out = [];
  tc.items.forEach(function(it){
    if(!it.str || !it.str.trim()) return;
    var t = it.transform, fs = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
    var p = vp.convertToViewportPoint(t[4], t[5]), w = (it.width || fs * it.str.length * 0.5) * vp.scale;
    // split items that hold far-apart words ("Student name:      Date:") at runs of 3+ spaces
    var parts = it.str.split(/(\s{3,})/), x = p[0], per = w / Math.max(1, it.str.length);
    parts.forEach(function(s){ if(s.trim()) out.push({str: s.trim(), x: x, y: p[1] - fs * 0.82 * vp.scale, w: s.length * per, h: fs * 1.02 * vp.scale, base: p[1]}); x += s.length * per; });
  });
  return out;
}
function findRules(dark, W, H, minH, minV){
  var line = new Uint8Array(W * H), hs = [], x, y, e, k;
  for(y = 0; y < H; y++){ x = 0; while(x < W){ if(dark[y * W + x]){ e = x; while(e < W && dark[y * W + e]) e++; if(e - x >= minH){ for(k = x; k < e; k++) line[y * W + k] = 1; hs.push([x, e, y]); } x = e; } else x++; } }
  for(x = 0; x < W; x++){ y = 0; while(y < H){ if(dark[y * W + x]){ e = y; while(e < H && dark[e * W + x]) e++; if(e - y >= minV){ for(k = y; k < e; k++) line[k * W + x] = 1; } y = e; } else y++; } }
  var out = new Uint8Array(line);
  for(y = 1; y < H - 1; y++) for(x = 1; x < W - 1; x++){ if(line[y * W + x]){ out[y * W + x - 1] = out[y * W + x + 1] = out[(y - 1) * W + x] = out[(y + 1) * W + x] = 1; } }
  hs.sort(function(a, b){ return a[2] - b[2] || a[0] - b[0]; }); var segs = [];
  hs.forEach(function(h){ var s = segs.find(function(s){ return Math.abs(s.y1 - h[2]) <= 1 && Math.abs(s.x0 - h[0]) < 6 && Math.abs(s.x1 - h[1]) < 6; }); if(s) s.y1 = h[2]; else segs.push({x0: h[0], x1: h[1], y0: h[2], y1: h[2]}); });
  return {mask: out, hsegs: segs};
}
function findRegions(mask, W, H){
  var lab = new Int32Array(W * H), regs = [], n = 0, qx = new Int32Array(W * H);
  for(var i = 0; i < W * H; i++){
    if(mask[i] || lab[i]) continue;
    n++; var head = 0, tail = 0; qx[tail++] = i; lab[i] = n; var x0 = W, x1 = 0, y0 = H, y1 = 0, area = 0, edge = false;
    while(head < tail){ var p = qx[head++], x = p % W, y = (p - x) / W; area++;
      if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; if(x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
      if(x > 0 && !mask[p - 1] && !lab[p - 1]){ lab[p - 1] = n; qx[tail++] = p - 1; }
      if(x < W - 1 && !mask[p + 1] && !lab[p + 1]){ lab[p + 1] = n; qx[tail++] = p + 1; }
      if(y > 0 && !mask[p - W] && !lab[p - W]){ lab[p - W] = n; qx[tail++] = p - W; }
      if(y < H - 1 && !mask[p + W] && !lab[p + W]){ lab[p + W] = n; qx[tail++] = p + W; } }
    if(!edge) regs.push({x0: x0, y0: y0, x1: x1, y1: y1, area: area});
  }
  return regs;
}
function inkBox(dark, mask, W, x0, y0, x1, y1){
  var a = x1, b = x0, c = y1, d = y0, any = false;
  for(var y = y0; y <= y1; y++) for(var x = x0; x <= x1; x++){ var i = y * W + x; if(dark[i] && !mask[i]){ any = true; if(x < a) a = x; if(x > b) b = x; if(y < c) c = y; if(y > d) d = y; } }
  return any ? {x0: a, x1: b, y0: c, y1: d} : null;
}
// one page: picture for the review screen, text in points, and (for forms without fields) the places to write
async function readPage(pg, pageNo, wantSlots){
  var vp = pg.getViewport({scale: S2}), vp1 = pg.getViewport({scale: 1}), W = Math.round(vp.width), H = Math.round(vp.height);
  var c = document.createElement('canvas'); c.width = W; c.height = H; var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  await pg.render({canvasContext: g, canvas: c, viewport: vp}).promise;
  var text = await pageText(pg, vp), S = S2;
  var T = text.map(function(t){ return {str: t.str, x: t.x / S, y: t.y / S, w: t.w / S, h: t.h / S}; });
  var info = {page: pageNo, w: vp1.width, h: vp1.height, t: vp1.transform.slice(0), T: T, slots: [], hasText: text.length > 3};
  // the picture: about 1.25 px per pt is sharp enough on a phone and keeps memory low
  var k = Math.min(1, 1.25 * vp1.width * 1.6 / W), o = document.createElement('canvas'); o.width = Math.round(W * k); o.height = Math.round(H * k);
  o.getContext('2d').drawImage(c, 0, 0, o.width, o.height); info.img = o.toDataURL('image/jpeg', 0.8);
  if(!wantSlots){ c.width = c.height = 1; return info; }
  var px = g.getImageData(0, 0, W, H).data, dark = new Uint8Array(W * H), light = new Uint8Array(W * H), i;
  for(i = 0; i < W * H; i++){ var l = 0.3 * px[i * 4] + 0.59 * px[i * 4 + 1] + 0.11 * px[i * 4 + 2]; dark[i] = l < 165 ? 1 : 0; light[i] = l < 215 ? 1 : 0; }
  px = null; c.width = c.height = 1;
  var hasText = info.hasText, forRules = new Uint8Array(light);
  if(hasText) text.forEach(function(t){ var x0 = Math.max(0, Math.floor(t.x) + 1), x1 = Math.min(W - 1, Math.ceil(t.x + t.w) - 1), y0 = Math.max(0, Math.floor(t.y) + 1), y1 = Math.min(H - 1, Math.ceil(t.y + t.h) - 1);
    if(/_{3,}/.test(t.str)) return; for(var y = y0; y <= y1; y++) for(var x = x0; x <= x1; x++) forRules[y * W + x] = 0; });
  var minH = Math.round((hasText ? 14 : 22) * S), minV = Math.round((hasText ? 9 : 16) * S);
  var R = findRules(forRules, W, H, minH, minV), mask = R.mask, slots = [];
  var toPt = function(x0, y0, x1, y1){ return {x: x0 / S, y: y0 / S, w: (x1 - x0) / S, h: (y1 - y0) / S}; };
  // 1. table cells and boxes
  findRegions(mask, W, H).forEach(function(r){
    var w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1; if(w < 7 * S || h < 7 * S || w * h > 0.45 * W * H || r.area < 0.8 * w * h) return;
    var ink = inkBox(dark, mask, W, r.x0 + 1, r.y0 + 1, r.x1 - 1, r.y1 - 1);
    var sq = w <= 26 * S && h <= 26 * S && w / h > 0.6 && w / h < 1.6;
    if(sq && !ink){ slots.push(Object.assign({kind: 'box'}, toPt(r.x0, r.y0, r.x1 + 1, r.y1 + 1))); return; }
    if(h < 9 * S || w < 16 * S) return;
    var free = toPt(r.x0 + 2, r.y0 + 2, r.x1 - 1, r.y1 - 1), labelled = false;
    if(ink){
      labelled = true; var pad = 3 * S;
      var below = {x0: r.x0 + 2, y0: ink.y1 + pad, x1: r.x1 - 1, y1: r.y1 - 1}, right = {x0: ink.x1 + pad, y0: r.y0 + 2, x1: r.x1 - 1, y1: r.y1 - 1};
      var ab = Math.max(0, below.x1 - below.x0) * Math.max(0, below.y1 - below.y0), ar = Math.max(0, right.x1 - right.x0) * Math.max(0, right.y1 - right.y0);
      var best = ab >= ar ? below : right; if(Math.max(ab, ar) < 14 * S * 9 * S || best.y1 - best.y0 < 8 * S || best.x1 - best.x0 < 18 * S) return;
      free = toPt(best.x0, best.y0, best.x1, best.y1);
    }
    slots.push(Object.assign({kind: 'cell', cell: toPt(r.x0, r.y0, r.x1 + 1, r.y1 + 1), labelled: labelled}, free));
  });
  // 2. answer lines (rules that are not the edge of a cell)
  R.hsegs.forEach(function(s){
    if(s.y1 - s.y0 > 3 * S) return; if(s.x1 - s.x0 < 22 * S) return;
    var sy = s.y0 / S, sx0 = s.x0 / S, sx1 = s.x1 / S;
    if(slots.some(function(o){ var c = o.cell || o; return o.kind !== 'box' && c.x < sx1 && c.x + c.w > sx0 && (Math.abs(c.y - sy) < 4 || Math.abs(c.y + c.h - sy) < 4); })) return;
    var ink = inkBox(dark, mask, W, s.x0, Math.max(0, s.y0 - 15 * S), s.x1, s.y0 - 2), x0 = s.x0;
    if(ink && ink.x1 < s.x1 - 20 * S && ink.y1 > s.y0 - 6 * S) x0 = ink.x1 + 3 * S; else if(ink) return;
    slots.push(Object.assign({kind: 'line'}, toPt(x0, Math.max(0, s.y0 - 15 * S), s.x1, s.y0 - 1)));
  });
  // small hollow squares drawn with short strokes (check boxes)
  (function(){
    var seen = new Uint8Array(W * H), q = new Int32Array(W * H), lo = 6 * S, hi = 22 * S;
    for(var i = 0; i < W * H; i++){
      if(!forRules[i] || seen[i]) continue; var head = 0, tail = 0; q[tail++] = i; seen[i] = 1; var x0 = W, x1 = 0, y0 = H, y1 = 0, n = 0;
      while(head < tail && tail < 6000){ var p = q[head++], x = p % W, y = (p - x) / W; n++; if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y;
        var nb = [p - 1, p + 1, p - W, p + W]; for(var k = 0; k < 4; k++){ var j = nb[k]; if(j >= 0 && j < W * H && forRules[j] && !seen[j]){ seen[j] = 1; q[tail++] = j; } } }
      var w = x1 - x0 + 1, h = y1 - y0 + 1; if(w < lo || h < lo || w > hi || h > hi || w / h < 0.75 || w / h > 1.33) continue;
      if(n > 0.45 * w * h) continue;
      var inside = 0; for(var yy = y0 + 3; yy <= y1 - 3; yy++) for(var xx = x0 + 3; xx <= x1 - 3; xx++) if(dark[yy * W + xx]) inside++;
      if(inside > 4) continue;
      var r = toPt(x0, y0, x1 + 1, y1 + 1); if(!slots.some(function(o){ return overlap(o, r) > 0.5 * r.w * r.h; })) slots.push(Object.assign({kind: 'box'}, r));
    }
  })();
  // 3. typed forms without rules: blank space after "Label:" and empty bands under a heading
  if(hasText){
    var lines = []; text.slice().sort(function(a, b){ return a.base - b.base || a.x - b.x; }).forEach(function(t){ var l = lines.find(function(l){ return Math.abs(l.base - t.base) < 3 * S; }); if(l) l.items.push(t); else lines.push({base: t.base, items: [t]}); });
    lines.forEach(function(l){ l.items.sort(function(a, b){ return a.x - b.x; }); });
    var right = Math.max.apply(null, text.map(function(t){ return t.x + t.w; })), left = Math.min.apply(null, text.map(function(t){ return t.x; }));
    var taken = function(r){ return slots.some(function(o){ return overlap(o.cell || o, r) > 0.05 * r.w * r.h; }); };
    lines.forEach(function(l, li){
      l.items.forEach(function(t, k){
        if(!/:\s*$/.test(t.str)) return; var nx = l.items[k + 1], x0 = t.x + t.w + 4 * S, x1 = nx ? nx.x - 4 * S : right;
        var r = {x: x0 / S, y: t.y / S, w: (x1 - x0) / S, h: t.h / S};
        if(r.w > 60 && !taken(r)) slots.push(Object.assign({kind: 'gap'}, r));
      });
      var next = lines[li + 1]; if(!next) return;
      var top = Math.max.apply(null, l.items.map(function(t){ return t.y + t.h; })) + 3 * S, bottom = Math.min.apply(null, next.items.map(function(t){ return t.y; })) - 3 * S;
      var r = {x: left / S, y: top / S, w: (right - left) / S, h: (bottom - top) / S};
      if(r.h > 30 && !taken(r) && /:\s*$/.test(l.items[l.items.length - 1].str)) slots.push(Object.assign({kind: 'gap', band: true}, r));
    });
  }
  text.forEach(function(t){ if(/^[☐□▢❏]$/.test(t.str.trim())){ var r = {x: t.x / S, y: t.y / S, w: t.h * 0.8 / S, h: t.h * 0.8 / S}; if(!slots.some(function(o){ return o.kind === 'box' && overlap(o, r); })) slots.push(Object.assign({kind: 'box'}, r)); } });
  slots.sort(function(a, b){ return RANK[a.kind] - RANK[b.kind]; });
  var kept = []; slots.forEach(function(s){ if(!kept.some(function(k){ return overlap(k, s) > 0.6 * Math.min(k.w * k.h, s.w * s.h); })) kept.push(s); });
  kept.sort(function(a, b){ return (a.y - b.y) || (a.x - b.x); });
  kept.forEach(function(s){
    s.page = pageNo;
    var cy = s.y + s.h / 2, same = T.filter(function(t){ return t.x + t.w <= s.x + 2 && t.y < cy + 4 && t.y + t.h > s.y - 4 && s.x - (t.x + t.w) < 220; }).sort(function(a, b){ return b.x - a.x; });
    var above = T.filter(function(t){ return t.y + t.h <= s.y + 2 && s.y - (t.y + t.h) < 40 && t.x < s.x + s.w && t.x + t.w > s.x - 10; }).sort(function(a, b){ return b.y - a.y; });
    s.left = same.slice(0, 3).reverse().map(function(t){ return t.str; }).join(' ').slice(-80);
    s.above = above.slice(0, 2).map(function(t){ return t.str; }).join(' ').slice(0, 80);
    s.inside = s.cell ? T.filter(function(t){ return overlap(s.cell, t) > 0.5 * t.w * t.h; }).map(function(t){ return t.str; }).join(' ').slice(0, 100) : '';
  });
  info.slots = kept;
  return info;
}
async function readPdf(buf, wantSlots, onPage){
  var lib = await pdfjs(), doc = await openPdf(lib, buf), n = Math.min(doc.numPages, 12), pages = [];
  for(var i = 1; i <= n; i++){ if(onPage) onPage(i, n); pages.push(await readPage(await doc.getPage(i), i, wantSlots)); }
  try{ doc.destroy(); }catch(e){}
  return {pages: pages, total: doc.numPages};
}

/* ---------- words near a box ---------- */
function textLeft(T, b){
  var cy = b.y + b.h / 2;
  var same = T.filter(function(t){ return t.x + t.w <= b.x + 3 && t.y < cy + Math.max(4, b.h / 2) && t.y + t.h > cy - Math.max(4, b.h / 2) && b.x - (t.x + t.w) < 260; }).sort(function(a, c){ return c.x - a.x; });
  var out = [], edge = b.x; same.forEach(function(t){ if(out.length < 4 && (!out.length || edge - (t.x + t.w) < 40)){ out.unshift(t.str); edge = t.x; } });
  return out.join(' ');
}
function textRight(T, b, maxGap){
  var cy = b.y + b.h / 2;
  var same = T.filter(function(t){ return t.x >= b.x + b.w - 2 && t.y < cy + Math.max(4, b.h / 2) && t.y + t.h > cy - Math.max(4, b.h / 2) && t.x - (b.x + b.w) < (maxGap || 40); }).sort(function(a, c){ return a.x - c.x; });
  return same.length ? same[0].str : '';
}
function textAbove(T, b){
  var above = T.filter(function(t){ return t.y + t.h <= b.y + 3 && b.y - (t.y + t.h) < 30 && t.x < b.x + b.w && t.x + t.w > b.x - 10; }).sort(function(a, c){ return c.y - a.y; });
  return above.length ? above[0].str : '';
}
function headerAbove(T, b){
  var best = null;
  T.forEach(function(t){ var cx = t.x + t.w / 2; if(cx < b.x - 4 || cx > b.x + b.w + 4) return; var gap = b.y - (t.y + t.h); if(gap < -2 || gap > 260) return; if(!best || gap < best.gap) best = {t: t, gap: gap}; });
  return best ? best.t : null;
}
// rows of small boxes or cells whose columns are headed by short words (4 3 2 1 N/A, Met / Not met...) become one rating each
function findGrids(items, T){
  var rows = [];
  items.slice().sort(function(a, b){ return (a.b.y + a.b.h / 2) - (b.b.y + b.b.h / 2); }).forEach(function(it){
    var cy = it.b.y + it.b.h / 2, r = rows.find(function(r){ return Math.abs(r.cy - cy) < Math.max(4, it.b.h * 0.4); });
    if(r) r.items.push(it); else rows.push({cy: cy, items: [it]});
  });
  var out = [];
  rows.forEach(function(r){
    if(r.items.length < 2) return;
    r.items.sort(function(a, b){ return a.b.x - b.b.x; });
    var heads = r.items.map(function(it){ return headerAbove(T, it.b); });
    if(heads.some(function(h){ return !h || h.str.length > 18 || /:\s*$/.test(h.str); })) return;
    var names = heads.map(function(h){ return h.str.trim(); });
    if(new Set(names).size !== names.length) return;
    var first = r.items[0].b, label = textLeft(T, {x: first.x, y: first.y, w: first.w, h: first.h});
    out.push({items: r.items, options: names, heads: heads, label: labelOf(label)});
  });
  return out;
}
// a scan has no text layer: rows of 3+ small cells that line up with the rows above or below are taken as a rating (options 1..n, renamed on the review screen)
function findGridsNoText(items){
  var rows = [];
  items.slice().sort(function(a, b){ return (a.b.y + a.b.h / 2) - (b.b.y + b.b.h / 2); }).forEach(function(it){
    var cy = it.b.y + it.b.h / 2, r = rows.find(function(r){ return Math.abs(r.cy - cy) < Math.max(4, it.b.h * 0.4); });
    if(r) r.items.push(it); else rows.push({cy: cy, items: [it]});
  });
  rows = rows.filter(function(r){ return r.items.length >= 3; });
  rows.forEach(function(r){ r.items.sort(function(a, b){ return a.b.x - b.b.x; }); });
  var same = function(a, b){ return a.items.length === b.items.length && a.items.every(function(it, i){ return Math.abs(it.b.x - b.items[i].b.x) < 5; }); };
  var out = [];
  rows.forEach(function(r, i){
    if(!(rows[i - 1] && same(rows[i - 1], r)) && !(rows[i + 1] && same(rows[i + 1], r))) return;
    out.push({items: r.items, options: r.items.map(function(_, k){ return String(k + 1); }), heads: [], label: ''});
  });
  return out;
}

/* =========================== fillable PDF (form fields) =========================== */
function ftype(lib, f){ return f instanceof lib.PDFTextField ? 'text' : f instanceof lib.PDFRadioGroup ? 'radio' : f instanceof lib.PDFCheckBox ? 'checkbox' : f instanceof lib.PDFDropdown ? 'dropdown' : f instanceof lib.PDFOptionList ? 'list' : (lib.PDFSignature && f instanceof lib.PDFSignature) ? 'signature' : 'other'; }
function widgetPageIndex(doc, w){
  var pages = doc.getPages(), ref = null; try{ ref = w.P(); }catch(e){}
  if(ref){ var i = pages.findIndex(function(p){ return p.ref === ref; }); if(i !== -1) return i; }
  var wref = null; try{ wref = doc.context.getObjectRef(w.dict); }catch(e){}
  for(var k = 0; k < pages.length; k++){ try{ var an = pages[k].node.Annots(); if(an && wref && an.asArray().some(function(a){ return a === wref; })) return k; }catch(e){} }
  return 0;
}
function niceName(n){
  var s = String(n || '').replace(/^.*\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if(/^(text|check ?box|field|untitled|button|radio|group|choice|dropdown|list)\s*\d*$/i.test(s) || !s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
async function acroFields(buf){
  var lib = await pdflib(), doc;
  try{ doc = await lib.PDFDocument.load(buf.slice(0), {ignoreEncryption: true}); }catch(e){ return null; }
  var fs; try{ fs = doc.getForm().getFields(); }catch(e){ return null; }
  if(!fs.length) return null;
  var out = [];
  fs.forEach(function(f){
    var t = ftype(lib, f); if(t === 'other') return;
    var o = {name: f.getName(), t: t, w: []};
    try{ f.acroField.getWidgets().forEach(function(w){ var r = w.getRectangle(); o.w.push({page: widgetPageIndex(doc, w) + 1, r: {x: r.x, y: r.y, width: r.width, height: r.height}}); }); }catch(e){}
    try{ if(t === 'radio' || t === 'dropdown' || t === 'list') o.options = f.getOptions(); }catch(e){}
    try{ if(t === 'text') o.multi = f.isMultiline(); }catch(e){}
    if(o.w.length) out.push(o);
  });
  return out.length ? out : null;
}
function acroToFields(acro, pages){
  var fields = [], pg = function(n){ return pages[n - 1] || pages[0]; };
  acro.forEach(function(a){ a.boxes = a.w.map(function(w){ return Object.assign({page: w.page}, fromPdfRect(pg(w.page), w.r)); }); });
  // one check box per score in a row -> a rating
  var singles = acro.filter(function(a){ return a.t === 'checkbox' && a.boxes.length === 1; }), used = new Set();
  pages.forEach(function(p){
    var items = singles.filter(function(a){ return a.boxes[0].page === p.page; }).map(function(a){ return {b: a.boxes[0], a: a}; });
    findGrids(items, p.T).forEach(function(g){
      var map = {}; g.items.forEach(function(it, i){ map[g.options[i]] = it.a.name; used.add(it.a.name); });
      fields.push({label: g.label || 'Rating', type: 'rating', options: g.options, tgt: {acroMap: map}, boxes: g.items.map(function(it){ return it.b; })});
    });
  });
  acro.forEach(function(a){
    if(used.has(a.name)) return;
    var b = a.boxes[0], T = pg(b.page).T, label;
    if(a.t === 'checkbox'){ label = textRight(T, b, 30) || textLeft(T, b) || niceName(a.name); fields.push({label: labelOf(label) || 'Check box', type: 'check', tgt: {acro: a.name}, boxes: a.boxes}); return; }
    if(a.t === 'radio'){
      var opts = (a.options || []).map(String), shown = opts.map(function(o, i){ var bb = a.boxes[i]; if(!bb) return o; var r = textRight(pg(bb.page).T, bb, 30) || (headerAbove(pg(bb.page).T, bb) || {}).str; return labelOf(r) || o; });
      if(new Set(shown).size !== shown.length) shown = opts;
      var vals = {}; shown.forEach(function(s, i){ vals[s] = opts[i]; });
      label = textLeft(T, a.boxes.reduce(function(m, x){ return x.x < m.x ? x : m; }, b)) || textAbove(T, b) || niceName(a.name);
      fields.push({label: labelOf(label) || 'Choice', type: 'rating', options: shown, tgt: {radio: a.name, vals: vals}, boxes: a.boxes}); return;
    }
    if(a.t === 'dropdown' || a.t === 'list'){ label = textLeft(T, b) || textAbove(T, b) || niceName(a.name); fields.push({label: labelOf(label) || 'Choice', type: 'rating', options: (a.options || []).map(String), tgt: {acroPick: a.name}, boxes: a.boxes}); return; }
    label = labelOf(textLeft(T, b) || textAbove(T, b)) || niceName(a.name) || 'Text';
    var type = a.t === 'signature' ? 'signature' : guessType(label, a.multi || b.h > 40);
    fields.push({label: label, type: type, tgt: {acro: a.name}, boxes: a.boxes});
  });
  return order(fields);
}
function order(fields){
  fields.sort(function(a, b){ var p = a.boxes[0], q = b.boxes[0]; return (p.page - q.page) || (Math.abs(p.y - q.y) > 4 ? p.y - q.y : p.x - q.x); });
  fields.forEach(function(f, i){ f.id = 'f' + (i + 1); });
  return fields;
}

/* =========================== flat PDF (typed, or a scan/photo) =========================== */
function slotsToFields(pages){
  var fields = [];
  pages.forEach(function(p){
    var slots = p.slots.slice(), drop = new Set();
    // rating grids: rows of empty boxes or small empty cells under short column headings
    var cand = slots.filter(function(s){ return s.kind === 'box' || (s.kind === 'cell' && !s.labelled && s.w <= 90 && s.h <= 44); }).map(function(s){ return {b: s, s: s}; });
    var grids = p.hasText ? findGrids(cand, p.T) : findGridsNoText(cand), rowNo = 0;
    grids.forEach(function(g){
      var map = {}; g.items.forEach(function(it, i){ map[g.options[i]] = box(it.s); drop.add(it.s); });
      // the row's label cell and the heading cells are printed text, not places to write
      var first = g.items[0].b, cy = first.y + first.h / 2, hy = g.heads.length ? g.heads[0].y + g.heads[0].h / 2 : -999;
      slots.forEach(function(s){ var c = s.cell || s; if(drop.has(s)) return;
        if(s.labelled && c.x + c.w <= first.x + 3 && (Math.abs((c.y + c.h / 2) - cy) < c.h / 2 || (hy > c.y && hy < c.y + c.h))) drop.add(s);
        if(s.labelled && g.heads.some(function(h){ return overlap(c, h) > 0.5 * h.w * h.h; })) drop.add(s); });
      rowNo++;
      fields.push({label: g.label || (p.hasText ? 'Rating' : 'Row ' + rowNo), type: 'rating', options: g.options, tgt: {optSlots: map}, boxes: g.items.map(function(it){ return box(it.s); })});
    });
    slots.forEach(function(s){
      if(drop.has(s)) return;
      if(s.kind === 'gap' && slots.some(function(o){ return o !== s && o.kind !== 'gap' && !drop.has(o) && overlap(o.cell || o, s) > 0.05 * s.w * s.h; })) return;
      if(s.kind === 'box'){ var lb = textRight(p.T, s, 30) || s.left || s.above; fields.push({label: labelOf(lb) || 'Check box', type: 'check', tgt: {slots: [box(s)]}, boxes: [box(s)]}); return; }
      var label = labelOf(s.left) || labelOf(s.inside) || labelOf(s.above);
      // a heading cell with no room to write is not a field
      if(s.labelled && !s.left && s.w < 40) return;
      var prev = fields[fields.length - 1], pb = prev && prev.boxes[prev.boxes.length - 1];
      // stacked answer lines under one label are one answer
      if(s.kind === 'line' && !labelOf(s.left) && prev && prev.tgt.slots && pb && pb.page === p.page && s.y - (pb.y + pb.h) < 14 && s.y > pb.y && Math.abs(s.x - pb.x) < 60 && prev.type !== 'check' && prev.type !== 'signature'){
        prev.tgt.slots.push(box(s)); prev.boxes.push(box(s)); if(prev.type === 'text') prev.type = 'long'; return;
      }
      fields.push({label: label || 'Answer', type: guessType(label, s.h > 40), tgt: {slots: [box(s)]}, boxes: [box(s)]});
    });
  });
  return order(fields);
}
function box(s){ return {page: s.page, x: s.x, y: s.y, w: s.w, h: s.h, kind: s.kind}; }

/* =========================== Word (.docx) =========================== */
function unzipList(buf){
  var u = new Uint8Array(buf), dv = new DataView(buf), eocd = -1;
  for(var i = u.length - 22; i >= Math.max(0, u.length - 65557); i--){ if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; } }
  if(eocd < 0) throw new Error('This is not a Word (.docx) file.');
  var p = dv.getUint32(eocd + 16, true), n = dv.getUint16(eocd + 10, true), dec = new TextDecoder(), list = [];
  for(var k = 0; k < n; k++){
    var e = {method: dv.getUint16(p + 10, true), time: dv.getUint16(p + 12, true), date: dv.getUint16(p + 14, true), crc: dv.getUint32(p + 16, true), csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true)};
    var nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    e.nameBytes = u.slice(p + 46, p + 46 + nl); e.name = dec.decode(e.nameBytes);
    var ds = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true); e.data = u.subarray(ds, ds + e.csize);
    list.push(e); p += 46 + nl + el + cl;
  }
  return list;
}
async function unzipText(e){
  if(e.method === 0) return new TextDecoder().decode(e.data);
  if(typeof DecompressionStream !== 'undefined'){ try{ var s = new Blob([e.data]).stream().pipeThrough(new DecompressionStream('deflate-raw')); return await new Response(s).text(); }catch(x){} }
  if(window.JSZip){ var z = new JSZip(); return await (await z.loadAsync(zipWith([e], {}, null))).file(e.name).async('string'); }
  throw new Error('This phone cannot open Word files. Update iOS, or use a PDF of the form.');
}
var CRC_T = (function(){ var t = new Uint32Array(256); for(var n = 0; n < 256; n++){ var c = n; for(var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u){ var c = 0xFFFFFFFF; for(var i = 0; i < u.length; i++) c = CRC_T[(c ^ u[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
// rebuild the .docx: every part copied byte for byte except the replaced ones (stored uncompressed)
function zipWith(list0, replace, add){
  var parts = [], central = [], off = 0, list = list0.slice();
  if(add){ var t0 = list0[0] || {time: 0, date: 33}; Object.keys(add).forEach(function(nm){ if(list.some(function(e){ return e.name === nm; })) return; var d = add[nm];
    list.push({name: nm, nameBytes: new TextEncoder().encode(nm), data: d, method: 0, crc: crc32(d), usize: d.length, time: t0.time, date: t0.date}); }); }
  list.forEach(function(e){
    var data = e.data, method = e.method, crc = e.crc, usize = e.usize;
    if(replace[e.name] != null){ data = typeof replace[e.name] === 'string' ? new TextEncoder().encode(replace[e.name]) : replace[e.name]; method = 0; crc = crc32(data); usize = data.length; }
    var h = new Uint8Array(30 + e.nameBytes.length), dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, method, true); dv.setUint16(10, e.time, true); dv.setUint16(12, e.date, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, usize, true); dv.setUint16(26, e.nameBytes.length, true); dv.setUint16(28, 0, true); h.set(e.nameBytes, 30);
    var c = new Uint8Array(46 + e.nameBytes.length), cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true); cv.setUint16(10, method, true); cv.setUint16(12, e.time, true); cv.setUint16(14, e.date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, usize, true); cv.setUint16(28, e.nameBytes.length, true); cv.setUint32(42, off, true); c.set(e.nameBytes, 46);
    parts.push(h, data); central.push(c); off += h.length + data.length;
  });
  var cdSize = central.reduce(function(a, c){ return a + c.length; }, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, list.length, true); ev.setUint16(10, list.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  var all = new Uint8Array(off + cdSize + 22), p = 0; parts.concat(central, [end]).forEach(function(x){ all.set(x, p); p += x.length; }); return all;
}
var WNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function wq(el, name){ return Array.prototype.slice.call(el.getElementsByTagNameNS(WNS, name)); }
function kids(el, name){ return Array.prototype.filter.call(el.childNodes, function(x){ return x.namespaceURI === WNS && x.localName === name; }); }
function wText(el){ return wq(el, 't').map(function(t){ return t.textContent; }).join(''); }
// the places to write in a Word document. Same rules (and same numbering) every time the same file is read.
function docxSlots(xml){
  var doc = new DOMParser().parseFromString(xml, 'application/xml'), body = wq(doc, 'body')[0]; if(!body) throw new Error('No text found in this Word file.');
  var slots = [], lines = [], tables = [], ctx = {}, n = 0;
  var add = function(s){ s.id = 'S' + (++n); slots.push(s); return '[[' + s.id + ']]'; };
  var note = function(txt){ (txt.match(/\[\[S\d+\]\]/g) || []).forEach(function(m){ var id = m.slice(2, -2); if(!(id in ctx)) ctx[id] = txt; }); };
  function para(p){
    var txt = '';
    if(wq(p, 'sdt').length){ Array.prototype.forEach.call(p.childNodes, function(ch){ if(ch.namespaceURI !== WNS) return; if(ch.localName === 'sdt') txt += add({kind: 'field', el: ch}); else if(ch.localName === 'r') txt += wText(ch); }); return txt; }
    var instr = wq(p, 'instrText').map(function(x){ return x.textContent; }).join('');
    if(wq(p, 'fldChar').length && /FORMTEXT|FORMCHECKBOX/.test(instr)){ return wText(p) + add({kind: /FORMCHECKBOX/.test(instr) ? 'box' : 'field', el: p, legacy: true}); }
    kids(p, 'r').forEach(function(r){
      var ts = kids(r, 't'); if(!ts.length){ if(kids(r, 'tab').length) txt += '\t'; return; }
      ts.forEach(function(t){
        var s = t.textContent, last = 0, re = /_{3,}|[☐□▢❏]/g, m;
        while((m = re.exec(s))){ txt += s.slice(last, m.index); txt += add({kind: m[0][0] === '_' ? 'blank' : 'box', el: t, run: r, match: m[0], at: m.index}); last = m.index + m[0].length; }
        txt += s.slice(last);
      });
    });
    return txt;
  }
  function block(el, inCell){
    Array.prototype.forEach.call(el.childNodes, function(node){
      if(node.namespaceURI !== WNS) return;
      if(node.localName === 'p'){
        var t = para(node);
        if(!t.trim()){ var prev = lines[lines.length - 1]; if(prev && prev.colon && !prev.used){ prev.used = true; var tag = add({kind: 'after', el: node, label: prev.el}); ctx[tag.slice(2, -2)] = prev.t.replace(/\s*\[\[S\d+\]\]$/, ''); lines.push({t: tag, el: node}); return; } lines.push({t: '', el: node}); return; }
        var colon = /:\s*$/.test(t) && t.length < 120 && !/\[\[S\d+\]\]/.test(t);
        var line = colon ? t + ' ' + add({kind: 'inline', el: node}) : t; note(line); lines.push({t: line, el: node, colon: colon});
      } else if(node.localName === 'tbl'){
        var grid = [];
        kids(node, 'tr').forEach(function(tr, ri){
          var cells = kids(tr, 'tc'), row = cells.map(function(tc, ci){
            var inner = kids(tc, 'p').map(function(p){ return para(p); }).join(' / ').trim(), out;
            if(!inner) out = add({kind: 'cell', el: tc, row: ri, col: ci});
            else if(/\[\[S\d+\]\]/.test(inner)) out = inner;
            else if(/:\s*$/.test(inner) || (cells.length <= 2 && ci === 0 && cells.length === 1)) out = inner + ' ' + add({kind: 'cellafter', el: tc, row: ri, col: ci});
            else out = inner;
            note(out); return out;
          });
          grid.push(row); lines.push({t: '| ' + row.join(' | ') + ' |', el: tr});
        });
        tables.push(grid); lines.push({t: '', el: node});
      } else if(node.localName === 'sdt'){ var c = kids(node, 'sdtContent')[0]; if(c) block(c, inCell); }
    });
  }
  block(body, false);
  var usedAfter = new Set(slots.filter(function(s){ return s.kind === 'after'; }).map(function(s){ return s.label; }));
  var finalSlots = slots.filter(function(s){ return !(s.kind === 'inline' && usedAfter.has(s.el)); });
  return {doc: doc, slots: finalSlots, tables: tables, ctx: ctx};
}
function aroundMarker(txt, id){
  var i = txt.indexOf('[[' + id + ']]'); if(i < 0) return {before: '', after: ''};
  var b = txt.slice(0, i), a = txt.slice(i + id.length + 4);
  var pb = b.lastIndexOf(']]'), na = a.search(/\[\[S\d+\]\]/);
  return {before: pb >= 0 ? b.slice(pb + 2) : b, after: na >= 0 ? a.slice(0, na) : a};
}
function docxToFields(r){
  var fields = [], used = new Set(), byId = {};
  r.slots.forEach(function(s){ byId[s.id] = s; });
  var idIn = function(cell){ var m = /^\[\[(S\d+)\]\]$/.exec(String(cell).trim()); return m ? m[1] : null; };
  // rating tables: a heading row of short words over columns of empty cells
  r.tables.forEach(function(grid){
    var hi = grid.findIndex(function(row){ var heads = row.slice(1).filter(function(c){ var t = clean(c); return t && t.length <= 18 && !/\[\[S/.test(c); }); return heads.length >= 2; });
    var head = grid[hi] || [];
    if(hi >= 0) grid.slice(hi + 1).forEach(function(row){
      var opts = [], map = {}, rest = [];
      row.forEach(function(c, ci){ var id = idIn(c); if(!id || ci === 0) return; var h = clean(head[ci] || '');
        if(h && h.length <= 18 && !map[h]){ opts.push(h); map[h] = id; } else rest.push({id: id, h: h}); });
      var label = labelOf(row[0]) || 'Rating';
      if(opts.length >= 2){ fields.push({label: label, type: 'rating', options: opts, tgt: {optSlots: map}, at: +map[opts[0]].slice(1)}); opts.forEach(function(o){ used.add(map[o]); });
        rest.forEach(function(x){ var lb = label + (x.h ? ' - ' + x.h : ''); fields.push({label: lb, type: guessType(lb, false), tgt: {slots: [x.id]}, at: +x.id.slice(1)}); used.add(x.id); }); }
    });
    // "Label:" cell followed by an empty cell: the answer goes in the empty cell
    grid.forEach(function(row){ row.forEach(function(c, ci){ var m = /\[\[(S\d+)\]\]\s*$/.exec(c), nx = row[ci + 1]; if(m && !idIn(c) && nx && idIn(nx) && byId[m[1]] && byId[m[1]].kind === 'cellafter') used.add(m[1]); }); });
    // other empty cells: name them from their row label and column heading
    grid.forEach(function(row, ri){ row.forEach(function(c, ci){ var id = idIn(c); if(!id || used.has(id) || !byId[id]) return;
      var rowLab = labelOf(row.slice(0, ci).reverse().find(function(x){ return clean(x); }) || ''), colLab = ri > 0 ? labelOf(grid[0][ci] || '') : '';
      var lb = rowLab && colLab && rowLab !== colLab ? rowLab + ' - ' + colLab : (rowLab || colLab);
      if(!lb && ri > 0){ var up = labelOf(grid[ri - 1][ci] || ''); lb = up; }
      byId[id].lab = lb; }); });
  });
  // several boxes in one line, each followed by a word: one choice ("☐ Met ☐ Not met")
  var boxesByCtx = {};
  r.slots.forEach(function(s){ if(s.kind === 'box' && !s.legacy && r.ctx[s.id]){ (boxesByCtx[r.ctx[s.id]] = boxesByCtx[r.ctx[s.id]] || []).push(s); } });
  Object.keys(boxesByCtx).forEach(function(txt){
    var bs = boxesByCtx[txt]; if(bs.length < 2) return;
    var opts = bs.map(function(s){ return labelOf(aroundMarker(txt, s.id).after); });
    if(opts.some(function(o){ return !o || o.length > 30; }) || new Set(opts).size !== opts.length) return;
    var map = {}; bs.forEach(function(s, i){ map[opts[i]] = s.id; used.add(s.id); });
    var lb = labelOf(aroundMarker(txt, bs[0].id).before) || 'Choice';
    fields.push({label: lb, type: 'rating', options: opts, tgt: {optSlots: map}, at: +bs[0].id.slice(1)});
  });
  r.slots.forEach(function(s){
    if(used.has(s.id)) return;
    var txt = r.ctx[s.id] || '', ar = aroundMarker(txt, s.id), lb;
    if(s.kind === 'box') lb = labelOf(ar.after) || labelOf(ar.before);
    else if(s.kind === 'cell') lb = s.lab || '';
    else if(s.kind === 'after') lb = labelOf(txt);
    else if(s.kind === 'field' && !s.legacy){ var pr = kids(s.el, 'sdtPr')[0], al = pr && (kids(pr, 'alias')[0] || kids(pr, 'tag')[0]); lb = (al && al.getAttributeNS(WNS, 'val')) || labelOf(ar.before); }
    else lb = labelOf(ar.before) || labelOf(ar.after);
    lb = lb || 'Answer';
    fields.push({label: lb, type: s.kind === 'box' ? 'check' : guessType(lb, s.kind === 'after' && LONG_RE.test(lb)), tgt: {slots: [s.id]}, at: +s.id.slice(1)});
  });
  fields.sort(function(a, b){ return a.at - b.at; });
  fields.forEach(function(f, i){ f.id = 'f' + (i + 1); delete f.at; });
  return fields;
}
async function docxOpen(buf){
  var list = unzipList(buf), e = list.find(function(x){ return x.name === 'word/document.xml'; }); if(!e) throw new Error('No text found in this Word file.');
  var xml = await unzipText(e); return {list: list, xml: xml, r: docxSlots(xml)};
}

/* =========================== a photo or scan becomes a one-page PDF =========================== */
async function imageToPdf(file, buf){
  var lib = await pdflib(), doc = await lib.PDFDocument.create(), img;
  var isPng = /png/i.test(file.type) || /\.png$/i.test(file.name);
  try{ img = isPng ? await doc.embedPng(buf) : await doc.embedJpg(buf); }
  catch(e){
    // other formats (HEIC, WebP...): let the browser decode it, then embed as JPEG
    var bmp = await new Promise(function(res, rej){ var im = new Image(); im.onload = function(){ res(im); }; im.onerror = function(){ rej(new Error('This picture could not be opened. Take a screenshot of it and add that instead.')); }; im.src = URL.createObjectURL(new Blob([buf], {type: file.type || 'image/jpeg'})); });
    var c = document.createElement('canvas'), k = Math.min(1, 2400 / Math.max(bmp.naturalWidth, bmp.naturalHeight)); c.width = Math.round(bmp.naturalWidth * k); c.height = Math.round(bmp.naturalHeight * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    var b = await new Promise(function(res){ c.toBlob(res, 'image/jpeg', 0.9); }); img = await doc.embedJpg(await b.arrayBuffer());
  }
  var w = 612, h = w * img.height / img.width, pg = doc.addPage([w, h]); pg.drawImage(img, {x: 0, y: 0, width: w, height: h});
  return (await doc.save()).buffer;
}

/* =========================== read an added file into a template =========================== */
async function readTemplate(file, onStep){
  var buf = await file.arrayBuffer(), name = file.name || 'form', kind, fields, pages = [], total = 1;
  if(/\.docx$/i.test(name) || /wordprocessingml/.test(file.type)){
    onStep('Reading the Word form...');
    var d = await docxOpen(buf); fields = docxToFields(d.r); kind = 'docx';
  } else if(/\.pdf$/i.test(name) || file.type === 'application/pdf' || /^image\//.test(file.type) || /\.(jpe?g|png|heic|webp)$/i.test(name)){
    if(!/pdf/i.test(file.type) && !/\.pdf$/i.test(name)){ onStep('Turning the picture into a PDF...'); buf = await imageToPdf(file, buf); name = name.replace(/\.[^.]+$/, '') + '.pdf'; }
    onStep('Looking for form fields...');
    var acro = await acroFields(buf);
    var rd = await readPdf(buf, !acro, function(i, n){ onStep('Reading page ' + i + ' of ' + n + '...'); });
    pages = rd.pages; total = rd.total;
    if(acro){ kind = 'acro'; fields = acroToFields(acro, pages); }
    else { kind = rd.pages.some(function(p){ return p.hasText; }) ? 'flat' : 'scan'; fields = slotsToFields(pages); }
  } else throw new Error('Add a PDF, a Word (.docx) file, or a photo of the form.');
  return {buf: buf, name: name, kind: kind, fields: fields, pages: pages, total: total};
}

/* =========================== writing the answers into the file =========================== */
function isSig(v){ return typeof v === 'string' && v.indexOf('data:image/png;base64,') === 0; }
function sigBytes(v){ var b = atob(v.slice(v.indexOf(',') + 1)), u = new Uint8Array(b.length); for(var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function pngSize(u){ var dv = new DataView(u.buffer, u.byteOffset, u.byteLength); return {w: dv.getUint32(16), h: dv.getUint32(20)}; }
function fitSig(iw, ih, box){ var k = Math.min(box.w * 0.96 / iw, box.h / ih); return {x: box.x + 2, y: box.y + 1, width: iw * k, height: ih * k}; }
function shown(f, v){
  if(v == null || v === false || v === '') return '';
  if(f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)){ var p = v.split('-'); return p[1] + '/' + p[2] + '/' + p[0]; }
  if(f.type === 'check') return v ? 'yes' : '';
  return String(v);
}
function hasValue(f, v){ return f.type !== 'skip' && v != null && v !== '' && v !== false; }

function withComments(tpl, values){
  if(!tpl.commentsTo) return values;
  var cs = itemComments(tpl, values); if(!cs.length) return values;
  var v = Object.assign({}, values), base = String(v[tpl.commentsTo] || '').trim();
  v[tpl.commentsTo] = (base ? base + '\n' : '') + cs.map(function(c){ return c.label + (c.rating ? ' (' + c.rating + ')' : '') + ': ' + c.text; }).join('\n');
  Object.keys(v).forEach(function(k){ if(/__c$/.test(k)) delete v[k]; });
  return v;
}
async function fillPdf(tpl, buf, values, opts){
  values = withComments(tpl, values);
  var lib = await pdflib(), doc = await lib.PDFDocument.load(buf.slice(0), {ignoreEncryption: true});
  var font = await doc.embedFont(lib.StandardFonts.Helvetica), ink = lib.rgb(0.05, 0.12, 0.42), pages = doc.getPages();
  var form = null; try{ form = doc.getForm(); }catch(e){}
  var filled = 0, missed = [], overflow = [], MIN = 6.5;
  var geo = function(b){ var g = tpl.pages[b.page - 1]; return g ? toPdfRect(g, b) : null; };
  var wrap = function(t, size, width){ var out = []; latin(t).split('\n').forEach(function(par){ var line = ''; par.split(' ').forEach(function(w){ var test = line ? line + ' ' + w : w; if(font.widthOfTextAtSize(test, size) > width && line){ out.push(line); line = w; } else line = test; }); out.push(line); }); return out; };
  var mark = function(b){ var r = geo(b), pg = pages[b.page - 1]; if(!r || !pg) return; var sz = Math.max(6, Math.min(12, Math.min(r.h, r.w) * 0.8)), w = font.widthOfTextAtSize('X', sz);
    pg.drawText('X', {x: r.x + (r.w - w) / 2, y: r.y + (r.h - sz * 0.72) / 2, size: sz, font: font, color: ink}); };
  var drawSig = async function(b, v, onLine){ var r = geo(b), pg = pages[b.page - 1]; if(!r || !pg) return false; var im = await doc.embedPng(sigBytes(v));
    pg.drawImage(im, fitSig(im.width, im.height, {x: r.x, y: r.y, w: Math.min(r.w, 230), h: onLine ? Math.min(Math.max(r.h, 30), 40) : Math.min(r.h, 48)})); return true; };
  var drawText = function(f, bs, v){
    var rs = bs.map(function(b){ return {b: b, r: geo(b)}; }).filter(function(x){ return x.r && pages[x.b.page - 1]; }); if(!rs.length) return;
    var pad = 1.5, size = Math.min(10, Math.max(MIN, Math.min.apply(null, rs.map(function(x){ return x.r.h - 2 * pad; })) * 0.85)), lines;
    var cap = function(sz){ return rs.reduce(function(a, x){ return a + Math.max(1, Math.floor((x.r.h - 2 * pad) / (sz * 1.18))); }, 0); };
    var width = Math.min.apply(null, rs.map(function(x){ return x.r.w - 2 * pad; }));
    for(;;){ lines = wrap(v, size, width); if(lines.length <= cap(size) || size <= MIN) break; size -= 0.5; }
    var li = 0;
    rs.forEach(function(x){ var r = x.r, pg = pages[x.b.page - 1], n = Math.max(1, Math.floor((r.h - 2 * pad) / (size * 1.18)));
      var y = r.y + r.h - pad - size; if(n === 1) y = r.y + (r.h - size) / 2 + size * 0.18;
      for(var k = 0; k < n && li < lines.length; k++, li++){ pg.drawText(lines[li], {x: r.x + pad, y: y, size: size, font: font, color: ink}); y -= size * 1.18; } });
    if(li < lines.length) overflow.push({label: f.label, rest: lines.slice(li).join(' ')});
  };
  for(var i = 0; i < tpl.fields.length; i++){
    var f = tpl.fields[i], v = values[f.id], t = f.tgt; if(!hasValue(f, v)) continue;
    try{
      if(t.acro || t.acroMap || t.radio || t.acroPick){
        if(!form) throw new Error('no form');
        if(t.acroMap){ Object.keys(t.acroMap).forEach(function(o){ var cb = form.getCheckBox(t.acroMap[o]); if(o === v) cb.check(); else cb.uncheck(); }); filled++; continue; }
        if(t.radio){ var rv = t.vals && t.vals[v]; if(rv == null){ missed.push(f.label); continue; } form.getRadioGroup(t.radio).select(rv); filled++; continue; }
        var fld = form.getField(t.acro || t.acroPick), ty = ftype(lib, fld);
        if(isSig(v)){ var ws = fld.acroField.getWidgets(), im = await doc.embedPng(sigBytes(v));
          ws.forEach(function(w){ var r = w.getRectangle(); pages[widgetPageIndex(doc, w)].drawImage(im, fitSig(im.width, im.height, {x: r.x, y: r.y, w: r.width, h: r.height})); });
          try{ form.removeField(fld); }catch(e){} filled++; continue; }
        if(ty === 'checkbox'){ if(v) fld.check(); else fld.uncheck(); filled++; continue; }
        if(ty === 'dropdown' || ty === 'list'){ var o = fld.getOptions().find(function(o){ return String(o) === String(v); }); if(o != null){ fld.select(o); filled++; } else missed.push(f.label); continue; }
        if(ty === 'text'){ var s = latin(shown(f, v)); try{ fld.setText(s); }catch(e){ var ml = 0; try{ ml = fld.getMaxLength() || 0; }catch(_){} fld.setText(ml ? s.slice(0, ml) : s); } filled++; continue; }
        missed.push(f.label); continue;
      }
      if(t.optSlots){ var b = t.optSlots[v]; if(b){ mark(b); filled++; } else missed.push(f.label); continue; }
      var bs = t.slots || []; if(!bs.length) continue;
      if(isSig(v)){ var big = bs.reduce(function(a, c){ return c.w * c.h > a.w * a.h ? c : a; }); if(await drawSig(big, v, big.kind === 'line' || big.kind === 'gap' || big.kind === 'manual')) filled++; continue; }
      if(f.type === 'check'){ mark(bs[0]); filled++; continue; }
      drawText(f, bs, shown(f, v)); filled++;
    }catch(e){ missed.push(f.label); }
  }
  if(form){ try{ form.updateFieldAppearances(font); }catch(e){} if(opts && opts.flatten){ try{ form.flatten(); }catch(e){} } }
  if(overflow.length){
    var sz = pages[0].getSize(), pg = doc.addPage([sz.width, sz.height]), y = sz.height - 54, bold = await doc.embedFont(lib.StandardFonts.HelveticaBold);
    var put2 = function(t, b, s){ wrap(t, s, sz.width - 108).forEach(function(l){ if(y < 54){ pg = doc.addPage([sz.width, sz.height]); y = sz.height - 54; } pg.drawText(l, {x: 54, y: y, size: s, font: b ? bold : font, color: ink}); y -= s * 1.3; }); };
    put2('Continued (answers that did not fit in their box)', true, 12); y -= 6;
    overflow.forEach(function(o){ put2(o.label + ' (continued)', true, 10); put2(o.rest, false, 10); y -= 8; });
  }
  await addCommentPagesPdf(doc, lib, itemComments(tpl, values), pages[0].getSize());
  return {bytes: await doc.save(), filled: filled, missed: missed, overflow: overflow.length};
}

/* Word */
function rPrOf(el){ var r = el && (el.localName === 'r' ? el : wq(el, 'r')[0]), rp = r && kids(r, 'rPr')[0]; if(rp) return rp; var pp = el && wq(el, 'pPr')[0], mrp = pp && kids(pp, 'rPr')[0]; return mrp || null; }
function mkRun(doc, text, rPr, plain){
  var r = doc.createElementNS(WNS, 'w:r');
  if(rPr){ var c = rPr.cloneNode(true); if(c.localName !== 'rPr'){ var x = doc.createElementNS(WNS, 'w:rPr'); Array.prototype.forEach.call(c.childNodes, function(k){ x.appendChild(k.cloneNode(true)); }); r.appendChild(x); } else r.appendChild(c);
    if(plain){ var rp = kids(r, 'rPr')[0]; ['b', 'bCs', 'i', 'caps'].forEach(function(n){ kids(rp, n).forEach(function(x){ rp.removeChild(x); }); }); } }
  String(text).split('\n').forEach(function(ln, i){ if(i) r.appendChild(doc.createElementNS(WNS, 'w:br')); var t = doc.createElementNS(WNS, 'w:t'); t.setAttribute('xml:space', 'preserve'); t.textContent = ln; r.appendChild(t); });
  return r;
}
function writeDocx(doc, s, v){
  if(s.kind === 'cell'){ var p = kids(s.el, 'p')[0]; if(!p){ p = doc.createElementNS(WNS, 'w:p'); s.el.appendChild(p); } var rp = rPrOf(p) || rPrOf(s.el.parentNode); kids(p, 'r').forEach(function(r){ p.removeChild(r); }); p.appendChild(mkRun(doc, v, rp, true)); }
  else if(s.kind === 'cellafter'){ var ps = kids(s.el, 'p'), last = ps[ps.length - 1], np = doc.createElementNS(WNS, 'w:p'), pp = kids(last, 'pPr')[0]; if(pp) np.appendChild(pp.cloneNode(true)); np.appendChild(mkRun(doc, v, rPrOf(last), true)); s.el.appendChild(np); }
  else if(s.kind === 'after'){ var rp2 = rPrOf(s.el) || rPrOf(s.label); kids(s.el, 'r').forEach(function(r){ s.el.removeChild(r); }); s.el.appendChild(mkRun(doc, v, rp2, true)); }
  else if(s.kind === 'inline'){ var rs = kids(s.el, 'r'); s.el.appendChild(mkRun(doc, ' ' + v, rPrOf(rs[rs.length - 1] || s.el), true)); }
  else if(s.kind === 'blank'){
    var t = s.el, r = s.run, full = t.textContent, i = full.substr(s.at, s.match.length) === s.match ? s.at : full.indexOf(s.match); if(i < 0) return;
    var before = full.slice(0, i), after = full.slice(i + s.match.length), rp3 = kids(r, 'rPr')[0], mid = mkRun(doc, v, rp3, true);
    var mrp = kids(mid, 'rPr')[0] || mid.insertBefore(doc.createElementNS(WNS, 'w:rPr'), mid.firstChild);
    if(!kids(mrp, 'u').length){ var u = doc.createElementNS(WNS, 'w:u'); u.setAttributeNS(WNS, 'w:val', 'single'); mrp.appendChild(u); }
    t.textContent = before; t.setAttribute('xml:space', 'preserve');
    var tail = mkRun(doc, after, rp3); r.parentNode.insertBefore(mid, r.nextSibling); mid.parentNode.insertBefore(tail, mid.nextSibling);
  }
  else if(s.kind === 'field'){
    if(s.legacy){ var rs2 = kids(s.el, 'r'), on = false, done = false;
      rs2.forEach(function(r){ var fc = kids(r, 'fldChar')[0], ty = fc && fc.getAttributeNS(WNS, 'fldCharType'); if(ty === 'separate'){ on = true; return; } if(ty === 'end'){ on = false; return; }
        if(on) kids(r, 't').forEach(function(t){ t.textContent = done ? '' : v.replace(/\n/g, ' '); done = true; }); });
      if(!done){ var sep = rs2.find(function(r){ var fc = kids(r, 'fldChar')[0]; return fc && fc.getAttributeNS(WNS, 'fldCharType') === 'separate'; }); if(sep) sep.parentNode.insertBefore(mkRun(doc, v.replace(/\n/g, ' '), kids(sep, 'rPr')[0]), sep.nextSibling); }
    } else { var c = kids(s.el, 'sdtContent')[0]; if(!c) return; var host = wq(c, 'p')[0] || c, rr = wq(c, 'r'), rp4 = rr[0] && kids(rr[0], 'rPr')[0];
      rr.forEach(function(r){ r.parentNode.removeChild(r); }); host.appendChild(mkRun(doc, v, rp4)); var sp = kids(s.el, 'sdtPr')[0]; if(sp) kids(sp, 'showingPlcHdr').forEach(function(x){ sp.removeChild(x); }); }
  }
}
function checkDocx(doc, s){
  if(s.legacy){ wq(s.el, 'checkBox').forEach(function(cb){ ['default', 'checked'].forEach(function(nm){ var d = kids(cb, nm)[0]; if(!d){ d = doc.createElementNS(WNS, 'w:' + nm); cb.appendChild(d); } d.setAttributeNS(WNS, 'w:val', '1'); }); }); return; }
  var s0 = s.el.textContent; s.el.textContent = s0.slice(0, s.at) + '☒' + s0.slice(s.at + 1);
}
var SIG_EMU = 914400;
function sigRunXml(rid, n, iw, ih){
  var k = Math.min(1.9 * SIG_EMU / iw, 0.6 * SIG_EMU / ih), cx = Math.round(iw * k), cy = Math.round(ih * k);
  return '<w:r xmlns:w="' + WNS + '" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + (7100 + n) + '" name="Signature ' + (n + 1) + '"/>' +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + (7100 + n) + '" name="signature' + (n + 1) + '.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}
function placeRun(doc, s, run){
  if(s.kind === 'cell'){ var p = kids(s.el, 'p')[0]; if(!p){ p = doc.createElementNS(WNS, 'w:p'); s.el.appendChild(p); } kids(p, 'r').forEach(function(r){ p.removeChild(r); }); p.appendChild(run); }
  else if(s.kind === 'cellafter'){ var ps = kids(s.el, 'p'), last = ps[ps.length - 1], np = doc.createElementNS(WNS, 'w:p'), pp = kids(last, 'pPr')[0]; if(pp) np.appendChild(pp.cloneNode(true)); np.appendChild(run); s.el.appendChild(np); }
  else if(s.kind === 'after'){ kids(s.el, 'r').forEach(function(r){ s.el.removeChild(r); }); s.el.appendChild(run); }
  else if(s.kind === 'inline'){ s.el.appendChild(run); }
  else if(s.kind === 'blank'){ var t = s.el, r = s.run, full = t.textContent, i = full.substr(s.at, s.match.length) === s.match ? s.at : full.indexOf(s.match); if(i < 0) return;
    var after = full.slice(i + s.match.length); t.textContent = full.slice(0, i); t.setAttribute('xml:space', 'preserve'); r.parentNode.insertBefore(run, r.nextSibling);
    if(after){ run.parentNode.insertBefore(mkRun(doc, after, kids(r, 'rPr')[0]), run.nextSibling); } }
  else if(s.kind === 'field' && !s.legacy){ var c = kids(s.el, 'sdtContent')[0]; if(!c) return; var host = wq(c, 'p')[0] || c; wq(c, 'r').forEach(function(r){ r.parentNode.removeChild(r); }); host.appendChild(run); }
}
async function fillDocxFile(tpl, buf, values){
  values = withComments(tpl, values);
  var d = await docxOpen(buf), r = d.r, list = d.list, byId = {}, rep = {}, add = {}, sigRuns = {}, filled = 0, missed = [];
  r.slots.forEach(function(s){ byId[s.id] = s; });
  var sigs = tpl.fields.filter(function(f){ return isSig(values[f.id]) && f.tgt && ((f.tgt.slots && f.tgt.slots.length) || f.tgt.dx); });
  var relE = list.find(function(x){ return x.name === 'word/_rels/document.xml.rels'; }), ctE = list.find(function(x){ return x.name === '[Content_Types].xml'; });
  if(sigs.length && relE && ctE){
    var rels = await unzipText(relE), ct = await unzipText(ctE);
    sigs.forEach(function(f, n){ var bytes = sigBytes(values[f.id]), sz = pngSize(bytes), rid = 'rIdApSig' + (n + 1), nm = 'media/anespilot-signature' + (n + 1) + '.png';
      add['word/' + nm] = bytes;
      rels = rels.replace('</Relationships>', '<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + nm + '"/></Relationships>');
      sigRuns[f.id] = r.doc.importNode(new DOMParser().parseFromString(sigRunXml(rid, n, sz.w, sz.h), 'application/xml').documentElement, true); });
    if(!/Extension="png"/i.test(ct)) ct = ct.replace(/<Types[^>]*>/, function(m){ return m + '<Default Extension="png" ContentType="image/png"/>'; });
    rep['word/_rels/document.xml.rels'] = rels; rep['[Content_Types].xml'] = ct;
  }
  var ops = [];
  // hand-mapped fields (school forms) first: they address cells and paragraphs directly
  tpl.fields.forEach(function(f){
    var v = values[f.id]; if(!f.tgt || !f.tgt.dx || !hasValue(f, v) || isSig(v)) return;
    var txt = f.type === 'check' ? (f.tgt.dx.text || 'Yes') : shown(f, v);
    if(dxWrite(r.doc, f.tgt.dx, txt)) filled++; else missed.push(f.label);
  });
  tpl.fields.forEach(function(f){
    var v = values[f.id], t = f.tgt; if(!t || t.dx || !hasValue(f, v)) return;
    if(t.optSlots){ var s = byId[t.optSlots[v]]; if(!s){ missed.push(f.label); return; } ops.push(s.kind === 'box' ? [s, null] : [s, 'X']); filled++; return; }
    var ss = (t.slots || []).map(function(id){ return byId[id]; }).filter(Boolean); if(!ss.length){ missed.push(f.label); return; }
    if(isSig(v)){ if(sigRuns[f.id]){ ops.push([ss[0], {run: sigRuns[f.id]}]); filled++; } return; }  // dx signatures are placed below
    if(ss[0].kind === 'box' || f.type === 'check'){ ops.push(ss[0].kind === 'box' ? [ss[0], null] : [ss[0], 'X']); filled++; return; }
    var val = shown(f, v);
    if(ss.length === 1) ops.push([ss[0], val]);
    else { var parts = val.split('\n'); ss.forEach(function(s, i){ ops.push([s, i < ss.length - 1 ? (parts[i] || '') : parts.slice(i).join(' ')]); }); }
    filled++;
  });
  // last slot first, so two blanks in one line both keep their place
  ops.sort(function(a, b){ return +b[0].id.slice(1) - +a[0].id.slice(1); }).forEach(function(o){ if(o[1] === null) checkDocx(r.doc, o[0]); else if(typeof o[1] === 'object') placeRun(r.doc, o[0], o[1].run); else writeDocx(r.doc, o[0], o[1]); });
  tpl.fields.forEach(function(f){ var v = values[f.id]; if(!f.tgt || !f.tgt.dx || !isSig(v) || !sigRuns[f.id]) return;
    var ok = dxWrite(r.doc, f.tgt.dx, '\u0000'); if(!ok){ missed.push(f.label); return; }
    var hole = wq(r.doc, 't').find(function(x){ return x.textContent.indexOf('\u0000') !== -1; }); if(hole){ var hr = hole.parentNode; hr.parentNode.replaceChild(sigRuns[f.id], hr); filled++; } });
  addCommentParasDocx(r.doc, itemComments(tpl, values));
  rep['word/document.xml'] = new XMLSerializer().serializeToString(r.doc);
  return {bytes: zipWith(list, rep, add), filled: filled, missed: missed, overflow: 0};
}

/* =========================== built-in form: daily evaluation on the COA graduate competencies (Standard D) ===========================
   Wording from the COA "Standards for Accreditation of Nurse Anesthesia Programs - Practice Doctorate", Standard D: Graduate Standards
   (revised May 2025, effective January 1, 2026). Only the competencies a preceptor can observe in a clinical day are rated:
   D12 (ACLS/PALS), D24 (NCE) and D39-D50 (wellness content, policy, scholarship, informatics, business) are program-level. */
var COA_ID = 'ap_coa_d';
var COA_SCALE = ['Above', 'Meets', 'Below', 'N/O'];
var COA_SCALE_LONG = {Above: 'Above expectations', Meets: 'Meets expectations', Below: 'Below expectations', 'N/O': 'Not observed'};
var COA_D = [
  ['Patient Safety', [
    [1, 'Be vigilant in the delivery of patient care.'],
    [2, 'Refrain from engaging in extraneous activities that abandon or minimize vigilance while providing direct patient care (e.g., texting, reading, emailing, etc.).'],
    [3, 'Conduct a comprehensive equipment check.'],
    [4, 'Protect patients from iatrogenic complications.']]],
  ['Perianesthesia', [
    [5, 'Provide individualized care throughout the perianesthesia continuum.'],
    [6, 'Deliver culturally competent perianesthesia care.'],
    [7, 'Provide anesthesia services to all patients across the lifespan.'],
    [8, 'Perform a comprehensive history and physical assessment.'],
    [9, 'Administer general anesthesia to patients with a variety of physical conditions.'],
    [10, 'Administer general anesthesia for a variety of surgical and medically related procedures.'],
    [11, 'Administer and manage a variety of regional anesthetics.']]],
  ['Critical Thinking', [
    [13, 'Apply knowledge to practice in decision making and problem solving.'],
    [14, 'Provide nurse anesthesia services based on evidence-based principles.'],
    [15, 'Perform a preanesthetic assessment before providing anesthesia services.'],
    [16, 'Assume responsibility and accountability for diagnosis.'],
    [17, 'Formulate an anesthesia plan of care before providing anesthesia services.'],
    [18, 'Identify and take appropriate action when confronted with anesthetic equipment-related malfunctions.'],
    [19, 'Interpret and utilize data obtained from noninvasive and invasive monitoring modalities.'],
    [20, 'Calculate, initiate, and manage fluid and blood component therapy.'],
    [21, 'Recognize, evaluate, and manage the physiological responses coincident to the provision of anesthesia services.'],
    [22, 'Recognize and appropriately manage complications that occur during the provision of anesthesia services.'],
    [23, 'Use science-based theories and concepts to analyze new practice approaches.']]],
  ['Communication', [
    [25, 'Utilize interpersonal and communication skills that result in the effective exchange of information and collaboration with patients and their families.'],
    [26, 'Utilize interpersonal and communication skills that result in the effective interprofessional exchange of information and collaboration with other healthcare professionals.'],
    [27, 'Respect the dignity and privacy of patients while maintaining confidentiality in the delivery of interprofessional care.'],
    [28, 'Maintain comprehensive, timely, accurate, and legible healthcare records.'],
    [29, 'Transfer the responsibility for care of the patient to other qualified providers in a manner that assures continuity of care and patient safety.'],
    [30, 'Teach others.']]],
  ['Leadership', [
    [31, 'Integrate critical thinking and self-reflection in one\'s approach to leadership.'],
    [32, 'Provide leadership that facilitates intraprofessional and interprofessional collaboration.']]],
  ['Professional Role', [
    [33, 'Adhere to the Code of Ethics for the Certified Registered Nurse Anesthetist.'],
    [34, 'Interact on a professional level with integrity.'],
    [35, 'Apply ethically sound decision-making processes.'],
    [36, 'Function within legal and regulatory requirements.'],
    [37, 'Accept responsibility and accountability for one\'s practice.'],
    [38, 'Understand the importance of providing cost-effective anesthesia services.']]]
];
var COA_TPL = null;
function coaTemplate(){
  if(COA_TPL) return COA_TPL;
  var F = [], add = function(f){ F.push(f); };
  var S0 = 'About this evaluation';
  add({id: 'student', label: 'Student (SRNA) name', type: 'text', section: S0, who: 'student'});
  add({id: 'preceptor', label: 'Preceptor name and credentials', type: 'text', section: S0, who: 'student'});
  add({id: 'date', label: 'Date', type: 'date', section: S0, who: 'student'});
  add({id: 'site', label: 'Clinical site', type: 'text', section: S0, who: 'student'});
  add({id: 'level', label: 'Clinical level', type: 'rating', options: ['Novice', 'Intermediate', 'Advanced', 'Senior'], section: S0, who: 'student'});
  add({id: 'cases', label: 'Cases and procedures today (no patient identifiers)', type: 'long', section: S0, who: 'student'});
  COA_D.forEach(function(sec){ sec[1].forEach(function(it){
    add({id: 'd' + it[0], code: 'D' + it[0], label: it[1], type: 'rating', options: COA_SCALE.slice(), section: sec[0], comment: true, who: 'preceptor'});
  }); });
  var S9 = 'Summary and signatures';
  add({id: 'overall', label: 'Overall performance today', type: 'rating', options: ['Above', 'Meets', 'Below'], section: S9, comment: true, who: 'preceptor', badge: true});
  add({id: 'strengths', label: 'Strengths', type: 'long', section: S9, who: 'preceptor', badge: true});
  add({id: 'improve', label: 'Areas to improve and goals for next time', type: 'long', section: S9, who: 'preceptor', badge: true});
  add({id: 'reflect', label: 'Student self-reflection', type: 'long', section: S9, who: 'student', badge: true});
  add({id: 'sig_preceptor', label: 'Preceptor signature', type: 'signature', section: S9, who: 'preceptor', badge: true});
  add({id: 'sig_student', label: 'Student signature', type: 'signature', section: S9, who: 'student', badge: true});
  COA_TPL = {id: COA_ID, name: 'Daily Clinical Evaluation (COA Standard D)', kind: 'builtin', builtin: true, fileName: 'AnesPilot form', fields: F, pages: [],
    quick: {opt: 'Meets', label: 'Meets'}, legend: COA_SCALE.map(function(s){ return [s, COA_SCALE_LONG[s]]; }),
    note: 'Graduate competencies from the COA Standards for Accreditation of Nurse Anesthesia Programs - Practice Doctorate, Standard D (effective January 1, 2026).'};
  return COA_TPL;
}

/* the built-in form as a PDF, made on the device */
async function builtinPdf(tpl, values){
  var lib = await pdflib(), doc = await lib.PDFDocument.create();
  var R = await doc.embedFont(lib.StandardFonts.Helvetica), B = await doc.embedFont(lib.StandardFonts.HelveticaBold), I = await doc.embedFont(lib.StandardFonts.HelveticaOblique);
  var ink = lib.rgb(0.1, 0.12, 0.16), mute = lib.rgb(0.42, 0.46, 0.53), blue = lib.rgb(0.05, 0.12, 0.42), line = lib.rgb(0.8, 0.83, 0.88), band = lib.rgb(0.93, 0.95, 0.97);
  var W = 612, H = 792, M = 40, pg, y, pageNo = 0, filled = 0;
  var wrap = function(t, f, s, w){ var out = []; latin(t).split('\n').forEach(function(par){ var l = ''; par.split(' ').forEach(function(wd){ var tt = l ? l + ' ' + wd : wd; if(f.widthOfTextAtSize(tt, s) > w && l){ out.push(l); l = wd; } else l = tt; }); out.push(l); }); return out; };
  var newPage = function(){ pg = doc.addPage([W, H]); pageNo++; y = H - M;
    pg.drawText(latin(tpl.name) + (pageNo > 1 ? ' (continued)' : ''), {x: M, y: H - 24, size: 7.5, font: R, color: mute});
    pg.drawText('Page ' + pageNo, {x: W - M - R.widthOfTextAtSize('Page ' + pageNo, 7.5), y: 20, size: 7.5, font: R, color: mute}); };
  var need = function(h){ if(y - h < M + 10) newPage(); };
  var text = function(t, f, s, x, c){ pg.drawText(latin(t), {x: x, y: y, size: s, font: f, color: c || ink}); };
  var para = function(t, f, s, x, w, c, lh){ wrap(t, f, s, w).forEach(function(l){ need(s * (lh || 1.3)); text(l, f, s, x, c); y -= s * (lh || 1.3); }); };
  var v = function(id){ var x = values[id]; return x == null ? '' : x; };
  var F = {}; tpl.fields.forEach(function(f){ F[f.id] = f; });
  newPage();
  text('Daily Clinical Evaluation', B, 17, M); y -= 16;
  para('Student Registered Nurse Anesthetist. Competencies from the COA Standards for Accreditation of Nurse Anesthesia Programs - Practice Doctorate, Standard D: Graduate Standards (effective January 1, 2026).', R, 8, M, W - 2 * M, mute); y -= 6;
  // the facts of the day
  var info = [['Student', v('student')], ['Preceptor', v('preceptor')], ['Date', shown({type: 'date'}, v('date'))], ['Clinical site', v('site')], ['Clinical level', v('level')]];
  var colW = (W - 2 * M) / 2;
  for(var i = 0; i < info.length; i += 2){ need(30);
    [info[i], info[i + 1]].forEach(function(p, k){ if(!p) return; var x = M + k * colW;
      pg.drawText(p[0].toUpperCase(), {x: x, y: y, size: 6.5, font: B, color: mute});
      pg.drawText(latin(p[1] || ' ').slice(0, 60), {x: x, y: y - 12, size: 10, font: R, color: blue});
      pg.drawLine({start: {x: x, y: y - 15}, end: {x: x + colW - 12, y: y - 15}, thickness: 0.5, color: line}); if(p[1]) filled++; });
    y -= 26; }
  if(v('cases')){ need(24); pg.drawText('CASES AND PROCEDURES', {x: M, y: y, size: 6.5, font: B, color: mute}); y -= 11; para(v('cases'), R, 9, M, W - 2 * M, blue); filled++; y -= 4; }
  // scale
  need(22); y -= 4;
  text('Scale: ' + COA_SCALE.map(function(s){ return s + ' = ' + COA_SCALE_LONG[s]; }).join('    '), R, 7.5, M, mute); y -= 14;
  // the competencies, section by section
  var boxX = W - M - COA_SCALE.length * 34, textW = boxX - M - 30;
  COA_D.forEach(function(sec){
    need(40);
    pg.drawRectangle({x: M, y: y - 5, width: W - 2 * M, height: 17, color: band});
    text(sec[0], B, 10, M + 5);
    COA_SCALE.forEach(function(s, k){ var cx = boxX + k * 34 + 17; pg.drawText(s, {x: cx - B.widthOfTextAtSize(s, 7) / 2, y: y, size: 7, font: B, color: ink}); });
    y -= 20;
    sec[1].forEach(function(it){
      var id = 'd' + it[0], lines = wrap(it[1], R, 8.5, textW), com = v(id + '__c'), cl = com ? wrap('Comment: ' + com, I, 8, textW + COA_SCALE.length * 34 - 4) : [];
      var hRow = Math.max(lines.length * 11, 14) + (cl.length ? cl.length * 10.5 + 3 : 0) + 6;
      need(hRow);
      var top = y;
      pg.drawText('D' + it[0], {x: M, y: y, size: 8.5, font: B, color: ink});
      lines.forEach(function(l, k){ pg.drawText(l, {x: M + 26, y: y - k * 11, size: 8.5, font: R, color: ink}); });
      var val = v(id);
      COA_SCALE.forEach(function(s, k){ var bx = boxX + k * 34 + 11, by = top - 2;
        pg.drawRectangle({x: bx, y: by, width: 11, height: 11, borderColor: lib.rgb(0.45, 0.5, 0.58), borderWidth: 0.8});
        if(val === s){ pg.drawText('X', {x: bx + 2.2, y: by + 2, size: 9, font: B, color: blue}); } });
      if(val) filled++;
      y -= Math.max(lines.length * 11, 14);
      if(cl.length){ y -= 1; cl.forEach(function(l){ pg.drawText(l, {x: M + 26, y: y, size: 8, font: I, color: blue}); y -= 10.5; }); y -= 3; filled++; }
      pg.drawLine({start: {x: M, y: y + 3}, end: {x: W - M, y: y + 3}, thickness: 0.4, color: line}); y -= 5;
    });
    y -= 6;
  });
  // summary
  need(60); pg.drawRectangle({x: M, y: y - 5, width: W - 2 * M, height: 17, color: band}); text('Summary', B, 10, M + 5); y -= 22;
  text('Overall performance today: ', B, 9, M);
  var ov = v('overall'); text(ov ? COA_SCALE_LONG[ov] || ov : 'Not rated', R, 9, M + B.widthOfTextAtSize('Overall performance today: ', 9), ov ? blue : mute); if(ov) filled++; y -= 14;
  if(v('overall__c')){ para('Comment: ' + v('overall__c'), I, 8.5, M, W - 2 * M, blue); filled++; }
  [['strengths', 'Strengths'], ['improve', 'Areas to improve and goals for next time'], ['reflect', 'Student self-reflection']].forEach(function(p){
    need(34); y -= 4; text(p[1], B, 9, M); y -= 13;
    if(v(p[0])){ para(v(p[0]), R, 9, M, W - 2 * M, blue); filled++; } else { pg.drawLine({start: {x: M, y: y}, end: {x: W - M, y: y}, thickness: 0.5, color: line}); y -= 14; }
  });
  // signatures
  need(96); y -= 10;
  var sigs = [['sig_preceptor', 'Preceptor signature', v('preceptor')], ['sig_student', 'Student signature', v('student')]], sw = (W - 2 * M - 24) / 2;
  for(var s = 0; s < sigs.length; s++){
    var x = M + s * (sw + 24), sv = v(sigs[s][0]), base = y - 52;
    if(isSig(sv)){ try{ var im = await doc.embedPng(sigBytes(sv)), k = Math.min((sw - 10) / im.width, 46 / im.height); pg.drawImage(im, {x: x + 4, y: base + 3, width: im.width * k, height: im.height * k}); filled++; }catch(e){} }
    pg.drawLine({start: {x: x, y: base}, end: {x: x + sw, y: base}, thickness: 0.8, color: ink});
    pg.drawText(sigs[s][1] + (sigs[s][2] ? ' - ' + latin(sigs[s][2]).slice(0, 40) : ''), {x: x, y: base - 11, size: 7.5, font: R, color: mute});
    pg.drawText('Date: ' + (shown({type: 'date'}, v('date')) || '__________'), {x: x, y: base - 21, size: 7.5, font: R, color: mute});
  }
  y -= 80;
  return {bytes: await doc.save(), filled: filled, missed: [], overflow: 0};
}

/* =========================== built-in form: anesthesia care plan, organized by the COA graduate standards it supports ===========================
   The COA does not publish an official care plan template. This plan is built so a completed plan documents the Standard D
   competencies a care plan shows: D5 individualized care, D8 history and physical, D15 preanesthetic assessment, D17 plan of care,
   D14 evidence-based practice, D20 fluid and blood therapy, D4 and D22 complications, D29 handoff, D31 self-reflection. */
var ACP_ID = 'ap_coa_acp';
var ACP_TPL = null;
function acpTemplate(){
  if(ACP_TPL) return ACP_TPL;
  var F = [], sec = '', add = function(id, label, type, extra){ F.push(Object.assign({id: id, label: label, type: type, section: sec}, extra || {})); };
  var S = function(x){ sec = x; };
  var short = {short: true}, num = {short: true, num: true};
  S('Case');
  add('student', 'Student (SRNA) name', 'text', short); add('preceptor', 'Preceptor', 'text', short); add('date', 'Date of case', 'date', short); add('site', 'Facility', 'text', short);
  add('procedure', 'Procedure', 'text'); add('preop_dx', 'Preoperative diagnosis', 'text');
  add('hx_events', 'Brief history of events leading to surgery', 'long');
  add('anes_type', 'Planned anesthetic', 'rating', {options: ['General', 'MAC', 'Regional', 'Neuraxial', 'Combined']});
  S('Patient assessment');
  add('age', 'Age', 'text', num); add('sex', 'Sex', 'rating', {options: ['Female', 'Male', 'Other']});
  add('height', 'Height', 'text', num); add('weight', 'Weight', 'text', num); add('bmi', 'BMI', 'text', num);
  add('asa', 'ASA physical status', 'rating', {options: ['I', 'II', 'III', 'IV', 'V', 'VI']}); add('asa_e', 'Emergency (E)', 'check');
  add('setting', 'Setting', 'rating', {options: ['Inpatient', 'Outpatient']});
  add('npo', 'NPO since', 'text', short); add('allergies', 'Allergies (reaction)', 'text');
  add('bp', 'BP', 'text', num); add('hr', 'HR', 'text', num); add('rr', 'RR', 'text', num); add('spo2', 'SpO2', 'text', num); add('temp', 'Temp', 'text', num);
  add('substances', 'Tobacco, alcohol and drug use', 'text');
  S('History and review of systems');
  add('ros_cv', 'Cardiovascular', 'long'); add('ros_pulm', 'Pulmonary', 'long'); add('ros_neuro', 'Neurologic', 'long');
  add('ros_gi', 'GI, hepatic and renal', 'long'); add('ros_endo', 'Endocrine', 'long'); add('ros_heme', 'Hematologic and anticoagulation', 'long'); add('ros_other', 'Other', 'long');
  add('psh', 'Past surgical and anesthesia history (complications?)', 'long'); add('fam', 'Family history of anesthesia complications', 'text');
  add('meds', 'Current medications and anesthetic implications', 'long');
  S('Labs and studies');
  ['Hgb', 'Hct', 'Plt', 'PT/INR', 'PTT', 'Na', 'K', 'Cl', 'CO2', 'BUN', 'Cr', 'Glucose'].forEach(function(l){ add('lab_' + l.replace(/\W/g, '').toLowerCase(), l, 'text', num); });
  add('lab_ts', 'Type and screen / crossmatch', 'text'); add('lab_preg', 'Pregnancy test', 'rating', {options: ['Negative', 'Positive', 'N/A']});
  add('studies', 'ECG, echo, imaging and other studies', 'long');
  S('Airway');
  add('mallampati', 'Mallampati', 'rating', {options: ['I', 'II', 'III', 'IV']}); add('tmd', 'Thyromental distance', 'text', short); add('mouth', 'Mouth opening', 'text', short);
  add('neck', 'Neck range of motion', 'rating', {options: ['Full', 'Limited']}); add('dentition', 'Dentition', 'text');
  add('prior_diff', 'Prior difficult airway', 'rating', {options: ['No', 'Yes', 'Unknown']}); add('airway_plan', 'Airway plan and backup plan', 'long');
  S('Anesthetic plan');
  add('plan_rationale', 'Anesthetic plan and rationale (GA vs regional)', 'long'); add('monitoring', 'Monitoring, lines and equipment (rationale)', 'long');
  add('premed', 'Premedication and antibiotics', 'long'); add('induction', 'Induction', 'long'); add('maintenance', 'Maintenance (agents, IV meds, gas)', 'long');
  add('infusions', 'Infusions', 'long'); add('ventilation', 'Ventilation strategy', 'long'); add('regional', 'Regional or neuraxial technique (approach, drug, dose)', 'long');
  add('emergence', 'Emergence and reversal', 'long');
  S('Fluids and blood');
  add('ebv', 'Estimated blood volume', 'text', short); add('abl', 'Allowable blood loss', 'text', short); add('maint_rate', 'Maintenance rate (4-2-1)', 'text', short);
  add('deficit', 'NPO deficit', 'text', short); add('fluid_plan', 'Fluid and blood replacement plan (crystalloid, colloid, products available)', 'long');
  S('Positioning and patient safety');
  add('position', 'Position', 'text'); add('position_effects', 'Effects of position (skin and joints, nerves, airway, pulmonary, cardiac) and protection', 'long');
  add('specific_care', 'Specific care for this patient and procedure (warming, BIS, eye protection...)', 'long');
  S('Complications');
  add('complications', 'Potential complications and how you will prepare for them', 'long');
  S('Postoperative plan');
  add('pain', 'Postoperative pain plan', 'long'); add('ponv', 'PONV risk and prophylaxis', 'long'); add('dispo', 'Disposition and handoff (extubated? VSS? SpO2?)', 'long');
  S('Evidence and reflection');
  add('refs', 'References (APA; at least one current journal article)', 'long'); add('evidence', 'How the evidence changed your plan', 'long');
  add('reflection', 'After the case: how it went, what you would change, medications to review', 'long');
  S('Review and signatures');
  add('feedback', 'Preceptor feedback', 'long', {who: 'preceptor', badge: true});
  add('sig_preceptor', 'Preceptor signature', 'signature', {who: 'preceptor', badge: true}); add('sig_student', 'Student signature', 'signature', {who: 'student', badge: true});
  var hints = {'Case': 'COA D5: individualized care.', 'Patient assessment': 'COA D8 and D15: history, physical and preanesthetic assessment.', 'History and review of systems': 'COA D8 and D15.',
    'Labs and studies': 'COA D15 and D19.', 'Airway': 'COA D8 and D17.', 'Anesthetic plan': 'COA D17 and D14: a plan of care before anesthesia, based on evidence.',
    'Fluids and blood': 'COA D20: calculate, initiate and manage fluid and blood therapy.', 'Positioning and patient safety': 'COA D4: protect patients from iatrogenic complications.',
    'Complications': 'COA D22: recognize and manage complications.', 'Postoperative plan': 'COA D29: transfer of care.', 'Evidence and reflection': 'COA D14, D23 and D31.',
    'Review and signatures': 'Preceptor review.'};
  ACP_TPL = {id: ACP_ID, cat: 'acp', name: 'Anesthesia Care Plan (COA Standard D)', kind: 'builtin', builtin: true, fileName: 'AnesPilot form', fields: F, pages: [], secHints: hints,
    note: 'Organized by the COA graduate standards a care plan demonstrates (Standard D, effective January 1, 2026). The COA does not publish an official care plan template.',
    instructions: 'Never enter patient names, record numbers, dates of birth or other identifiers.'};
  return ACP_TPL;
}

/* any built-in form (other than the evaluation) as a clean PDF: sections, short answers in a grid, long answers as paragraphs */
async function genericPdf(tpl, values){
  var lib = await pdflib(), doc = await lib.PDFDocument.create();
  var R = await doc.embedFont(lib.StandardFonts.Helvetica), B = await doc.embedFont(lib.StandardFonts.HelveticaBold);
  var ink = lib.rgb(0.1, 0.12, 0.16), mute = lib.rgb(0.42, 0.46, 0.53), blue = lib.rgb(0.05, 0.12, 0.42), line = lib.rgb(0.8, 0.83, 0.88), band = lib.rgb(0.93, 0.95, 0.97);
  var W = 612, H = 792, M = 40, pg, y, pageNo = 0, filled = 0;
  var wrap = function(t, f, s, w){ var out = []; latin(t).split('\n').forEach(function(par){ var l = ''; par.split(' ').forEach(function(wd){ var tt = l ? l + ' ' + wd : wd; if(f.widthOfTextAtSize(tt, s) > w && l){ out.push(l); l = wd; } else l = tt; }); out.push(l); }); return out; };
  var newPage = function(){ pg = doc.addPage([W, H]); pageNo++; y = H - M;
    pg.drawText(latin(tpl.name) + (pageNo > 1 ? ' (continued)' : ''), {x: M, y: H - 24, size: 7.5, font: R, color: mute});
    pg.drawText('Page ' + pageNo, {x: W - M - R.widthOfTextAtSize('Page ' + pageNo, 7.5), y: 20, size: 7.5, font: R, color: mute}); };
  var need = function(h){ if(y - h < M + 10) newPage(); };
  var val = function(f){ var v = values[f.id]; if(!hasValue(f, v)) return ''; filled++; return f.type === 'check' ? 'Yes' : shown(f, v); };
  newPage();
  pg.drawText(latin(tpl.name.replace(/ \(COA Standard D\)$/, '')), {x: M, y: y, size: 17, font: B, color: ink}); y -= 16;
  wrap(tpl.note || '', R, 8, W - 2 * M).forEach(function(l){ pg.drawText(l, {x: M, y: y, size: 8, font: R, color: mute}); y -= 10.4; }); y -= 6;
  var secs = [], by = {};
  tpl.fields.forEach(function(f){ if(f.type === 'skip') return; var k = f.section || ''; if(!(k in by)){ by[k] = []; secs.push(k); } by[k].push(f); });
  for(var si = 0; si < secs.length; si++){
    var fs = by[secs[si]];
    need(40); pg.drawRectangle({x: M, y: y - 5, width: W - 2 * M, height: 17, color: band}); pg.drawText(latin(secs[si]), {x: M + 5, y: y, size: 10, font: B, color: ink}); y -= 22;
    // short answers and choices three to a row
    var grid = fs.filter(function(f){ return f.short || f.type === 'rating' || f.type === 'check' || f.type === 'date'; }), cw = (W - 2 * M) / 3;
    for(var gi = 0; gi < grid.length; gi += 3){ need(28);
      grid.slice(gi, gi + 3).forEach(function(f, k){ var x = M + k * cw, v = val(f);
        pg.drawText(latin(f.label).toUpperCase().slice(0, 42), {x: x, y: y, size: 6.3, font: B, color: mute});
        pg.drawText(latin(v || ' ').slice(0, 48), {x: x, y: y - 11, size: 9.5, font: R, color: blue});
        pg.drawLine({start: {x: x, y: y - 14}, end: {x: x + cw - 10, y: y - 14}, thickness: 0.5, color: line}); });
      y -= 25; }
    var rest = fs.filter(function(f){ return grid.indexOf(f) === -1; });
    for(var ri = 0; ri < rest.length; ri++){
      var f = rest[ri];
      if(f.type === 'signature') continue;
      need(26); pg.drawText(latin(f.label), {x: M, y: y, size: 8.5, font: B, color: ink}); y -= 12;
      var v = val(f);
      if(v) wrap(v, R, 9.5, W - 2 * M).forEach(function(l){ need(13); pg.drawText(l, {x: M, y: y, size: 9.5, font: R, color: blue}); y -= 12.5; });
      else { pg.drawLine({start: {x: M, y: y + 2}, end: {x: W - M, y: y + 2}, thickness: 0.5, color: line}); y -= 6; }
      y -= 5;
    }
    var sigs = fs.filter(function(f){ return f.type === 'signature'; });
    if(sigs.length){ need(80); y -= 8; var sw = (W - 2 * M - 24) / 2;
      for(var k = 0; k < sigs.length; k++){ var x = M + (k % 2) * (sw + 24), base = y - 52, sv = values[sigs[k].id];
        if(isSig(sv)){ try{ var im = await doc.embedPng(sigBytes(sv)), sc = Math.min((sw - 10) / im.width, 46 / im.height); pg.drawImage(im, {x: x + 4, y: base + 3, width: im.width * sc, height: im.height * sc}); filled++; }catch(e){} }
        pg.drawLine({start: {x: x, y: base}, end: {x: x + sw, y: base}, thickness: 0.8, color: ink});
        pg.drawText(latin(sigs[k].label), {x: x, y: base - 11, size: 7.5, font: R, color: mute});
        if(k % 2 === 1 || k === sigs.length - 1) y -= 72; }
    }
    y -= 4;
  }
  return {bytes: await doc.save(), filled: filled, missed: [], overflow: 0};
}

/* =========================== Word forms mapped by hand (school forms): exact places to write ===========================
   tgt.dx = {tbl, row, col, mode, label}   a table cell (top-level tables, physical cells, all counted from 0)
            {anchor, mode, label}          a paragraph in the body found by its text
   modes:   inline  - after the label in the same line (blank lines of ____ are removed first if blank: true)
            below   - on the first empty line under the label in the same cell (a new line if there is none)
            cell    - the first empty line of the cell
            after   - the first empty paragraph after the anchor paragraph (a new one if there is none)
            fill    - replace the ___ run in the label's line (e.g. "T&C: ___units") */
function dxText(el){ return wq(el, 't').map(function(t){ return t.textContent; }).join(''); }
function dxNorm(s){ return String(s || '').replace(/\s+/g, ' ').trim(); }
function dxEmpty(p){ return !dxNorm(dxText(p)) && !wq(p, 'drawing').length; }
function dxRunFor(doc, ref, text, under){
  var rp = ref ? rPrOf(ref) : null, r = mkRun(doc, text, rp, true), rpr = kids(r, 'rPr')[0];
  if(rpr){ ['u', 'i', 'iCs', 'highlight', 'shd'].forEach(function(n){ kids(rpr, n).forEach(function(x){ rpr.removeChild(x); }); }); }
  if(under){ if(!rpr){ rpr = doc.createElementNS(WNS, 'w:rPr'); r.insertBefore(rpr, r.firstChild); } var u = doc.createElementNS(WNS, 'w:u'); u.setAttributeNS(WNS, 'w:val', 'single'); rpr.appendChild(u); }
  return r;
}
function dxFillPara(doc, p, text, ref){ kids(p, 'r').forEach(function(r){ p.removeChild(r); }); p.appendChild(dxRunFor(doc, ref || p, text)); }
function dxNewParaAfter(doc, after, like){
  var np = doc.createElementNS(WNS, 'w:p'), pp = like && kids(like, 'pPr')[0]; if(pp){ var c = pp.cloneNode(true); kids(c, 'numPr').forEach(function(x){ c.removeChild(x); }); np.appendChild(c); }
  after.parentNode.insertBefore(np, after.nextSibling); return np;
}
function dxWrite(doc, t, text){
  var body = wq(doc, 'body')[0]; if(!body) return false;
  if(t.anchor){
    var ps = kids(body, 'p'), want = dxNorm(t.anchor), p = ps.find(function(x){ return dxNorm(dxText(x)).indexOf(want) !== -1; }); if(!p) return false;
    if(t.mode === 'inline'){
      var lab = t.label || t.anchor, tn = wq(p, 't').find(function(x){ return x.textContent.indexOf(lab) !== -1; }); if(!tn) return false;
      var run = tn.parentNode; run.parentNode.insertBefore(dxRunFor(doc, run, ' ' + text), run.nextSibling); return true;
    }
    var nx = p.nextSibling; while(nx && !(nx.namespaceURI === WNS && nx.localName === 'p')) nx = nx.nextSibling;
    if(nx && dxEmpty(nx) && !nx.__dxUsed){ dxFillPara(doc, nx, text, p); nx.__dxUsed = true; return true; }
    var np = dxNewParaAfter(doc, p, p); np.appendChild(dxRunFor(doc, p, text)); np.__dxUsed = true; return true;
  }
  var tb = kids(body, 'tbl')[t.tbl], tr = tb && kids(tb, 'tr')[t.row], tc = tr && kids(tr, 'tc')[t.col]; if(!tc) return false;
  var cps = kids(tc, 'p'), li = 0;
  if(t.label){ li = cps.findIndex(function(x){ return dxNorm(dxText(x)).indexOf(dxNorm(t.label)) !== -1; }); if(li < 0) li = 0; }
  var lp = cps[li];
  if(t.mode === 'inline'){
    if(t.blank) wq(lp, 't').forEach(function(x){ if(/_/.test(x.textContent)){ x.textContent = x.textContent.replace(/_+/g, ' ').replace(/\s+$/, ''); x.setAttribute('xml:space', 'preserve'); } });
    var rs = kids(lp, 'r'), last = rs[rs.length - 1]; lp.appendChild(dxRunFor(doc, last || lp, ' ' + text, !!t.blank)); return true;
  }
  if(t.mode === 'fill'){
    var tf = wq(lp, 't').find(function(x){ return /_{2,}/.test(x.textContent); }); if(!tf) return false;
    var full = tf.textContent, m = /_{2,}/.exec(full), run2 = tf.parentNode;
    tf.textContent = full.slice(0, m.index); tf.setAttribute('xml:space', 'preserve');
    var rest = full.slice(m.index + m[0].length), mid = dxRunFor(doc, run2, text + (/^\w/.test(rest) ? ' ' : ''), true); run2.parentNode.insertBefore(mid, run2.nextSibling); if(rest){ var tail = mkRun(doc, rest, kids(run2, 'rPr')[0]); mid.parentNode.insertBefore(tail, mid.nextSibling); }
    return true;
  }
  var start = t.mode === 'cell' ? 0 : li + 1;
  for(var i = start; i < cps.length; i++){ if(dxEmpty(cps[i]) && !cps[i].__dxUsed){ dxFillPara(doc, cps[i], text, lp); cps[i].__dxUsed = true; return true; } }
  var np2 = dxNewParaAfter(doc, cps[cps.length - 1], lp); np2.appendChild(dxRunFor(doc, lp, text)); np2.__dxUsed = true; return true;
}

/* comments on individual rating items (any form): kept as <field id>__c */
function itemComments(tpl, values){
  var out = []; tpl.fields.forEach(function(f){ var c = values[f.id + '__c']; if(f.type !== 'skip' && c && String(c).trim()) out.push({label: (f.code ? f.code + ' ' : '') + f.label, rating: values[f.id] || '', text: String(c)}); });
  return out;
}
async function addCommentPagesPdf(doc, lib, comments, size){
  if(!comments.length) return;
  var R = await doc.embedFont(lib.StandardFonts.Helvetica), B = await doc.embedFont(lib.StandardFonts.HelveticaBold), ink = lib.rgb(0.05, 0.12, 0.42);
  var W = size.width, H = size.height, pg = doc.addPage([W, H]), y = H - 54;
  var wrap = function(t, f, s, w){ var out = []; latin(t).split('\n').forEach(function(par){ var l = ''; par.split(' ').forEach(function(wd){ var tt = l ? l + ' ' + wd : wd; if(f.widthOfTextAtSize(tt, s) > w && l){ out.push(l); l = wd; } else l = tt; }); out.push(l); }); return out; };
  var put = function(t, f, s){ wrap(t, f, s, W - 108).forEach(function(l){ if(y < 54){ pg = doc.addPage([W, H]); y = H - 54; } pg.drawText(l, {x: 54, y: y, size: s, font: f, color: ink}); y -= s * 1.3; }); };
  put('Comments on individual items', B, 12); y -= 6;
  comments.forEach(function(c){ put(c.label + (c.rating ? ' (' + c.rating + ')' : ''), B, 9.5); put(c.text, R, 9.5); y -= 6; });
}
function addCommentParasDocx(doc, comments){
  if(!comments.length) return;
  var body = wq(doc, 'body')[0]; if(!body) return; var sect = kids(body, 'sectPr')[0] || null;
  var addP = function(t, bold){ var p = doc.createElementNS(WNS, 'w:p'), r = mkRun(doc, t, null); if(bold){ var rp = doc.createElementNS(WNS, 'w:rPr'); rp.appendChild(doc.createElementNS(WNS, 'w:b')); r.insertBefore(rp, r.firstChild); } p.appendChild(r); body.insertBefore(p, sect); };
  addP('Comments on individual items', true);
  comments.forEach(function(c){ addP(c.label + (c.rating ? ' (' + c.rating + ')' : ''), true); addP(c.text, false); });
}

/* =========================== school forms (school code), hidden inside the app ===========================
   A program's form is set up once (fields named and checked) and saved as a sealed school form file:
     {format:'anespilot-school-forms-enc', version:1, id, data}
   "data" is the form pack (blank form + field map + school name) encrypted with a key made from the school code, so the
   form cannot be read or even named from the app's files without the code. Nothing is stored online and nothing is downloaded:
   sealed files are built into the app (window.FF_SCHOOL_PACKS, from qbank_build/school_packs/) or opened from a file.
   id  = stretch('anespilot-school:' + CODE)   (looks the file up)
   key = stretch('anespilot-key:' + CODE)      (opens it)       stretch = SHA-256, repeated STRETCH times (slows guessing)
   cipher: byte i is XORed with SHA-256(key || uint32 block number)[i mod 32]; a SHA-256 check of the plain text proves the code. */
var STRETCH = 20000;
var SHA_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
var SHA_W = new Uint32Array(64);
function sha256(bytes){   // Uint8Array -> Uint8Array(32)
  var l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n); m.set(bytes); m[l] = 0x80;
  var dv = new DataView(m.buffer); dv.setUint32(n - 4, (l * 8) >>> 0); dv.setUint32(n - 8, Math.floor(l / 0x20000000));
  var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19, w = SHA_W, i;
  for(var o = 0; o < n; o += 64){
    for(i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for(i = 16; i < 64; i++){ var x = w[i - 15], y = w[i - 2];
      w[i] = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) >>> 0; }
    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for(i = 0; i < 64; i++){
      var t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      var t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
  }
  var out = new Uint8Array(32), ov = new DataView(out.buffer); [h0, h1, h2, h3, h4, h5, h6, h7].forEach(function(v, k){ ov.setUint32(k * 4, v); });
  return out;
}
function hex(u){ var s = ''; for(var i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16); return s; }
function sha256hex(str){ return hex(sha256(new TextEncoder().encode(str))); }
function stretch(str){ var h = sha256(new TextEncoder().encode(str)); for(var i = 1; i < STRETCH; i++) h = sha256(h); return h; }
function normCode(c){ return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
var CODE_CACHE = {};
function codeKeys(c){ var n = normCode(c); if(!CODE_CACHE[n]) CODE_CACHE[n] = {id: hex(stretch('anespilot-school:' + n)), key: stretch('anespilot-key:' + n)}; return CODE_CACHE[n]; }
function codeHash(c){ return codeKeys(c).id; }
function xorStream(key, data){
  var out = new Uint8Array(data.length), inp = new Uint8Array(36); inp.set(key, 0); var iv = new DataView(inp.buffer);
  for(var blk = 0, p = 0; p < data.length; blk++, p += 32){ iv.setUint32(32, blk); var ks = sha256(inp); for(var k = 0; k < 32 && p + k < data.length; k++) out[p + k] = data[p + k] ^ ks[k]; }
  return out;
}
function b64ToU8(s){ var b = atob(s), u = new Uint8Array(b.length); for(var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function b64ToBuf(s){ return b64ToU8(s).buffer; }
function bufToB64(buf){ var u = new Uint8Array(buf), s = '', CH = 0x8000; for(var i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH)); return btoa(s); }
// sealed file -> pack (or null if the code is wrong)
function openSealed(sealed, code){
  if(!sealed || sealed.format !== 'anespilot-school-forms-enc' || typeof sealed.data !== 'string') return null;
  var k = codeKeys(code); if(sealed.id && sealed.id !== k.id) return null;
  var raw = xorStream(k.key, b64ToU8(sealed.data)); if(raw.length < 33) return null;
  var body = raw.subarray(32); if(hex(sha256(body)) !== hex(raw.subarray(0, 32))) return null;
  try{ var p = JSON.parse(new TextDecoder().decode(body)); p.hash = k.id; return p; }catch(e){ return null; }
}
function seal(pack, code){
  var k = codeKeys(code), body = new TextEncoder().encode(JSON.stringify(Object.assign({}, pack, {hash: undefined}))), raw = new Uint8Array(32 + body.length);
  raw.set(sha256(body), 0); raw.set(body, 32);
  return {format: 'anespilot-school-forms-enc', version: 1, id: k.id, data: bufToB64(xorStream(k.key, raw))};
}
function schools(){ return get('schools', []); }
function validPack(p){
  if(!p || p.format !== 'anespilot-school-forms' || !Array.isArray(p.forms) || !p.forms.length) return false;
  return p.forms.every(function(f){ return f && typeof f.name === 'string' && Array.isArray(f.fields) && /^(acro|flat|scan|docx|builtin)$/.test(f.kind) && (f.kind === 'builtin' || typeof f.file === 'string'); });
}
// the sealed forms built into this copy of the app
function builtInSealed(id){ var all = window.FF_SCHOOL_PACKS || {}; return all[id] || null; }
function lookupPack(code){
  var k = codeKeys(code), s = builtInSealed(k.id); if(!s) return null;
  var p = openSealed(s, code); return p && validPack(p) ? p : null;
}
function packTemplate(pack, f, i, hash){
  var key = String(f.key || ('form' + (i + 1))).replace(/[^\w-]/g, '').slice(0, 30), id = 'sch_' + hash.slice(0, 12) + '_' + key;
  var t = {id: id, name: String(f.name).slice(0, 80), fileName: f.fileName || f.name, kind: f.kind, size: f.size || 0, total: f.total || (f.pages || []).length,
    pages: (f.pages || []).map(function(p){ return {w: +p.w, h: +p.h, t: (p.t || []).map(Number)}; }), fields: f.fields, school: String(pack.school || 'School form').slice(0, 80),
    schoolHash: hash, locked: true, cat: f.cat === 'acp' ? 'acp' : 'eval', version: pack.updated || '', created: Date.now(), updated: Date.now()};
  ['legend', 'quick', 'secHints', 'commentsTo', 'instructions'].forEach(function(k){ if(f[k] != null) t[k] = f[k]; });
  return t;
}
async function installPack(pack, hash, code){
  hash = hash || pack.hash || sha256hex('anespilot-school-file:' + (pack.school || '') + (pack.updated || ''));
  var ids = [], idx = index();
  for(var i = 0; i < pack.forms.length; i++){
    var f = pack.forms[i], t = packTemplate(pack, f, i, hash), id = t.id;
    if(f.kind !== 'builtin'){ var buf = b64ToBuf(f.file); t.size = buf.byteLength; await fileSave(id, buf, t.fileName); }
    if(!put('tpl:' + id, t)) throw new Error('storage');
    idx = idx.filter(function(x){ return x.id !== id; }); idx.unshift({id: id, cat: t.cat, name: t.name, kind: t.kind, nFields: t.fields.filter(function(x){ return x.type !== 'skip'; }).length, created: t.created, school: t.school});
    ids.push(id);
  }
  put('index', idx);
  var sealedNow = builtInSealed(hash);
  var ss = schools().filter(function(s){ return s.hash !== hash; });
  ss.push({hash: hash, school: pack.school || 'School form', updated: pack.updated || '', forms: ids, code: code ? normCode(code) : '', sig: sealedNow ? sealedNow.data.length + ':' + sealedNow.data.slice(-24) : '', fromFile: !!pack._fromFile});
  put('schools', ss);
  return ids;
}
function removeSchool(hash){
  var s = schools().find(function(x){ return x.hash === hash; }); if(!s) return;
  s.forms.forEach(function(id){ del('tpl:' + id); del('fills:' + id); fileDrop(id); });
  put('index', index().filter(function(x){ return s.forms.indexOf(x.id) === -1; }));
  put('schools', schools().filter(function(x){ return x.hash !== hash; }));
}
// after an app update: a school's sealed form changed -> reinstall it (answers are kept: field ids stay the same)
async function refreshSchools(){
  var ss = schools();
  for(var i = 0; i < ss.length; i++){
    var s = ss[i], sealed = builtInSealed(s.hash); if(!sealed || !s.code) continue;
    var sig = sealed.data.length + ':' + sealed.data.slice(-24); if(sig === s.sig) continue;
    try{ var p = openSealed(sealed, s.code); if(p && validPack(p)){ await installPack(p, s.hash, s.code); toast(s.school + ' forms were updated'); } }catch(e){}
  }
}
// the blank form went missing (e.g. after restoring a backup): take it again from the sealed copy in the app
async function restoreSchoolFile(t){
  var s = schools().find(function(x){ return x.hash === t.schoolHash; }), sealed = builtInSealed(t.schoolHash);
  if(!s || !s.code || !sealed) return false;
  var p = openSealed(sealed, s.code); if(!p || !validPack(p)) return false;
  await installPack(p, t.schoolHash, s.code); return true;
}
// a program director makes a sealed school form file from saved forms
async function buildPack(school, code, tplIds){
  var forms = [];
  for(var i = 0; i < tplIds.length; i++){
    var t = tplGet(tplIds[i]); if(!t) continue;
    var f = {key: fileSafe(t.name).toLowerCase().slice(0, 30) || 'form' + (i + 1), cat: catOf(t), name: t.name, kind: t.kind, fileName: t.fileName, pages: t.pages, fields: t.fields, total: t.total, size: t.size};
    ['legend', 'quick', 'secHints', 'commentsTo', 'instructions'].forEach(function(k){ if(t[k] != null) f[k] = t[k]; });
    if(t.kind !== 'builtin'){ var rec = await fileLoad(t.id); if(!rec || !rec.buf) throw new Error('The blank file for "' + t.name + '" is not on this device. Open it, save a filled copy once (it will ask for the file), then try again.'); f.file = bufToB64(rec.buf); }
    forms.push(f);
  }
  var d = new Date(), pad = function(n){ return (n < 10 ? '0' : '') + n; };
  var pack = {format: 'anespilot-school-forms', version: 1, school: String(school).trim().slice(0, 80), updated: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()), forms: forms};
  return seal(pack, code);
}

/* =========================== screens =========================== */
var KIND = {acro: 'Fillable PDF', flat: 'PDF', scan: 'Scanned form', docx: 'Word', builtin: 'AnesPilot form'};
var TYPES = {text: 'Short answer', long: 'Long answer', date: 'Date', rating: 'Rating / choice', check: 'Check box', signature: 'Signature', skip: 'Skip (leave blank)'};
var V = {secOpen: {}, cOpen: {}, code: '', codeMsg: '', dir: false, root: null, view: 'list', tid: null, fill: null, draft: null, pages: null, adding: false, status: '', busy: false, hit: null, preview: '', confirm: null, flatten: false};
var saveTimer = null;

function index(){ return get('index', []); }
function tplGet(id){ if(V.remote && V.remote.tpl && id === V.remote.tpl.id) return V.remote.tpl; return id === COA_ID ? coaTemplate() : id === ACP_ID ? acpTemplate() : get('tpl:' + id, null); }
function catOf(t){ return (t && t.cat) || 'eval'; }
function builtinFor(cat){ return cat === 'acp' ? acpTemplate() : coaTemplate(); }
var CAT = {eval: {title: 'Daily Evaluations', one: 'evaluation', head: 'AnesPilot daily evaluation', sub: '36 COA graduate competencies · tap to score · comments · signatures',
    lede: 'Fill out daily clinical evaluations with tap-to-score buttons, comments and signatures, then export them directly from the app in your file\'s format.'},
  acp: {title: 'Care Plans', one: 'care plan', head: 'AnesPilot care plan', sub: 'Organized by COA Standard D · quick entry · signatures',
    lede: 'Write anesthesia care plans with quick entry boxes and choices, then export them directly from the app: the AnesPilot plan as a PDF, or your school\'s own form in its file\'s format.'}};
function fkey(id){ return V.remote ? 'rfill:' + V.remote.link.id : 'fills:' + id; } // a preceptor's draft (web page) is kept per link
function fillsGet(id){ return (V._pending && V._pending.tid === id) ? V._pending.list : get(fkey(id), []); } // unsaved typing wins
function fillsPut(id, list){ if(V._pending && V._pending.tid === id){ clearTimeout(saveTimer); V._pending = null; } return put(fkey(id), list); }
function fmtDate(t){ try{ return new Date(t).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'}); }catch(e){ return ''; } }
/* ---- check before saving: empty answers and possible patient identifiers (fixed patterns, no AI) ---- */
var PHI_RULES = [
  [/\b\d{3}-\d{2}-\d{4}\b/, 'looks like a Social Security number'],
  [/\b(?:MRN|MR\s?#|med(?:ical)?\.?\s*rec(?:ord)?s?(?:\s*(?:no|number|#))?|acct(?:\s*#)?|account\s*(?:no|number|#)|FIN|CSN|encounter\s*(?:no|number|#))\s*[:#]?\s*[A-Z]{0,3}\d{3,}/i, 'looks like a record or account number'],
  [/(?:^|[^\d.,])(\d{7,})(?![\d.,])/, 'long number: could be a record number'],
  [/\b(?:DOB|D\.O\.B\.?|date of birth|birth\s?date|born(?:\s+on)?)\b/i, 'mentions a date of birth'],
  [/(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/, 'looks like a phone number'],
  [/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i, 'looks like an email address'],
  [/\b(?:Mr|Mrs|Ms|Miss|Mx)\.?\s+[A-Z][a-z'-]+/, 'looks like a patient name'],
  [/\b(?:pt|patient)(?:'?s)?\s+name\b/i, 'mentions the patient’s name'],
  [/\b(?:9\d|1[01]\d)\s*(?:y\/?o\b|yo\b|y\.o\.|-?years?[-\s]old|yrs?\b)/i, 'age over 89: write 90+ instead']
];
var PHI_SKIP_NAMES = /student|srna|preceptor|evaluator|instructor|faculty|facility|site|school|feedback|signature/i;
function phiHits(text, label){
  var out = [], t = String(text || ''); if(!t.trim()) return out;
  PHI_RULES.forEach(function(r, i){ if(i === 6 && PHI_SKIP_NAMES.test(label || '')) return; var m = r[0].exec(t); if(m) out.push({why: r[1], match: m[1] || m[0]}); });
  if(/^age\b/i.test(label || '') && /^\s*(?:9\d|1[01]\d)(?:\.\d+)?\s*$/.test(t)) out.push({why: 'age over 89: write 90+ instead', match: t.trim()});
  return out;
}
function fillCheck(t, fl){
  var empty = [], phi = [], vals = fl.values || {};
  t.fields.forEach(function(f){
    if(f.type === 'skip') return;
    var v = vals[f.id];
    if(!hasValue(f, v) && f.type !== 'check' && !f.optional && !(V.remote && V.remote.locked[f.id])) empty.push(f);
    if((f.type === 'text' || f.type === 'long') && v) phiHits(v, f.label).forEach(function(h){ phi.push({id: f.id, f: f, why: h.why, match: h.match}); });
    if(vals[f.id + '__c']) phiHits(vals[f.id + '__c'], '').forEach(function(h){ phi.push({id: f.id, f: f, cmt: true, why: h.why, match: h.match}); });
  });
  [['ftitle', 'Name of this one', fl.title], ['fname', 'File name', fl.fileName]].forEach(function(x){ phiHits(x[2], '').forEach(function(h){ phi.push({id: x[0], name: x[1], why: h.why, match: h.match}); }); });
  return {empty: empty, phi: phi};
}
function fLabel(f){ return (f.code ? f.code + ' ' : '') + f.label; }
function reviewHtml(t, fl){
  var r = fillCheck(t, fl), h = '<div class="ff-review" role="region" aria-label="Check before saving">';
  if(!r.empty.length && !r.phi.length) return h + '<div class="ff-rv-ok">✓ Every answer is filled in and no patient identifiers were found.</div></div>';
  var bits = []; if(r.phi.length) bits.push('<span class="ff-rv-n ff-rv-n-phi">' + r.phi.length + ' possible identifier' + (r.phi.length === 1 ? '' : 's') + '</span>');
  if(r.empty.length) bits.push('<span class="ff-rv-n ff-rv-n-empty">' + r.empty.length + ' empty</span>');
  var SV = V.remote ? 'submit' : 'save';
  h += '<div class="ff-rv-head"><div class="ff-h3">Before you ' + SV + '</div><div class="ff-rv-sum">' + bits.join('') + '</div></div>' +
    '<div class="ff-row ff-rv-btns"><button class="action secondary" data-act="reviewclose">Keep editing</button><button class="action" data-act="exportnow">' + (r.phi.length ? 'I checked, ' + SV + ' anyway' : (V.remote ? 'Submit anyway' : 'Save anyway')) + '</button></div>';
  if(r.phi.length){
    var groups = [], gi = {};
    r.phi.forEach(function(x){ var k = x.id + (x.cmt ? '__c' : ''); if(!(k in gi)){ gi[k] = groups.length; groups.push({x: x, list: []}); } groups[gi[k]].list.push(x); });
    h += '<div class="ff-rv-phi"><div class="ff-rv-t">Remove before you ' + SV + '</div>' +
      groups.map(function(g){ var x = g.x; return '<button class="ff-rv-item" data-act="jump" data-f="' + esc(x.id) + '"' + (x.cmt ? ' data-cmt="1"' : '') + '><b>' + esc(x.f ? fLabel(x.f) + (x.cmt ? ' (comment)' : '') : x.name) + '</b>' +
        g.list.map(function(y){ return '<span>“' + esc(y.match.slice(0, 40)) + '” ' + esc(y.why) + '</span>'; }).join('') + '</button>'; }).join('') + '</div>';
  }
  if(r.empty.length){
    var secs = [], by = {};
    r.empty.forEach(function(f){ var k = f.section || ''; if(!(k in by)){ by[k] = []; secs.push(k); } by[k].push(f); });
    h += '<details class="ff-rv-empty"' + (r.empty.length <= 12 ? ' open' : '') + '><summary class="ff-rv-t">Still empty (' + r.empty.length + ')<span class="ff-small ff-muted"> · marked in yellow on the form</span></summary>' +
      secs.map(function(k){ return '<div class="ff-rv-sec">' + (k ? '<div class="ff-rv-sn">' + esc(k) + ' <span class="ff-muted">' + by[k].length + '</span></div>' : '') + '<div class="ff-rv-chips">' +
        by[k].map(function(f){ return '<button class="ff-rv-chip" data-act="jump" data-f="' + esc(f.id) + '">' + esc(fLabel(f)) + '</button>'; }).join('') + '</div></div>'; }).join('') + '</details>';
  }
  h += '<div class="ff-small ff-muted ff-rv-note">AnesPilot looks for common identifier patterns but cannot recognize every name. Read your answers before you submit.</div>';
  return h + '</div>';
}
function qFlags(f, fl){
  if(!V.review || !fl) return '';
  var v = fl.values[f.id], c = '';
  if(f.type !== 'skip' && f.type !== 'check' && !f.optional && !hasValue(f, v) && !(V.remote && V.remote.locked[f.id])) c += ' ff-q-empty';
  if(((f.type === 'text' || f.type === 'long') && phiHits(v, f.label).length) || phiHits(fl.values[f.id + '__c'], '').length) c += ' ff-q-phi';
  return c;
}
var reviewTimer = null;
function refreshReview(){
  if(!V.review || V.view !== 'fill') return; clearTimeout(reviewTimer);
  reviewTimer = setTimeout(function(){
    var c = curFill(), box = V.root && V.root.querySelector('.ff-review'); if(!c.t || !c.f || !box) return;
    box.outerHTML = reviewHtml(c.t, c.f);
    c.t.fields.forEach(function(f){ var q = V.root.querySelector('[data-q="' + f.id + '"]'); if(!q) return; var fl = qFlags(f, c.f);
      q.classList.toggle('ff-q-empty', fl.indexOf('ff-q-empty') !== -1); q.classList.toggle('ff-q-phi', fl.indexOf('ff-q-phi') !== -1); });
  }, 250);
}
function jumpTo(fid, cmt){
  var c = curFill(); if(!c.t) return;
  var f = c.t.fields.find(function(x){ return x.id === fid; }), sel;
  if(f){ V.secOpen[c.t.id + '|' + (f.section || '')] = true; if(cmt) V.cOpen[fid] = true; render(true); sel = cmt ? '[data-f="' + fid + '__c"]' : '[data-q="' + fid + '"]'; }
  else sel = fid === 'fname' ? '#ffName' : '[data-in="ftitle"]';
  var el = V.root.querySelector(sel); if(!el) return;
  el.scrollIntoView({block: 'center'});
  var box = el.closest('.ff-q') || el; box.classList.remove('ff-flash'); void box.offsetWidth; box.classList.add('ff-flash');
  var inp = el.matches('input, textarea') ? el : el.querySelector('input, textarea, .ff-chip, .ff-pad');
  if(inp && inp.focus) try{ inp.focus({preventScroll: true}); }catch(x){ inp.focus(); }
}
function countDone(tpl, values){ var n = 0, m = 0; tpl.fields.forEach(function(f){ if(f.type === 'skip' || (V.remote && V.remote.locked[f.id])) return; m++; if(hasValue(f, values[f.id])) n++; }); return [n, m]; }
function optTarget(t){ return !!(t.optSlots || t.acroMap || t.radio || t.acroPick); }
function typesFor(f){ var t = f.tgt; if(optTarget(t)) return ['rating', 'skip']; if(t.acro && f._acroCheck) return ['check', 'skip']; return ['text', 'long', 'date', 'check', 'signature', 'skip']; }

function scroller(){ return document.getElementById('content'); }
function render(keepScroll){
  var root = V.root; if(!root || !root.isConnected) return;
  var sc = scroller(), a = sc ? sc.scrollTop : 0, b = window.scrollY;
  root.innerHTML = '<div class="ff-wrap">' + (V.view === 'remotemsg' ? viewRemoteMsg() : V.view === 'review' ? viewReview() : V.view === 'fills' ? viewFills() : V.view === 'fill' ? viewFill() : viewList()) + '</div>';
  if(V.view === 'fill') mountSigPads(root);
  if(keepScroll){ if(sc) sc.scrollTop = a; window.scrollTo(0, b); } else { if(sc) sc.scrollTop = 0; window.scrollTo(0, 0); }
}
function go(view, extra){ Object.assign(V, {view: view, preview: '', status: '', confirm: null, adding: false, review: false, send: null, sendTop: false, pick: false}, extra || {}); render(false); }
function setStatus(msg){ V.status = msg; var el = V.root && V.root.querySelector('.ff-status'); if(el) el.textContent = msg; }

function viewList(){
  var cat = V.cat || 'eval', C = CAT[cat], list = index().filter(function(t){ return (t.cat || 'eval') === cat; }), old = typeof claudeOldWork === 'function' ? claudeOldWork('careplan') : null, bt = builtinFor(cat), ss = schools();
  var h = '<div class="panel-head"><div class="panel-title">' + C.title + '</div></div>' +
    '<p class="ff-lede">' + C.lede + '</p>';
  // 1. built-in form
  var nB = fillsGet(bt.id).length;
  h += '<div class="ff-h2">' + C.head + '</div><div class="card ff-item ff-coa"><button class="ff-item-main" data-act="open" data-id="' + bt.id + '"><span class="ff-item-n">' + esc(bt.name) + '</span>' +
    '<span class="ff-item-s">' + C.sub + ' · ' + nB + ' filled</span></button><button class="action" data-act="open" data-id="' + bt.id + '">Open</button></div>';
  h += sendPickHtml(cat, C, bt);
  h += linksHtml(cat);
  // 2. school code
  h += '<div class="ff-h2">Your school\'s forms</div><div class="card ff-school"><label class="ff-lab" for="ffCode">School code</label>' +
    '<div class="ff-coderow"><input class="ff-in" id="ffCode" data-in="code" value="' + esc(V.code) + '" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g., ABC-1234">' +
    '<button class="action" data-act="code"' + (V.busy ? ' disabled' : '') + '>Get forms</button></div>' +
    '<div class="ff-status ff-codemsg" role="status" aria-live="polite">' + esc(V.codeMsg) + '</div>' +
    '<div class="panel-hint">Your program gives you the code. Its forms then appear below, set up and ready to fill. Nothing is downloaded.</div>';
  ss.forEach(function(sc){ var nIn = sc.forms.filter(function(id){ var t = tplGet(id); return t && catOf(t) === cat; }).length; h += '<div class="ff-schoolrow"><span>🏫 <b>' + esc(sc.school) + '</b> · ' + nIn + ' ' + C.one + (nIn === 1 ? '' : 's') + (sc.forms.length > nIn ? ' here, ' + (sc.forms.length - nIn) + ' in the other tab' : '') + '</span>' +
    '<button class="ff-link ff-danger" data-act="rmschool" data-id="' + esc(sc.hash) + '">' + (V.confirm === 'sch' + sc.hash ? 'Tap again to remove (deletes its filled copies)' : 'Remove') + '</button></div>'; });
  h += '</div>';
  // 3. upload
  h += '<div class="ff-h2">Upload your own form</div><div class="card ff-intro"><p>Add the <b>blank</b> form once. AnesPilot finds the answer boxes, rating rows, check boxes and signature lines (no AI), and you check the list before your first fill.</p>' +
    '<label class="action ff-add' + (V.busy ? ' ff-dis' : '') + '"><input type="file" class="ff-file" data-in="add" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"' + (V.busy ? ' disabled' : '') + '>Add a blank form</label>' +
    '<div class="ff-status" role="status" aria-live="polite">' + esc(V.status) + '</div>' +
    '<div class="panel-hint">PDF (fillable or typed), Word (.docx), or a photo of a paper form. Everything stays on this device. Never enter patient names or other identifiers.</div></div>';
  if(list.length){
    h += '<div class="ff-h2">Your ' + C.one + ' forms</div><div class="ff-list">';
    list.forEach(function(t){
      var n = fillsGet(t.id).length;
      h += '<div class="card ff-item"><button class="ff-item-main" data-act="open" data-id="' + t.id + '"><span class="ff-item-n">' + esc(t.name) + '</span>' +
        '<span class="ff-item-s">' + (t.school ? '🏫 ' + esc(t.school) + ' · ' : '') + esc(KIND[t.kind] || '') + ' · ' + t.nFields + ' fields · ' + n + ' filled</span></button>' +
        (t.school ? '' : '<div class="ff-item-b"><button class="ff-link" data-act="edit" data-id="' + t.id + '">Edit fields</button>' +
        '<button class="ff-link ff-danger" data-act="deltpl" data-id="' + t.id + '">' + (V.confirm === 'tpl' + t.id ? 'Tap again to delete' : 'Delete') + '</button></div>') + '</div>';
    });
    h += '</div>';
  }
  h += '<div class="card ff-how"><div class="ff-h3">Tips for the best result</div><ul class="ff-ul">' +
    '<li>Use the <b>blank</b> form from your program, not a filled one. A fillable PDF or the Word file works best.</li>' +
    '<li>Rating tables are found when the scores (like 4 3 2 1 N/A, or Met / Not met) are printed above their columns.</li>' +
    '<li>For a photo, lay the page flat in good light and fill the frame. Names cannot be read from a photo, so you name the boxes once on the check screen, or tap <b>Add a box</b> to place your own.</li></ul></div>';
  // 4. program directors: schools are added by AnesPilot (PRECEPTOR-LINK-V2)
  h += '<div class="card ff-dir"><div class="ff-h3">For program directors</div><div class="panel-hint">Want your program\'s evaluation and care plan forms in AnesPilot, with a school code for your students and a link they can send to preceptors? Contact AnesPilot at <a href="mailto:support@anespilot.com">support@anespilot.com</a> and we will add them for you.</div></div>';
  if(old) h += '<div class="card"><div class="ff-h3">Your earlier saved work</div><div class="panel-hint">Care plans and evaluations saved by an older version of this tab are still on this device.</div>' +
    '<button class="action secondary" data-act="olddl">Download earlier work (.json)</button></div>';
  return h;
}

/* ---- check the fields ---- */
function boxStyle(pg, b){ return 'left:' + (b.x / pg.w * 100) + '%;top:' + (b.y / pg.h * 100) + '%;width:' + (b.w / pg.w * 100) + '%;height:' + (b.h / pg.h * 100) + '%'; }
function viewReview(){
  var d = V.draft, isPdf = d.kind !== 'docx', n = d.fields.filter(function(f){ return f.type !== 'skip'; }).length;
  var h = '<div class="ff-crumb"><button class="ff-link" data-act="cancel">‹ Forms</button></div>' +
    '<div class="ff-h2">Check the fields</div>' +
    '<label class="ff-lab">Form name<input class="ff-in" data-in="tname" value="' + esc(d.name) + '" maxlength="80"></label>' +
    '<div class="panel-hint">' + (d.fields.length ? 'AnesPilot found <b>' + n + '</b> places to fill. Give each a clear name, fix the type if it is wrong, and set anything you never fill to <b>Skip</b>.' : 'No places to fill were found.') +
    (isPdf ? ' Numbers on the page match the list. Tap <b>Add a box</b>, then tap the page, to add one that was missed.' : ' Word forms are filled in their own blanks, table cells and check boxes.') + '</div>';
  if(d.total > d.pages.length && isPdf) h += '<div class="panel-hint">Only the first ' + d.pages.length + ' pages were read.</div>';
  if(isPdf && d.pages.length && d.pages[0].img){
    h += '<div class="ff-tools"><button class="action ' + (V.adding ? '' : 'secondary ') + 'ff-sm" data-act="addmode" aria-pressed="' + V.adding + '">' + (V.adding ? 'Tap the page where the box goes' : '+ Add a box') + '</button></div>';
    d.pages.forEach(function(pg, pi){
      h += '<div class="ff-page' + (V.adding ? ' ff-adding' : '') + '" data-page="' + (pi + 1) + '"><img src="' + pg.img + '" alt="Page ' + (pi + 1) + ' of the form" draggable="false">';
      d.fields.forEach(function(f, fi){ f.boxes.forEach(function(b, bi){ if(b.page !== pi + 1) return;
        h += '<div class="ff-ov' + (f.type === 'skip' ? ' ff-ov-skip' : '') + (b.kind === 'manual' ? ' ff-ov-man' : '') + (V.hit === f.id ? ' ff-ov-hit' : '') + '" style="' + boxStyle(pg, b) + '" data-act="hit" data-f="' + f.id + '" data-b="' + bi + '">' + (bi === 0 ? '<span>' + (fi + 1) + '</span>' : '') + '</div>'; }); });
      h += '</div>';
    });
  } else if(isPdf) h += '<div class="panel-hint">The page pictures are not available because the original file is not on this device. You can still rename fields.</div>';
  h += '<div class="ff-flist">';
  d.fields.forEach(function(f, fi){
    var types = typesFor(f), prev = d.fields[fi - 1];
    h += '<div class="card ff-fcard' + (V.hit === f.id ? ' ff-hit' : '') + (f.type === 'skip' ? ' ff-skipped' : '') + '" id="ffc-' + f.id + '"><div class="ff-frow"><span class="ff-num">' + (fi + 1) + '</span>' +
      '<input class="ff-in ff-grow" data-in="flabel" data-f="' + f.id + '" value="' + esc(f.label) + '" aria-label="Name of field ' + (fi + 1) + '">' +
      '<button class="ff-x" data-act="fdel" data-f="' + f.id + '" aria-label="Remove field ' + (fi + 1) + '">✕</button></div>' +
      '<div class="ff-frow"><select class="ff-in ff-sel" data-in="ftype" data-f="' + f.id + '" aria-label="Type of field ' + (fi + 1) + '">' +
      types.map(function(t){ return '<option value="' + t + '"' + (t === f.type ? ' selected' : '') + '>' + TYPES[t] + '</option>'; }).join('') + '</select>';
    if(f.tgt.slots && prev && prev.tgt.slots && f.type !== 'check' && prev.type !== 'check' && d.kind !== 'docx') h += '<button class="ff-link" data-act="join" data-f="' + f.id + '">Join with ' + fi + '</button>';
    h += '</div>';
    h += '<label class="ff-lab ff-small">Section (optional, groups fields on the fill screen)<input class="ff-in" data-in="fsec" data-f="' + f.id + '" value="' + esc(f.section || '') + '" maxlength="60"></label>';
    if(f.type === 'rating') h += '<label class="ff-lab ff-small">Choices, in order, separated by commas<input class="ff-in" data-in="fopts" data-f="' + f.id + '" value="' + esc((f.options || []).join(', ')) + '"></label>';
    if(f.boxes && f.boxes[0] && f.boxes[0].kind === 'manual'){ var b = f.boxes[0];
      h += '<div class="ff-frow ff-small">Box size: <button class="ff-step" data-act="size" data-f="' + f.id + '" data-d="w-">W−</button><button class="ff-step" data-act="size" data-f="' + f.id + '" data-d="w+">W+</button>' +
        '<button class="ff-step" data-act="size" data-f="' + f.id + '" data-d="h-">H−</button><button class="ff-step" data-act="size" data-f="' + f.id + '" data-d="h+">H+</button><span class="ff-muted">' + Math.round(b.w) + ' × ' + Math.round(b.h) + ' pt · drag the box on the page to move it</span></div>'; }
    h += '</div>';
  });
  h += '</div><div class="ff-status" role="status" aria-live="polite">' + esc(V.status) + '</div>' +
    '<div class="ff-row"><button class="action" data-act="savetpl"' + (d.fields.length ? '' : ' disabled') + '>Save form</button><button class="action secondary" data-act="cancel">Cancel</button></div>';
  return h;
}

/* ---- the fills of one form ---- */
function viewFills(){
  var t = tplGet(V.tid); if(!t) return viewList();
  var fills = fillsGet(t.id).slice().sort(function(a, b){ return b.updated - a.updated; });
  var h = '<div class="ff-crumb"><button class="ff-link" data-act="home">‹ Forms</button>' + (t.builtin || t.locked ? '' : '<button class="ff-link" data-act="edit" data-id="' + t.id + '">Edit fields</button>') + '</div>' +
    '<div class="ff-h2">' + esc(t.name) + '</div><div class="ff-muted ff-small">' + (t.builtin ? esc(t.note) : (t.school ? '🏫 ' + esc(t.school) + ' · ' : '') + esc(KIND[t.kind] || '') + ' · ' + esc(t.fileName)) + '</div>' +
    '<div class="ff-row"><button class="action" data-act="newfill">Start a new one</button></div>';
  if(!fills.length) h += '<div class="panel-hint">Nothing filled yet. Tap <b>Start a new one</b>.</div>';
  else { h += '<div class="ff-list">'; fills.forEach(function(f){ var c = countDone(t, f.values);
    h += '<div class="card ff-item"><button class="ff-item-main" data-act="openfill" data-id="' + f.id + '"><span class="ff-item-n">' + esc(f.title) + '</span><span class="ff-item-s">' + c[0] + ' of ' + c[1] + ' filled · ' + fmtDate(f.updated) + '</span></button>' +
      '<div class="ff-item-b"><button class="ff-link" data-act="copyfill" data-id="' + f.id + '">Copy</button><button class="ff-link ff-danger" data-act="delfill" data-id="' + f.id + '">' + (V.confirm === 'fill' + f.id ? 'Tap again to delete' : 'Delete') + '</button></div></div>'; });
    h += '</div><div class="panel-hint">Copy starts a new one with the same answers (signatures are not copied).</div>'; }
  return h;
}

/* ---- fill it in ---- */
function curFill(){ var t = tplGet(V.tid); var f = t && fillsGet(t.id).find(function(x){ return x.id === V.fill; }); return {t: t, f: f}; }
function fieldHtml(f, v, fl){
  if(V.remote && V.remote.locked[f.id]) return lockedHtml(f, v, fl);
  var id = 'ffq-' + f.id, h ='<div class="ff-q' + (f.type === 'rating' ? ' ff-qr' : '') + qFlags(f, fl) + '" data-q="' + f.id + '">';
  var lab = (f.code ? '<span class="ff-code">' + esc(f.code) + '</span>' : '') + esc(f.label) + (f.who && f.badge ? '<span class="ff-who ff-who-' + f.who + '">' + (f.who === 'preceptor' ? 'Preceptor' : 'Student') + '</span>' : '');
  if(f.type === 'rating'){
    h += '<div class="ff-ql" id="' + id + '">' + lab + '</div><div class="ff-chips" role="group" aria-labelledby="' + id + '">' +
      (f.options || []).map(function(o){ return '<button class="ff-chip' + ((f.lowOpts ? f.lowOpts.indexOf(o) !== -1 : (o === 'Below' || o === 'Not met')) ? ' ff-chip-low' : '') + '" data-act="rate" data-f="' + f.id + '" data-o="' + esc(o) + '" aria-pressed="' + (v === o) + '"' + (COA_SCALE_LONG[o] && f.code ? ' title="' + COA_SCALE_LONG[o] + '"' : '') + '>' + esc(o) + '</button>'; }).join('') + '</div>';
    var cv = fl.values[f.id + '__c'] || '', open = !!cv || V.cOpen[f.id];
    if(f.comment || !V.curBuiltin) h += '<button class="ff-cbtn" data-act="cmt" data-f="' + f.id + '" aria-expanded="' + !!open + '">' + (cv ? '💬 Comment' : '+ Comment') + ' <span aria-hidden="true">' + (open ? '▴' : '▾') + '</span></button>' +
      ((open && (f.comment || !V.curBuiltin)) ? '<textarea class="ff-in ff-ctext" rows="2" data-in="val" data-f="' + f.id + '__c" aria-label="Comment on ' + esc(f.label) + '" placeholder="Optional comment">' + esc(cv) + '</textarea>' : '');
  } else if(f.type === 'check'){
    h += '<button class="ff-check" data-act="tick" data-f="' + f.id + '" role="checkbox" aria-checked="' + !!v + '"><span class="ff-tick" aria-hidden="true">' + (v ? '✓' : '') + '</span>' + esc(f.label) + '</button>';
  } else if(f.type === 'signature'){
    h += '<div class="ff-ql">' + lab + '</div>' + (isSig(v) ? '<div class="ff-sig ff-signed"><img alt="Signature: ' + esc(f.label) + '" src="' + v + '"></div>'
      : '<div class="ff-sig"><canvas class="ff-pad" data-sig="' + f.id + '" role="img" aria-label="Signature pad for ' + esc(f.label) + '. Sign with a finger."></canvas><div class="ff-sigline" aria-hidden="true"></div><div class="ff-sighint" aria-hidden="true">Sign here with a finger</div></div>') +
      '<button class="ff-link" data-act="sigclear" data-f="' + f.id + '">' + (isSig(v) ? 'Clear and sign again' : 'Clear') + '</button>';
  } else if(f.type === 'long'){
    h += '<label class="ff-ql" for="' + id + '">' + lab + '</label><textarea class="ff-in" id="' + id + '" rows="' + (f.rows || 3) + '" data-in="val" data-f="' + f.id + '">' + esc(v || '') + '</textarea>';
  } else {
    h += '<label class="ff-ql" for="' + id + '">' + lab + '</label><input class="ff-in" id="' + id + '" type="' + (f.type === 'date' ? 'date' : 'text') + '"' + (f.num ? ' inputmode="decimal"' : '') + ' data-in="val" data-f="' + f.id + '" value="' + esc(v || '') + '"' + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') + '>';
  }
  return h + '</div>';
}
var SEC_HINT = {'About this evaluation': 'Filled in by the student.', 'Summary and signatures': 'Each field shows who completes it.'};
['Patient Safety', 'Perianesthesia', 'Critical Thinking', 'Communication', 'Leadership', 'Professional Role'].forEach(function(k){ SEC_HINT[k] = 'Scored by the preceptor. Tap a score; add a comment if needed.'; });
function viewFill(){
  var c = curFill(), t = c.t, fl = c.f; if(!t || !fl) return viewFills();
  var cnt = countDone(t, fl.values); V.curBuiltin = !!t.builtin || catOf(t) === 'acp' || t.fields.some(function(f){ return f.comment; }); // with explicit comment fields, only those get a comment box
  var h = V.remote ? remoteHead(t, cnt) : '<div class="ff-crumb"><button class="ff-link" data-act="back">‹ ' + esc(t.name) + '</button></div>' +
    '<label class="ff-lab">Name of this one<input class="ff-in" data-in="ftitle" value="' + esc(fl.title) + '" maxlength="80"></label>' +
    '<div class="ff-prog ff-muted ff-small">' + cnt[0] + ' of ' + cnt[1] + ' filled · saved on this device</div>';
  if(!V.remote && V.send && V.sendTop && !V.send.made) h += '<div class="card ff-send ff-sendtop"><div class="ff-small"><b>Fill in your part below</b> (your name, date, site, cases and your signature), then enter who receives it in <b>Send to preceptor</b> at the bottom.</div><div class="ff-row"><button class="action secondary" data-act="sendjump">Go to Send to preceptor</button></div></div>';
  if(t.legend) h += '<div class="ff-scale">' + t.legend.map(function(s){ return '<span><b>' + esc(s[0]) + '</b> ' + esc(s[1]) + '</span>'; }).join('') + '</div>';
  if(t.instructions) h += '<div class="panel-hint">' + esc(t.instructions) + '</div>';
  var shownF = t.fields.filter(function(f){ return f.type !== 'skip'; }), secs = [], by = {};
  shownF.forEach(function(f){ var k = f.section || ''; if(!(k in by)){ by[k] = []; secs.push(k); } by[k].push(f); });
  h += '<div class="ff-qs">';
  var fieldsHtml = function(fs){ var out = '', grid = ''; fs.forEach(function(f){ if(f.short && (f.type === 'text' || f.type === 'date')) grid += fieldHtml(f, fl.values[f.id], fl); else { if(grid){ out += '<div class="ff-grid">' + grid + '</div>'; grid = ''; } out += fieldHtml(f, fl.values[f.id], fl); } }); return out + (grid ? '<div class="ff-grid">' + grid + '</div>' : ''); };
  if(secs.length === 1 && !secs[0]) h += fieldsHtml(shownF);
  else secs.forEach(function(sec, si){
    var fs = by[sec], done = fs.filter(function(f){ return hasValue(f, fl.values[f.id]); }).length, key = t.id + '|' + sec;
    var open = key in V.secOpen ? V.secOpen[key] : si === 0 || (done < fs.length && secs.slice(0, si).every(function(p){ var q = by[p]; return q.every(function(f){ return hasValue(f, fl.values[f.id]); }); }));
    var qk = t.quick || {opt: 'Meets', label: 'Meets'}, canRest = fs.some(function(f){ return f.type === 'rating' && f.quick !== false && (f.options || []).indexOf(qk.opt) !== -1 && !hasValue(f, fl.values[f.id]); });
    h += '<details class="ff-sec"' + (open ? ' open' : '') + ' data-sec="' + esc(key) + '"><summary><span class="ff-sec-t">' + esc(sec || 'Other') + '</span><span class="ff-sec-n' + (done === fs.length ? ' ff-sec-done' : '') + '">' + done + ' / ' + fs.length + '</span></summary>' +
      ((t.secHints || SEC_HINT)[sec] ? '<div class="ff-sec-hint">' + esc((t.secHints || SEC_HINT)[sec]) + '</div>' : '') + (canRest ? '<button class="ff-link ff-rest" data-act="restmeets" data-sec="' + esc(sec) + '">Mark the rest as ' + esc(qk.opt === qk.label ? qk.opt : qk.opt + ' (' + qk.label + ')') + '</button>' : '') +
      fieldsHtml(fs) + '</details>';
  });
  if(V.remote) return h + '</div>' + remoteFoot(t, fl);
  h += '</div><div class="ff-export card">' + (V.review ? reviewHtml(t, fl) : '') +
    '<label class="ff-lab" for="ffName">File name</label><div class="ff-namerow"><input class="ff-in" id="ffName" data-in="fname" value="' + esc(cleanName(fl.fileName) || defaultName(t, fl)) + '" maxlength="100" autocomplete="off" spellcheck="false"><span class="ff-ext">' + outExt(t) + '</span></div>' +
    (t.kind === 'acro' ? '<label class="ff-opt"><input type="checkbox" data-in="flatten"' + (V.flatten ? ' checked' : '') + '> Lock the answers so they cannot be changed in the file</label>' : '') +
    '<div class="ff-row"><button class="action" data-act="export">' + (t.builtin ? 'Save as PDF' : 'Save filled ' + (t.kind === 'docx' ? 'Word file' : 'PDF')) + '</button>' + (t.kind !== 'docx' ? '<button class="action secondary" data-act="preview">Preview</button>' : '') + '</div>' +
    '<div class="ff-status" role="status" aria-live="polite">' + esc(V.status) + '</div>' + (V.preview || '') +
    '<div class="panel-hint">The file is made on this device and opens the share sheet: save it to Files, AirDrop it, or attach it to an email. Check every answer before you submit.</div></div>' +
    sendHtml(t, fl);
  return h;
}

/* ---- preceptor links (PRECEPTOR-LINK-V2: no server) ----
   Only the AnesPilot COA forms and the school forms built into the app can be sent (not forms a student uploaded).
   The student fills their own part and chooses who receives it. The link (anespilot.com/eval/#...) carries the form choice,
   the student's answers and the recipient AFTER the "#", which browsers never send to any server. The preceptor fills the
   rest on that page (this same code, "remote" mode); the PDF is made on the preceptor's device and the preceptor emails it
   from their own email to the recipient. Nothing passes through AnesPilot or any other server. */
function profName(){ try{ var p = JSON.parse(localStorage.getItem('anespilot:app:profile') || 'null'); return (p && p.name) || ''; }catch(e){ return ''; } }
function evalPage(){ return String(window.AP_EVAL_PAGE != null ? window.AP_EVAL_PAGE : 'https://anespilot.com/eval/'); }
var EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
var LINK_DAYS = 30;
function links(){ return get('links', []); }
function linksPut(l){ return put('links', l); }
// which forms can go to a preceptor: the AnesPilot forms, and school forms built into this app (opened with the school's code)
function schoolOf(t){ return t && t.schoolHash ? schools().find(function(s){ return s.hash === t.schoolHash; }) : null; }
function canSend(t){
  if(!t) return false;
  if(t.id === COA_ID || t.id === ACP_ID) return true;
  var sc = schoolOf(t); return !!(t.school && sc && sc.code && builtInSealed(t.schoolHash));
}
function formKey(t){ return String(t.id).split('_').slice(2).join('_'); } // sch_<hash12>_<key>
/* link payload: base64url of (deflated) JSON */
function b64url(u){ return bufToB64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s){ s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while(s.length % 4) s += '='; return b64ToU8(s); }
async function zip(u, how){ var st = new Blob([u]).stream().pipeThrough(how === 'in' ? new DecompressionStream('deflate-raw') : new CompressionStream('deflate-raw')); return new Uint8Array(await new Response(st).arrayBuffer()); }
async function encodeLink(obj){
  var u = new TextEncoder().encode(JSON.stringify(obj));
  if(typeof CompressionStream !== 'undefined'){ try{ return '1z.' + b64url(await zip(u, 'out')); }catch(e){} }
  return '1j.' + b64url(u);
}
async function decodeLink(h){
  h = String(h || '').replace(/^#/, ''); var m = /^1([zj])\.([A-Za-z0-9_-]+)$/.exec(h); if(!m) throw new Error('bad');
  var u = unb64url(m[2]);
  if(m[1] === 'z'){ if(typeof DecompressionStream === 'undefined') throw new Error('old'); u = await zip(u, 'in'); }
  return JSON.parse(new TextDecoder().decode(u));
}
// a smaller copy of a signature, so the link stays short
function shrinkSig(v){
  return new Promise(function(res){
    try{ var img = new Image(); img.onload = function(){ var k = Math.min(1, 300 / img.width, 110 / img.height);
      var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      var g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
      // two colors only (ink or nothing): a much smaller PNG, still a clean signature
      var d = g.getImageData(0, 0, c.width, c.height), a = d.data;
      for(var i = 0; i < a.length; i += 4){ var on = a[i + 3] > 90; a[i] = 11; a[i + 1] = 31; a[i + 2] = 92; a[i + 3] = on ? 255 : 0; }
      g.putImageData(d, 0, 0); var out = c.toDataURL('image/png'); res(out.length < v.length ? out : v); };
      img.onerror = function(){ res(v); }; img.src = v; }catch(e){ res(v); }
  });
}
function lockedHtml(f, v, fl){
  var lab = (f.code ? '<span class="ff-code">' + esc(f.code) + '</span>' : '') + esc(f.label) + '<span class="ff-who ff-who-student">From the student</span>';
  var val = !hasValue(f, v) && f.type !== 'check' ? '<div class="ff-ro ff-muted">Left blank by the student</div>' : isSig(v) ? '<div class="ff-sig ff-signed"><img alt="Student signature" src="' + v + '"></div>' : '<div class="ff-ro">' + esc(f.type === 'check' ? (v ? '✓ Yes' : 'No') : v) + '</div>';
  var cv = fl.values[f.id + '__c'];
  return '<div class="ff-q ff-locked" data-q="' + f.id + '"><div class="ff-ql">' + lab + '</div>' + val + (cv ? '<div class="ff-ro ff-small">💬 ' + esc(cv) + '</div>' : '') + '</div>';
}
function remoteHead(t, cnt){
  var L = V.remote.link;
  return '<div class="card ff-rhead"><div class="ff-h2">' + esc(L.formName || t.name) + '</div>' +
    '<div class="ff-small">For <b>' + esc(L.studentName || 'your student') + '</b>' + (L.school ? ' · ' + esc(L.school) : '') + '</div>' +
    '<div class="panel-hint">Fill in your part, then tap <b>Make the PDF</b> at the bottom and email it from your own email to <b>' + esc(L.to) + '</b>. ' +
    'Everything stays on this device: nothing you type is sent to AnesPilot or the student. Never enter patient names or other identifiers.</div></div>' +
    '<div class="ff-prog ff-muted ff-small">' + cnt[0] + ' of ' + cnt[1] + ' filled · kept in this browser until you finish</div>';
}
function remoteFoot(t, fl){
  var R = V.remote, L = R.link, kind = t.kind === 'docx' ? 'Word file' : 'PDF';
  if(R.file) return '<div class="ff-export card ff-sendout"><div class="ff-h3">Email it to ' + esc(L.to) + '</div>' +
    '<ol class="ff-ul ff-steps"><li>Copy the address: <span class="ff-addr">' + esc(L.to) + '</span> <button class="ff-link" data-act="rcopy">Copy</button></li>' +
    '<li>' + (R.canShare ? 'Tap <b>Share ' + kind + '</b>, choose <b>Mail</b> (or Gmail, Outlook), paste the address and send.' : 'Tap <b>Download ' + kind + '</b>, then <b>Open email</b> and attach the downloaded file.') + '</li></ol>' +
    '<div class="ff-row">' + (R.canShare ? '<button class="action" data-act="rshare">Share ' + kind + '</button>' : '<button class="action" data-act="rdownload">Download ' + kind + '</button><button class="action secondary" data-act="rmail">Open email</button>') +
    (R.canShare ? '<button class="action secondary" data-act="rdownload">Download</button>' : '') + '</div>' +
    '<div class="ff-status" role="status" aria-live="polite">' + esc(V.status) + '</div>' + (V.preview || '') +
    '<div class="ff-row"><button class="ff-link" data-act="redit">‹ Change an answer</button><button class="ff-link" data-act="rdone">I sent it: clear this form</button></div>' +
    '<div class="panel-hint">The file is named ' + esc(R.file.name) + '. Clearing the form removes your answers from this browser.</div></div>';
  return '<div class="ff-export card">' + (V.review ? reviewHtml(t, fl) : '') +
    '<div class="ff-row"><button class="action" data-act="export"' + (V.busy ? ' disabled' : '') + '>Make the ' + kind + '</button>' + (t.kind !== 'docx' ? '<button class="action secondary" data-act="preview"' + (V.busy ? ' disabled' : '') + '>Preview</button>' : '') + '</div>' +
    '<div class="ff-status" role="status" aria-live="polite">' + esc(V.status) + '</div>' + (V.preview || '') +
    '<div class="panel-hint">The ' + kind + ' is made on this device. Next you email it to ' + esc(L.to) + ' from your own email.</div></div>';
}
function viewRemoteMsg(){
  var m = V.remote && V.remote.msg || {};
  return '<div class="card ff-rhead ff-rdone"><div class="ff-h2">' + esc(m.title || '') + '</div><p>' + esc(m.body || '') + '</p>' + (m.small ? '<div class="panel-hint">' + esc(m.small) + '</div>' : '') + '</div>';
}
// what the student sends ahead: their own answers only (fields marked for the preceptor are left for the preceptor)
function studentValues(t, fl){
  var out = {}, pre = {};
  t.fields.forEach(function(f){ if(f.who === 'preceptor') pre[f.id] = 1; });
  Object.keys(fl.values || {}).forEach(function(k){ var base = k.replace(/__c$/, ''); if(!pre[base]) out[k] = fl.values[k]; });
  return out;
}
function sendHtml(t, fl){
  if(!canSend(t)) return '';
  var S = V.send;
  if(!S) return '<div class="card ff-send"><div class="ff-h3">Have your preceptor fill it out</div>' +
    '<div class="panel-hint">Fill in your part first. Then send your preceptor a link: they finish the form on their phone or computer and email it from their own email to the person you choose (for example your clinical coordinator). You will not see their answers.</div>' +
    '<div class="ff-row"><button class="action" data-act="sendopen">Send to preceptor</button></div></div>';
  if(S.made){
    var l = S.made;
    return '<div class="card ff-send"><div class="ff-h3">Link ready for your preceptor</div>' +
      '<div class="ff-row"><button class="action" data-act="sendshare">Share link</button><button class="action secondary" data-act="sendcopy">Copy link</button><button class="action secondary" data-act="sendclose">Done</button></div>' +
      '<div class="ff-status ff-sendmsg" role="status" aria-live="polite">' + esc(S.msg || '') + '</div>' +
      '<div class="panel-hint">Your preceptor emails the finished evaluation to <b>' + esc(l.to) + '</b>. The link works until ' + esc(fmtDate(l.expires)) + '. AnesPilot cannot see it or tell you when it is sent, so check with your coordinator.</div></div>';
  }
  var nm = S.name != null ? S.name : (fl.values.student || profName() || '');
  var mine = t.fields.filter(function(f){ return f.who === 'student' && f.type !== 'check' && !f.optional && !/preceptor/i.test(f.label) && !hasValue(f, fl.values[f.id]); });
  return '<div class="card ff-send"><div class="ff-h3">Send to preceptor</div>' +
    (mine.length ? '<div class="ff-review"><div class="ff-rv-t">Your part is not finished</div><div class="ff-small">Your preceptor cannot fill these, and you will not get the form back: ' + mine.map(function(f){ return '<b>' + esc(f.label) + '</b>'; }).join(', ') + '. Fill them first, or send it as it is.</div></div>' : '') +
    '<label class="ff-lab" for="ffSendTo">Who receives the finished evaluation (email)</label><input class="ff-in" id="ffSendTo" data-in="sendto" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" value="' + esc(S.to || '') + '" placeholder="coordinator@school.edu">' +
    '<label class="ff-lab" for="ffSendTo2">Type the email again</label><input class="ff-in" id="ffSendTo2" data-in="sendto2" type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(S.to2 || '') + '">' +
    '<label class="ff-lab" for="ffSendName">Your name (shown to your preceptor)</label><input class="ff-in" id="ffSendName" data-in="sendname" maxlength="80" value="' + esc(nm) + '">' +
    '<div class="ff-row"><button class="action" data-act="sendgo"' + (V.busy ? ' disabled' : '') + '>Create link</button><button class="action secondary" data-act="sendclose">Cancel</button></div>' +
    '<div class="ff-status ff-sendmsg" role="status" aria-live="polite">' + esc(S.msg || '') + '</div>' +
    '<div class="panel-hint">Your answers so far travel inside the link, so anyone with the link can see them. Send it only to your preceptor. Nothing goes through AnesPilot or any server. Never enter patient identifiers.</div></div>';
}
async function createLink(){
  var c = curFill(), t = c.t, fl = c.f, S = V.send; if(!t || !fl || !S) return;
  if(!canSend(t)) return;
  var to = String(S.to || '').trim(), to2 = String(S.to2 || '').trim(), name = String(S.name != null ? S.name : (fl.values.student || profName())).trim();
  var say = function(m){ S.msg = m; var el = V.root && V.root.querySelector('.ff-sendmsg'); if(el) el.textContent = m; };
  if(!EMAIL_RE.test(to)) return say('Type the email address the evaluation should go to.');
  if(to.toLowerCase() !== to2.toLowerCase()) return say('The two email addresses do not match.');
  if(!name) return say('Type your name so your preceptor knows who the evaluation is for.');
  flush();
  var vals = studentValues(t, fl), phi = [];
  t.fields.forEach(function(f){ var v = vals[f.id]; if((f.type === 'text' || f.type === 'long') && v) phiHits(v, f.label).forEach(function(h){ phi.push(fLabel(f) + ': “' + h.match.slice(0, 30) + '” ' + h.why); });
    if(vals[f.id + '__c']) phiHits(vals[f.id + '__c'], '').forEach(function(h){ phi.push(fLabel(f) + ' (comment): ' + h.why); }); });
  if(phi.length) return say('Remove possible patient identifiers first: ' + phi.slice(0, 3).join('; ') + (phi.length > 3 ? '...' : ''));
  V.busy = true; say('Making the link...');
  try{
    for(var k in vals){ if(isSig(vals[k])) vals[k] = await shrinkSig(vals[k]); }
    var sc = schoolOf(t), expires = Date.now() + LINK_DAYS * 86400000;
    var obj = {v: 1, f: (t.id === COA_ID || t.id === ACP_ID) ? {b: t.id} : {c: sc.code, k: formKey(t)}, n: name, to: to, p: vals, fn: defaultName(t, fl), x: expires};
    var url = evalPage() + '#' + await encodeLink(obj);
    var l = {id: uid(), url: url, to: to, tid: t.id, tname: t.name, cat: catOf(t), student: name, created: Date.now(), expires: expires};
    linksPut([l].concat(links()).slice(0, 100));
    V.send = {made: l, msg: url.length > 12000 ? 'This link is long because of your signature. If a text message cuts it off, use Copy link and send it by email.' : ''};
  }catch(err){ say('The link could not be made: ' + ((err && err.message) || 'unknown error')); V.busy = false; return; }
  V.busy = false; render(true);
}
function linksHtml(cat){
  var now = Date.now(), ls = links().filter(function(l){ return (l.cat || 'eval') === cat; });
  if(!ls.length) return '';
  var h = '<div class="ff-h2">Links you sent</div><div class="card ff-links">';
  ls.slice(0, 20).forEach(function(l){
    var open = !l.expires || now < l.expires;
    h += '<div class="ff-linkrow"><div><div class="ff-item-n">' + esc(l.tname) + '</div><div class="ff-item-s' + (open ? '' : ' ff-st-expired') + '">' + (open ? 'Open until ' + esc(fmtDate(l.expires)) : 'Expired') + '</div>' +
      '<div class="ff-muted ff-small">To ' + esc(l.to) + ' · made ' + esc(fmtDate(l.created)) + '</div></div>' +
      '<div class="ff-item-b">' + (open ? '<button class="ff-link" data-act="linkshare" data-id="' + esc(l.id) + '">Share again</button>' : '') +
      '<button class="ff-link ff-danger" data-act="linkforget" data-id="' + esc(l.id) + '">Remove</button></div></div>';
  });
  return h + '<div class="panel-hint">Your preceptor emails the evaluation from their own email. AnesPilot cannot see whether it was sent, so check with the person who receives it.</div></div>';
}
// Forms main screen: "Send to preceptor" starts a new copy of the chosen form with the send panel open
function sendPickHtml(cat, C, bt){
  var forms = [bt].concat(index().filter(function(t){ return (t.cat || 'eval') === cat; }).map(function(x){ return tplGet(x.id); }).filter(canSend));
  var h = '<div class="card ff-send ff-sendmain"><div class="ff-h3">Send to your preceptor</div>' +
    '<div class="panel-hint">Fill in your part, then send your preceptor a link. They complete the ' + C.one + ' on their phone or computer and email it to the person you choose. You will not see their answers. Works with the AnesPilot form and your school\'s forms in AnesPilot.</div>';
  if(!V.pick) return h + '<div class="ff-row"><button class="action" data-act="sendpick">Send to preceptor</button></div></div>';
  h += '<div class="ff-h3 ff-pickh">Which form?</div><div class="ff-pick">' + forms.map(function(t){
    return '<button class="action secondary ff-pickbtn" data-act="sendform" data-id="' + esc(t.id) + '">' + esc(t.name) + (t.school ? '<span class="ff-muted ff-small"> · ' + esc(t.school) + '</span>' : '') + '</button>'; }).join('') + '</div>' +
    '<div class="ff-row"><button class="ff-link" data-act="sendpickclose">Cancel</button></div>';
  return h + '</div>';
}
function shareUrl(url, title){
  var wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.anespilotShare;
  if(wk){ try{ wk.postMessage({url: url, text: 'Please fill out my clinical evaluation:'}); return Promise.resolve(true); }catch(e){} } // the iOS app's share sheet
  if(navigator.share) return navigator.share({title: title || 'Evaluation', text: 'Please fill out my clinical evaluation:', url: url}).then(function(){ return true; }, function(){ return false; });
  return copyText(url).then(function(ok){ if(ok) toast('Link copied'); return ok; });
}
function copyText(s){
  if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s).then(function(){ return true; }, function(){ return legacyCopy(s); });
  return Promise.resolve(legacyCopy(s));
}
function legacyCopy(s){ try{ var ta = document.createElement('textarea'); ta.value = s; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); return ok; }catch(e){ return false; } }
// preceptor page: the file is made first (it takes a moment), then a fresh tap shares it (browsers need a tap for sharing)
function remoteFile(){ var R = V.remote, f = R.file; return new File([f.bytes], f.name, {type: f.mime}); }
function remoteSubject(){ var L = V.remote.link; return 'Clinical evaluation for ' + (L.studentName || 'student') + ': ' + (L.formName || 'evaluation'); }
/* the school's form, straight from the sealed copy built into this app or page (nothing is stored) */
async function schoolForm(code, key){
  var pk = lookupPack(code); if(!pk) return null;
  for(var i = 0; i < pk.forms.length; i++){
    var f = pk.forms[i], k = String(f.key || ('form' + (i + 1))).replace(/[^\w-]/g, '').slice(0, 30);
    if(k !== key) continue;
    var t = packTemplate(pk, f, i, pk.hash);
    return {tpl: t, buf: f.kind !== 'builtin' ? b64ToBuf(f.file) : null, school: t.school};
  }
  return null;
}

/* ---- signature pad ---- */
function sigTrim(c){
  var g = c.getContext('2d'), W = c.width, H = c.height, d = g.getImageData(0, 0, W, H).data, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for(var y = 0; y < H; y++) for(var x = 0; x < W; x++) if(d[(y * W + x) * 4 + 3] > 8){ if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; }
  if(x1 < 0) return '';
  var pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  var w = x1 - x0 + 1, h = y1 - y0 + 1, k = Math.min(1, 700 / w, 260 / h), o = document.createElement('canvas');
  o.width = Math.max(1, Math.round(w * k)); o.height = Math.max(1, Math.round(h * k)); o.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, o.width, o.height);
  return o.toDataURL('image/png');
}
function mountSigPads(root){
  root.querySelectorAll('canvas.ff-pad').forEach(function(c){
    var id = c.dataset.sig, dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1)), r0 = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r0.width * dpr)); c.height = Math.max(1, Math.round(r0.height * dpr));
    var g = c.getContext('2d'); g.lineWidth = 2.6 * dpr; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = g.fillStyle = '#0b1f5c';
    var down = false, pts = [];
    var pos = function(e){ var r = c.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
    var mid = function(a, b){ return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
    var seg = function(){ var n = pts.length; g.beginPath();
      if(n < 3){ g.moveTo(pts[0][0], pts[0][1]); g.lineTo(pts[n - 1][0], pts[n - 1][1]); }
      else { var a = mid(pts[n - 3], pts[n - 2]), b = mid(pts[n - 2], pts[n - 1]); g.moveTo(a[0], a[1]); g.quadraticCurveTo(pts[n - 2][0], pts[n - 2][1], b[0], b[1]); }
      g.stroke(); };
    c.addEventListener('pointerdown', function(e){ e.preventDefault(); down = true; try{ c.setPointerCapture(e.pointerId); }catch(_){}
      pts = [pos(e)]; g.beginPath(); g.arc(pts[0][0], pts[0][1], g.lineWidth / 2, 0, 2 * Math.PI); g.fill(); c.parentNode.classList.add('ff-inked'); });
    c.addEventListener('pointermove', function(e){ if(!down) return; e.preventDefault(); (e.getCoalescedEvents ? e.getCoalescedEvents() : [e]).forEach(function(ev){ pts.push(pos(ev)); seg(); }); });
    var up = function(){ if(!down) return; down = false; setValue(id, sigTrim(c), true); };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up); c.addEventListener('lostpointercapture', up);
    c.addEventListener('touchstart', function(e){ e.preventDefault(); }, {passive: false}); c.addEventListener('touchmove', function(e){ e.preventDefault(); }, {passive: false});
  });
}

/* ---- values ---- */
function setValue(fid, v, quiet){
  var t = tplGet(V.tid); if(!t) return; var list = fillsGet(t.id), fl = list.find(function(x){ return x.id === V.fill; }); if(!fl) return;
  if(v === '' || v == null || v === false) delete fl.values[fid]; else fl.values[fid] = v;
  fl.updated = Date.now(); V._pending = {tid: t.id, list: list};
  clearTimeout(saveTimer); saveTimer = setTimeout(flush, quiet ? 0 : 350);
  var c = countDone(t, fl.values), p = V.root && V.root.querySelector('.ff-prog'); if(p) p.textContent = c[0] + ' of ' + c[1] + ' filled · saved on this device';
  if(!cleanName(fl.fileName)){ var ni = V.root && V.root.querySelector('#ffName'); if(ni && document.activeElement !== ni) ni.value = defaultName(t, fl); }
  V.preview = ''; var pv = V.root && V.root.querySelector('.ff-preview'); if(pv) pv.remove();
  refreshReview();
}
function flush(){ clearTimeout(saveTimer); var p = V._pending; V._pending = null; if(p) fillsPut(p.tid, p.list); }

/* ---- the original file ---- */
function chooseFile(accept){
  return new Promise(function(res){ var i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.style.display = 'none';
    i.onchange = function(){ var f = i.files && i.files[0]; i.remove(); res(f || null); }; document.body.appendChild(i); i.click(); });
}
async function originalBytes(t){
  if(V.remote) return V.remote.buf ? V.remote.buf.slice(0) : null;
  var rec = await fileLoad(t.id); if(rec && rec.buf) return rec.buf;
  if(t.schoolHash){ try{ if(await restoreSchoolFile(t)){ rec = await fileLoad(t.id); if(rec && rec.buf) return rec.buf; } }catch(e){}
    setStatus('Your school\'s blank form is not on this device. Remove the school forms and enter the code again.'); return null; }
  setStatus('The blank ' + (t.kind === 'docx' ? 'Word file' : 'form') + ' is not on this device any more (for example after restoring a backup). Choose it again.');
  var f = await chooseFile(t.kind === 'docx' ? '.docx' : '.pdf,application/pdf,image/*'); if(!f) return null;
  var buf = await f.arrayBuffer();
  if(t.kind === 'scan' && /^image\//.test(f.type)) buf = await imageToPdf(f, buf);
  if(t.size && buf.byteLength !== t.size) V.warn = 'This file is not the same as the one you set up, so check that every answer landed in the right place. ';
  await fileSave(t.id, buf, f.name); return buf;
}
function offer(name, bytes, mime){
  var blob = new Blob([bytes], {type: mime}), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ try{ URL.revokeObjectURL(a.href); }catch(e){} }, 60000);
}
function outExt(t){ return t.kind === 'docx' ? '.docx' : '.pdf'; }
function defaultName(t, fl){
  var v = fl.values || {}, who = v.student || '', d = v.date || '';
  if(t.builtin || t.school){ var base = catOf(t) === 'acp' ? (t.school ? fileSafe(t.name) : 'Care-Plan') : 'Daily-Evaluation'; return base + (who ? '-' + fileSafe(who) : '') + (d ? '-' + d : (who ? '' : '-' + fileSafe(fl.title))); }
  return fl.title.indexOf(t.name) === 0 ? fileSafe(fl.title) : fileSafe(t.name) + '-' + fileSafe(fl.title);
}
function cleanName(s){ return String(s || '').replace(/\.(pdf|docx)$/i, '').replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100); }
function outName(t, fl){ return (cleanName(fl.fileName) || defaultName(t, fl)) + outExt(t); }
async function makeFile(){
  var c = curFill(); if(!c.t || !c.f) return null; flush();
  if(c.t.builtin){ var rb = c.t.id === COA_ID ? await builtinPdf(c.t, c.f.values) : await genericPdf(c.t, c.f.values); rb.name = outName(c.t, c.f); return rb; }
  var buf = await originalBytes(c.t); if(!buf) return null;
  var r = c.t.kind === 'docx' ? await fillDocxFile(c.t, buf, c.f.values) : await fillPdf(c.t, buf, c.f.values, {flatten: V.flatten});
  r.name = outName(c.t, c.f); return r;
}
function report(r){ return 'Filled ' + r.filled + (r.filled === 1 ? ' field' : ' fields') + (r.missed.length ? '. Could not fill: ' + r.missed.slice(0, 4).join(', ') + (r.missed.length > 4 ? '...' : '') : '') + (r.overflow ? '. ' + r.overflow + ' long answers continue on an added last page' : '') + '.'; }
async function pagesHtml(bytes, max){
  var lib = await pdfjs(), doc = await openPdf(lib, bytes), h = '<div class="ff-preview">';
  for(var i = 1; i <= Math.min(doc.numPages, max); i++){
    var pg = await doc.getPage(i), vp = pg.getViewport({scale: 1.4}), c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await pg.render({canvasContext: g, canvas: c, viewport: vp}).promise; h += '<img alt="Filled page ' + i + '" src="' + c.toDataURL('image/jpeg', 0.85) + '">'; c.width = c.height = 1;
  }
  try{ doc.destroy(); }catch(e){}
  return h + (doc.numPages > max ? '<div class="ff-muted ff-small">First ' + max + ' pages shown.</div>' : '') + '</div>';
}

/* ---- adding and saving a form ---- */
async function addFile(file){
  if(!file || V.busy) return;
  V.busy = true; render(true);
  try{
    var r = await readTemplate(file, setStatus);
    if(!V.root || !V.root.isConnected) return;
    r.fields.forEach(function(f){ if(f.tgt.acro && f.type === 'check') f._acroCheck = true; });
    V.draft = {id: null, cat: V.cat || 'eval', name: r.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 80) || 'My form', fileName: r.name, kind: r.kind, fields: r.fields, pages: r.pages, total: r.total, buf: r.buf, size: r.buf.byteLength};
    V.busy = false; go('review', {hit: null});
  }catch(e){ V.busy = false; V.status = (e && e.message) || 'This file could not be read.'; render(true); }
}
async function editTpl(id){
  var t = tplGet(id); if(!t) return;
  V.draft = {id: t.id, name: t.name, fileName: t.fileName, kind: t.kind, fields: JSON.parse(JSON.stringify(t.fields)), pages: t.pages.map(function(p){ return Object.assign({}, p); }), total: t.total, size: t.size};
  go('review', {hit: null});
  if(t.kind === 'docx') return;
  var rec = await fileLoad(t.id); if(!rec || !rec.buf) return;
  try{ var rd = await readPdf(rec.buf, false); if(V.view === 'review' && V.draft && V.draft.id === t.id){ rd.pages.forEach(function(p, i){ if(V.draft.pages[i]) V.draft.pages[i].img = p.img; }); render(true); } }catch(e){}
}
async function saveTpl(){
  var d = V.draft; if(!d) return;
  var id = d.id || uid(), now = Date.now(), old = d.id ? tplGet(d.id) : null;
  var t = {id: id, cat: (old && old.cat) || d.cat || V.cat || 'eval', name: (d.name || 'My form').trim(), fileName: d.fileName, kind: d.kind, size: d.size, total: d.total,
    pages: d.pages.map(function(p){ return {w: p.w, h: p.h, t: p.t}; }), fields: d.fields, created: old ? old.created : now, updated: now};
  if(d.buf){ setStatus('Saving...'); var ok = await fileSave(id, d.buf, d.fileName); if(!ok) toast('The blank file could not be kept on this device. You will be asked for it when you save a filled copy.'); }
  if(!put('tpl:' + id, t)) return;
  var list = index().filter(function(x){ return x.id !== id; }); list.unshift({id: id, cat: t.cat, name: t.name, kind: t.kind, nFields: t.fields.filter(function(f){ return f.type !== 'skip'; }).length, created: t.created});
  put('index', list); V.draft = null; toast('Form saved');
  go('fills', {tid: id});
}
function newFill(tid, from){
  var t = tplGet(tid); if(!t) return; var list = fillsGet(tid), now = Date.now(), vals = {};
  if(from) Object.keys(from.values).forEach(function(k){ if(!isSig(from.values[k])) vals[k] = from.values[k]; });
  var f = {id: uid(), title: (from ? from.title + ' (copy)' : (t.builtin ? (catOf(t) === 'acp' ? 'Care plan' : 'Evaluation') : t.name) + ' ' + fmtDate(now)), created: now, updated: now, values: vals};
  list.push(f); if(fillsPut(tid, list)) go('fill', {tid: tid, fill: f.id});
}

/* ---- events ---- */
function fieldById(id){ return V.draft && V.draft.fields.find(function(f){ return f.id === id; }); }
async function onClick(e){
  var el = e.target.closest('[data-act]');
  if(!el){
    var pg = e.target.closest('.ff-page'); if(pg && V.adding && V.view === 'review') addBox(pg, e); return;
  }
  var act = el.dataset.act, id = el.dataset.id, d = V.draft;
  if(act === 'hit' && V.adding){ var pg2 = el.closest('.ff-page'); if(pg2) addBox(pg2, e); return; }
  switch(act){
    case 'open': flush(); go('fills', {tid: id}); break;
    case 'home': flush(); go('list'); break;
    case 'back': flush(); go('fills'); break;
    case 'edit': flush(); editTpl(id); break;
    case 'cancel': V.draft = null; go(V.tid && tplGet(V.tid) && d && d.id ? 'fills' : 'list'); break;
    case 'cmt': V.cOpen[el.dataset.f] = !(el.getAttribute('aria-expanded') === 'true'); render(true); if(V.cOpen[el.dataset.f]){ var ta = V.root.querySelector('[data-f="' + el.dataset.f + '__c"]'); if(ta) ta.focus(); } break;
    case 'restmeets':
      var cf = curFill(); if(!cf.t || !cf.f) return; var nset = 0, qk2 = cf.t.quick || {opt: 'Meets'};
      cf.t.fields.forEach(function(f){ if((f.section || '') === el.dataset.sec && f.type === 'rating' && f.quick !== false && (f.options || []).indexOf(qk2.opt) !== -1 && !hasValue(f, cf.f.values[f.id])){ setValue(f.id, qk2.opt, true); nset++; } });
      flush(); toast(nset + ' marked ' + qk2.opt); render(true); break;
    case 'code':
      var code = (V.root.querySelector('#ffCode') || {}).value || V.code; V.code = code;
      if(normCode(code).length < 4){ V.codeMsg = 'Type the code your program gave you.'; render(true); return; }
      V.busy = true; V.codeMsg = 'Checking your code...'; render(true);
      await new Promise(function(r){ setTimeout(r, 30); });
      try{ var pk = lookupPack(code);
        if(!pk) V.codeMsg = 'That code was not found. Check it with your program.';
        else { var got = await installPack(pk, pk.hash, code); V.code = ''; var here = got.filter(function(id){ return catOf(tplGet(id)) === (V.cat || 'eval'); }).length, other = got.length - here;
          V.codeMsg = (pk.school || 'Your school') + ': ' + here + ' ' + CAT[V.cat || 'eval'].one + ' form' + (here === 1 ? '' : 's') + ' added below' + (other ? ', and ' + other + ' in ' + CAT[(V.cat || 'eval') === 'acp' ? 'eval' : 'acp'].title : '') + '.'; toast('School forms added'); } }
      catch(err){ V.codeMsg = 'The forms could not be added: ' + ((err && err.message) || 'unknown error') + '.'; }
      V.busy = false; render(true); break;
    case 'rmschool':
      if(V.confirm !== 'sch' + id){ V.confirm = 'sch' + id; render(true); return; }
      removeSchool(id); V.confirm = null; toast('School forms removed'); render(true); break;
    case 'mkpack':
      var ids = Array.prototype.map.call(V.root.querySelectorAll('.ff-pk:checked'), function(x){ return x.value; }), sch = (V.root.querySelector('#ffPkSchool') || {}).value || '', cd = (V.root.querySelector('#ffPkCode') || {}).value || '';
      var pm = V.root.querySelector('.ff-pkmsg'), say = function(m){ if(pm) pm.textContent = m; };
      if(!ids.length) return say('Pick at least one form.'); if(!sch.trim()) return say('Type the school and program name.'); if(normCode(cd).length < 6) return say('Choose a code with at least 6 letters or numbers.');
      say('Sealing the forms with your code...'); await new Promise(function(r){ setTimeout(r, 30); });
      try{ var sealed = await buildPack(sch, cd, ids), json = JSON.stringify(sealed);
        offer('school-forms-' + sealed.id.slice(0, 12) + '.json', new TextEncoder().encode(json), 'application/json');
        say('Made a sealed school form file for code ' + normCode(cd) + '. Only that code opens it. Send the file to AnesPilot to add it to the app, and keep the code to give to your students.'); }
      catch(err){ say((err && err.message) || 'The file could not be made.'); }
      break;
    case 'deltpl':
      if(id === COA_ID) return;
      if(V.confirm !== 'tpl' + id){ V.confirm = 'tpl' + id; render(true); return; }
      del('tpl:' + id); del('fills:' + id); fileDrop(id); put('index', index().filter(function(x){ return x.id !== id; })); V.confirm = null; toast('Form deleted'); render(true); break;
    case 'olddl': if(typeof claudeOldDownload === 'function') claudeOldDownload('careplan'); break;
    case 'sendpick': V.pick = true; render(true); break;
    case 'sendpickclose': V.pick = false; render(true); break;
    case 'sendform': V.pick = false; flush(); newFill(id); if(V.view === 'fill'){ V.send = {}; V.sendTop = true; render(false); } break;
    case 'sendjump': flush(); render(true); var sj = V.root.querySelector('#ffSendTo'); if(sj){ sj.scrollIntoView({block: 'center', behavior: 'smooth'}); sj.focus({preventScroll: true}); } break;
    case 'sendopen': flush(); V.send = {}; render(true); var sf = V.root.querySelector('#ffSendTo'); if(sf){ sf.scrollIntoView({block: 'center', behavior: 'smooth'}); sf.focus(); } break;
    case 'sendclose': V.send = null; V.sendTop = false; render(true); break;
    case 'sendgo': if(!V.busy) await createLink(); break;
    case 'sendshare': if(V.send && V.send.made) await shareUrl(V.send.made.url, V.send.made.tname); break;
    case 'sendcopy': if(V.send && V.send.made){ var okc = await copyText(V.send.made.url); V.send.msg = okc ? 'Link copied. Paste it in a text or email to your preceptor.' : 'Select the link above and copy it.'; var sm = V.root.querySelector('.ff-sendmsg'); if(sm) sm.textContent = V.send.msg; } break;
    case 'linkshare': var ls1 = links().find(function(x){ return x.id === id; }); if(ls1) await shareUrl(ls1.url, ls1.tname); break;
    case 'linkforget': linksPut(links().filter(function(x){ return x.id !== id; })); render(true); break;
    /* preceptor page */
    case 'rcopy': var okr = await copyText(V.remote.link.to); setStatus(okr ? 'Address copied.' : 'Select the address and copy it.'); break;
    case 'rshare':
      try{ await navigator.share({files: [remoteFile()], title: remoteSubject(), text: remoteSubject()}); setStatus('Shared. If you emailed it, tap "I sent it" below.'); }
      catch(e2){ if(!(e2 && e2.name === 'AbortError')) setStatus('Sharing did not work here. Tap Download, then attach the file to an email.'); }
      break;
    case 'rdownload': offer(V.remote.file.name, V.remote.file.bytes, V.remote.file.mime); setStatus('Downloaded. Attach it to an email to ' + V.remote.link.to + '.'); break;
    case 'rmail': location.href = 'mailto:' + encodeURIComponent(V.remote.link.to) + '?subject=' + encodeURIComponent(remoteSubject()) + '&body=' + encodeURIComponent('The completed evaluation is attached.'); break;
    case 'redit': V.remote.file = null; V.preview = ''; V.status = ''; render(true); break;
    case 'rdone':
      del(fkey(V.tid)); V._pending = null; V.remote.file = null;
      V.remote.msg = {title: 'Thank you', body: 'The form was cleared from this browser.', small: 'If you have not emailed the file yet, open the link again: you would have to fill it out again.'};
      V.view = 'remotemsg'; render(false); break;
    case 'addmode': V.adding = !V.adding; render(true); break;
    case 'hit':
      V.hit = el.dataset.f; render(true); var card = document.getElementById('ffc-' + V.hit); if(card) card.scrollIntoView({block: 'center', behavior: 'smooth'}); break;
    case 'fdel': d.fields = d.fields.filter(function(f){ return f.id !== el.dataset.f; }); render(true); break;
    case 'join':
      var i = d.fields.findIndex(function(f){ return f.id === el.dataset.f; }), a = d.fields[i - 1], b = d.fields[i]; if(!a || !b) return;
      a.tgt.slots = a.tgt.slots.concat(b.tgt.slots); a.boxes = a.boxes.concat(b.boxes); if(a.type === 'text') a.type = 'long'; d.fields.splice(i, 1); render(true); break;
    case 'size':
      var f = fieldById(el.dataset.f), bx = f && f.boxes[0]; if(!bx) return; var k = el.dataset.d, step = k[0] === 'w' ? 20 : 6, pgw = d.pages[bx.page - 1];
      if(k === 'w+') bx.w = Math.min(pgw.w - bx.x, bx.w + step); if(k === 'w-') bx.w = Math.max(14, bx.w - step);
      if(k === 'h+') bx.h = Math.min(pgw.h - bx.y, bx.h + step); if(k === 'h-') bx.h = Math.max(8, bx.h - step);
      f.tgt.slots[0] = bx; render(true); break;
    case 'savetpl': saveTpl(); break;
    case 'newfill': newFill(V.tid); break;
    case 'openfill': go('fill', {fill: id}); break;
    case 'copyfill': var src = fillsGet(V.tid).find(function(x){ return x.id === id; }); if(src) newFill(V.tid, src); break;
    case 'delfill':
      if(V.confirm !== 'fill' + id){ V.confirm = 'fill' + id; render(true); return; }
      fillsPut(V.tid, fillsGet(V.tid).filter(function(x){ return x.id !== id; })); V.confirm = null; render(true); break;
    case 'rate':
      var on = el.getAttribute('aria-pressed') === 'true';
      el.parentNode.querySelectorAll('.ff-chip').forEach(function(c){ c.setAttribute('aria-pressed', 'false'); });
      if(!on) el.setAttribute('aria-pressed', 'true'); setValue(el.dataset.f, on ? '' : el.dataset.o);
      var rf = (curFill().t.fields || []).find(function(x){ return x.id === el.dataset.f; }) || {}, low = rf.lowOpts ? rf.lowOpts.indexOf(el.dataset.o) !== -1 : /^(Below|Not met|Unsatisfactory)$/i.test(el.dataset.o);
      if(!on && low && !V.cOpen[el.dataset.f]){ V.cOpen[el.dataset.f] = true; flush(); render(true); var tb = V.root.querySelector('[data-f="' + el.dataset.f + '__c"]'); if(tb) tb.focus(); }
      var sd = el.closest('details.ff-sec'); if(sd){ var cf2 = curFill(), sk = sd.dataset.sec.split('|').slice(1).join('|'), fsx = cf2.t.fields.filter(function(f){ return f.type !== 'skip' && (f.section || '') === sk; }), dn = fsx.filter(function(f){ return hasValue(f, cf2.f.values[f.id]); }).length, nn = sd.querySelector('.ff-sec-n'); if(nn){ nn.textContent = dn + ' / ' + fsx.length; nn.classList.toggle('ff-sec-done', dn === fsx.length); } }
      break;
    case 'tick':
      var now = el.getAttribute('aria-checked') !== 'true'; el.setAttribute('aria-checked', String(now)); el.querySelector('.ff-tick').textContent = now ? '✓' : ''; setValue(el.dataset.f, now); break;
    case 'sigclear': setValue(el.dataset.f, '', true); flush(); render(true); break;
    case 'reviewclose': V.review = false; render(true); break;
    case 'jump': jumpTo(el.dataset.f, !!el.dataset.cmt); break;
    case 'exportnow': act = 'export'; V.checkedOk = true;
    // falls through
    case 'export': case 'preview':
      if(V.busy) return;
      if(act === 'export' && !V.checkedOk){
        flush(); var ck = curFill(), rr = ck.t && ck.f ? fillCheck(ck.t, ck.f) : {empty: [], phi: []};
        if(rr.empty.length || rr.phi.length){ V.review = true; V.status = ''; render(true); var rv = V.root.querySelector('.ff-review'); if(rv) rv.scrollIntoView({block: 'start', behavior: 'smooth'}); break; }
      }
      V.checkedOk = false; V.busy = true; setStatus(act === 'export' ? 'Making your file...' : 'Making a preview...');
      try{
        var r = await makeFile();
        if(r && act === 'export' && V.remote){ V.review = false; flush();
          var mime = curFill().t.kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
          V.remote.file = {name: r.name, bytes: r.bytes, mime: mime};
          try{ V.remote.canShare = !!(navigator.canShare && navigator.share && navigator.canShare({files: [remoteFile()]})); }catch(e3){ V.remote.canShare = false; }
          V.status = ''; V.preview = curFill().t.kind !== 'docx' ? await pagesHtml(r.bytes, 1) : ''; V.busy = false; render(true);
          var so = V.root.querySelector('.ff-sendout'); if(so) so.scrollIntoView({block: 'start', behavior: 'smooth'}); break; }
        if(r){ if(act === 'export'){ V.review = false; } if(act === 'export') offer(r.name, r.bytes, curFill().t.kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf');
          V.status = (V.warn || '') + report(r) + (act === 'export' ? '' : V.remote ? ' Tap Make the PDF when it looks right.' : ' Tap Save filled PDF when it looks right.');
          V.preview = curFill().t.kind !== 'docx' ? await pagesHtml(r.bytes, act === 'export' ? 2 : 6) : ''; }
        else V.status = '';
      }catch(err){ V.status = 'The file could not be made: ' + ((err && err.message) || 'unknown error') + '.'; }
      V.busy = false; render(true); break;
  }
}
function addBox(pgEl, e){
  var d = V.draft, pn = +pgEl.dataset.page, pg = d.pages[pn - 1], r = pgEl.getBoundingClientRect(); if(!pg) return;
  var x = (e.clientX - r.left) / r.width * pg.w, y = (e.clientY - r.top) / r.height * pg.h;
  var b = {page: pn, x: Math.max(0, Math.min(pg.w - 150, x - 4)), y: Math.max(0, Math.min(pg.h - 16, y - 8)), w: 150, h: 16, kind: 'manual'};
  var n = d.fields.reduce(function(m, f){ return Math.max(m, +String(f.id).replace(/\D/g, '') || 0); }, 0) + 1;
  var f = {id: 'f' + n, label: 'New field', type: 'text', tgt: {slots: [b]}, boxes: [b]};
  var at = d.fields.findIndex(function(o){ var q = o.boxes && o.boxes[0]; return q && (q.page > pn || (q.page === pn && q.y > b.y + 4)); });
  if(at < 0) d.fields.push(f); else d.fields.splice(at, 0, f);
  V.adding = false; V.hit = f.id; render(true);
  var inp = V.root.querySelector('#ffc-' + f.id + ' input'); if(inp){ inp.focus(); inp.select(); }
}
// drag a box you placed yourself
var drag = null;
function onDown(e){
  var ov = e.target.closest('.ff-ov-man'); if(!ov || V.view !== 'review' || V.adding) return;
  var f = fieldById(ov.dataset.f), pgEl = ov.closest('.ff-page'); if(!f || !pgEl) return;
  e.preventDefault(); drag = {f: f, el: ov, pg: pgEl, x0: e.clientX, y0: e.clientY, bx: f.boxes[0].x, by: f.boxes[0].y, moved: false};
  try{ ov.setPointerCapture(e.pointerId); }catch(_){}
}
function onMove(e){
  if(!drag) return; var r = drag.pg.getBoundingClientRect(), pg = V.draft.pages[drag.f.boxes[0].page - 1], b = drag.f.boxes[0];
  var dx = (e.clientX - drag.x0) / r.width * pg.w, dy = (e.clientY - drag.y0) / r.height * pg.h; if(Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
  b.x = Math.max(0, Math.min(pg.w - b.w, drag.bx + dx)); b.y = Math.max(0, Math.min(pg.h - b.h, drag.by + dy));
  drag.el.style.left = (b.x / pg.w * 100) + '%'; drag.el.style.top = (b.y / pg.h * 100) + '%';
}
function onUp(){ if(!drag) return; drag.f.tgt.slots[0] = drag.f.boxes[0]; drag = null; }
function onInput(e){
  var el = e.target, k = el.dataset.in; if(!k) return;
  if(k === 'val' || k === 'ftitle' || k === 'fname') setTimeout(refreshReview, 0);
  if(k === 'val') setValue(el.dataset.f, el.value);
  else if(k === 'ftitle'){ var t = tplGet(V.tid), list = fillsGet(V.tid), fl = list.find(function(x){ return x.id === V.fill; }); if(fl){ fl.title = el.value.slice(0, 80) || 'Untitled'; fl.updated = Date.now(); V._pending = {tid: t.id, list: list}; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 350); } }
  else if(k === 'tname' && V.draft) V.draft.name = el.value;
  else if(k === 'flabel'){ var f = fieldById(el.dataset.f); if(f) f.label = el.value; }
  else if(k === 'fsec'){ var fs = fieldById(el.dataset.f); if(fs){ if(el.value.trim()) fs.section = el.value.trim(); else delete fs.section; } }
  else if(k === 'code'){ V.code = el.value; }
  else if(k === 'sendto' && V.send){ V.send.to = el.value; }
  else if(k === 'sendto2' && V.send){ V.send.to2 = el.value; }
  else if(k === 'sendname' && V.send){ V.send.name = el.value; }
  else if(k === 'fname'){ var tn = tplGet(V.tid), ln = fillsGet(V.tid), fn = ln.find(function(x){ return x.id === V.fill; }); if(fn){ fn.fileName = el.value; V._pending = {tid: tn.id, list: ln}; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 350); } }
}
function onChange(e){
  var el = e.target, k = el.dataset.in; if(!k) return;
  if(k === 'add'){ var file = el.files && el.files[0]; el.value = ''; addFile(file); }
  else if(k === 'packfile'){ var pf = el.files && el.files[0]; el.value = ''; if(pf) pf.text().then(function(txt){ var pk = null, cd2 = (V.root.querySelector('#ffCode') || {}).value || V.code; try{ pk = JSON.parse(txt); }catch(x){}
      if(pk && pk.format === 'anespilot-school-forms-enc'){ if(normCode(cd2).length < 4){ V.codeMsg = 'Type your school code first, then open the file.'; render(true); return; } pk = openSealed(pk, cd2); if(!pk){ V.codeMsg = 'That code does not open this file.'; render(true); return; } }
      if(!validPack(pk)){ V.codeMsg = 'That is not an AnesPilot school form file.'; render(true); return; }
      pk._fromFile = true; V.code = ''; return installPack(pk, pk.hash, cd2).then(function(got){ V.codeMsg = (pk.school || 'School') + ': ' + got.length + ' form' + (got.length === 1 ? '' : 's') + ' added below.'; render(true); }); }).catch(function(){ V.codeMsg = 'That file could not be read.'; render(true); }); }
  else if(k === 'flatten') V.flatten = el.checked;
  else if(k === 'ftype'){ var f = fieldById(el.dataset.f); if(f){ f.type = el.value; if(f.type === 'rating' && !f.options) f.options = ['Yes', 'No']; render(true); } }
  else if(k === 'fopts'){
    var f2 = fieldById(el.dataset.f); if(!f2) return;
    var opts = el.value.split(',').map(function(s){ return s.trim(); }).filter(Boolean), old = f2.options || [], t = f2.tgt;
    if(new Set(opts).size !== opts.length){ setStatus('Each choice needs a different name.'); el.value = old.join(', '); return; }
    var keyed = t.optSlots ? 'optSlots' : t.acroMap ? 'acroMap' : t.radio ? 'vals' : null;
    if(keyed){
      if(opts.length !== old.length){ setStatus('This rating has ' + old.length + ' boxes on the form, so keep ' + old.length + ' choices.'); el.value = old.join(', '); return; }
      var m = {}; old.forEach(function(o, i){ m[opts[i]] = t[keyed][o]; }); t[keyed] = m;
    }
    f2.options = opts; setStatus('');
  }
}
function onKey(e){
  if(e.key === 'Enter' && e.target.id === 'ffCode'){ e.preventDefault(); var b = V.root.querySelector('[data-act="code"]'); if(b) b.click(); return; }
  if(e.key === 'Enter' && e.target.dataset && e.target.dataset.act){ e.preventDefault(); e.target.click(); } }

function mount(root, cat){
  cat = cat === 'acp' ? 'acp' : 'eval';
  if(V.cat !== cat){ V.cat = cat; V.view = 'list'; V.tid = null; V.fill = null; V.draft = null; V.code = ''; }
  V.remote = null; listen(root);
  if(V.view === 'review' && !V.draft) V.view = 'list';
  if((V.view === 'fills' || V.view === 'fill') && (!tplGet(V.tid) || catOf(tplGet(V.tid)) !== V.cat)) V.view = 'list';
  if(V.view === 'fill' && !curFill().f) V.view = 'fills';
  V.busy = false; V.status = ''; V.preview = ''; V.confirm = null; V.adding = false; V.codeMsg = '';
  render(false);
  refreshSchools().then(function(){ if(V.root && V.view === 'list') render(true); });
}
function listen(root){
  V.root = root; root.classList.add('ff-root');
  if(root.__ffOn) return; root.__ffOn = true;
  root.addEventListener('click', onClick); root.addEventListener('input', onInput); root.addEventListener('change', onChange);
  root.addEventListener('pointerdown', onDown); root.addEventListener('pointermove', onMove); root.addEventListener('pointerup', onUp); root.addEventListener('pointercancel', onUp);
  root.addEventListener('keydown', onKey);
  root.addEventListener('toggle', function(e){ var d = e.target; if(d && d.dataset){ if(d.dataset.sec) V.secOpen[d.dataset.sec] = d.open; if(d.dataset.dir) V.dir = d.open; } }, true);
}
// the preceptor's web page: one form, one fill, Submit instead of Save. opts = {link: {id, formName, studentName, to, expires}, tpl, buf, prefill}
function mountRemote(root, opts){
  var tpl = opts.tpl, prefill = opts.prefill || {}, locked = {};
  tpl.fields.forEach(function(f){ if(f.who === 'student' && !/preceptor/i.test(f.label)) locked[f.id] = 1; }); // the student's part is theirs alone, even if left blank
  V.remote = {link: opts.link, tpl: tpl, buf: opts.buf || null, locked: locked};
  Object.assign(V, {cat: catOf(tpl), tid: tpl.id, draft: null, busy: false, status: '', preview: '', review: false, confirm: null, send: null});
  var list = fillsGet(tpl.id), fl = list[0];
  if(!fl){ var now = Date.now(); fl = {id: uid(), title: tpl.name, created: now, updated: now, values: JSON.parse(JSON.stringify(prefill)), fileName: opts.fileName || ''}; list = [fl]; fillsPut(tpl.id, list); }
  else Object.keys(locked).forEach(function(k){ fl.values[k] = prefill[k]; if(prefill[k + '__c'] != null) fl.values[k + '__c'] = prefill[k + '__c']; });
  V.fill = fl.id; V.view = 'fill'; listen(root); render(false);
}
function remoteMessage(root, title, body, small){
  V.remote = V.remote || {link: {}, tpl: null, locked: {}}; V.remote.msg = {title: title, body: body, small: small}; V.view = 'remotemsg'; listen(root); render(false);
}
function teardown(){ flush(); drag = null; V.root = null; }

return {mount: mount, mountRemote: mountRemote, remoteMessage: remoteMessage, decodeLink: decodeLink, encodeLink: encodeLink, schoolForm: schoolForm, teardown: teardown, readTemplate: readTemplate, fillPdf: fillPdf, fillDocxFile: fillDocxFile, coa: coaTemplate, acp: acpTemplate, codeHash: codeHash, sha256hex: sha256hex, buildPack: buildPack, openSealed: openSealed, seal: seal, _V: V};
})();
function initFormFill(root, key, label){ FF.mount(root, String(key).split(':')[1] === 'formacp' ? 'acp' : 'eval'); }
function ffTeardown(){ FF.teardown(); }
