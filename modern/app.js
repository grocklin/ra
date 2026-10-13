// Ra — modern interface. Same rules/AI (ra_engine.js) and turn sequence (game.js) as the classic
// version; this file is only presentation and input.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  };

  const TILE = [null, 'Pharaoh', 'Nile', 'Flood', 'God', 'Astronomy', 'Art', 'Agriculture', 'Writing', 'Religion', 'Gold',
    'Obelisk', 'Palace', 'Sphinx', 'Pyramid', 'Fortress', 'Step Pyramid', 'Temple', 'Statues', 'Funeral', 'Drought', 'Unrest', 'Earthquake'];
  const TIP = [null,
    'Pharaoh: most Pharaohs +5, fewest −2 each epoch. Kept.', 'Nile: 1 point each, only if you have a Flood. Kept.',
    'Flood: 1 point, and makes your Niles score. Discarded each epoch.', 'God: 2 points, or spend it on your turn to take a tile from the block.',
    ...['Astronomy', 'Art', 'Agriculture', 'Writing', 'Religion'].map(c => `${c} (civilization): none −5; 3/4/5 different +5/+10/+15. Discarded each epoch.`),
    'Gold: 3 points. Discarded each epoch.',
    ...['Obelisk', 'Palace', 'Sphinx', 'Pyramid', 'Fortress', 'Step Pyramid', 'Temple', 'Statues'].map(m => `${m} (monument): scored at game end — 1 per different type (7 types 10, 8 types 15) plus 5/10/15 for 3/4/5 of one type.`),
    'Funeral: the winner loses 2 Pharaohs.', 'Drought: the winner loses 2 Floods, then Niles.', 'Unrest: the winner discards 2 civilizations.', 'Earthquake: the winner discards 2 monuments.'];
  const ORDER = [1, 2, 3, 4, 10, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18];
  const SPEEDS = { slow: 1300, normal: 700, fast: 250 };

  // ---- settings ----
  const DEF = { name: 'Doris', easy: false, showScores: true, showFDSuns: true, speed: 'normal', players: 4, ai: 'improved' };
  let opt = Object.assign({}, DEF);
  try { Object.assign(opt, JSON.parse(localStorage.getItem('ra-modern') || '{}')); } catch (e) { /* defaults */ }
  const save = () => { try { localStorage.setItem('ra-modern', JSON.stringify(opt)); } catch (e) { /* ignore */ } };

  // ---- UI state ----
  let mode = null;            // null | 'turn' | 'godpick' | 'godAgain' | 'bid' | 'discard' | 'wait' | 'result'
  let ctx = null, pending = null, waitingTurn = 0, resultText = '', inGame = false;
  let bubbles = {}, bidSun = {}, raSlot = false, chosen = [], need = null, hintText = '', godFromAgain = false;
  let lastEpochInfo = null, endText = '', showBreakdown = false;
  const resolve = v => { const p = pending; pending = null; mode = null; hintText = ''; if (p) p(v); render(); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const ui = {
    newGame() {},
    render: () => render(),
    status(t, kind) { addFeed(t, kind); },
    turnStart(p) { waitingTurn = p; endText = ''; if (p !== 1) { mode = 'wait'; render(); } },
    humanTurn(c) { ctx = c; mode = 'turn'; godFromAgain = false; return new Promise(r => { pending = r; render(); }); },
    godAgain(c) { ctx = c; mode = 'godAgain'; godFromAgain = true; return new Promise(r => { pending = r; render(); }); },
    humanBid(c) { ctx = c; mode = 'bid'; return new Promise(r => { pending = r; render(); }); },
    discard(n) { need = n; chosen = []; mode = 'discard'; return new Promise(r => { pending = r; render(); }); },
    auctionBids(list, humanBid) {
      const v = flow.view();
      if (humanBid !== undefined && v.suns[0][3] > 0) {
        if (humanBid > 0) { bubbles[1] = { t: 'Bid ' + humanBid }; bidSun[1] = humanBid; addFeed(`You bid ${humanBid}.`, 'minor'); }
        else { bubbles[1] = { t: 'Pass', c: 'pass' }; addFeed('You pass.', 'minor'); }
      }
      for (const { p, bid } of list) {
        if (bid > 0) { bubbles[p] = { t: 'Bid ' + bid }; bidSun[p] = bid; addFeed(`${v.names[p - 1]} bids ${bid}.`, 'minor'); }
        else { bubbles[p] = { t: 'Pass', c: 'pass' }; addFeed(`${v.names[p - 1]} passes.`, 'minor'); }
      }
      render();
    },
    auctionWon(f) { bubbles[1] = { t: 'Won', c: 'win' }; },
    auctionDone() { bubbles = {}; bidSun = {}; raSlot = false; render(); },
    async pause(kind, info) {
      const ms = SPEEDS[opt.speed] || 700;
      if (kind === 'auction') {
        const v = flow.view();
        if (info.winner) { bubbles[info.winner] = { t: 'Wins with ' + info.bid, c: 'win' }; resultText = `${info.winner === 1 ? 'You win' : v.names[info.winner - 1] + ' wins'} the lot with ${info.winner === 1 ? 'your' : 'a'} ${info.bid} and takes the ${v.SunOnBlock} sun.`; }
        else resultText = v.block.length === 8 ? 'Everyone passed. The full block is discarded.' : 'Everyone passed. The tiles stay on the block.';
        mode = 'result'; render();
        await Promise.race([sleep(ms * 3), new Promise(r => { pending = r; })]);
        pending = null; mode = 'wait'; resultText = '';
      } else {
        render();
        await sleep(kind === 'god' ? ms * 1.6 : ms);
      }
    },
    async epochEnd(info) {
      bubbles = {}; bidSun = {}; raSlot = false; lastEpochInfo = info; mode = 'wait'; endText = `Epoch ${info.epoch} has ended`; render();
      await sleep(400);
      if (info.over) { inGame = false; mode = null; render(); showEpochDialog(info); return; }
      await showEpochDialog(info);
    },
  };
  const flow = RA_FLOW.createFlow(ui);
  flow.setEasy(opt.easy); flow.setName(opt.name);

  // the drawn Ra tile stays visible in the next slot during its auction
  const origStatus = ui.status;
  let raEvent = '';
  ui.status = (t, kind) => {
    if (kind === 'ra') { raEvent = t; if (t.endsWith('drawn a Ra tile.')) raSlot = true; }
    origStatus(t, kind);
  };
  const youify = t => { const v = flow.view(); return v && t.startsWith(v.names[0] + ' ') ? 'You ' + t.slice(v.names[0].length + 1).replace(/^has /, 'have ') : t; };

  // =========================================================================
  // Feed
  // =========================================================================
  const feedItems = [];
  function addFeed(t, kind) {
    if (kind === 'start') feedItems.length = 0;
    const v = flow.view();
    let text = t, who = '';
    if (v) for (const n of v.names) if (t.startsWith(n + ' ')) { who = n; text = t.slice(n.length + 1); break; }
    if (v && who === v.names[0]) who = 'You';
    if (who === 'You') text = text.replace(/^has /, 'have ').replace(/^is the winner!/, 'are the winner!');
    feedItems.push({ who, text, kind });
    if (feedItems.length > 80) feedItems.shift();
    renderFeed();
  }
  function renderFeed() {
    const ol = $('#feed'); ol.innerHTML = '';
    for (let i = feedItems.length - 1; i >= 0; i--) {
      const f = feedItems[i];
      ol.prepend(h('li', { class: f.kind === 'epoch' ? 'epoch' : f.kind === 'minor' || f.kind === 'draw' ? 'minor' : f.kind || '' }, f.who ? h('span', { class: 'who' }, f.who) : null, h('span', {}, f.text)));
    }
  }

  // =========================================================================
  // Scoring helpers for derived displays (same rules as the engine)
  // =========================================================================
  function pharStanding(v) {
    const c = v.tiles.map(t => t[1]), hi = Math.max(...c), lo = Math.min(...c);
    return c.map(x => hi === lo ? '' : x === hi ? 'most' : x === lo ? 'fewest' : '');
  }
  function projection(v, p, withFinal) {
    const T = v.tiles[p], c = v.tiles.map(t => t[1]), hi = Math.max(...c), lo = Math.min(...c);
    let ph = 0; if (hi !== lo) { if (T[1] === hi) ph += 5; if (T[1] === lo) ph -= 2; }
    const nile = T[3] >= 1 ? T[2] + T[3] : 0, god = 2 * T[4], gold = 3 * T[10];
    let nc = 0; for (let k = 5; k <= 9; k++) if (T[k]) nc++;
    const civ = nc === 0 ? -5 : nc >= 3 ? 5 * (nc - 2) : 0;
    let mon = 0, sun = 0, sunSum = 0;
    if (v.Epoch === 3 || withFinal) {
      let nm = 0; for (let k = 11; k <= 18; k++) { if (T[k]) nm++; if (T[k] >= 3) mon += 5 * (T[k] - 2); }
      mon += nm === 7 ? 10 : nm === 8 ? 15 : nm;
      const sums = v.suns.map(r => r.reduce((a, x) => a + Math.abs(x), 0)), shi = Math.max(...sums), slo = Math.min(...sums);
      if (shi !== slo) { if (sums[p] === shi) sun += 5; if (sums[p] === slo) sun -= 5; }
      sunSum = sums[p];
    }
    const parts = { Pharaohs: ph, 'Nile/Flood': nile, Gods: god, Gold: gold, Civilizations: civ };
    if (v.Epoch === 3) { parts.Monuments = mon; parts.Suns = sun; }
    return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts, final: { mon, sun, sunSum } };
  }
  const lotSummary = v => {
    const cnt = {}; v.block.forEach(t => cnt[t] = (cnt[t] || 0) + 1);
    const parts = Object.keys(cnt).map(Number).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b) || a - b).map(t => TILE[t] + (cnt[t] > 1 ? ' ×' + cnt[t] : ''));
    return parts.length ? parts.join(', ') : 'no tiles';
  };

  // =========================================================================
  // Render
  // =========================================================================
  function sunEl(val, p, v, extra = '') {
    const down = val < 0, a = Math.abs(val);
    const secret = down && p !== 0 && !opt.showFDSuns && !v.over;
    let cls = 'sun' + (down ? ' down' : '') + (secret ? ' secret' : '') + extra;
    if (bidSun[p + 1] === val && val > 0) cls += ' bid';
    return h('span', { class: cls, title: down ? (secret ? 'Face-down sun (used this epoch)' : `Face-down ${a} (used this epoch; back next epoch)`) : `Sun ${a}` }, secret ? '' : a);
  }
  function tilesEl(v, p, pickable) {
    const T = v.tiles[p], wrap = h('div', { class: 'tiles' });
    let any = false;
    for (const t of ORDER) {
      let n = T[t];
      if (p === 0 && mode === 'discard') n -= chosen.filter(x => x === t).length;
      const had = T[t];
      if (had <= 0) continue;
      any = true;
      const can = pickable && pickable(t) && n > 0;
      const el = h('div', { class: 'tg' + (n <= 0 ? ' lost' : '') + (can ? ' pick' : ''), title: TIP[t], role: can ? 'button' : null, tabindex: can ? '0' : null,
        onclick: can ? () => { chooseDiscard(t); } : null },
      h('img', { src: `img/big${t}.png`, alt: TILE[t] }), n > 1 ? h('span', { class: 'n' }, n) : null);
      wrap.append(el);
    }
    if (!any) wrap.append(h('span', { class: 'empty' }, 'No tiles yet'));
    return wrap;
  }

  function render() {
    const v = flow.view();
    renderHeader(v);
    renderBanner(v);
    renderBlock(v);
    renderPlayers(v);
    renderDock(v);
    const hb = $('#hintBox');
    hb.hidden = !hintText;
    if (hintText) { hb.innerHTML = ''; hb.append(h('span', {}, '💡'), h('span', {}, hintText), h('button', { 'aria-label': 'Close hint', onclick: () => { hintText = ''; render(); } }, '×')); }
  }

  function renderHeader(v) {
    const tr = $('#track'); tr.innerHTML = '';
    if (!v) return;
    for (let i = 0; i < v.MaxRa; i++) tr.append(h('span', { class: 'dot' + (i < v.RaTrack ? ' on' : '') }));
    tr.append(h('span', { class: 'lbl' }, `Ra ${v.RaTrack}/${v.MaxRa}`));
    tr.title = `Ra track: ${v.RaTrack} of ${v.MaxRa}. The epoch ends at once (no auction) when it fills.`;
    $('#epochChip').textContent = `Epoch ${v.Epoch} of 3`;
    $('#bagChip').textContent = `${v.bagCount} tiles remaining`;
  }

  function actBtn(label, onclick, cls = '', disabled = false, title = '') {
    return h('button', { class: 'btn ' + cls, onclick, disabled, title: title || null }, label);
  }
  function hintBtn() { return actBtn('Hint', () => { const t = flow.hint(); if (t) { hintText = t; render(); } }, '', false, 'What would the AI do?'); }

  function renderBanner(v) {
    const P = $('#prompt'), S = $('#subprompt'), A = $('#actions'), B = $('#banner');
    A.innerHTML = ''; B.className = '';
    if (!v || (!inGame && !v.over)) {
      P.textContent = 'Play Ra against the AI'; S.textContent = 'Choose the number of players.';
      for (const n of [3, 4, 5]) A.append(actBtn(`${n} players`, () => startGame(n), n === opt.players ? 'primary' : ''));
      return;
    }
    if (v.over) {
      P.textContent = v.winner === 1 ? 'You win!' : `${v.names[v.winner - 1]} wins.`;
      S.textContent = 'Final scores: ' + v.names.map((n, i) => `${i === 0 ? 'You' : n} ${v.scores[i]}`).join(' · ');
      A.append(actBtn('Scores', scoresDialog), actBtn('History', showHistory), actBtn('New game', () => newGameDialog(), 'primary'));
      return;
    }
    const lot = `${lotSummary(v)} + the ${v.SunOnBlock} sun`;
    switch (mode) {
      case 'turn': {
        B.className = 'yours';
        P.textContent = 'Your turn';
        S.textContent = ctx.blockFull ? 'The block is full: call Ra or use a God.'
          : `Draw a tile${ctx.canGod ? ', call Ra, or use a God' : ' or call Ra'}. If you call Ra and everyone passes, you must bid.`;
        A.append(actBtn('Draw tile', () => resolve({ action: 'draw' }), 'primary', !ctx.canDraw, 'Tiles left: ' + v.bagCount));
        A.append(actBtn('Call Ra', () => resolve({ action: 'ra' }), ''));
        if (ctx.canGod) A.append(actBtn(`Use God (${v.tiles[0][4]})`, () => { mode = 'godpick'; render(); }, '', false, 'Take one tile from the block (not a God)'));
        A.append(hintBtn());
        break;
      }
      case 'godpick':
        B.className = 'yours';
        P.textContent = 'Use a God: pick a tile from the block';
        S.textContent = 'You can take any tile except a God.';
        A.append(actBtn('Cancel', () => { mode = godFromAgain ? 'godAgain' : 'turn'; render(); }));
        break;
      case 'godAgain':
        B.className = 'yours';
        P.textContent = `You have ${v.tiles[0][4] > 1 ? 'more Gods' : 'another God'}`;
        S.textContent = ctx.canGod ? 'Take another tile from the block, or end your turn.'
          : v.block.length ? 'Only Gods are left on the block, and a God can\'t take a God.' : 'The block is empty, so your turn ends here.';
        if (ctx.canGod) A.append(actBtn('Use God', () => { mode = 'godpick'; render(); }));
        A.append(actBtn('End turn', () => resolve({ action: 'pass' }), 'primary'));
        break;
      case 'bid': {
        B.className = 'bidding';
        P.textContent = `Auction: ${lot}`;
        const hi = ctx.high ? `High bid: ${v.names[ctx.highBidder - 1]}'s ${ctx.high}.` : 'No bids yet.';
        S.textContent = (raEvent ? youify(raEvent) + ' ' : '') + hi + (ctx.mustBid ? ' You called Ra and everyone passed, so you must bid.' : '');
        const legal = v.suns[0].filter(s => s > ctx.high);
        for (const s of legal) A.append(actBtn(h('span', { class: 'sunbtn' }, 'Bid ', h('b', {}, s)), () => resolve(s), 'primary'));
        if (!legal.length && !ctx.mustBid) S.textContent += ' None of your suns beats it.';
        A.append(actBtn('Pass', () => resolve(0), '', ctx.mustBid));
        A.append(hintBtn());
        break;
      }
      case 'discard': {
        B.className = 'yours';
        const left = { civ: need.civ - chosen.filter(t => t <= 9).length, mon: need.mon - chosen.filter(t => t >= 11).length };
        const what = [need.civ ? `${need.civ} civilization${need.civ > 1 ? 's' : ''}` : '', need.mon ? `${need.mon} monument${need.mon > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
        P.textContent = `${need.civ ? 'Unrest' : ''}${need.civ && need.mon ? ' and ' : ''}${need.mon ? 'Earthquake' : ''}: discard ${what}`;
        S.textContent = left.civ + left.mon > 0 ? 'Tap the highlighted tiles in your area below.' : 'Ready.';
        A.append(actBtn(`Discard${chosen.length ? ' ' + chosen.map(t => TILE[t]).join(', ') : ''}`, () => resolve(chosen.slice()), 'danger', left.civ + left.mon > 0));
        if (chosen.length) A.append(actBtn('Undo', () => { chosen = []; render(); }));
        break;
      }
      case 'result':
        P.textContent = resultText;
        S.textContent = '';
        A.append(actBtn('Continue', () => { const p = pending; pending = null; if (p) p(); }, 'primary'));
        break;
      default: {
        const p = v.Turn;
        P.textContent = endText || (p === 1 ? 'Your move…' : `${v.names[p - 1]}'s turn`);
        const last = feedItems[feedItems.length - 1];
        S.textContent = last ? (last.who ? last.who + ' ' : '') + last.text : '';
      }
    }
  }

  function renderBlock(v) {
    const sl = $('#slots'); sl.innerHTML = '';
    $('#sobSun').textContent = v ? v.SunOnBlock : 1;
    $('#lotInfo').textContent = v ? `${v.block.length}/8 tiles` : '';
    for (let i = 1; i <= 8; i++) {
      let t = null, ra = false;
      if (v && i <= v.block.length) t = v.block[i - 1];
      else if (v && raSlot && i === v.block.length + 1) { t = 0; ra = true; }
      if (t === null) { sl.append(h('div', { class: 'slot', 'aria-label': 'empty slot' })); continue; }
      const pick = mode === 'godpick' && !ra;
      const ok = pick && t !== 4;
      const el = h(pick ? 'button' : 'div', { class: 'slot filled' + (ra ? ' ra' : '') + (pick ? ' pick' + (ok ? '' : ' nope') : ''),
        title: ra ? 'Ra tile (starts an auction)' : TIP[t], disabled: pick && !ok, onclick: ok ? () => resolve({ action: 'god', pos: i }) : null },
      h('img', { src: `img/big${t}.png`, alt: ra ? 'Ra' : TILE[t] }), h('span', { class: 'cap' }, ra ? 'Ra' : TILE[t]));
      sl.append(el);
    }
  }

  function renderPlayers(v) {
    const box = $('#players'); box.innerHTML = '';
    if (!v) return;
    const st = pharStanding(v);
    for (let p = 2; p <= v.N; p++) {
      const i = p - 1, out = !(v.suns[i][3] > 0);
      const card = h('article', { class: 'pcard' + (v.Turn === p && !v.over ? ' turn' : '') + (out && !v.over ? ' out' : '') });
      const score = opt.showScores || v.over ? v.scores[i] : '?';
      card.append(h('div', { class: 'phead' }, h('span', { class: 'pname' }, v.names[i]),
        st[i] ? h('span', { class: 'badge ' + st[i], title: `${st[i] === 'most' ? 'Most' : 'Fewest'} Pharaohs right now (${v.tiles[i][1]}): ${st[i] === 'most' ? '+5' : '−2'} at the end of the epoch if it stays this way` }, st[i] === 'most' ? 'Most Pharaohs' : 'Fewest Pharaohs') : null,
        h('span', { class: 'pscore', title: opt.showScores || v.over ? 'Score' : 'Hidden (Settings → Show AI scores)' }, score)));
      card.append(h('div', { class: 'sunrow' }, v.suns[i].filter(x => x !== 0).sort((a, b) => (b > 0) - (a > 0) || Math.abs(a) - Math.abs(b)).map(x => sunEl(x, i, v)),
        out && !v.over ? h('span', { class: 'empty' }, 'out of suns') : null));
      card.append(tilesEl(v, i, null));
      if (bubbles[p]) card.append(h('div', { class: 'bubble ' + (bubbles[p].c || '') }, bubbles[p].t));
      box.append(card);
    }
  }

  function renderDock(v) {
    const d = $('#dock'); d.innerHTML = '';
    if (!v) { setDockH(); return; }
    const st = pharStanding(v), pr = projection(v, 0);
    const legal = mode === 'bid' ? v.suns[0].filter(s => s > ctx.high) : [];
    const you = h('section', { class: 'you' + (v.Turn === 1 ? ' turn' : ''), 'aria-label': 'Your area' });
    you.append(h('div', { class: 'who' }, h('span', { class: 'pname' }, v.names[0]),
      h('span', { class: 'pscore', style: 'margin:0' }, v.scores[0], h('small', {}, 'pts')),
      v.over ? null : h('button', { class: 'proj', 'aria-expanded': String(showBreakdown), onclick: () => { showBreakdown = !showBreakdown; render(); },
        title: showBreakdown ? 'Hide the breakdown' : 'Show how this is made up' }, `this epoch so far ${pr.total >= 0 ? '+' : ''}${pr.total} ${showBreakdown ? '▴' : '▾'}`)));

    const suns = h('div', { class: 'sunrow' });
    for (const x of v.suns[0].filter(x => x !== 0).sort((a, b) => (b > 0) - (a > 0) || Math.abs(a) - Math.abs(b))) {
      const can = legal.includes(x);
      const s = sunEl(x, 0, v, can ? ' can' : '');
      if (can) { s.setAttribute('role', 'button'); s.setAttribute('tabindex', '0'); s.title = 'Bid ' + x; s.addEventListener('click', () => resolve(x)); s.addEventListener('keydown', e => { if (e.key === 'Enter') resolve(x); }); }
      suns.append(s);
    }
    you.append(suns);
    if (st[0]) you.append(h('span', { class: 'badge ' + st[0], title: `${st[0] === 'most' ? 'Most' : 'Fewest'} Pharaohs right now (${v.tiles[0][1]}): ${st[0] === 'most' ? '+5' : '−2'} at the end of the epoch if it stays this way` }, st[0] === 'most' ? 'Most Pharaohs' : 'Fewest Pharaohs'));
    const pick = mode === 'discard' ? t => {
      const left = { civ: need.civ - chosen.filter(x => x <= 9).length, mon: need.mon - chosen.filter(x => x >= 11).length };
      return (t >= 5 && t <= 9 && left.civ > 0) || (t >= 11 && left.mon > 0);
    } : null;
    you.append(tilesEl(v, 0, pick));
    if (bubbles[1]) you.append(h('span', { class: 'badge' }, bubbles[1].t));
    if (showBreakdown && !v.over) {
      const fmt = x => (x > 0 ? '+' : '') + x;
      you.append(h('div', { class: 'breakdown' }, Object.entries(pr.parts).map(([k, x]) => h('span', { class: x < 0 ? 'neg' : x > 0 ? 'pos' : '' }, `${k} ${fmt(x)}`))));
    }
    d.append(you);
    setDockH();
  }
  function setDockH() {
    const d = $('#dock');
    document.documentElement.style.setProperty('--dock-h', (d.offsetHeight || 0) + 'px');
  }
  new ResizeObserver(setDockH).observe($('#dock'));

  function chooseDiscard(t) { chosen.push(t); render(); }

  // =========================================================================
  // Dialogs
  // =========================================================================
  let dlgResolve = null;
  function dialog(title, body, buttons = [{ label: 'Close', cls: 'primary' }]) {
    const d = $('#dialog'); d.innerHTML = '';
    d.append(h('h2', {}, title), body);
    const bar = h('div', { class: 'dlg-actions' });
    d.append(bar);
    $('#dialogBack').hidden = false;
    return new Promise(res => {
      dlgResolve = v => { $('#dialogBack').hidden = true; dlgResolve = null; res(v); };
      buttons.forEach((b, i) => {
        const e = actBtn(b.label, () => { const r = b.value ? b.value() : b.label; if (r !== false) dlgResolve(r); }, b.cls || '');
        bar.append(e); if (i === buttons.length - 1) setTimeout(() => e.focus(), 0);
      });
    });
  }
  $('#dialogBack').addEventListener('click', e => { if (e.target.id === 'dialogBack' && dlgResolve && !dlgLocked) dlgResolve(null); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && dlgResolve && !dlgLocked) dlgResolve(null); });
  let dlgLocked = false;

  function showEpochDialog(info, review) {
    const v = flow.view();
    const keys = ['phar', 'nile', 'god', 'gold', 'civ'].concat(info.epoch === 3 ? ['mon', 'sun'] : []);
    const LBL = { phar: 'Pharaohs', nile: 'Nile/Flood', god: 'Gods', gold: 'Gold', civ: 'Civilizations', mon: 'Monuments', sun: 'Suns' };
    const showAll = opt.showScores || info.over;
    const tbl = h('table', { class: 'score-table' });
    tbl.append(h('tr', {}, h('th', {}, ''), v.names.map((n, i) => h('th', {}, i === 0 ? 'You' : n))));
    for (const k of keys) tbl.append(h('tr', {}, h('td', {}, LBL[k]), info.parts.slice(1).map(pt => h('td', { class: pt[k] < 0 ? 'neg' : '' }, pt[k] > 0 ? '+' + pt[k] : pt[k] || '·'))));
    const ep = info.parts.slice(1).map(pt => keys.reduce((a, k) => a + pt[k], 0));
    tbl.append(h('tr', {}, h('td', {}, 'This epoch'), ep.map(x => h('td', { class: 'tot' + (x < 0 ? ' neg' : '') }, (x > 0 ? '+' : '') + x))));
    const row = h('tr', { class: info.over ? '' : '' }, h('td', {}, info.over ? 'Final score' : 'Total'),
      v.scores.map((s, i) => h('td', { class: 'tot' + (info.over && v.winner === i + 1 ? ' win' : '') }, i === 0 || showAll ? s : '?')));
    if (info.over) row.className = '';
    tbl.append(row);
    const body = h('div', {});
    if (info.over) body.append(h('p', {}, v.winner === 1 ? '🏆 You win!' : `🏆 ${v.names[v.winner - 1]} wins.`));
    body.append(tbl);
    body.append(h('p', { class: 'muted', style: 'font-size:12.5px' }, info.over ? 'Ties go to the highest single sun. Scores never drop below 0.'
      : 'Floods, Gods, Gold and civilizations are discarded now; Pharaohs, Niles and monuments carry over. Used suns turn face up for the next epoch.'));
    if (!showAll && !info.over) body.append(h('p', { class: 'muted', style: 'font-size:12.5px' }, 'AI totals are hidden (Settings → Show AI scores).'));
    const btns = info.over ? [{ label: 'History', value: () => { showHistory(); return false; } }, { label: 'New game', cls: 'primary', value: () => { setTimeout(newGameDialog, 0); return true; } }, { label: 'Close', cls: '' }]
      : review ? [{ label: 'Close', cls: 'primary' }] : [{ label: `Start epoch ${info.epoch + 1}`, cls: 'primary' }];
    return dialog(info.over ? 'Game over' : `Epoch ${info.epoch} scoring`, body, btns);
  }
  // Whole-game scoring: every scored epoch, the current epoch so far, and the end-of-game outlook.
  function scoreTable(cols, rows) {
    const t = h('table', { class: 'score-table' });
    t.append(h('tr', {}, h('th', {}, ''), cols.map(c => h('th', {}, c))));
    for (const r of rows) t.append(h('tr', { class: r.cls || '' }, h('td', {}, r.label),
      r.vals.map(x => typeof x === 'string' ? h('td', { class: r.tot ? 'tot' : '' }, x)
        : h('td', { class: (r.tot ? 'tot ' : '') + (x < 0 ? 'neg' : '') }, r.plain ? x : x > 0 ? '+' + x : x === 0 ? '·' : x))));
    return h('div', { class: 'table-wrap' }, t);
  }
  function scoresDialog() {
    const v = flow.view();
    if (!v) { toast('Start a game first'); return; }
    const cols = v.names.map((n, i) => i === 0 ? 'You' : n);
    const showAll = opt.showScores || v.over;
    const hidden = (x, i) => i === 0 || showAll ? x : '?';
    const LBL = { phar: 'Pharaohs', nile: 'Nile/Flood', god: 'Gods', gold: 'Gold', civ: 'Civilizations', mon: 'Monuments', sun: 'Suns' };
    const body = h('div', { class: 'scores' });
    for (const e of v.epochHistory) {
      const keys = ['phar', 'nile', 'god', 'gold', 'civ'].concat(e.epoch === 3 ? ['mon', 'sun'] : []);
      const rows = keys.map(k => ({ label: LBL[k], vals: e.parts.map(pt => pt[k]) }));
      rows.push({ label: 'Epoch total', tot: true, vals: e.parts.map(pt => keys.reduce((a, k) => a + pt[k], 0)) });
      rows.push({ label: e.epoch === 3 ? 'Final score' : 'Score after', tot: true, plain: true, vals: e.scores.map((x, i) => hidden(x, i)) });
      body.append(h('h3', {}, `Epoch ${e.epoch}`), scoreTable(cols, rows));
    }
    const scoredThis = v.epochHistory.some(e => e.epoch === v.Epoch);
    if (!v.over && !scoredThis) {
      const pr = v.names.map((_, i) => projection(v, i, true));
      const keys = Object.keys(pr[0].parts);
      const rows = keys.map(k => ({ label: k, vals: pr.map(x => x.parts[k]) }));
      rows.push({ label: 'Epoch so far', tot: true, vals: pr.map(x => x.total) });
      rows.push({ label: 'Score if it ended now', tot: true, plain: true, vals: pr.map((x, i) => hidden(Math.max(0, v.scores[i] + x.total), i)) });
      body.append(h('h3', {}, `Epoch ${v.Epoch} so far`),
        h('p', { class: 'note' }, 'What each player would score if the epoch ended now, from the tiles they hold.'), scoreTable(cols, rows));
      if (v.Epoch < 3) {
        body.append(h('h3', {}, 'End of game outlook'),
          h('p', { class: 'note' }, 'Monuments and suns score only after epoch 3. This is where everyone stands now.'),
          scoreTable(cols, [
            { label: 'Monuments', vals: pr.map(x => x.final.mon) },
            { label: 'Sun total', plain: true, vals: pr.map(x => x.final.sunSum) },
            { label: 'Sun bonus', vals: pr.map(x => x.final.sun) },
          ]));
      }
    }
    if (!v.epochHistory.length && v.Epoch === 1) body.prepend(h('p', { class: 'note' }, 'No epoch has been scored yet.'));
    if (!showAll) body.append(h('p', { class: 'note' }, 'AI totals are hidden (Settings → Show AI scores); their points per epoch are shown.'));
    dialog('Scores', body);
  }
  function moreMenu() {
    const body = h('div', { class: 'newgame' },
      actBtn('History', () => { dlgResolve && dlgResolve(null); setTimeout(showHistory, 0); }),
      actBtn('Rules', () => { dlgResolve && dlgResolve(null); setTimeout(rulesDialog, 0); }),
      actBtn('Settings', () => { dlgResolve && dlgResolve(null); setTimeout(settingsDialog, 0); }));
    dialog('Menu', body);
  }
  function showHistory() {
    const v = flow.view(); if (!v) return;
    const pre = h('pre', { class: 'history' }, v.history);
    const prevResolve = dlgResolve;
    if (prevResolve) { /* replace current dialog */ }
    dialog('Game history', pre, [{ label: 'Copy', value: () => { try { navigator.clipboard.writeText(v.history); toast('Copied'); } catch (e) { /* ignore */ } return false; } }, { label: 'Close', cls: 'primary' }]);
  }
  function settingsDialog() {
    const body = h('div', { class: 'settings' });
    const name = h('input', { type: 'text', value: opt.name, maxlength: 20, 'aria-label': 'Your name' });
    const cb = (k, label, sub) => { const i = h('input', { type: 'checkbox' }); i.checked = !!opt[k]; i.addEventListener('change', () => { opt[k] = i.checked; save(); if (k === 'easy') flow.setEasy(opt.easy); render(); }); return h('label', {}, i, h('span', {}, label, sub ? h('div', { class: 'muted', style: 'font-size:12.5px' }, sub) : null)); };
    const speed = h('select', {}, ['slow', 'normal', 'fast'].map(s => { const o = h('option', { value: s }, s[0].toUpperCase() + s.slice(1)); if (opt.speed === s) o.selected = true; return o; }));
    speed.addEventListener('change', () => { opt.speed = speed.value; save(); });
    const aiSel = h('select', { 'aria-label': 'AI opponents' }, [['improved', 'Improved (2026)'], ['classic', 'Classic (2008)']].map(([v, t]) => { const o = h('option', { value: v }, t); if (opt.ai === v) o.selected = true; return o; }));
    aiSel.addEventListener('change', () => { opt.ai = aiSel.value; save(); if (inGame) toast('Takes effect in your next game'); });
    body.append(h('label', {}, h('span', {}, 'Your name'), name),
      h('label', {}, h('span', {}, 'AI opponents', h('div', { class: 'muted', style: 'font-size:12.5px' }, 'Improved: retuned in 2026 to be stronger and hard to exploit. Classic: the original 2008 AI.')), aiSel),
      cb('easy', 'Easy mode', 'The AI misjudges values a little and calls Ra less sharply (as in the original).'),
      cb('showScores', 'Show AI scores', 'Off: AI totals stay hidden until the end, as with face-down tablets.'),
      cb('showFDSuns', 'Show the values of AI face-down suns'),
      h('label', {}, h('span', {}, 'AI speed'), speed));
    return dialog('Settings', body, [{ label: 'Done', cls: 'primary', value: () => { const n = name.value.trim(); if (n && n !== opt.name) { opt.name = n; save(); flow.setName(n); } render(); return true; } }]);
  }
  function newGameDialog() {
    const body = h('div', {}, h('p', { class: 'muted' }, (inGame ? 'This ends the current game. ' : 'You play against 2–4 AIs. ') + `Opponents: ${opt.ai === 'improved' ? 'Improved AI (2026)' : 'Classic AI (2008)'} — change in Settings.`));
    const ng = h('div', { class: 'newgame' });
    for (const n of [3, 4, 5]) ng.append(actBtn(`${n} players`, () => { dlgResolve && dlgResolve(n); }, n === opt.players ? 'primary' : ''));
    body.append(ng);
    dialog('New game', body, [{ label: 'Cancel' }]).then(n => { if (typeof n === 'number') startGame(n, true); });
  }
  function rulesDialog() {
    const b = h('div', { class: 'rules' }); b.innerHTML = RULES_HTML;
    dialog('How to play Ra', b);
  }
  function toast(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { e.hidden = true; }, 1600); }

  const RULES_HTML = `
    <p>Ra lasts three epochs. You win tiles in auctions by bidding your <b>suns</b>, and score at the end of each epoch. Highest total after epoch 3 wins (ties: highest single sun).</p>
    <h3>Your turn</h3>
    <ul><li><b>Draw tile</b>: it goes on the block. A <b>Ra</b> tile moves the Ra track and starts an auction instead.</li>
    <li><b>Call Ra</b>: start an auction now. If you called it yourself and everyone passes, you must bid (unless the block was full).</li>
    <li><b>Use God</b>: take one tile from the block (not a God). You can use several Gods in one turn.</li></ul>
    <h3>Auctions</h3>
    <p>Starting left of the player who called Ra and ending with them, everyone may bid one face-up sun higher than the current bid, or pass. The winner takes all the block tiles plus the prize sun (face down, usable next epoch); the winning sun becomes the new prize. If everyone passes after a Ra draw, the tiles stay; if the block was full they're discarded. With no face-up suns you sit out the rest of the epoch.</p>
    <p>The epoch ends when nobody has a face-up sun, or immediately — no auction — when the Ra track fills (8/9/10 Ra tiles for 3/4/5 players).</p>
    <h3>Disasters</h3>
    <p>Funeral: lose 2 Pharaohs. Drought: lose 2 Floods, then Niles. Unrest: discard 2 civilizations. Earthquake: discard 2 monuments. Tiles from the same lot count.</p>
    <h3>Scoring each epoch</h3>
    <ul><li>Pharaohs: most +5, fewest −2 (no one scores if all tie). Kept.</li>
    <li>Niles 1 each but only with a Flood; Floods 1 each. Niles kept, Floods discarded.</li>
    <li>Gods 2 each, Gold 3 each (discarded).</li>
    <li>Civilizations: none −5; 3/4/5 different +5/+10/+15 (discarded).</li></ul>
    <h3>Game end only</h3>
    <ul><li>Monuments: 1 per different type up to 6, 10 for 7, 15 for 8, plus 5/10/15 for 3/4/5 of one type.</li>
    <li>Suns: highest total of all your suns +5, lowest −5.</li></ul>
    <p>Scores never go below 0. <b>Hint</b> asks the AI what it would do.</p>`;

  // =========================================================================
  // Game control
  // =========================================================================
  async function startGame(n, confirmed) {
    if (inGame && !confirmed && !(await confirmEnd())) return;
    opt.players = n; save();
    inGame = true; bubbles = {}; bidSun = {}; raSlot = false; chosen = []; hintText = ''; mode = 'wait'; pending = null;
    if (dlgResolve) dlgResolve(null);
    flow.setAI(opt.ai === 'improved' && window.RA_IMPROVED_AI ? window.RA_IMPROVED_AI[n] : null);
    flow.newGame(n).catch(e => { console.error(e); toast('Error: ' + e.message); });
  }
  async function confirmEnd() {
    if (!inGame) return true;
    const r = await dialog('End this game?', h('p', {}, 'Your current game will be lost.'), [{ label: 'Keep playing' }, { label: 'End game', cls: 'danger' }]);
    return r === 'End game';
  }
  $('#btnNew').addEventListener('click', newGameDialog);
  $('#btnHistory').addEventListener('click', showHistory);
  $('#btnScores').addEventListener('click', scoresDialog);
  $('#btnMore').addEventListener('click', moreMenu);
  $('#btnRules').addEventListener('click', rulesDialog);
  $('#btnSettings').addEventListener('click', settingsDialog);

  // =========================================================================
  // Info bubbles for touch screens. Desktop keeps the native hover tooltips (title).
  // Touch: tap shows the explanation on things that do nothing when tapped; press and
  // hold shows it on things that do (buttons, tiles you can pick, suns you can bid).
  // =========================================================================
  const tip = $('#tip');
  let tipFor = null, holdTimer = 0, suppressClick = false, lastPointer = 'mouse', tipHide = 0;
  const interactive = el => !!el.closest('button, [role=button], a, input, select, .pick');
  function showTip(el) {
    const text = el.getAttribute('title') || el.dataset.tip;
    if (!text) return;
    tip.textContent = text; tip.hidden = false; tipFor = el;
    const r = el.getBoundingClientRect(), tw = Math.min(300, window.innerWidth - 16);
    tip.style.maxWidth = tw + 'px';
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    let x = r.left + r.width / 2 - w / 2; x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    let y = r.top - hgt - 10, below = false;
    if (y < 8) { y = r.bottom + 10; below = true; }
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    tip.classList.toggle('below', below);
    tip.style.setProperty('--arrow-x', Math.max(12, Math.min(w - 12, r.left + r.width / 2 - x)) + 'px');
    clearTimeout(tipHide); tipHide = setTimeout(hideTip, 5000);
  }
  function hideTip() { tip.hidden = true; tipFor = null; }
  document.addEventListener('pointerdown', e => {
    lastPointer = e.pointerType;
    clearTimeout(holdTimer);
    if (tipFor && !tip.contains(e.target) && e.target.closest('[title]') !== tipFor) hideTip();
    if (e.pointerType !== 'touch') return;
    const el = e.target.closest('[title]');
    if (!el || !interactive(el)) return;
    holdTimer = setTimeout(() => { showTip(el); suppressClick = true; }, 450);
  }, true);
  for (const ev of ['pointerup', 'pointercancel', 'pointermove']) document.addEventListener(ev, e => {
    if (ev === 'pointermove' && Math.abs(e.movementX) + Math.abs(e.movementY) < 6) return;
    clearTimeout(holdTimer);
  }, true);
  document.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    if (lastPointer !== 'touch') return;
    const el = e.target.closest('[title]');
    if (el && !interactive(el)) { if (tipFor === el) hideTip(); else showTip(el); }
  }, true);
  document.addEventListener('contextmenu', e => { if (lastPointer === 'touch' && e.target.closest('[title]')) e.preventDefault(); });
  window.addEventListener('scroll', hideTip, { passive: true });

  render();
  window.RA_DEBUG = () => ({ view: flow.view(), mode, ctx, need, chosen, opt });
})();
