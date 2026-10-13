// Ra — game flow shared by both web versions.
// The VB6 version drove the game from button handlers and a GameState number; here the same
// sequence is one async turn loop. It awaits the UI for the human's choices and for the places
// where the original stopped on a Continue button.
//
// The UI object supplies:
//   render()                      redraw from flow.view()
//   status(text, kind)            an event line (original status-bar wording)
//   humanTurn(ctx) -> {action:'draw'|'ra'|'god', pos}
//   godAgain(ctx)  -> {action:'god', pos} | {action:'pass'}
//   humanBid(ctx)  -> sun value, or 0 to pass
//   discard(need)  -> array of tile numbers to discard ({civ, mon} owed)
//   pause(kind, info)             'draw' | 'god' | 'auction': where VB showed Continue
//   epochEnd(info)                after scoring (VB: Continue "Epoch 2" / Show History)
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined') ? require('./ra_engine.js') : root.RA_ENGINE;

  const ARTICLE = [null, 'a Pharaoh', 'a Nile', 'a Flood', 'a God', 'an Astronomy', 'an Art', 'an Agriculture', 'a Writing', 'a Religion', 'a Gold',
    'an Obelisk', 'a Palace', 'a Sphinx', 'a Pyramid', 'a Fortress', 'a Step Pyramid', 'a Temple', 'a Statues', 'a Funeral', 'a Drought', 'an Unrest', 'an Earthquake'];
  const isCiv = t => t >= 5 && t <= 9, isMon = t => t >= 11 && t <= 18;

  class Abort extends Error {}

  function createFlow(ui) {
    let g = null, token = 0, waiting = null, settings = { easy: false, names: ['Doris', 'Anna', 'Bob', 'Cathy', 'Don'] };
    const name = p => g.view().names[p - 1];

    function guard(my) { if (my !== token) throw new Abort(); }
    async function wait(my, ctx, promise) {
      waiting = ctx;
      try { const r = await promise; guard(my); return r; } finally { if (my === token) waiting = null; }
    }

    async function newGame(players, seed) {
      const my = ++token;
      if (seed == null) seed = Math.floor(Math.random() * 1e9);
      // default: original v1.2.0 AIs. With an improved AI, your seat is modeled by it too (hints come from it, and the AIs predict your bids with it).
      const variants = settings.ai ? new Array(players).fill(settings.ai) : undefined;
      g = E.createGame({ players, seed, human: true, easy: settings.easy, names: settings.names.slice(), analyze: false, variants });
      ui.newGame && ui.newGame({ players, seed });
      ui.render();
      ui.status(`New ${players}-player game started.`, 'start');
      try {
        while (!g.view().over) {
          if (g.view().Turn === 1) await humanTurn(my); else await aiTurn(my);
        }
      } catch (e) { if (!(e instanceof Abort)) throw e; }
    }

    async function aiTurn(my) {
      const p = g.view().Turn;
      ui.turnStart && ui.turnStart(p);
      const r = g.aiTurn();
      if (r.type === 'draw') {
        ui.status(`${name(p)} has drawn ${ARTICLE[r.tile]} tile.`, 'draw'); ui.render();
        await wait(my, { kind: 'continue' }, ui.pause('draw', { p, tile: r.tile }));
        g.advance();
      } else if (r.type === 'god') {
        ui.status(`${name(p)} has exchanged a God for ${ARTICLE[r.tile]}.`, 'god'); ui.render();
        await wait(my, { kind: 'continue' }, ui.pause('god', { p, tile: r.tile }));
        g.resolveAuction(0);
        await afterAuction(my);
      } else if (r.type === 'epochEnd') {
        ui.status(`${name(p)} has drawn a Ra tile.`, 'ra'); ui.render();
        await epochEnd(my);
      } else {
        ui.status(r.cause === 'ra' ? `${name(p)} has drawn a Ra tile.` : `${name(p)} has called Ra.`, 'ra');
        await auction(my, r.cause);
      }
    }

    async function humanTurn(my) {
      ui.turnStart && ui.turnStart(1);
      const v = g.view();
      // a God can take any block tile except another God
      const takeable = v.block.some(t => t !== 4);
      const ctx = { kind: 'turn', canDraw: v.block.length < 8, canGod: v.tiles[0][4] >= 1 && takeable, blockFull: v.block.length === 8 };
      const c = await wait(my, ctx, ui.humanTurn(ctx));
      if (c.action === 'draw') {
        const r = g.humanDraw();
        if (r.type === 'draw') {
          ui.status(`${name(1)} has drawn ${ARTICLE[r.tile]} tile.`, 'draw'); ui.render();
          await wait(my, { kind: 'continue' }, ui.pause('draw', { p: 1, tile: r.tile }));
          g.advance();
        } else if (r.type === 'epochEnd') {
          ui.status(`${name(1)} has drawn a Ra tile.`, 'ra'); ui.render();
          await epochEnd(my);
        } else {
          ui.status(`${name(1)} has drawn a Ra tile.`, 'ra');
          await auction(my, 'ra');
        }
      } else if (c.action === 'ra') {
        g.humanCallRa();
        ui.status(`${name(1)} has called Ra.`, 'ra');
        await auction(my, 'call');
      } else {
        let pos = c.pos;
        for (;;) {
          const r = g.humanGod(pos);
          ui.status(`${name(1)} has exchanged a God for ${ARTICLE[r.tile]}.`, 'god'); ui.render();
          if (r.need.civ + r.need.mon > 0) await doDiscard(my, r.need);
          const v2 = g.view();
          if (v2.tiles[0][4] < 1) break;
          const ctx2 = { kind: 'godAgain', canGod: v2.block.some(t => t !== 4) };
          const a = await wait(my, ctx2, ui.godAgain(ctx2));
          if (a.action !== 'god') break;
          pos = a.pos;
        }
        g.advance();
      }
    }

    async function doDiscard(my, need, fromAuction) {
      need = Object.assign({ fromAuction: !!fromAuction }, need);
      const tiles = await wait(my, { kind: 'discard', need }, ui.discard(need));
      g.humanDiscard(tiles); ui.render();
    }

    async function auction(my, cause) {
      const a = g.auctionStart(cause);
      ui.auctionBids && ui.auctionBids(a.phaseA);
      ui.render();
      let hb = 0;
      if (a.canBid) {
        if (a.high === 0 && a.phaseA.length) ui.status('So far, everyone has passed.', 'append');
        const ctx = { kind: 'bid', high: a.high, highBidder: a.highBidder, mustBid: a.mustBid, force: a.force };
        hb = await wait(my, ctx, ui.humanBid(ctx));
      }
      const f = g.auctionFinish(hb);
      ui.auctionBids && ui.auctionBids(f.phaseB, hb);
      if (f.winner === 0) {
        ui.status('Everyone declined the set.', a.canBid ? 'auction' : 'append');
      } else if (f.winner === 1 && f.need.civ + f.need.mon > 0) {
        ui.auctionWon && ui.auctionWon(f);
        const res = g.resolveAuction(1); ui.render();
        await doDiscard(my, res.need, true);
        ui.auctionDone && ui.auctionDone(res);
        return afterAuction(my);
      } else {
        ui.status(`${name(f.winner)} won the auction with the ${f.bid}.`, 'auction');
      }
      ui.render();
      await wait(my, { kind: 'continue' }, ui.pause('auction', f));
      const res = g.resolveAuction(f.winner);
      ui.auctionDone && ui.auctionDone(res);
      ui.render();
      await afterAuction(my);
    }

    async function afterAuction(my) {
      if (g.epochOver()) await epochEnd(my); else g.advance();
    }

    async function epochEnd(my) {
      g.scoreEpoch();
      const v = g.view();
      ui.status(v.over ? `${name(v.winner)} is the winner!` : `Epoch ${v.Epoch} has ended.`, 'epoch');
      ui.render();
      await wait(my, { kind: 'epoch' }, ui.epochEnd({ epoch: v.Epoch, over: v.over, parts: v.lastEpochParts, scores: v.scores, added: v.scoreAdded, winner: v.winner }));
      if (!v.over) { g.newEpoch(); ui.render(); }
    }

    // Hint menu: the original allows it on your turn (draw/call/God choice) and while bidding.
    function hint() {
      if (!g || !waiting) return null;
      if (waiting.kind === 'turn') return g.hint('turn');
      if (waiting.kind === 'bid') return g.hint('bid', waiting.mustBid);
      return null;
    }

    return {
      newGame, hint,
      view: () => g && g.view(),
      waiting: () => waiting,
      setEasy(e) { settings.easy = !!e; if (g) g.setEasy(e); },
      setAI(spec) { settings.ai = spec || null; },   // takes effect from the next game
      setName(nm) { settings.names[0] = nm; if (g) g.setName(0, nm); },
      abort() { token++; waiting = null; },
      isCiv, isMon, ARTICLE,
    };
  }

  const api = { createFlow, Abort, ARTICLE };
  if (typeof module !== 'undefined') module.exports = api; else root.RA_FLOW = api;
})(this);
