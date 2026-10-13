// Ra — classic interface: the VB6 form (raPharTest.frm, v1.2.0) rebuilt control by control.
// Game rules and AI live in ra_engine.js; the turn sequence lives in game.js. This file is the
// form: it shows the state and turns clicks into the answers game.js is waiting for, following
// the original SetGameState cases (1 = your turn ... 13 = game over).
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const form = $('#form');
  const TILE_TIPS = [null,
    'PHARAOH: Most Pharaohs: +5 points.  Fewest Pharaohs: -2 points.  Kept across epochs.',
    'NILE: +1 point if Flood tile is possessed.  Kept across epochs.',
    'FLOOD: +1 point.  Allows points for all Nile tiles.',
    'GOD: +2 points.  May be discarded to gain 1 tile from auction block.'];
  const CIV = ['Astronomy', 'Art', 'Agriculture', 'Writing', 'Religion'];
  CIV.forEach(c => TILE_TIPS.push(`CIVILIZATION (${c}): Player loses 5 points if no Civilization tiles are possessed.  +5/10/15 points if 3/4/5 different Civilization tiles are possessed.`));
  TILE_TIPS.push('GOLD: +3 points.');
  ['Obelisk', 'Palace', 'Sphinx', 'Pyramid', 'Fortress', 'Step Pyramid', 'Temple', 'Statues'].forEach(m => TILE_TIPS.push(
    `MONUMENT (${m}): End of game: +1 point for each different Monument to 6.  +10/15 points for 7/8 different Monuments.  +5/10/15 points for 3/4/5 of the same Monument.  Kept across epochs.`));
  TILE_TIPS.push('FUNERAL: -2 Pharaoh tiles.', 'DROUGHT: -2 Flood tiles, or Nile tiles if player has no Floods.', 'UNREST: -2 Civilization tiles.', 'EARTHQUAKE: -2 Monument tiles.');
  const RA_TIP = 'RA TILE: A Ra tile begins an auction.';
  const SUN_TIP = 'SUN: End of game: +5 points for greatest sum of all suns.  -5 points for lowest sum of all suns.';

  // ---- settings (ra.ini) ----
  const DEFAULTS = { name: 'Doris', easy: false, showScores: true, showFDSuns: true, showShadow: false, skipContinue: false, skipConfirm: false, improvedAI: false };
  let opt = Object.assign({}, DEFAULTS);
  try { Object.assign(opt, JSON.parse(localStorage.getItem('ra-classic-ini') || '{}')); } catch (e) { /* defaults */ }
  const saveOpt = () => { try { localStorage.setItem('ra-classic-ini', JSON.stringify(opt)); } catch (e) { /* ignore */ } };

  // =========================================================================
  // Build the form (back-to-front, matching the .frm z-order)
  // =========================================================================
  function mk(tag, cls, x, y, w, h, parent = form) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    Object.assign(e.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    parent.appendChild(e);
    return e;
  }
  function imgBox(x, y, w, h, src) { const d = mk('div', 'img', x, y, w, h); const i = document.createElement('img'); i.alt = ''; i.draggable = false; if (src) i.src = src; d.appendChild(i); return d; }
  function label(x, y, w, h, px, bold, extra = '') { const l = mk('div', 'lbl ' + extra, x, y, w, h); l.style.font = `${bold ? 'bold ' : ''}${px}px Arial`; return l; }
  const show = (e, v) => e.classList.toggle('hidden', !v);

  const C = {};   // controls
  C.splash = mk('img', 'splash', 0, 0, 873, 649); C.splash.src = 'img/splash.png'; C.splash.alt = 'Ra';
  const BOX_FILL = ['#ffffc0', '#ffe0c0', '#ffc080', '#ffa645', '#ff7434'];
  const boxTop = p => 8 + 128 * (p - 1);
  C.box = [null];
  C.box[1] = mk('div', 'shape hidden', 184, 8, 681, 121); C.box[1].style.background = BOX_FILL[0];
  C.shadow = mk('img', 'hidden', 185, 9, 680, 119); C.shadow.src = 'img/shadow.png'; C.shadow.alt = '';
  for (const p of [4, 3, 2]) { C.box[p] = mk('div', 'shape hidden', 184, boxTop(p), 681, 121); C.box[p].style.background = BOX_FILL[p - 1]; }
  C.buttonBox = mk('div', 'shape hidden', 8, 8, 169, 121);
  C.sunTile0 = imgBox(106, 24, 52, 52, 'img/sun.png'); show(C.sunTile0, false);
  C.box[5] = mk('div', 'shape hidden', 184, boxTop(5), 681, 121); C.box[5].style.background = BOX_FILL[4];

  // tile positions within a player box (x, row 0/1)
  const TILE_POS = [null, [192, 1], [248, 1], [304, 1], [808, 0], [528, 0], [584, 0], [640, 0], [696, 0], [752, 0], [360, 1],
    [416, 1], [472, 1], [528, 1], [584, 1], [640, 1], [696, 1], [752, 1], [808, 1]];
  C.tile = [null]; C.count = [null];
  for (let p = 1; p <= 5; p++) {
    C.tile[p] = [null]; C.count[p] = [null];
    for (let t = 1; t <= 18; t++) {
      const [x, row] = TILE_POS[t], y = boxTop(p) + 8 + 56 * row;
      const b = imgBox(x, y, 52, 52, `img/tile${t}.png`); b.title = TILE_TIPS[t]; show(b, false);
      if (p === 1) { b.addEventListener('dblclick', () => clickTile(t)); }
      C.tile[p][t] = b;
    }
  }
  C.status = mk('div', '', 0, 648, 873, 49); C.status.id = 'status'; C.status.title = 'Double-click to expand.';
  C.status.addEventListener('dblclick', () => { show(C.statusHistory, true); C.statusHistory.scrollTop = 1e9; });
  C.pName = [null];
  C.pName[1] = label(184, 8, 121, 49, 24, false, 'hidden');
  for (let p = 1; p <= 5; p++) for (let t = 1; t <= 18; t++) {
    const [x, row] = TILE_POS[t], y = boxTop(p) + 8 + 56 * row;
    const n = mk('div', 'count hidden', x + 33, y + 33, 17, 17); n.title = TILE_TIPS[t];
    if (p === 1) n.addEventListener('dblclick', () => clickTile(t));
    C.count[p][t] = n;
  }
  C.blockBox = mk('div', 'shape hidden', 8, 232, 169, 409); C.blockBox.style.background = '#ffff80';
  C.block = [null];
  for (let i = 1; i <= 8; i++) {
    const b = imgBox(i % 2 ? 16 : 96, 320 + 80 * Math.floor((i - 1) / 2), 72, 72); show(b, false);
    b.addEventListener('dblclick', () => clickBlock(i));
    C.block[i] = b;
  }
  C.bigSun = imgBox(56, 240, 72, 72, 'img/bigsun.png'); C.bigSun.title = SUN_TIP; show(C.bigSun, false);
  C.trackBox = mk('div', 'shape hidden', 8, 136, 169, 89); C.trackBox.style.background = '#ffff80';
  C.raFaded = imgBox(16, 144, 72, 72, 'img/rafaded.png'); show(C.raFaded, false);
  C.trackLabel = label(88, 168, 89, 41, 19, false, 'hidden'); C.trackLabel.textContent = 'Ra Track';
  C.raTrackLabel = label(88, 192, 89, 33, 29, true, 'hidden');
  for (let p = 2; p <= 5; p++) C.pName[p] = label(184, boxTop(p), 121, 49, 24, false, 'hidden');
  C.sunTile = [null]; C.sunNum = [null];
  for (let p = 1; p <= 5; p++) {
    C.sunTile[p] = [null]; C.sunNum[p] = [null];
    for (let s = 1; s <= 4; s++) {
      const x = 304 + 56 * (s - 1), y = boxTop(p) + 8;
      const t = imgBox(x, y, 52, 52, 'img/sun.png'); t.title = SUN_TIP; show(t, false);
      if (p === 1) t.addEventListener('click', () => clickSun(s));
      C.sunTile[p][s] = t;
    }
  }
  for (let p = 1; p <= 5; p++) for (let s = 1; s <= 4; s++) {
    const n = label(313 + 56 * (s - 1), boxTop(p) + 14, 33, 33, 32, true, 'sunnum hidden');
    if (p === 1) { n.style.pointerEvents = 'auto'; n.addEventListener('dblclick', () => clickSun(s)); n.addEventListener('click', () => clickSun(s)); }
    C.sunNum[p][s] = n;
  }
  C.sobNum = label(64, 253, 57, 49, 37, true, 'hidden'); C.sobNum.title = SUN_TIP;
  C.sunNum0 = label(115, 30, 33, 33, 32, true, 'sunnum hidden');
  C.highbid = label(16, 96, 153, 25, 19, true, 'hidden');
  C.epochLabel = label(88, 144, 89, 41, 19, false, 'hidden');
  C.tileToGod = imgBox(106, 24, 52, 52); show(C.tileToGod, false);
  C.pScore = [null];
  for (let p = 1; p <= 5; p++) C.pScore[p] = label(248, boxTop(p) + 25, 60, 50, 37, true, 'hidden');
  C.turnMarker = imgBox(192, 36, 52, 35, 'img/turnmarker.png'); show(C.turnMarker, false);
  const DOTS = [[19, 147], [36, 147], [53, 147], [70, 147], [27, 164], [44, 164], [62, 164], [36, 181], [53, 181], [45, 198]];
  C.dot = DOTS.map(([x, y]) => mk('div', 'radot hidden', x, y, 15, 15));
  C.button2 = mk('button', 'vbbtn graphic hidden', 96, 16, 73, 73); C.button2.innerHTML = '<img src="img/callra.png" alt=""><span>Call Ra</span>';
  C.button1 = mk('button', 'vbbtn graphic hidden', 16, 16, 73, 73); C.button1.innerHTML = '<img src="img/draw.png" alt=""><span>Draw</span>';
  C.confirm = mk('button', 'vbbtn hidden', 16, 96, 153, 25); C.confirm.textContent = 'Confirm';
  C.cont = mk('button', 'vbbtn hidden', 16, 16, 153, 105); C.cont.id = 'continue'; C.cont.textContent = 'Continue';
  C.statusHistory = mk('textarea', 'hidden', 0, 560, 872, 137); C.statusHistory.id = 'statusHistory'; C.statusHistory.readOnly = true;
  C.statusHistory.title = 'Double-click to hide.';
  C.statusHistory.addEventListener('dblclick', () => show(C.statusHistory, false));
  const caption = (b, t) => { const s = b.querySelector('span'); if (s) s.textContent = t; else b.textContent = t; };
  const capOf = b => (b.querySelector('span') || b).textContent;

  // fit the 873x697 form into the window
  function fit() {
    const st = $('#stage'), k = Math.min(st.clientWidth / 873, st.clientHeight / 697, 1.6);
    form.style.transform = `scale(${k})`;
    form.style.left = Math.max(0, (st.clientWidth - 873 * k) / 2) + 'px';
    form.style.top = Math.max(0, (st.clientHeight - 697 * k) / 2) + 'px';
  }
  window.addEventListener('resize', fit); fit();

  // =========================================================================
  // Status line + StatusHistory (status_Change)
  // =========================================================================
  let lastStatus = '';
  const clock = () => new Date().toLocaleTimeString('en-US');
  function setStatus(t) {
    C.status.textContent = t;
    if (t === '') return;
    const line = clock() + ': ' + t;
    const prevText = lastStatus.slice(lastStatus.indexOf(': ') + 2);
    if (lastStatus && prevText && t.startsWith(prevText) && C.statusHistory.value.endsWith(lastStatus))
      C.statusHistory.value = C.statusHistory.value.slice(0, -lastStatus.length) + line;
    else C.statusHistory.value += (C.statusHistory.value ? '\n' : '') + line;
    lastStatus = line;
    C.statusHistory.scrollTop = 1e9;
  }
  const appendStatus = t => setStatus((C.status.textContent ? C.status.textContent + '  ' : '') + t);

  // =========================================================================
  // Dialogs (MsgBox, InputBox, forms)
  // =========================================================================
  let modalResolve = null;
  function dialog(title, bodyEl, buttons) {
    const m = $('#modal'); m.innerHTML = '';
    const tb = document.createElement('div'); tb.className = 'dlg-title'; tb.innerHTML = `<span></span><button aria-label="Close">×</button>`;
    tb.firstChild.textContent = title; m.appendChild(tb);
    m.appendChild(bodyEl);
    const bb = document.createElement('div'); bb.className = 'dlg-buttons'; m.appendChild(bb);
    $('#modalBack').hidden = false;
    return new Promise(res => {
      modalResolve = v => { $('#modalBack').hidden = true; modalResolve = null; res(v); };
      tb.lastChild.onclick = () => modalResolve(buttons[buttons.length - 1].value);
      buttons.forEach((b, i) => {
        const e = document.createElement('button'); e.textContent = b.label; e.onclick = () => modalResolve(typeof b.value === 'function' ? b.value() : b.value);
        bb.appendChild(e); if (i === 0) setTimeout(() => e.focus(), 0);
      });
    });
  }
  function msgBox(text, title = 'Ra', cancel = false) {
    const b = document.createElement('div'); b.className = 'dlg-body'; b.textContent = text;
    return dialog(title, b, cancel ? [{ label: 'OK', value: true }, { label: 'Cancel', value: false }] : [{ label: 'OK', value: true }]);
  }
  function inputBox(prompt, title, def) {
    const b = document.createElement('div'); b.className = 'dlg-body'; b.textContent = prompt;
    const i = document.createElement('input'); i.type = 'text'; i.value = def; b.appendChild(i);
    setTimeout(() => { i.focus(); i.select(); }, 0);
    i.addEventListener('keydown', e => { if (e.key === 'Enter' && modalResolve) modalResolve(i.value); });
    return dialog(title, b, [{ label: 'OK', value: () => i.value }, { label: 'Cancel', value: '' }]);
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalResolve) modalResolve(false); });

  // =========================================================================
  // State shared with the flow
  // =========================================================================
  let GameState = 0, pending = null, inGame = false, numPlayers = 0;
  let raSlot = false;            // the drawn Ra tile shown in the next block slot during its auction
  let bidMarks = {};             // "p,s" -> red sun numbers during an auction
  let scoreCap = [null];         // pScore captions/visibility (VB updates these only at set moments)
  let deleting = [];             // tiles moved to the block for discarding (state 10)
  let need = null, selPos = 0, godFrom12 = false, gameOverShown = false;
  const flow = RA_FLOW.createFlow(makeUI());
  flow.setEasy(opt.easy); flow.setName(opt.name);
  const view = () => flow.view();

  function done(v) { const p = pending; pending = null; if (p) p(v); }

  // =========================================================================
  // render: everything that follows from the game state
  // =========================================================================
  function render() {
    const v = view(); if (!v) return;
    const N = v.N, z = N === 3 ? 1 : 2;
    for (let p = 1; p <= 5; p++) {
      const on = p <= N;
      show(C.box[p], on); show(C.pName[p], on);
      if (on) C.pName[p].textContent = v.names[p - 1];
      const sc = scoreCap[p];
      show(C.pScore[p], on && !!sc && sc.vis);
      if (sc) C.pScore[p].textContent = sc.text;
      for (let s = 1; s <= 4; s++) {
        const vis = on && s >= z;
        show(C.sunTile[p][s], vis);
        const val = on ? v.suns[p - 1][s - 1] : 0, n = C.sunNum[p][s];
        n.textContent = String(Math.abs(val));
        n.classList.toggle('used', val < 0);
        n.classList.toggle('bid', !!bidMarks[p + ',' + s] && val > 0);
        show(n, vis && (val >= 0 || p === 1 || opt.showFDSuns || v.over));
      }
      for (let t = 1; t <= 18; t++) {
        let c = on ? v.tiles[p - 1][t] : 0;
        if (p === 1 && GameState === 10) c -= deleting.filter(x => x === t).length;
        show(C.tile[p][t], c > 0);
        let cap = (c >= 0 ? ' ' : '') + c; if (cap.length === 3) cap = cap.slice(1);   // NumOfTile_Change
        C.count[p][t].textContent = cap;
        show(C.count[p][t], c > 1);
      }
    }
    show(C.shadow, opt.showShadow);
    // block
    for (let i = 1; i <= 8; i++) {
      const b = C.block[i], im = b.firstChild;
      let t = null;
      if (GameState === 10) t = deleting[i - 1] != null ? deleting[i - 1] : null;
      else if (i <= v.block.length) t = v.block[i - 1];
      else if (raSlot && i === v.block.length + 1) t = 0;
      show(b, t !== null);
      if (t !== null) { im.src = `img/big${t}.png`; b.title = t === 0 ? RA_TIP : TILE_TIPS[t]; } else b.title = '';
    }
    C.sobNum.textContent = String(v.SunOnBlock);
    for (let i = 0; i < 10; i++) {
      const d = C.dot[i]; d.classList.toggle('on', i < v.RaTrack); d.classList.toggle('unused', i >= v.MaxRa);
    }
    C.raTrackLabel.textContent = `${v.RaTrack} / ${v.MaxRa}`;
    C.epochLabel.textContent = 'Epoch ' + v.Epoch;
    C.button1.title = 'Tiles in Bag: ' + v.bagCount;
    C.turnMarker.style.top = (boxTop(v.Turn || 1) + 28) + 'px';
  }

  // =========================================================================
  // SetGameState
  // =========================================================================
  function SetGameState(st) {
    GameState = st;
    const v = view();
    hintOn(false);
    switch (st) {
      case 1: {
        C.buttonBox.style.background = '#ffff80';
        C.button1.disabled = !(v.block.length < 8);
        caption(C.button1, 'Draw'); show(C.button1, true); show(C.button2, true); C.button2.disabled = false;
        hintOn(true);
        C.confirm.disabled = true; C.confirm.textContent = 'Confirm'; show(C.confirm, true); show(C.cont, false);
        const g = v.tiles[0][4] >= 1;
        if (g && v.block.length >= 1 && v.block.length < 8) setStatus('You may choose to draw a tile, call Ra, or double-click your God tile to use it.');
        else if (v.block.length < 8) setStatus('You may choose to draw a tile or call Ra.');
        else if (g) setStatus('You may choose to call Ra or double-click your God tile to use it.');
        else setStatus('You must call Ra.');
        C.turnMarker.style.top = (boxTop(1) + 28) + 'px';
        break;
      }
      case 2:
        if (!opt.skipConfirm) { show(C.confirm, true); C.confirm.disabled = false; C.confirm.focus(); hintOn(true); }
        else confirmClick();
        break;
      case 3: C.buttonBox.style.background = '#ffff80'; show(C.cont, true); C.cont.textContent = 'Continue'; C.cont.focus(); break;
      case 4: {
        show(C.button1, true); C.buttonBox.style.background = '#ff8080';
        const b = pending4;
        C.highbid.textContent = b.highBidder ? 'High: ' + v.names[b.highBidder - 1] : 'High: None'; show(C.highbid, true);
        hintOn(true);
        C.sunNum0.textContent = String(b.high);
        show(C.tileToGod, false); show(C.sunNum0, true); show(C.sunTile0, true); show(C.cont, false);
        const s = C.status.textContent;
        if (s.length > 8 && !s.endsWith('to bid.')) appendStatus('Double-click Sun tile to bid.');
        show(C.button2, false); show(C.confirm, false);
        caption(C.button1, 'Pass'); C.button1.disabled = b.mustBid;
        break;
      }
      case 5:
        caption(C.button1, 'Cancel'); C.button1.disabled = false; hintOn(true);
        if (!opt.skipConfirm) { show(C.confirm, true); C.confirm.disabled = false; C.confirm.focus(); }
        else confirmClick();
        break;
      case 6: show(C.cont, true); C.cont.textContent = 'Continue'; C.cont.focus(); break;
      case 7:
        if (capOf(C.button1) !== 'Pass') caption(C.button1, 'Cancel');
        C.button1.disabled = false; C.confirm.textContent = 'Confirm'; C.confirm.disabled = true;
        C.tileToGod.firstChild.removeAttribute('src'); show(C.tileToGod, true); show(C.sunNum0, false); show(C.sunTile0, false); show(C.button2, false);
        hintOn(!godFrom12);
        setStatus('Double-click tile to exchange for God tile.');
        break;
      case 8: C.confirm.textContent = 'Confirm Exchange'; C.confirm.disabled = false; show(C.confirm, true); C.confirm.focus(); hintOn(true); break;
      case 9: C.buttonBox.style.background = '#ffff80'; show(C.cont, true); C.cont.textContent = 'Continue'; C.cont.focus(); break;
      case 10:
        C.button1.disabled = true; C.button2.disabled = true; C.confirm.disabled = false; C.confirm.textContent = 'Confirm discard'; show(C.confirm, true); C.confirm.focus();
        break;
      case 11: show(C.cont, true); C.cont.focus(); C.cont.textContent = 'Epoch ' + (v.Epoch + 1); break;
      case 12:
        setStatus('You may pass your turn or use another God.');
        C.button1.disabled = false; caption(C.button1, 'Pass'); C.confirm.disabled = true; C.confirm.textContent = 'Confirm';
        C.button2.disabled = true; show(C.button2, true); show(C.confirm, true);
        break;
      case 13: show(C.cont, true); C.cont.textContent = 'Show History'; C.cont.disabled = false; break;
    }
    hintOn([1, 2, 4, 5, 7, 8].includes(st) && !godFrom12);
    render();
  }
  function hintOn(on) { $('#mnuHint').disabled = !on; }

  // =========================================================================
  // The UI object the flow talks to
  // =========================================================================
  let pending4 = null;
  function makeUI() {
    return {
      newGame() {},
      render,
      status(t, kind) {
        if (kind === 'ra' && t.endsWith('drawn a Ra tile.')) raSlot = true;   // VB shows the Ra in the next block slot
        if (kind === 'append') appendStatus(t); else setStatus(t);
      },
      turnStart(p) { C.turnMarker.style.top = (boxTop(p) + 28) + 'px'; },
      humanTurn() { godFrom12 = false; return new Promise(res => { pending = res; SetGameState(1); }); },
      godAgain() { godFrom12 = false; return new Promise(res => { pending = res; SetGameState(12); }); },
      humanBid(ctx) { pending4 = ctx; return new Promise(res => { pending = res; SetGameState(4); }); },
      auctionBids(list) {
        const v = view();
        for (const { p, bid } of list) if (bid > 0) { const s = v.suns[p - 1].indexOf(bid); if (s >= 0) bidMarks[p + ',' + (s + 1)] = true; }
        render();
      },
      auctionWon() {},
      auctionDone() { bidMarks = {}; raSlot = false; render(); },
      discard(n) {
        need = { civ: n.civ, mon: n.mon }; deleting = [];
        const v = view();
        if (n.fromAuction) {
          let t = v.names[0] + ' won the auction.  Double-click ' + need.civ;
          if (need.mon > 0 && need.civ > 0) t += (need.civ > 1 ? ' civilization tiles and ' : ' civilization tile and ') + need.mon + (need.mon > 1 ? ' monuments to discard.' : ' monument to discard.');
          else if (need.mon > 0) t = v.names[0] + ' won the auction.  Double-click ' + need.mon + (need.mon > 1 ? ' monuments to discard.' : ' monument to discard.');
          else t += need.civ > 1 ? ' civilization tiles to discard.' : ' civilization tile to discard.';
          setStatus(t);
        } else if (need.mon > 0) setStatus('Double-click ' + need.mon + ' monuments to discard.');
        else setStatus('Double-click ' + need.civ + ' civilization tiles to discard.');
        return new Promise(res => { pending = res; SetGameState(10); });
      },
      pause(kind) {
        if (kind === 'draw' && opt.skipContinue) { GameState = 3; render(); return Promise.resolve(); }
        return new Promise(res => { pending = res; SetGameState(kind === 'draw' ? 3 : kind === 'god' ? 9 : 6); });
      },
      epochEnd(info) {
        const v = view();
        // EpochIsOver: score captions
        for (let p = 1; p <= v.N; p++) {
          if (opt.showScores || p === 1 || info.over) scoreCap[p] = { text: String(v.scores[p - 1]), vis: true };
          else scoreCap[p] = { text: '[' + v.scoreAdded[p - 1] + ']', vis: true };
        }
        bidMarks = {}; raSlot = false;
        if (info.over) { inGame = false; gameOverShown = true; SetGameState(13); return Promise.resolve(); }
        return new Promise(res => {
          pending = () => {
            for (let p = 2; p <= v.N; p++) if (!opt.showScores) scoreCap[p].vis = false;   // NewEpoch
            res();
          };
          SetGameState(11);
        });
      },
    };
  }

  // =========================================================================
  // Click handlers (button1_Click, button2_Click, confirm_Click, ...)
  // =========================================================================
  C.button1.addEventListener('click', () => {
    switch (GameState) {
      case 1: case 2: C.confirm.textContent = 'Confirm Draw Tile'; SetGameState(2); break;
      case 4: C.confirm.textContent = 'Confirm Pass'; SetGameState(5); break;
      case 5: SetGameState(4); break;
      case 7: case 8:
        if (godFrom12) { SetGameState(12); break; }
        SetGameState(1); break;
      case 12:
        show(C.button2, true); C.confirm.textContent = 'Confirm Pass'; C.confirm.disabled = false; show(C.confirm, true); C.confirm.focus();
        setStatus('Press confirm to complete your turn.');
        break;
    }
  });
  C.button2.addEventListener('click', () => {
    if (GameState === 1 || GameState === 2) { C.confirm.textContent = 'Confirm Call Ra'; SetGameState(2); }
  });
  C.confirm.addEventListener('click', confirmClick);
  function confirmClick() {
    const cap = C.confirm.textContent;
    if (GameState === 2) {
      show(C.confirm, false);
      if (cap === 'Confirm Draw Tile') done({ action: 'draw' });
      else if (cap === 'Confirm Call Ra') done({ action: 'ra' });
    } else if (GameState === 5) {
      if (cap === 'Confirm Pass') done(0);
      else {
        const bid = +C.sunNum0.textContent, v = view(), s = v.suns[0].indexOf(bid);
        if (s >= 0) bidMarks['1,' + (s + 1)] = true;
        done(bid);
      }
    } else if (GameState === 8) {
      show(C.tileToGod, false);
      done({ action: 'god', pos: selPos });
    } else if (GameState === 10) {
      if (need.civ + need.mon === 0) { const d = deleting; deleting = []; need = null; GameState = 0; done(d); }
      else if (need.civ > 0 && need.mon > 0) setStatus('Double-click ' + need.civ + ' civilization tiles and ' + need.mon + ' monuments to discard.');
      else if (need.mon > 0) setStatus('Double-click ' + need.mon + ' monuments to discard.');
      else setStatus('Double-click ' + need.civ + ' civilization tiles to discard.');
    } else if (GameState === 12) {
      if (cap === 'Confirm Pass') done({ action: 'pass' });
      else if (cap === 'Confirm Exchange') { show(C.tileToGod, false); done({ action: 'god', pos: selPos }); }
    }
  }
  C.cont.addEventListener('click', () => {
    if (GameState === 13) { showHistory(); return; }
    show(C.cont, false);
    done();
  });

  function clickTile(t) {
    const v = view(); if (!v) return;
    if (GameState === 10) {
      const have = v.tiles[0][t] - deleting.filter(x => x === t).length;
      if (have <= 0 || deleting.length >= 8) return;
      if (t >= 5 && t <= 9 && need.civ > 0) { deleting.push(t); need.civ--; }
      else if (t >= 11 && t <= 18 && need.mon > 0) { deleting.push(t); need.mon--; }
      render();
    } else if ((GameState === 1 || GameState === 2) && t === 4 && v.tiles[0][4] >= 1 && v.block.length > 0) {
      godFrom12 = false; SetGameState(7);
    } else if (GameState === 12 && t === 4 && v.tiles[0][4] >= 1 && v.block.length > 0) {
      godFrom12 = true; SetGameState(7); GameState = 12; caption(C.button1, 'Pass');
    }
  }
  async function clickBlock(i) {
    const v = view(); if (!v) return;
    if (GameState === 10) {
      const t = deleting[i - 1]; if (t == null) return;
      if (t >= 5 && t <= 9) need.civ++; else need.mon++;
      deleting.splice(i - 1, 1); render();
    } else if ((GameState === 7 || GameState === 8 || GameState === 12) && i <= v.block.length) {
      if (GameState === 12 && !godFrom12) return;
      const t = v.block[i - 1];
      if (t === 4) { await msgBox('You may not take a God tile with another God tile.'); return; }
      selPos = i;
      C.tileToGod.firstChild.src = `img/tile${t}.png`;
      if (GameState !== 12) SetGameState(8);
      else { C.confirm.textContent = 'Confirm Exchange'; C.confirm.disabled = false; }
    }
  }
  async function clickSun(s) {
    const v = view(); if (!v || (GameState !== 4 && GameState !== 5)) return;
    const mine = v.suns[0][s - 1];
    if (GameState === 4) {
      if (mine > 0) {
        if (mine > +C.sunNum0.textContent) { C.sunNum0.textContent = String(mine); C.confirm.textContent = 'Confirm Bid ' + mine; SetGameState(5); }
        else await msgBox('You must bid higher than ' + C.sunNum0.textContent + ' or pass.');
      } else await msgBox('You cannot bid that sun until the next epoch.');
      return;
    }
    // state 5: changing the chosen sun; must beat the highest red (bid) AI sun
    let cur = 0;
    for (let p = 2; p <= v.N; p++) for (let k = 1; k <= 4; k++) if (bidMarks[p + ',' + k] && v.suns[p - 1][k - 1] > cur) cur = v.suns[p - 1][k - 1];
    if (mine > 0) {
      if (mine > cur) { C.sunNum0.textContent = String(mine); C.confirm.textContent = 'Confirm Bid ' + mine; SetGameState(5); }
      else await msgBox('You must bid higher than ' + cur + ' or pass.');
    } else await msgBox('You cannot bid that sun until the next epoch.');
  }


  // =========================================================================
  // Menus
  // =========================================================================
  document.querySelectorAll('.menu-title').forEach(b => b.addEventListener('click', e => {
    const m = b.parentElement, open = m.classList.contains('open');
    document.querySelectorAll('.menu').forEach(x => x.classList.remove('open'));
    if (!open) m.classList.add('open');
    e.stopPropagation();
  }));
  document.querySelectorAll('.menu-title').forEach(b => b.addEventListener('mouseenter', () => {
    if (document.querySelector('.menu.open') && !b.parentElement.classList.contains('open')) {
      document.querySelectorAll('.menu').forEach(x => x.classList.remove('open')); b.parentElement.classList.add('open');
    }
  }));
  document.addEventListener('click', () => document.querySelectorAll('.menu').forEach(x => x.classList.remove('open')));
  function syncChecks() {
    document.querySelectorAll('[data-opt]').forEach(b => b.classList.toggle('checked', !!opt[b.dataset.opt]));
    document.querySelectorAll('[data-ai]').forEach(b => b.classList.toggle('checked', (b.dataset.ai === 'improved') === !!opt.improvedAI));
  }
  document.querySelectorAll('[data-ai]').forEach(b => b.addEventListener('click', () => {
    opt.improvedAI = b.dataset.ai === 'improved'; saveOpt(); syncChecks();
    if (inGame) msgBox('The AI change takes effect when you start a new game.');
  }));
  syncChecks();
  document.querySelectorAll('[data-opt]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.opt; opt[k] = !opt[k]; saveOpt(); syncChecks();
    if (k === 'easy') flow.setEasy(opt.easy);
    if (k === 'showScores') toggleScores();
    render();
  }));
  document.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => command(b.dataset.cmd)));
  document.addEventListener('keydown', e => {
    if (modalResolve) return;
    const map = { F3: 'new3', F4: 'new4', F5: 'new5', F1: 'rules', F9: 'hint' };
    if (map[e.key]) { e.preventDefault(); if (e.key !== 'F9' || !$('#mnuHint').disabled) command(map[e.key]); }
  });
  function toggleScores() {   // ShowScores_Click
    const v = view(); if (!v) return;
    const between = GameState === 11 || GameState === 13;
    for (let p = 2; p <= v.N; p++) {
      if (!between) scoreCap[p] = { text: String(v.scores[p - 1]), vis: opt.showScores };
      else if (opt.showScores || v.Epoch === 3) scoreCap[p] = { text: String(v.scores[p - 1]), vis: true };
      else scoreCap[p] = { text: '[' + v.scoreAdded[p - 1] + ']', vis: true };
    }
  }

  async function command(c) {
    if (c === 'new3' || c === 'new4' || c === 'new5') {
      if (inGame && !(await msgBox('Are you sure you wish to end the current game?', 'Ra', true))) return;
      startGame(+c.slice(3));
    } else if (c === 'exit') {
      if (await msgBox('Are you sure you wish to exit?', 'Ra', true)) { flow.abort(); location.reload(); }
    } else if (c === 'name') {
      const t = await inputBox('What is your name?', 'Ra', opt.name);
      if (t) { opt.name = t; saveOpt(); flow.setName(t); render(); }
    } else if (c === 'hint') {
      const h = flow.hint(); if (h) msgBox(h, 'Ra Hint');
    } else if (c === 'about') about();
    else if (c === 'composition') composition();
    else if (c === 'rules') rules();
  }

  function startGame(n) {
    flow.abort();
    pending = null; numPlayers = n; inGame = true; gameOverShown = false; bidMarks = {}; raSlot = false; deleting = []; GameState = 0;
    scoreCap = [null];
    for (let p = 1; p <= 5; p++) scoreCap.push({ text: '10', vis: p === 1 || opt.showScores });
    C.statusHistory.value = ''; lastStatus = '';
    [C.buttonBox, C.turnMarker, C.trackBox, C.epochLabel, C.bigSun, C.raFaded, C.sobNum, C.trackLabel, C.raTrackLabel, C.blockBox].forEach(e => show(e, true));
    C.dot.forEach(d => show(d, true));
    [C.button1, C.button2, C.confirm, C.cont, C.highbid, C.sunTile0, C.sunNum0, C.tileToGod].forEach(e => show(e, false));
    C.button1.disabled = C.button2.disabled = C.confirm.disabled = true; C.cont.disabled = false;
    flow.setAI(opt.improvedAI && window.RA_IMPROVED_AI ? window.RA_IMPROVED_AI[n] : null);
    flow.newGame(n).catch(e => { console.error(e); msgBox('Error: ' + e.message); });
  }


  // ---- History form ----
  function showHistory() {
    const b = document.createElement('div'); b.className = 'dlg-body';
    const ta = document.createElement('textarea'); ta.readOnly = true; ta.value = view().history; b.appendChild(ta);
    dialog('Game History', b, [
      { label: 'Copy to Clipboard', value: () => { try { navigator.clipboard.writeText(ta.value); } catch (e) { /* ignore */ } return true; } },
      { label: 'Close', value: true }]);
  }
  // ---- About ----
  function about() {
    const b = document.createElement('div'); b.className = 'dlg-body about';
    b.innerHTML = `<img src="img/abouticon.png" width="32" height="32" alt=""><div><h2>Ra</h2>Version 1.2.0</div>
      <div></div><p>Ra was designed by Reiner Knizia and published by Alea in 1999.  The images in this program come from a reprint published by Uberplay in 2005.  This computer version was programmed in Microsoft Visual Basic 6.0 by Gabriel Rocklin.  The AI uses an artificial neural network to assess the value of a group of tiles and uses a second neural network to assess the trade value of its sun tiles.</p>
      <div></div><p>E-Mail: gabriel.rocklin@ucsf.edu</p>`;
    dialog('About Ra', b, [{ label: 'OK', value: true }]);
  }
  // ---- Initial Bag Composition (composition.frm) ----
  function composition() {
    const b = document.createElement('div'); b.className = 'dlg-body comp';
    const rows = [['Ra Tiles:', 30, '#ff0000'], ['Pharaoh Tiles:', 25, '#00ff00'], ['Nile Tiles:', 25, '#00ffff'], ['Flood Tiles:', 12, '#0000ff'],
      ['Gold Tiles:', 5, '#ff8000'], ['God Tiles:', 8, '#ffff00']];
    let h = '<div style="left:0;top:8px;width:529px;text-align:center;font-size:18px">Initial Bag Composition (180 tiles)</div>';
    rows.forEach(([t, n, c], i) => {
      const y = 42 + 16 * i;
      h += `<div style="left:8px;top:${y}px">${t}</div><div style="left:88px;top:${y}px;width:17px;text-align:right">${n}</div>`;
      h += `<div class="bar" style="left:112px;top:${y - 2}px;width:${10 * n}px;height:17px;background:${c}"></div>`;
    });
    h += '<div style="left:8px;top:138px">Civilization Tiles: 5x5</div>';
    ['#ff8080', '#8080ff', '#80ff80', '#ffff80', '#f8f8f8'].forEach((c, i) => h += `<div class="bar" style="left:${112 + 50 * i}px;top:136px;width:50px;height:17px;background:${c}"></div>`);
    h += '<div style="left:8px;top:154px">Monument Tiles: 8x5</div>';
    ['#fff', '#f0f0f0', '#e0e0e0', '#d0d0d0', '#c0c0c0', '#b0b0b0', '#a0a0a0', '#909090'].forEach((c, i) => h += `<div class="bar" style="left:${112 + 50 * i}px;top:152px;width:50px;height:17px;background:${c}"></div>`);
    [['Funeral:', 2, '#008000', 170], ['Drought:', 2, '#0000c0', 186], ['Unrest:', 4, '#808080', 202], ['Earthquake:', 2, '#000', 218]].forEach(([t, n, c, y]) => {
      h += `<div style="left:8px;top:${y}px">${t}</div><div style="left:88px;top:${y}px;width:17px;text-align:right">${n}</div>`;
      h += `<div class="bar" style="left:112px;top:${y - 2}px;width:${10 * n}px;height:17px;background:${c}"></div>`;
    });
    b.innerHTML = h;
    dialog('Ra', b, [{ label: 'Close', value: true }]);
  }
  // ---- How to play (the VB menu opened readme.txt, which was empty) ----
  function rules() {
    const b = document.createElement('div'); b.className = 'dlg-body rules';
    b.innerHTML = RULES_HTML;
    dialog('How to play Ra', b, [{ label: 'OK', value: true }]);
  }
  const RULES_HTML = `
    <p>Ra lasts three epochs. You collect tiles in auctions, bidding with your suns, and score points at the end of each epoch. The most points after epoch 3 wins (ties: highest single sun).</p>
    <h3>Your turn</h3>
    <ul><li><b>Draw</b> a tile onto the auction block (not allowed when the block is full). Drawing a Ra tile advances the Ra track and starts an auction.</li>
    <li><b>Call Ra</b> to start an auction. If you call voluntarily and everyone else passes, you must bid. If the block is full you may still pass.</li>
    <li><b>Use a God</b> (double-click your God tile, then a block tile) to take one tile from the block instead. You may use several Gods in one turn. Gods can't take Gods.</li></ul>
    <h3>Auctions</h3>
    <p>Starting left of the player who called Ra and ending with that player, each player may bid one face-up sun higher than the current bid, or pass. The winner takes every tile on the block and the sun in the middle (face down, usable next epoch); the winning sun goes to the middle. After an auction drawn from a Ra tile, everyone may pass and the tiles stay. When you have no face-up suns you sit out the rest of the epoch.</p>
    <p>The epoch ends when nobody has face-up suns, or immediately (with no auction) when the Ra track fills: 8 Ra tiles with 3 players, 9 with 4, 10 with 5.</p>
    <h3>Disasters</h3>
    <ul><li>Funeral: lose 2 Pharaohs. Drought: lose 2 Floods, then Niles. Unrest: lose 2 Civilizations of your choice. Earthquake: lose 2 Monuments of your choice. Tiles won in the same lot count.</li></ul>
    <h3>Scoring after each epoch</h3>
    <ul><li>Pharaohs: most +5, fewest −2 (nothing if everyone ties). Kept.</li>
    <li>Niles and Floods: 1 each, but only if you have a Flood. Niles kept, Floods discarded.</li>
    <li>Gods 2 each, Gold 3 each (discarded).</li>
    <li>Civilizations: none −5; 3/4/5 different +5/+10/+15 (discarded).</li></ul>
    <h3>End of the game only</h3>
    <ul><li>Monuments: 1 per different type up to 6, 10 for 7 types, 15 for all 8; plus 5/10/15 for 3/4/5 of one type.</li>
    <li>Suns: highest total of all your suns +5, lowest −5.</li></ul>
    <p>Scores can't go below 0. Hint (F9) asks the AI what it would do.</p>`;

  // initial screen: splash, as in the VB program
  setStatus('');
  window.RA_DEBUG = () => ({ view: view(), GameState, opt });
})();
