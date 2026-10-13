// Ra — headless game engine + AI, ported line by line from the VB6 sources
// (Playable/BigAdapt/raPharTest.frm = v1.2.0, ra2.frm = v1.1.1).
//
// Every seat is played by the AI (ComputerTakeTurn), so AIs of different
// versions can be compared. Arrays are 1-indexed with a real slot 0, as in VB.
// Single-precision VB arrays are Float32Array so stores round like VB Singles.
// Places where the VB code is buggy but the evolved weights were tuned against
// it are kept and marked `VB quirk`.
//
// Seat-1 note: in the VB game seat 1 is always the human. Here seat 1 uses the
// same turn logic as every other seat, and the auction treats all seats alike
// (see runAuction). Everything else is the original game.

(function (root) {
  'use strict';
  const WEIGHTS = (typeof module !== 'undefined') ? require('./weights.js') : root.RA_WEIGHTS;

  const GL = 46, SL = 21, TN = GL + SL + 1;          // GroundLevelNeurons, SecondLevelNeurons, TotalNeurons
  const SG = 33, SS = 17, ST = SG + SS + 1;          // SunIsWorthGround/Second/Total
  const Pharaoh = 1, Nile = 2, Flood = 3, God = 4, Cul1 = 5, Cul5 = 9, Gold = 10, Mon1 = 11, Mon8 = 18;
  const BAG = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCCCCCCCDDDDDDDDDDDDEEEEEEEEFFFFFGGGGGHHHHHIIIIIJJJJJKKKKKLLLLLMMMMMNNNNNOOOOOPPPPPQQQQQRRRRRSSSSSTTUUVVVVWW';
  const TILE_NAMES = [null, 'Pharaoh', 'Nile', 'Flood', 'God', 'Astronomy', 'Art', 'Agriculture', 'Writing', 'Religion', 'Gold',
    'Obelisk', 'Palace', 'Sphinx', 'Pyramid', 'Fortress', 'Step Pyramid', 'Temple', 'Statues', 'Funeral', 'Drought', 'Unrest', 'Earthquake'];
  const f32 = Math.fround;

  // ---- versions ---------------------------------------------------------------
  // Evolved Pharaoh feature values from raPharTest.frm (Start3P/4P/5PGame), by set number.
  const PHAR_SETS = {
    3: { 2: [-0.46, -1.35, 3.65, 2.01, 1.6], 3: [-0.47, -1.35, 3.55, 1.96, 1.56] },
    4: { 2: [-0.37, -1.43, 3.96, 1.96, 1.7], 3: [-0.4, -1.44, 3.4, 2.12, 1.92], 4: [-0.4, -1.5, 3.18, 1.85, 1.4] },
    5: { 2: [-0.84, -1.5, 3.01, 2.07, 1.36], 3: [-0.84, -1.81, 2.82, 2.07, 1.35], 4: [-0.84, -1.96, 3.36, 1.24, 1.45], 5: [-0.84, -2.02, 2.82, 2.07, 1.53] },
  };
  const VARIANTS = {
    // ra2.frm: one fixed Pharaoh set; Const EasyScrewUp = 0.55 even in normal mode
    // (so the Bargain call needs a +0.9 margin); Flood-God check before Bargain.
    'v1.1.1': { phar: () => [-2, -2.8, 2, 2, 0.8], div: { 3: [7, 2.5], 4: [7, 2], 5: [8.5, 3] }, easyScrewUp: 0.55, bargainFirst: false },
    // raPharTest.frm: evolved Pharaoh set per AI; retuned epoch-3 sun values; Bargain first.
    'v1.2.0': { phar: null, div: { 3: [7, 2.5], 4: [7, 3.15], 5: [8.5, 3.3] }, easyScrewUp: 1, bargainFirst: true },
  };

  // Variant names: 'v1.2.0' | 'v1.1.1', optionally '+evo' (v1.1.1 with the evolved Pharaoh sets),
  // '+oldphar' (v1.2.0 with v1.1.1's fixed Pharaoh values), and '*k' to scale how much the seat values
  // the Pharaoh/Funeral part of every lot by k (an experiment knob; k = 1 is the original AI).
  const variantCache = {};
  // Tunable decision settings (experiment knobs). Defaults reproduce the original AI exactly.
  //   phar[5]   Pharaoh feature values          pharMult  scale on the Pharaoh part of lot values
  //   bargain   Bargain call margin (default 2 - 2*EasyScrewUp)   force  margin for the Force call
  //   auto      Auto call margin (0.4)          autoOther  Auto: other player's slack (-2)
  //   defGap    Defense: other's value lead (1) god  God-use threshold (4)
  //   e3b       epoch-3 sun divisor             catchUp  strength of the catch-up adjustment (1)
  // A variant can also be given as an object: { base: 'v1.2.0', name, params: {...} }.
  function getVariant(name) {
    if (typeof name === 'object') {
      const key = name.name || JSON.stringify(name);
      if (variantCache[key]) return variantCache[key];
      const b = getVariant(name.base || 'v1.2.0'), P = Object.assign({}, name.params || {});
      if (P.nnet && !(P.nnet instanceof Float32Array)) P.nnet = Float32Array.from(P.nnet);
      if (P.sunNets) P.sunNets = P.sunNets.map(a => a && !(a instanceof Float32Array) ? Float32Array.from(a) : a);
      const v = Object.assign({}, b, { name: key, P, pharMult: P.pharMult != null ? P.pharMult : b.pharMult });
      if (P.phar) v.phar = () => P.phar.slice();
      if (P.e3b != null) v.div = Object.assign({}, b.div, { 3: [b.div[3][0], P.e3b], 4: [b.div[4][0], P.e3b], 5: [b.div[5][0], P.e3b] });
      return (variantCache[key] = v);
    }
    if (variantCache[name]) return variantCache[name];
    const m = /^(v1\.1\.1|v1\.2\.0)(\+evo|\+oldphar)?(?:\*([\d.]+))?$/.exec(name);
    if (!m) throw new Error('unknown variant ' + name);
    const v = Object.assign({}, VARIANTS[m[1]], { name, base: m[1], P: {}, pharMult: m[3] ? +m[3] : 1 });
    if (m[2] === '+evo') v.phar = null;
    if (m[2] === '+oldphar') v.phar = VARIANTS['v1.1.1'].phar;
    return (variantCache[name] = v);
  }

  // mulberry32 with its state exposed, so the Hint can run without disturbing the AI's random numbers
  function makeRng(a) {
    const r = function () {
      r.s |= 0; r.s = (r.s + 0x6D2B79F5) | 0;
      let t = Math.imul(r.s ^ (r.s >>> 15), 1 | r.s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.s = a | 0;
    return r;
  }
  // VB CInt/CLng: round half to even
  function cint(x) { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); }
  // VB Str() of a number: leading space for non-negatives, no leading zero before the decimal point
  function vbStr(x) {
    let t = String(Math.round(x * 1e6) / 1e6);
    if (t.startsWith('0.')) t = t.slice(1); else if (t.startsWith('-0.')) t = '-' + t.slice(2);
    return x >= 0 ? ' ' + t : t;
  }
  const SET1 = [-1, -2, 3, 2, 1];   // TestPhar(.,1): the human seat's values (used by the AI to model the human, and by Hint)
  // VB Val(): ignores whitespace, stops at the first invalid character.
  function val(s) { const v = parseFloat(s.replace(/\s+/g, '')); return isNaN(v) ? 0 : v; }

  const netCache = {};
  function loadNets(n) {
    if (netCache[n]) return netCache[n];
    const w = WEIGHTS[n];
    const neuralnet = new Float32Array(GL * (SL - 1) + SL + 1);
    const sunNet = [null];
    let p = 0;
    for (let t = 1; t <= Math.floor(w.nnet.length / 7); t++) { neuralnet[t] = val(w.nnet.substr(p, 5)) / 100; p += 7; }
    for (const k of ['sun1', 'sun2', 'sun3']) {
      const a = new Float32Array(SG * (SS - 1) + SS + 1); p = 0;
      for (let t = 1; t <= Math.floor(w[k].length / 7); t++) { a[t] = val(w[k].substr(p, 5)) / 10; p += 7; }
      sunNet.push(a);
    }
    return (netCache[n] = { neuralnet, sunNet });
  }

  // =============================================================================
  // createGame({ players, variants: ['v1.2.0', ...] (seat 1..N), seed, pharSets?, fixes?, analyze?,
  //              human: true (seat 1 is the human, as in the VB game), easy: false, names })
  // =============================================================================
  function createGame(opts) {
    const N = opts.players;
    const fixes = Object.assign({ pharTie: true, sunTie: true, unrest: true }, opts.fixes || {});
    const rng = makeRng(opts.seed >>> 0);                   // tile draws, seats, Pharaoh sets
    const aiRng = makeRng((opts.seed ^ 0x2545F491) >>> 0);   // Easy-mode noise (kept separate so the deal replays)
    const human = !!opts.human;                              // seat 1 is the human
    let easy = !!opts.easy;
    const names = (opts.names || ['Doris', 'Anna', 'Bob', 'Cathy', 'Don']).slice(0, 5);
    if (human && !opts.variants) opts = Object.assign({}, opts, { variants: new Array(N).fill('v1.2.0') });
    const nets = loadNets(N);
    const neuralnet = nets.neuralnet, SunIsWorthNet = nets.sunNet;

    // ---- per-seat version settings ----
    const V = [null], TestPhar = [null], pharSet = [null];
    {
      const sets = Object.keys(PHAR_SETS[N]).map(Number);
      // Distinct evolved sets where possible (VB gave players 2..N distinct sets 2..N).
      let pool = [];
      for (let p = 1; p <= N; p++) {
        const v = getVariant(opts.variants[p - 1]);
        V.push(v);
        if (human && p === 1 && !(v.P && v.P.phar)) { TestPhar.push([0, ...SET1].map(f32)); pharSet.push(1); continue; }
        if (v.phar) { TestPhar.push([0, ...v.phar()]); pharSet.push(0); continue; }
        let s = opts.pharSets && opts.pharSets[p - 1];
        if (!s) {
          if (!pool.length) pool = sets.slice();
          s = pool.splice(Math.floor(rng() * pool.length), 1)[0];
        }
        TestPhar.push([0, ...PHAR_SETS[N][s]].map(f32));
        pharSet.push(s);
      }
    }

    // ---- VB module-level state ----
    const neurons = new Float32Array(TN + 1);
    const SunIsWorthNeurons = new Float32Array(ST + 1);
    const BlockIsWorth = new Float32Array(6);
    const SunOnBlockIsWorth = new Float32Array(6);
    const SunsNextRoundAll = new Float32Array(17);
    const AllSunsAreWorth = new Float32Array(17);
    const Bids = [0, 0, 0, 0, 0, 0];
    const TilesInHand = []; for (let i = 0; i <= 5; i++) TilesInHand.push(new Array(19).fill(0));
    const Suns = []; for (let i = 0; i <= 5; i++) Suns.push([0, 0, 0, 0, 0]);
    const Scores = [0, 0, 0, 0, 0, 0];
    let TilesInBag = BAG, AuctionBlock = '', Turn = 0, Epoch = 1, SunOnBlock = 1, RaTrack = 0, Force = false;
    const MaxRa = N === 3 ? 8 : N === 4 ? 9 : 10;
    let over = false;

    // ---- analysis log ----
    const log = { auctions: [], gods: [], epochs: [], calls: {}, pharLots: [], turns: 0 };
    const analyze = opts.analyze !== false;
    function bump(p, k) { const v = V[p].name; if (!log.calls[v]) log.calls[v] = {}; log.calls[v][k] = (log.calls[v][k] || 0) + 1; }

    // =============================================================================
    // Setup (Start3P/4P/5PGame + startnewgame)
    // =============================================================================
    const SUN_GROUPS = {
      3: [[2, 5, 8, 13], [3, 6, 9, 12], [4, 7, 10, 11]],
      4: [[0, 2, 6, 13], [0, 3, 7, 12], [0, 4, 8, 11], [0, 5, 9, 10]],
      5: [[0, 2, 7, 16], [0, 3, 8, 15], [0, 4, 9, 14], [0, 5, 10, 13], [0, 6, 11, 12]],
    };
    {
      const who = [];                      // WhoIsWho: random permutation of seats
      const seats = []; for (let p = 1; p <= N; p++) seats.push(p);
      while (seats.length) who.push(seats.splice(Math.floor(rng() * seats.length), 1)[0]);
      SUN_GROUPS[N].forEach((g, i) => { for (let k = 0; k < 4; k++) Suns[who[i]][k + 1] = g[k]; });
      Turn = who[0];
      for (let p = 1; p <= N; p++) Scores[p] = 10;
    }

    // =============================================================================
    // Neural nets
    // =============================================================================
    function ActiveFunction(x) { return f32(1 / (1 + Math.pow(2.7183, -x))); }
    function FinActive(x) { let f = f32(1 / (1 + Math.pow(2, -x))); f = f32(f * 40); return f32(f - 17); }
    function SunFinActive(x) { return (1 / (1 + Math.pow(3, -x))) * 16; }

    let lastFin = 0, lastZeroed = false;   // for training-data collection: the net's own output, before VB's add-ons
    function calcneurons(WhichP) {
      const n = neurons, nn = V[WhichP].P.nnet || neuralnet;   // a seat may carry its own (retrained) tile net
      let X, Y;
      for (X = GL + 1; X <= TN; X++) n[X] = 0;
      for (X = 1; X <= SL - 1; X++) {
        for (Y = 1; Y <= GL; Y++) n[X + GL] = n[X + GL] + f32(nn[GL * (X - 1) + Y] * n[Y]);
        n[X + GL] = ActiveFunction(n[X + GL]);
      }
      n[GL + SL] = -1;
      for (X = 1; X <= SL; X++) n[TN] = n[TN] + f32(nn[GL * (SL - 1) + X] * n[GL + X]);
      n[TN] = FinActive(n[TN]);
      lastFin = n[TN]; lastZeroed = false;
      if (n[16] === 0 && n[17] === 0 && n[19] === 0 && n[20] === 0 && n[22] === 0 && n[23] === 0 && n[26] === 0 && n[27] === 0 && n[29] === 0 &&
          n[35] === 0 && n[36] === 0 && n[37] === 0 && n[38] === 0 && n[41] === 0 && n[42] === 0 && n[44] === 0 && n[45] === 0) { n[TN] = 0; lastZeroed = true; }

      for (const c of AuctionBlock) if (c === 'K') n[TN] = n[TN] + 3;

      if (n[12] === -1) {
        const CulOnBlock = [0, 0, 0, 0, 0, 0], MonOnBlock = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        let NileOnBlock = 0, DCul = 0, Floods = 0, DMon = 0;
        for (const c of AuctionBlock) {
          switch (c) {
            case 'C': if (Epoch === 3) NileOnBlock++; break;
            case 'D': Floods++; break;
            case 'E': n[TN] = n[TN] + 2; break;
            case 'U': Floods -= 2; break;
            case 'V': DCul += 2; break;
            case 'W': DMon += 2; break;
            default:
              if ('FGHIJ'.includes(c)) CulOnBlock[c.charCodeAt(0) - 69]++;
              if (n[40] === 1 && 'LMNOPQRS'.includes(c)) MonOnBlock[c.charCodeAt(0) - 75]++;
          }
        }
        const T = TilesInHand[WhichP];
        if (Floods >= 1) {
          if (T[Flood] === 0) n[TN] = n[TN] + n[4] + n[19] + Floods;
          else n[TN] = n[TN] + Floods;
        }
        if (Floods < 0) {
          if (T[Flood] >= 1 && Floods + T[Flood] <= 0) n[TN] = n[TN] - n[4] - n[5];
        }
        if (Floods + T[Flood] >= 1) n[TN] = n[TN] + NileOnBlock;

        let ScoreBefore = 0, ScoreAfter = 0, NumberOfCultures = 0, NumberOfMonuments = 0;
        for (Y = 1; Y <= 5; Y++) if (T[Cul1 - 1 + Y] >= 1) NumberOfCultures++;
        if (NumberOfCultures === 0) ScoreBefore -= 5;
        NumberOfCultures -= 2;
        if (NumberOfCultures >= 1) ScoreBefore += 5 * NumberOfCultures;
        NumberOfCultures = 0;
        for (Y = 1; Y <= 5; Y++) CulOnBlock[Y] += T[Cul1 - 1 + Y];
        if (DCul >= 1) {
          for (X = 1; X <= 5; X++) if (CulOnBlock[X] > 1) { DCul -= (CulOnBlock[X] - 1); CulOnBlock[X] = 1; }
        }
        for (Y = 1; Y <= 5; Y++) if (CulOnBlock[Y] >= 1) NumberOfCultures++;
        if (DCul > 0) NumberOfCultures -= DCul;
        if (NumberOfCultures <= 0) ScoreAfter -= 5;
        NumberOfCultures -= 2;
        if (NumberOfCultures >= 1) ScoreAfter += 5 * NumberOfCultures;
        n[TN] = n[TN] + (ScoreAfter - ScoreBefore);

        if (n[40] === 1) {
          ScoreAfter = 0; ScoreBefore = 0;
          for (Y = 1; Y <= 8; Y++) {
            MonOnBlock[Y] += T[Mon1 - 1 + Y];
            if (T[Mon1 - 1 + Y] >= 1) NumberOfMonuments++;
            if (T[Mon1 - 1 + Y] >= 3) ScoreBefore += 5 * (T[Mon1 - 1 + Y] - 2);
          }
          if (NumberOfMonuments === 7) NumberOfMonuments = 10;
          if (NumberOfMonuments === 8) NumberOfMonuments = 15;
          ScoreBefore += NumberOfMonuments;
          NumberOfMonuments = 0;
          for (X = 1; X <= DMon; X++) {
            let done = false;
            for (const from of [2, 1, 3, 4, 5]) {
              for (Y = 1; Y <= 8; Y++) if (MonOnBlock[Y] === from) { MonOnBlock[Y] = from - 1; done = true; break; }
              if (done) break;
            }
          }
          for (Y = 1; Y <= 8; Y++) {
            if (MonOnBlock[Y] >= 1) NumberOfMonuments++;
            if (MonOnBlock[Y] >= 3) ScoreAfter += 5 * (MonOnBlock[Y] - 2);
          }
          if (NumberOfMonuments === 7) NumberOfMonuments = 10;
          if (NumberOfMonuments === 8) NumberOfMonuments = 15;
          ScoreAfter += NumberOfMonuments;
          n[TN] = n[TN] + (ScoreAfter - ScoreBefore);
        }
      }
      if (easyFor(WhichP)) {
        const E = EasyScrewUp(WhichP);
        n[TN] = E * n[TN] + (2 * (1 - E)) * n[TN] * aiRng();
      }
    }

    function CalcSunIsWorthNeurons(WhichEpoch, WhichPlayer) {
      const PV = V[WhichPlayer] && V[WhichPlayer].P;
      const s = SunIsWorthNeurons, net = (PV && PV.sunNets && PV.sunNets[WhichEpoch]) || SunIsWorthNet[WhichEpoch];
      let X, Y;
      for (X = SG + 1; X <= ST; X++) s[X] = 0;
      for (X = 1; X <= SS - 1; X++) {
        for (Y = 1; Y <= SG; Y++) s[X + SG] = s[X + SG] + f32(net[SG * (X - 1) + Y] * s[Y]);
        s[X + SG] = ActiveFunction(s[X + SG]);
      }
      s[SG + SS] = -1;
      for (X = 1; X <= SS; X++) s[ST] = s[ST] + f32(net[SG * (SS - 1) + X] * s[SG + X]);
      s[ST] = SunFinActive(s[ST]);
      if (s[ST] < 1) s[ST] = 1;
      if (WhichEpoch === Epoch && easyFor(WhichPlayer)) {
        const E = EasyScrewUp(WhichPlayer);
        s[ST] = E * s[ST] + 2 * (1 - E) * s[ST] * aiRng();
      }
    }
    // v1.2.0: EasyScrewUp = 0.55 in Easy mode, else 1.  v1.1.1: Const EasyScrewUp = 0.55 always.
    function EasyScrewUp(p) { return V[p].base === 'v1.1.1' ? 0.55 : easyFor(p) ? 0.55 : 1; }
    // Easy mode applies to the AI seats; the human's seat (hints) plays at full strength. A variant's params.easy overrides (simulations).
    function easyFor(p) { const e = V[p] && V[p].P.easy; return e != null ? !!e : easy && !(human && p === 1); }

    // =============================================================================
    // Net inputs
    // =============================================================================
    function CalcGround(player) {
      const n = neurons, T = TilesInHand[player], S = Suns;
      let X, Y, z, MonumentsOnBlock = 0;
      for (X = 2; X <= GL; X++) n[X] = 0;
      n[1] = -1;

      // pharaohs in hand: insertion ranking (ties go to the later player)
      const PL = [0, 1, 0, 0, 0, 0];
      const ph = p => TilesInHand[p][Pharaoh];
      for (X = 2; X <= N; X++) {
        if (ph(X) >= ph(PL[1])) { PL[5] = PL[4]; PL[4] = PL[3]; PL[3] = PL[2]; PL[2] = PL[1]; PL[1] = X; continue; }
        if (ph(X) >= ph(PL[2])) { PL[5] = PL[4]; PL[4] = PL[3]; PL[3] = PL[2]; PL[2] = X; continue; }
        if (ph(X) >= ph(PL[3])) { PL[5] = PL[4]; PL[4] = PL[3]; PL[3] = X; continue; }
        if (ph(X) >= ph(PL[4])) { PL[5] = PL[4]; PL[4] = X; continue; }
        PL[5] = X;
      }
      for (X = 1; X <= N; X++) {
        if (PL[X] !== player) continue;
        if (X === 1) { n[2] = ph(PL[2]) - ph(player); n[3] = ph(player) - ph(PL[N]); }
        else if (X === N) { n[2] = ph(PL[1]) - ph(player); n[3] = ph(player) - ph(PL[N - 1]); }
        else { n[2] = ph(PL[1]) - ph(player); n[3] = ph(player) - ph(PL[N]); }
      }

      n[4] = T[Nile]; n[5] = T[Flood];
      for (X = 0; X <= 7; X++) {
        if (T[Mon1 + X] >= 1) n[7] = n[7] + 1;
        if (T[Mon1 + X] === 2) n[8] = n[8] + 1;
        if (T[Mon1 + X] === 3 || T[Mon1 + X] === 4) n[9] = n[9] + 1;
      }
      n[14] = T[God];

      // suns
      for (X = 1; X <= 4; X++) {
        if (S[player][X] <= 0) n[9 + X] = -1;
        else {
          n[9 + X] = 5;
          for (Y = 1; Y <= N; Y++) for (z = 1; z <= 4; z++) {
            if (S[player][X] < S[Y][z]) n[9 + X] = n[9 + X] - 0.3333;
            if (N !== 3 && S[Y][z] > 0) n[33] = n[33] + 1;      // VB quirk: counted once per own usable sun (4-5p)
          }
        }
      }
      if (N === 3) for (Y = 1; Y <= N; Y++) for (z = 1; z <= 4; z++) if (S[Y][z] > 0) n[33] = n[33] + 1;
      n[33] = n[33] > MaxRa - RaTrack ? 1 : -1;

      for (X = 0; X <= 4; X++) if (T[Cul1 + X] >= 2) n[6] = n[6] + T[Cul1 + X] - 1;

      const MonOnBlock = [0, 0, 0, 0, 0, 0, 0, 0, 0], CulOnBlock = [0, 0, 0, 0, 0, 0];
      let DFlood = 0, DCul = 0, diff = 0;
      const s3 = S[player][3];
      for (const c of AuctionBlock) {
        switch (c) {
          case 'B': n[17] = n[17] + 1; break;
          case 'C': if (Epoch !== 3 || s3 > 0) n[19] = n[19] + 1; break;
          case 'D': if (s3 >= 1) n[20] = n[20] + 1; break;
          case 'E': if (s3 >= 1) n[16] = n[16] + 1; break;
          case 'K': break;
          case 'T': n[17] = n[17] - 2; break;
          case 'U': DFlood++; break;
          case 'V': if (s3 >= 1) DCul++; break;
          case 'W': if (s3 > 0 || Epoch < 3) { n[34] = n[34] + 1; } break;
          default:
            if (s3 >= 1 && 'FGHIJ'.includes(c)) CulOnBlock[c.charCodeAt(0) - 69]++;
            if ('LMNOPQRS'.includes(c) && (s3 > 0 || Epoch < 3)) { MonOnBlock[c.charCodeAt(0) - 75]++; MonumentsOnBlock++; }
        }
      }
      // DMon is only counted in VB, never used after its final clamp; omitted.

      // pharaohs (the "potentially changed pharaoh code (1-7-07)", using this seat's Pharaoh set)
      const TP = TestPhar[player];
      if (n[17] < 0) {
        if (n[17] + T[Pharaoh] < 0) n[17] = 0 - T[Pharaoh];
        if (n[17] < n[2]) n[18] = TP[1];
        if (n[17] + n[3] <= 0 && n[3] > 0) n[18] = TP[2];
      }
      if (n[17] > 0) {
        if (n[17] > n[2] && n[2] > 0) n[18] = TP[3];
        if (n[17] === n[2] && n[2] > 0) n[18] = TP[4];
        if (n[3] < 1 && n[17] + n[3] > 0) n[18] = TP[5];
      }

      // flood disasters
      if (s3 >= 1) n[20] = n[20] - (2 * DFlood);
      if (n[20] + T[Flood] < 0) {
        diff = n[20] + T[Flood];
        if (s3 >= 1) n[26] = 0 - T[Flood];                       // VB quirk: writes the monument input
        n[19] = n[19] + diff;
        if (s3 >= 1) {
          if (n[19] + T[Nile] < 0) n[19] = 0 - T[Nile];
          if (n[5] > 0 && n[20] < 0 && n[5] + n[20] <= 0) n[21] = 0 - n[4];
        }
      }

      if (s3 >= 1) {
        if (n[20] >= 1 && n[5] === 0) n[21] = n[4] + n[19];
        let CulMissing = 0, NewCul = 0;
        for (X = 1; X <= 5; X++) {
          if (T[Cul1 - 1 + X] >= 1) { if (CulOnBlock[X] >= 1) n[30] = n[30] + CulOnBlock[X]; }
          else { CulMissing++; if (CulOnBlock[X] >= 1) NewCul++; }
        }
        for (X = 1; X <= 2 * DCul; X++) {
          if (n[30] > 1) { n[30] = n[30] - 1; continue; }
          if (n[6] > 1) { n[6] = n[6] - 1; continue; }
          if (NewCul >= 1) { NewCul--; continue; }
          if (CulMissing <= 4) { NewCul--; continue; }
        }
        while (NewCul >= 1) {
          if (CulMissing <= 3) { n[29] = n[29] + 1; CulMissing--; NewCul--; }
          if (CulMissing === 4) { n[28] = 1; CulMissing--; NewCul--; }
          if (CulMissing === 5) { n[27] = 1; CulMissing--; NewCul--; }
        }
        while (NewCul <= -1) {
          if (n[6] + n[30] >= 1) { n[30] = n[30] - 1; NewCul++; }
          else {
            if (CulMissing === 4) { n[27] = -1; CulMissing++; NewCul++; }
            if (CulMissing === 3) { n[28] = -1; CulMissing++; NewCul++; }
            if (CulMissing <= 2) { n[29] = n[29] - 1; CulMissing++; NewCul++; }
            if (CulMissing === 5) NewCul = 0;
          }
        }
      }

      // monuments
      for (X = 1; X <= 8; X++) {
        if (MonOnBlock[X] < 1) continue;
        const h = T[Mon1 - 1 + X], inBag = TilesInBag.includes(String.fromCharCode(65 + 10 + X));
        if (h === 0) {
          n[22] = n[22] + 1;
          if (MonOnBlock[X] === 2) { if (inBag) n[24] = n[24] + 1; else n[25] = n[25] + 1; }
          if (MonOnBlock[X] >= 3) n[26] = n[26] + MonOnBlock[X] - 2;
        }
        if (h === 1) {
          if (MonOnBlock[X] === 1) { if (inBag) n[24] = n[24] + 1; else n[25] = n[25] + 1; }
          if (MonOnBlock[X] >= 2) n[26] = n[26] + MonOnBlock[X] - 1;
        }
        if (h === 2) n[26] = n[26] + MonOnBlock[X];
        if (h >= 3) n[26] = n[26] + MonOnBlock[X];
      }
      // DMon in VB: +1 per earthquake, +1 more if (s3>0 or Epoch<3)
      let DMon = 0;
      for (const c of AuctionBlock) if (c === 'W') { DMon++; if (s3 > 0 || Epoch < 3) DMon++; }
      n[24] = n[24] - 2 * DMon;
      if (n[24] + n[8] < 0) { n[26] = n[26] + n[24] + n[8]; n[24] = 0 - n[8]; }

      for (X = 1; X <= N; X++) {
        if (X === player) continue;
        for (Y = 1; Y <= 4; Y++) if (S[X][Y] > 0) n[31] = n[31] + 1;
        if (S[X][4] > 0) n[32] = n[32] + 1;
      }

      n[39] = -1; n[40] = -1;
      if (Epoch === 2) {
        n[35] = n[17]; n[37] = n[19]; n[41] = n[22]; n[42] = n[23]; n[43] = n[24];
        n[22] = 0; n[23] = 0; n[24] = 0; n[17] = 0; n[19] = 0; n[39] = 1;
      } else if (Epoch === 3) {
        n[36] = n[17]; n[38] = n[19]; n[44] = n[22]; n[45] = n[23]; n[46] = n[24];
        n[22] = 0; n[23] = 0; n[24] = 0; n[17] = 0; n[19] = 0; n[40] = 1;
      }

      n[15] = -1;
      if (N !== 3) { if (RaTrack >= 5) n[15] = 1; }
      else { if (RaTrack >= 4) n[15] = 1; n[15] = (RaTrack - 4) / 2; }
      n[34] = -1;
      if (RaTrack >= 7) n[34] = 1;
      if (N === 3 && RaTrack >= 6) n[34] = 1;
    }

    function CalcSunOnBlockGround(WhichPlayer, WhichSun) {
      const s = SunIsWorthNeurons;
      let X, Y, MostPhar = 0, AboveMeSuns = 0, DiffMons = 0;
      for (X = 1; X <= SG; X++) s[X] = 0;
      for (X = 1; X <= N; X++) if (TilesInHand[X][Pharaoh] > MostPhar) MostPhar = TilesInHand[X][Pharaoh];
      s[24] = MostPhar - TilesInHand[WhichPlayer][Pharaoh];
      s[1] = -1; s[2] = 0;
      for (X = 1; X <= N; X++) {
        if (X !== WhichPlayer) { if (Suns[X][4] > WhichSun) s[3] = s[3] + 1; }
        else for (Y = 1; Y <= 4; Y++) {
          const a = Math.abs(Suns[X][Y]);
          if (a !== 0) { if (a > WhichSun) s[4] = s[4] + 1; if (a < WhichSun) s[5] = s[5] + 1; }
        }
      }
      s[10] = 12;
      s[6] = -1; s[22] = -1; s[21] = 1; s[29] = -1; s[25] = -1; s[26] = 1;
      s[7] = -1; s[8] = 0;
      s[9] = TilesInHand[WhichPlayer][Nile];
      s[11] = N - 1; s[12] = N - 1; s[13] = N - 1; s[23] = N - 1;
      for (X = 1; X <= N; X++) if (X !== WhichPlayer) for (Y = 1; Y <= 4; Y++) if (Math.abs(Suns[X][Y]) > WhichSun) AboveMeSuns++;
      for (X = 0; X <= 5; X++) { let v = AboveMeSuns - 2 * X; if (v > 2) v = 2; if (v < 0) v = 0; s[14 + X] = v; }
      for (X = 0; X <= 7; X++) {
        const t = TilesInHand[WhichPlayer][Mon1 + X];
        if (t > 0) DiffMons++;
        if (t >= 2 && t <= 4) s[20] = s[20] + 1;
      }
      if (DiffMons === 6) s[28] = 1;
      if (DiffMons === 7) s[28] = 2;
      if (N === 3) s[31] = -1.75;
      if (N === 4) s[31] = -2;
      if (N === 5) s[31] = -2.25;
      s[27] = 0; s[30] = 0; s[32] = N === 3 ? 4 : 3; s[33] = 0;
    }

    function CalcSunIsWorthGround(WhichPlayer, WhichSun) {
      const s = SunIsWorthNeurons;
      let X, Y, NumDiffCultures = 0, AboveMeSuns = 0, DiffMons = 0, MostPhar = 0;
      for (X = 1; X <= SG; X++) s[X] = 0;
      for (X = 1; X <= N; X++) if (TilesInHand[X][Pharaoh] > MostPhar) MostPhar = TilesInHand[X][Pharaoh];
      s[24] = MostPhar - TilesInHand[WhichPlayer][Pharaoh];
      s[1] = -1;
      if (Suns[WhichPlayer][3] > 0 && TilesInHand[WhichPlayer][God] > 0) s[2] = TilesInHand[WhichPlayer][God];
      for (X = 1; X <= N; X++) {
        if (X !== WhichPlayer) {
          if (Suns[X][4] > 0) s[11] = s[11] + 1;
          if (Suns[X][3] > 0) s[23] = s[23] + 1;
          for (Y = 1; Y <= 4; Y++) if (Suns[X][Y] > WhichSun) { s[3] = s[3] + 1; break; }
          for (Y = 1; Y <= 4; Y++) if (Suns[X][Y] > 0) s[10] = s[10] + 1;
        } else for (Y = 1; Y <= 4; Y++) {
          if (Suns[X][Y] > WhichSun) s[4] = s[4] + 1;
          if (Suns[X][Y] > 0 && Suns[X][Y] < WhichSun) s[5] = s[5] + 1;
          if (Suns[X][Y] > 0) s[10] = s[10] + 1;
        }
      }
      if (N !== 3) s[6] = RaTrack <= 4 ? -1 : 1; else s[6] = RaTrack <= 3 ? -1 : 1;
      const lastIdx = { 3: [6, 7], 4: [7, 8], 5: [8, 9] }[N];
      s[29] = RaTrack <= lastIdx[0] ? -1 : 1;
      s[22] = RaTrack === lastIdx[1] ? 1 : -1;
      s[21] = s[10] > (MaxRa - RaTrack) ? 1 : -1;
      s[25] = (Suns[WhichPlayer][3] > 0 && MaxRa - RaTrack === 1) ? 1 : -1;
      s[7] = -1;
      for (X = 0; X <= 4; X++) if (TilesInHand[WhichPlayer][Cul1 + X] > 0) { s[7] = 1; NumDiffCultures++; }
      if (NumDiffCultures > 1 && NumDiffCultures < 4) s[8] = 5 - NumDiffCultures;
      if (TilesInHand[WhichPlayer][Flood] === 0) s[9] = TilesInHand[WhichPlayer][Nile];
      for (X = 1; X <= N; X++) {
        if (X === WhichPlayer || Suns[X][4] <= 0) continue;
        const T = TilesInHand[X];
        if (T[Flood] === 0) s[12] = s[12] + T[Nile];
        if (T[5] === 0 && T[6] === 0 && T[7] === 0 && T[8] === 0 && T[9] === 0) s[13] = s[13] + 1;
      }
      for (X = 1; X <= N; X++) if (X !== WhichPlayer) for (Y = 1; Y <= 4; Y++) if (Suns[X][Y] > 0 && Suns[X][Y] > WhichSun) AboveMeSuns++;
      for (X = 0; X <= 5; X++) { let v = AboveMeSuns - 2 * X; if (v > 2) v = 2; if (v < 0) v = 0; s[14 + X] = v; }
      for (X = 0; X <= 7; X++) {
        const t = TilesInHand[WhichPlayer][Mon1 + X];
        if (t > 0) DiffMons++;
        if (t >= 2 && t <= 4) s[20] = s[20] + 1;
      }
      if (DiffMons === 6) s[28] = 1;
      if (DiffMons === 7) s[28] = 2;
      // LastRa: position of the last "A" in the (sorted) bag
      s[26] = (TilesInBag.lastIndexOf('A') + 1) / TilesInBag.length * 6;
      if (N !== 3) s[27] = Suns[WhichPlayer][2] > 0 ? 1 : Suns[WhichPlayer][3] > 0 ? 0.666 : 0.333;
      else s[27] = Suns[WhichPlayer][1] > 0 ? 1 : Suns[WhichPlayer][2] > 0 ? 0.75 : Suns[WhichPlayer][3] > 0 ? 0.5 : 0.25;
      s[27] = (s[27] / ((MaxRa - RaTrack) / MaxRa)) - 1;
      s[30] = N === 4 ? (s[10] / (MaxRa - RaTrack)) - 1.333 : (s[10] / (MaxRa - RaTrack)) - 1.5;
      if (N === 3) s[31] = (RaTrack - 3.5) / 2;
      if (N === 4) s[31] = (RaTrack - 4) / 2;
      if (N === 5) s[31] = (RaTrack - 4.5) / 2;
      s[32] = s[4] + s[5] + 1;
      s[33] = ((s[4] + s[5] + 1) / (s[10] / N)) - 1;
    }

    // epoch-3 linear sun value, using that player's version constants
    const catchK = X => (V[X].P.catchUp != null ? V[X].P.catchUp : 1);
    const linSun = (p, sun) => { const [a, b] = V[p].div[N]; return (sun - a) / b; };

    // =============================================================================
    // Valuation passes (the blocks repeated throughout ComputerTakeTurn)
    // =============================================================================
    let TempSunTotal = [0, 0, 0, 0, 0, 0], SunMin = 50, SunMid = 49;
    function sunTotals() {
      TempSunTotal = [0, 0, 0, 0, 0, 0]; SunMin = 50; SunMid = 49;
      for (let X = 1; X <= N; X++) {
        for (let Y = 1; Y <= 4; Y++) TempSunTotal[X] += Math.abs(Suns[X][Y]);
        if (TempSunTotal[X] < SunMin) { SunMid = SunMin; SunMin = TempSunTotal[X]; }
        else if (TempSunTotal[X] < SunMid) SunMid = TempSunTotal[X];
      }
    }
    // e3: 'turn' (ComputerTakeTurn start), 'quirk5' (after a Ra draw / Ra call: VB quirk TempSunTotal(5)),
    // 'plain' (Hint: linear value only)
    function sunsPass(monotone, e3) {
      for (let Y = 1; Y <= N; Y++) for (let X = 1; X <= 4; X++) {
        const sun = Suns[Y][X];
        if (sun <= 0) continue;
        CalcSunIsWorthGround(Y, sun);
        CalcSunIsWorthNeurons(Epoch, Y);
        AllSunsAreWorth[sun] = SunIsWorthNeurons[ST];
        if (monotone && Suns[Y][X - 1] > 0 && SunIsWorthNeurons[ST] < AllSunsAreWorth[Suns[Y][X - 1]])
          AllSunsAreWorth[sun] = AllSunsAreWorth[Suns[Y][X - 1]];
        if (Epoch < 3) {
          CalcSunOnBlockGround(Y, sun);
          CalcSunIsWorthNeurons(Epoch + 1, Y);
          SunsNextRoundAll[sun] = SunIsWorthNeurons[ST];
          if (SunsNextRoundAll[sun] < SunOnBlockIsWorth[Y] && sun > SunOnBlock) SunsNextRoundAll[sun] = SunOnBlockIsWorth[Y];
          if (SunsNextRoundAll[sun] > SunOnBlockIsWorth[Y] && sun < SunOnBlock) {
            BlockIsWorth[Y] = BlockIsWorth[Y] - SunOnBlockIsWorth[Y];
            SunOnBlockIsWorth[Y] = SunsNextRoundAll[sun];
            BlockIsWorth[Y] = BlockIsWorth[Y] + SunOnBlockIsWorth[Y];
          }
        } else {
          const tot = e3 === 'quirk5' ? TempSunTotal[5] : TempSunTotal[Y];   // VB quirk: TempSunTotal(5)
          if (e3 !== 'plain' && TempSunTotal[Y] === SunMin && tot - sun + SunOnBlock < SunMid &&
              ((Suns[Y][3] < 0 && N > 3) || (Suns[Y][2] < 0 && N === 3))) SunsNextRoundAll[sun] = SunOnBlockIsWorth[Y];
          else SunsNextRoundAll[sun] = linSun(Y, sun);
        }
      }
    }
    function blockPassTurnStart() {
      for (let X = 1; X <= N; X++) {
        if (Suns[X][4] <= 0) continue;
        BlockIsWorth[X] = tileNet(X);
        if (AuctionBlock === '') BlockIsWorth[X] = 0;
        if (Epoch < 3) { CalcSunOnBlockGround(X, SunOnBlock); CalcSunIsWorthNeurons(Epoch + 1, X); SunOnBlockIsWorth[X] = SunIsWorthNeurons[ST]; }
        else SunOnBlockIsWorth[X] = linSun(X, SunOnBlock);
        BlockIsWorth[X] = BlockIsWorth[X] + SunOnBlockIsWorth[X];
      }
    }
    function blockPassRaDrawn() {
      for (let X = 1; X <= N; X++) {
        if (Suns[X][4] > 0) {
          BlockIsWorth[X] = tileNet(X);
          if (AuctionBlock === '') BlockIsWorth[X] = 0;
        }
        BlockIsWorth[X] = BlockIsWorth[X] + SunOnBlockIsWorth[X];   // VB quirk: also for seats out of suns (stale, accumulates)
      }
    }

    // =============================================================================
    // ComputerTakeTurn
    // =============================================================================
    // Tile-net value of the current AuctionBlock for player p (CalcGround + calcneurons), with the
    // experimental Pharaoh-appetite multiplier applied to the Pharaoh/Funeral part of the lot.
    // Stand-in knobs (all neutral by default): per-category multipliers on the part of a lot's value
    // that comes from those tiles (pharMult, monMult, civMult, nileMult, godMult, goldMult).
    const CATS = [['pharMult', /[BT]/g], ['monMult', /[L-SW]/g], ['civMult', /[F-JV]/g], ['nileMult', /[CDU]/g], ['godMult', /E/g], ['goldMult', /K/g]];
    function tileNet(p) {
      CalcGround(p); calcneurons(p);
      const v = neurons[TN], P = V[p].P;
      let out = v;
      for (const [key, re] of CATS) {
        const k = key === 'pharMult' ? V[p].pharMult : (P[key] != null ? P[key] : 1);
        if (k === 1) continue;
        re.lastIndex = 0;
        if (!re.test(AuctionBlock)) continue;
        const saved = AuctionBlock;
        AuctionBlock = saved.replace(re, '');
        let w = 0;
        if (AuctionBlock !== '') { CalcGround(p); calcneurons(p); w = neurons[TN]; }
        AuctionBlock = saved;
        out += (k - 1) * (v - w);
      }
      // cheap additive per-tile adjustments (tuning knob): tb = { phar, mon, civ, nile, god, gold } points per tile
      if (P.tb) for (const c of AuctionBlock) {
        if (c === 'B') out += P.tb.phar || 0; else if (c >= 'L' && c <= 'S') out += P.tb.mon || 0;
        else if (c >= 'F' && c <= 'J') out += P.tb.civ || 0; else if (c === 'C' || c === 'D') out += P.tb.nile || 0;
        else if (c === 'E') out += P.tb.god || 0; else if (c === 'K') out += P.tb.gold || 0;
      }
      return out;
    }

    const bidMarginOf = p => V[p].P.bidMargin || 0;
    function randomBid(p) {
      const mine = Suns[p].slice(1).filter(x => x > 0);
      return mine.length && aiRng() < 0.5 ? mine[Math.floor(aiRng() * mine.length)] : 0;
    }
    function sunVal(p, sun) { return AllSunsAreWorth[sun] + SunsNextRoundAll[sun]; }   // + RaAdd() = 0

    let lastGod = 0, lastGodVal = 0, lastSkip = false;
    function tryGod(floodOnly) {
      if (AuctionBlock.length === 0 || Force || TilesInHand[Turn][God] < 1) return false;
      const TempBlock = AuctionBlock, TilesToGod = new Float32Array(9);
      TilesToGod[0] = 0;
      for (let X = 1; X <= TempBlock.length; X++) {
        AuctionBlock = TempBlock[X - 1];
        const ok = floodOnly ? AuctionBlock === 'D'
          : (AuctionBlock !== 'E' && AuctionBlock !== 'C' && AuctionBlock !== 'K' && AuctionBlock < 'T');
        if (ok) {
          TilesToGod[X] = tileNet(Turn);
          if (TilesToGod[X] > TilesToGod[TilesToGod[0]]) TilesToGod[0] = X;
        } else TilesToGod[X] = 0;
      }
      const best = TilesToGod[0];
      // general check in VB: "> 4 Or (EasyMode.Checked = True And x) > 3.5". VB quirk: precedence makes the second
      // term (True And CLng(x)) > 3.5, i.e. CLng(x) >= 4 in Easy mode and False otherwise.
      if (TilesToGod[best] > (floodOnly ? 6 : (V[Turn].P.god != null ? V[Turn].P.god : 4)) || (!floodOnly && easyFor(Turn) && cint(TilesToGod[best]) > 3.5)) {
        AuctionBlock = TempBlock[best - 1];
        let High = 0;
        for (let X = 1; X <= N; X++) if (Suns[X][4] > 0 && BlockIsWorth[X] > BlockIsWorth[High]) High = X;
        if (BlockIsWorth[Turn] < BlockIsWorth[High] - 1 || BlockIsWorth[Turn] - TilesToGod[best] < 1 || Suns[Turn][3] < 0) {
          const t = AuctionBlock.charCodeAt(0) - 65;
          const before = TilesInHand[Turn][Pharaoh];
          TilesInHand[Turn][God]--;
          TilesInHand[Turn][t]++;
          AuctionBlock = TempBlock.slice(0, best - 1) + TempBlock.slice(best);
          Force = false;
          lastGod = t; lastGodVal = TilesToGod[best];
          if (analyze) {
            log.gods.push({ epoch: Epoch, player: Turn, tile: t, floodOnly });
            if (t === Pharaoh) addPharLot(Turn, TilesInHand[Turn][Pharaoh] - before, 'god', null);
          }
          bump(Turn, floodOnly ? 'godFlood' : 'god');
          return true;
        }
      }
      AuctionBlock = TempBlock;
      return false;
    }

    function ComputerTakeTurn() {
      const v = V[Turn];
      if (collectSun && (turnCount++ % sunEvery) === 0) recordSunSamples();
      Force = false;
      let callra = false, why = '';
      for (let X = 1; X <= N; X++) BlockIsWorth[X] = 0;
      sunTotals();
      blockPassTurnStart();
      for (let X = 1; X <= 16; X++) AllSunsAreWorth[X] = 0;
      sunsPass(false, 'turn');

      let HighestSun = 0;
      for (let X = 1; X <= N; X++) if (Suns[X][4] > HighestSun) HighestSun = Suns[X][4];
      let UsedGod = false;
      // "I hold the highest sun: keep drawing" rule. Knobs: skip (value margin), skipRa (Ra tiles that must remain, VB: more than 1)
      const skip = lastSkip = Suns[Turn][4] === HighestSun && (MaxRa - RaTrack) > (v.P.skipRa != null ? Math.round(v.P.skipRa) : 1) &&
        BlockIsWorth[Turn] > sunVal(0, HighestSun) + (v.P.skip || 0);

      const bargain = () => {
        let willUse = 0, has = 0;
        for (let X = 1; X <= N; X++) {
          if (X === Turn) continue;
          for (let Y = 1; Y <= 4; Y++) {
            if (Suns[X][Y] > willUse && sunVal(X, Suns[X][Y]) < BlockIsWorth[X]) willUse = Suns[X][Y];
            if (Suns[X][Y] > has) has = Suns[X][Y];
          }
        }
        for (let X = 1; X <= 4; X++) {
          const s = Suns[Turn][X];
          if (s > 0 && s > willUse && s < has && sunVal(Turn, s) < BlockIsWorth[Turn] + (v.P.bargain != null ? v.P.bargain : 2 - (2 * EasyScrewUp(Turn)))) {
            callra = true; Force = true; why = 'bargain'; break;
          }
        }
        if (easyFor(Turn) && callra && aiRng() > EasyScrewUp(Turn)) { callra = false; Force = false; why = ''; }
      };

      if (!skip) {
        if (v.bargainFirst) {
          bargain();
          UsedGod = tryGod(true);
        } else {
          UsedGod = tryGod(true);
          if (!UsedGod) bargain();
        }
        if (!UsedGod) {
          const myTop = Suns[Turn][4];
          // (1) FORCE
          if (!callra && BlockIsWorth[Turn] > sunVal(Turn, myTop) + (v.P.force || 0)) {
            outer: for (let X = 1; X <= N; X++) {
              if (X === Turn) continue;
              for (let Y = 1; Y <= 4; Y++)
                if (Suns[X][Y] > myTop && BlockIsWorth[X] > sunVal(X, Suns[X][Y])) { callra = true; Force = true; why = 'force'; break outer; }
            }
          }
          // (2) AUTO
          if ((!easyFor(Turn) || MaxRa - RaTrack === 1) && !callra && BlockIsWorth[Turn] > AllSunsAreWorth[myTop] + (v.P.auto != null ? v.P.auto : 0.4) + SunsNextRoundAll[myTop]) {
            if (MaxRa - RaTrack === 1) { callra = true; Force = true; why = 'auto'; }
            else for (let X = 1; X <= N; X++) {
              if (X !== Turn && Suns[X][4] > myTop && BlockIsWorth[X] > sunVal(X, Suns[X][4]) + (v.P.autoOther != null ? v.P.autoOther : -2)) { callra = true; Force = true; why = 'auto'; break; }
            }
          }
          // (3) DEFENSE
          if (!callra) {
            let G = 0;
            for (let Y = 4; Y >= 1; Y--) if (Suns[Turn][Y] > 0 && sunVal(Turn, Suns[Turn][Y]) < BlockIsWorth[Turn]) { G = Y; break; }
            if (Suns[Turn][G] !== 0) {
              for (let X = 1; X <= N; X++) {
                if (X === Turn || callra) continue;
                if (!(BlockIsWorth[X] > BlockIsWorth[Turn] + (v.P.defGap != null ? v.P.defGap : 1) || Suns[X][4] > Suns[Turn][4])) continue;
                for (let Y = 1; Y <= 4; Y++) {
                  if (Suns[X][Y] > Suns[Turn][G] && sunVal(X, Suns[X][Y]) < BlockIsWorth[X]) {
                    if (G < 4 && AllSunsAreWorth[Suns[Turn][G + 1]] + SunsNextRoundAll[Suns[Turn][G]] - 0.5 < BlockIsWorth[Turn] &&
                        Suns[Turn][G + 1] > Suns[X][Y]) break;
                    callra = true; Force = true; why = 'defense'; break;
                  }
                }
              }
            }
          }
          UsedGod = tryGod(false);
        }
      }

      // DoNotCallRa:
      if (UsedGod) return { type: 'god', tile: lastGod };
      { const P = v.P;
        if (P.random) { callra = AuctionBlock.length > 0 && aiRng() < 0.3; Force = callra; why = 'random'; }
        if (P.noCall) { callra = false; Force = false; }
        if (P.callAtLen && !callra && AuctionBlock.length >= P.callAtLen) { callra = true; Force = true; why = 'eager'; } }
      if (AuctionBlock.length === 8) { callra = true; Force = false; why = 'full'; }

      if (!callra) {
        const BagLoc = Math.floor(TilesInBag.length * rng());
        const NewTile = TilesInBag[BagLoc];
        TilesInBag = TilesInBag.slice(0, BagLoc) + TilesInBag.slice(BagLoc + 1);
        if (NewTile !== 'A') { AuctionBlock += NewTile; bump(Turn, 'draw'); return { type: 'draw', tile: NewTile.charCodeAt(0) - 65 }; }
        RaTrack++;
        bump(Turn, 'drawRa');
        if (RaTrack === MaxRa) return { type: 'epochEnd', raDrawn: true };
        blockPassRaDrawn();
        sunsPass(true, 'quirk5');
        return { type: 'auction', cause: 'ra' };
      }
      bump(Turn, 'call_' + why);
      return { type: 'auction', cause: why, force: Force };
    }

    // =============================================================================
    // Auction (StartAuctionBefore + EndAuction, with every seat played by the AI)
    // Seats after the caller and before seat 1 follow StartAuctionBefore; seats 1..Turn
    // follow EndAuction's "players after the human" rules. A forced caller bids as in VB.
    // =============================================================================
    function runAuction(cause) {
      const rec = analyze ? auctionRecordStart(cause) : null;
      const pre = collect ? collectInputs() : null;
      if (collectSun) {
        auctionCount++;
        const usable = [];
        for (let p = 1; p <= N; p++) usable.push(Suns[p].slice(1).filter(x => x > 0));
        auctionInfo.push({ idx: auctionCount, E: Epoch, bw: Array.from(BlockIsWorth), snra: Array.from(SunsNextRoundAll), usable, winBid: 0, winner: 0 });
      }
      // catch-up adjustment (normal mode)
      let SumScore = 0, mbw = 0;
      for (let X = 1; X <= N; X++) {
        SumScore += Scores[X];
        if (BlockIsWorth[X] > mbw) mbw = X;                 // VB quirk: compares a value with a seat index
      }
      if (Scores[mbw] > SumScore / N) {
        for (let X = 1; X <= N; X++) if (!easyFor(X)) BlockIsWorth[X] = BlockIsWorth[X] + catchK(X) * ((BlockIsWorth[mbw] - BlockIsWorth[X]) / (N - 1));
      }

      let cur = 0, old = 0;
      for (let p = 1; p <= N; p++) {
        for (let X = 1; X <= 4; X++) {
          const s = Suns[p][X];
          if (s >= 1 && sunVal(p, s) + bidMarginOf(p) < BlockIsWorth[p] && BlockIsWorth[p] !== 0 && !(V[p].P.cheapSun && Bids[p] > 0)) Bids[p] = s;
        }
        if (V[p].P.random) Bids[p] = randomBid(p);
        if (Bids[p] > Bids[cur]) { old = cur; cur = p; } else if (Bids[p] > Bids[old]) old = p;
      }
      if (rec) rec.planned = Bids.slice(0, N + 1);
      if (cur > Turn) for (let X = 3; X >= 1; X--) if (Suns[cur][X] > Bids[old]) Bids[cur] = Suns[cur][X];
      cur = 0;
      for (let p = Turn + 1; p <= N; p++) { if (Bids[cur] < Bids[p]) cur = p; else Bids[p] = 0; }

      cur = 0; old = 0;
      for (let X = Turn + 1; X <= N; X++) { if (Bids[X] > Bids[cur]) { old = cur; cur = X; } else if (Bids[X] > Bids[old]) old = X; }
      const tobid = cur;
      for (let X = 1; X <= Turn; X++) { if (Bids[X] > Bids[cur]) { old = cur; cur = X; } else if (Bids[X] > Bids[old]) old = X; }
      if (cur === 0 && Force) { cur = Turn; Bids[Turn] = Suns[Turn][4]; if (rec) rec.forcedBid = true; }
      if (cur !== tobid) for (let X = 3; X >= 1; X--) if (Suns[cur][X] > Bids[old]) Bids[cur] = Suns[cur][X];
      let w = tobid;
      for (let p = 1; p <= Turn; p++) if (Bids[p] > Bids[w]) w = p;

      if (rec) { rec.winner = w; rec.winBid = w ? Bids[w] : 0; rec.secondBid = old ? Bids[old] : 0; rec.final = Bids.slice(0, N + 1); }
      const before = w ? TilesInHand[w][Pharaoh] : 0;
      const handBefore = w && (pre || collectSun) ? TilesInHand[w].slice() : null;
      const paid = w ? Bids[w] : 0;
      if (collectSun) { const ai = auctionInfo[auctionInfo.length - 1]; ai.winBid = paid; ai.winner = w; }
      AdjustAfterWinning(w);
      if (handBefore) {
        const d = TilesInHand[w].map((c, k) => c - handBefore[k]);
        const train = !!(pre && pre[w]);
        lots.push({ p: w, d, epoch: Epoch, x: train ? pre[w].x : null, extra: train ? pre[w].extra : 0, own: 0, oth: 0, len: pre ? pre.len : 0, train, sun: paid, a: auctionCount });
      }
      if (rec) {
        log.auctions.push(rec);
        if (w && (rec.nPhar || rec.nFuneral)) addPharLot(w, TilesInHand[w][Pharaoh] - before, 'auction', log.auctions.length - 1);
      }
    }

    let humanNeed = { civ: 0, mon: 0 };
    function AdjustAfterWinning(w) {
      humanNeed = { civ: 0, mon: 0 };
      if (w !== 0) {
        for (let X = 1; X <= 4; X++) if (Suns[w][X] === Bids[w]) { Suns[w][X] = 0 - SunOnBlock; break; }
        sortSuns(w);
        SunOnBlock = Bids[w];
        let dPhar = 0, dFlood = 0, dCul = 0, dMon = 0;
        const T = TilesInHand[w];
        for (const c of AuctionBlock) {
          const t = c.charCodeAt(0) - 65;
          if (t < 19) T[t]++;
          else if (c === 'T') dPhar += 2; else if (c === 'U') dFlood += 2; else if (c === 'V') dCul += 2; else if (c === 'W') dMon += 2;
        }
        const nCul = T[5] + T[6] + T[7] + T[8] + T[9];
        let nMon = 0; for (let k = Mon1; k <= Mon8; k++) nMon += T[k];
        if (dCul > nCul) dCul = nCul;
        if (dMon > nMon) dMon = nMon;
        for (let X = 1; X <= dPhar; X++) if (T[Pharaoh] > 0) T[Pharaoh]--;
        for (let X = 1; X <= dFlood; X++) { if (T[Flood] >= 1) T[Flood]--; else if (T[Nile] >= 1) T[Nile]--; }

        if (human && w === 1) { humanNeed = { civ: dCul, mon: dMon }; dCul = 0; dMon = 0; }
        if (dCul > 0) {
          const CulturesInBag = [0, 0, 0, 0, 0, 0], CulturesForOthers = [0, 0, 0, 0, 0, 0], Order = [0, 0, 0, 0, 0, 0];
          for (const c of TilesInBag) if ('FGHIJ'.includes(c)) CulturesInBag[c.charCodeAt(0) - 69]++;
          for (let Y = 2; Y <= N; Y++) for (let z = 1; z <= 5; z++) if (TilesInHand[Y][Cul1 - 1 + z] >= 1) CulturesForOthers[z]++;
          let marker = 1;
          // VB loops X = 5 To 1, so civilizations with none left in the bag are never ordered and the empty
          // slots (0) point at tile 4 = God. fixes.unrest includes X = 0.
          for (let X = 5; X >= (fixes.unrest ? 0 : 1); X--) for (let Y = N - 1; Y >= 0; Y--) for (let z = 1; z <= 5; z++)
            if (CulturesInBag[z] === X && CulturesForOthers[z] === Y) Order[marker++] = z;
          for (let X = 1; X <= dCul; X++) {
            let done = false;
            for (let Y = 1; Y <= 5 && !done; Y++) { const k = Cul1 - 1 + Order[Y]; if (T[k] >= 2) { T[k]--; done = true; } }
            for (let Y = 1; Y <= 5 && !done; Y++) { const k = Cul1 - 1 + Order[Y]; if (T[k] === 1) { T[k] = 0; done = true; } }
            if (done && analyze) log.unrestHits = (log.unrestHits || 0) + 1;
          }
        }
        if (dMon > 0) {
          // VB quirk: MonumentsInBag only scans the first Len(AuctionBlock) bag positions (always Ra tiles),
          // so the order is effectively Obelisk..Statues.
          for (let X = 1; X <= dMon; X++) {
            let done = false;
            for (const from of [2, 1, 3, 4, 5]) {
              for (let Y = 1; Y <= 8; Y++) if (T[Mon1 - 1 + Y] === from) { T[Mon1 - 1 + Y] = from - 1; done = true; break; }
              if (done) break;
            }
          }
        }
      }
      if (w !== 0 || AuctionBlock.length === 8) AuctionBlock = '';
      for (let X = 1; X <= N; X++) Bids[X] = 0;
    }

    function sortSuns(p) {
      const S = Suns[p];
      for (let X = 4; X >= 1; X--) for (let Y = X - 1; Y >= 1; Y--)
        if ((S[X] < S[Y] || S[X] === 0) && S[Y] !== 0) { const h = S[X]; S[X] = S[Y]; S[Y] = h; }
    }

    // =============================================================================
    // Scoring and epochs
    // =============================================================================
    // ---- training-data collection (opts.collect) ----
    const collect = !!opts.collect, lots = [];
    // ---- sun-net training data (opts.collectSun) ----
    const collectSun = !!opts.collectSun, sunEvery = opts.sunEvery || 8, sunSamples = [], auctionInfo = [], heldAtEnd = [];
    let turnCount = 0, auctionCount = 0;
    function recordSunSamples() {
      for (let Y = 1; Y <= N; Y++) for (let X = 1; X <= 4; X++) {
        const sun = Suns[Y][X];
        if (sun <= 0) continue;
        CalcSunIsWorthGround(Y, sun);
        sunSamples.push({ net: Epoch, x: Array.from(SunIsWorthNeurons.slice(1, SG + 1)), p: Y, s: sun, E: Epoch, a: auctionCount, kind: 0 });
        if (Epoch < 3) {
          CalcSunOnBlockGround(Y, sun);
          sunSamples.push({ net: Epoch + 1, x: Array.from(SunIsWorthNeurons.slice(1, SG + 1)), p: Y, s: sun, E: Epoch, a: auctionCount, kind: 1 });
        }
      }
    }
    // Two targets per sample (both +1 and clamped to the net's range, as the VB trainer did):
    //  real: rel value of the lot this sun actually bought (0 if unused)
    //  opp:  best (tile-net value - next-round sun value) among later auctions this sun could have won (VB AdvancedSunTargets)
    function sunTargets() {
      const rel = L => L.own - L.oth / (N - 1);
      const bought = new Map();
      for (const L of lots) bought.set(L.p + ':' + L.sun + ':' + L.epoch, { v: rel(L), a: L.a });
      for (const ai of auctionInfo) if (ai.winner && !bought.has(ai.winner + ':' + ai.winBid + ':' + ai.E)) bought.set(ai.winner + ':' + ai.winBid + ':' + ai.E, { v: 0, a: ai.idx });
      const clamp = t => Math.max(0.1, Math.min(15.5, t + 1));
      const out = [];
      for (const S of sunSamples) {
        let E = S.E, after = S.a;
        if (S.kind === 1) { if (!heldAtEnd[E] || !heldAtEnd[E].has(S.p + ':' + S.s)) continue; E = E + 1; after = 0; }
        const b = bought.get(S.p + ':' + S.s + ':' + E);
        const real = b && b.a > after ? b.v : 0;
        let opp = 0;
        for (const ai of auctionInfo) {
          if (ai.E !== E || ai.idx <= after || !ai.usable[S.p - 1].includes(S.s)) continue;
          if (ai.winBid > S.s || (ai.winBid === S.s && ai.winner !== S.p)) continue;
          opp = Math.max(opp, ai.bw[S.p] - ai.snra[S.s]);
        }
        out.push({ net: S.net, x: S.x, real: clamp(real), opp: clamp(opp), kind: S.kind });
      }
      return out;
    }
    function collectInputs() {
      const out = { len: AuctionBlock.length };
      if (AuctionBlock === '') return out;
      const savedN = Float32Array.from(neurons);
      for (let p = 1; p <= N; p++) {
        if (Suns[p][4] <= 0) continue;
        CalcGround(p); const x = Array.from(neurons.slice(1, GL + 1));
        calcneurons(p);
        if (!lastZeroed) out[p] = { x, extra: neurons[TN] - lastFin };
      }
      neurons.set(savedN);
      return out;
    }
    function playerEpochPoints(T, ph, E) {   // one player's epoch points except Pharaohs and the sun bonus
      let pts = 0;
      if (T[Flood] >= 1) pts += T[Nile] + T[Flood];
      pts += 2 * T[God] + 3 * T[Gold];
      let nc = 0; for (let Y = 1; Y <= 5; Y++) if (T[Cul1 - 1 + Y] >= 1) nc++;
      if (nc === 0) pts -= 5; else if (nc >= 3) pts += 5 * (nc - 2);
      if (E === 3) {
        let nm = 0;
        for (let Y = 1; Y <= 8; Y++) { const t = T[Mon1 - 1 + Y]; if (t >= 1) nm++; if (t >= 3) pts += 5 * (t - 2); }
        pts += nm === 7 ? 10 : nm === 8 ? 15 : nm;
      }
      return pts + ph;
    }
    // At each scoring: the lot winner's points with the lot vs without it (VB evolver's TilesInHandExcept),
    // and the change it caused to the others (Pharaoh standings).
    function settleLots(E, counts) {
      const phA = pharaohPoints(counts);
      for (const L of lots) {
        const T = TilesInHand[L.p], cf = T.map((c, k) => Math.max(0, c - L.d[k]));
        const cnt = counts.slice(); cnt[L.p] = cf[Pharaoh];
        const phC = pharaohPoints(cnt);
        L.own += playerEpochPoints(T, phA[L.p], E) - playerEpochPoints(cf, phC[L.p], E);
        for (let X = 1; X <= N; X++) if (X !== L.p) L.oth += phA[X] - phC[X];
        for (const k of [Flood, God, Gold, 5, 6, 7, 8, 9]) L.d[k] = 0;   // these are discarded after scoring
      }
    }

    function pharaohPoints(counts) {
      let hi = 0, lo = 30;
      for (let X = 1; X <= N; X++) { if (counts[X] > hi) hi = counts[X]; if (counts[X] < lo) lo = counts[X]; }
      const pts = new Array(N + 1).fill(0);
      if (fixes.pharTie && hi === lo) return pts;
      for (let X = 1; X <= N; X++) { if (counts[X] === hi) pts[X] += 5; if (counts[X] === lo) pts[X] -= 2; }
      return pts;
    }

    function CalculateScores(E) {
      const counts = [0]; for (let X = 1; X <= N; X++) counts.push(TilesInHand[X][Pharaoh]);
      const phPts = pharaohPoints(counts);
      if (collect || collectSun) settleLots(E, counts);
      if (collectSun) { const held = new Set(); for (let p = 1; p <= N; p++) for (let X = 1; X <= 4; X++) if (Suns[p][X] > 0) held.add(p + ':' + Suns[p][X]); heldAtEnd[E] = held; }
      const sunSum = [0];
      let HighSun = 0, LowSun = 50;
      if (E === 3) for (let X = 1; X <= N; X++) {
        let s = 0; for (let Y = N === 3 ? 1 : 2; Y <= 4; Y++) s += Math.abs(Suns[X][Y]);
        sunSum.push(s); if (s > HighSun) HighSun = s; if (s < LowSun) LowSun = s;
      }
      const parts = [null];
      for (let X = 2; X <= N; X++) ScoreAdded[X] = Scores[X];
      history += 'Epoch ' + E + '\n\n';
      for (let X = 1; X <= N; X++) {
        const T = TilesInHand[X]; const part = { phar: phPts[X], nile: 0, god: 2 * T[God], civ: 0, gold: 3 * T[Gold], mon: 0, sun: 0 };
        if (T[Flood] >= 1) part.nile = T[Nile] + T[Flood];
        let nc = 0; for (let Y = 1; Y <= 5; Y++) if (T[Cul1 - 1 + Y] >= 1) nc++;
        if (nc === 0) part.civ = -5; else if (nc >= 3) part.civ = 5 * (nc - 2);
        if (E === 3) {
          let nm = 0, ms = 0;
          for (let Y = 1; Y <= 8; Y++) { const t = T[Mon1 - 1 + Y]; if (t >= 1) nm++; if (t >= 3) ms += 5 * (t - 2); }
          if (nm === 7) nm = 10; if (nm === 8) nm = 15;
          part.mon = ms + nm;
          if (!(fixes.sunTie && HighSun === LowSun)) {
            if (sunSum[X] === HighSun) part.sun += 5;
            if (sunSum[X] === LowSun) part.sun -= 5;
          }
        }
        Scores[X] += part.phar + part.nile + part.god + part.civ + part.gold + part.mon + part.sun;
        if (Scores[X] < 0) Scores[X] = 0;
        parts.push(part);
        history += historyLines(X, E, counts, phPts[X], sunSum[X], part) + '\n' + (E < 3 ? 'Total Score: ' : 'Final Score: ') + Scores[X] + '\n\n';
        if (X > 1) ScoreAdded[X] = Scores[X] - ScoreAdded[X];
      }
      if (E !== 3) history += '--------------------\n';
      else { winner = findWinner(); history += names[winner - 1] + ' is the winner!'; }
      lastEpochParts = parts;
      epochHistory.push({ epoch: E, parts: parts.slice(1), scores: Scores.slice(1, N + 1), pharaohs: counts.slice(1), sunSums: E === 3 ? sunSum.slice(1) : null });
      if (analyze) {
        settlePharLots(counts);
        log.epochs.push({ epoch: E, pharCounts: counts.slice(), parts, scores: Scores.slice(0, N + 1), sunSum: E === 3 ? sunSum : null });
      }
    }

    const MONUMENT_NAMES = [null, 'Obelisks', 'Palaces', 'Sphinxes', 'Pyramids', 'Fortresses', 'Step Pyramids', 'Temples', 'Statues'];
    let history = '', winner = 0, lastEpochParts = null;
    const epochHistory = [];   // per scored epoch: category points, totals after scoring
    const ScoreAdded = [0, 0, 0, 0, 0, 0];
    // FullGameHistory lines for one player, in the original wording
    function historyLines(X, E, counts, ph, sunSumX, part) {
      const T = TilesInHand[X]; let h = names[X - 1] + ':\n';
      if (ph === 5 || ph === 3) h += '5 points for the most Pharaohs (' + counts[X] + ')\n';
      if (ph === -2 || ph === 3) h += '-2 points for the fewest Pharaohs (' + counts[X] + ')\n';
      if (T[Flood] >= 1) {
        if (T[Nile] === 1) h += '1 points for 1 Nile\n'; else if (T[Nile] > 1) h += T[Nile] + ' points for ' + T[Nile] + ' Niles\n';
        if (T[Flood] === 1) h += '1 points for 1 Flood\n'; else if (T[Flood] > 1) h += T[Flood] + ' points for ' + T[Flood] + ' Floods\n';
      }
      if (T[God] === 1) h += '2 points for 1 God\n'; else if (T[God] >= 2) h += 2 * T[God] + ' points for ' + T[God] + ' Gods\n';
      if (part.civ === -5) h += '-5 points for missing a Civilization\n';
      if (part.civ > 0) h += part.civ + ' points for a set of ' + (part.civ / 5 + 2) + ' different Civilizations\n';
      if (T[Gold] === 1) h += '3 points for 1 Gold\n'; else if (T[Gold] >= 2) h += 3 * T[Gold] + ' points for ' + T[Gold] + ' Golds\n';
      if (E === 3) {
        let nm = 0;
        for (let Y = 1; Y <= 8; Y++) { const t = T[Mon1 - 1 + Y]; if (t >= 1) nm++; if (t >= 3) h += 5 * (t - 2) + ' points for a set of ' + t + ' ' + MONUMENT_NAMES[Y] + '\n'; }
        if (nm === 1) h += '1 point for 1 different Monument\n';
        else if (nm > 1 && nm < 7) h += nm + ' points for ' + nm + ' different Monuments\n';
        else if (nm === 7) h += '10 points for 7 different Monuments\n';
        else if (nm === 8) h += '15 points for 8 different Monuments\n';
        if (part.sun === 5) h += '5 points for the highest final Sun total (' + sunSumX + ')\n';
        if (part.sun === -5) h += '-5 points for the lowest final Sun total (' + sunSumX + ')\n';
      }
      return h;
    }
    function findWinner() {
      let hi = -1; for (let X = 1; X <= N; X++) if (Scores[X] > hi) hi = Scores[X];
      let w = 0, hs = 0;
      for (let X = 1; X <= N; X++) if (Scores[X] === hi) for (let Y = 1; Y <= 4; Y++) if (Math.abs(Suns[X][Y]) > hs) { hs = Math.abs(Suns[X][Y]); w = X; }
      return w;
    }

    // EpochIsOver: score, then discard the tiles that don't carry over (state 11 waits before NewEpoch)
    // (the scored tiles stay on screen until NewEpoch, as in VB where the images were hidden there)
    function scoreEpoch() {
      CalculateScores(Epoch);
      if (Epoch === 3) over = true;
    }
    function EpochIsOver() { scoreEpoch(); if (!over) NewEpoch(); }
    function NewEpoch() {
      for (let X = 1; X <= N; X++) for (const k of [Flood, God, Gold, 5, 6, 7, 8, 9]) TilesInHand[X][k] = 0;
      let HighSun = 0;
      for (let X = 1; X <= N; X++) for (let Y = 1; Y <= 4; Y++) { Suns[X][Y] = Math.abs(Suns[X][Y]); if (Suns[X][Y] > HighSun) HighSun = Suns[X][Y]; }
      for (let z = 1; z <= N; z++) sortSuns(z);
      AuctionBlock = '';
      for (let X = 1; X <= N; X++) if (Suns[X][4] === HighSun) Turn = X;
      Epoch++; RaTrack = 0;
    }

    function advance() { do { Turn = Turn + 1; if (Turn === N + 1) Turn = 1; } while (!(Suns[Turn][4] > 0)); }
    function afterAuction() {
      let EpochOver = true;
      for (let X = 1; X <= N; X++) if (Suns[X][4] > 0) { EpochOver = false; break; }
      if (EpochOver) EpochIsOver(); else advance();
    }

    // =============================================================================
    // Analysis helpers (read-only with respect to the game)
    // =============================================================================
    function standing(p) {
      let hi = 0, lo = 99; for (let X = 1; X <= N; X++) { const c = TilesInHand[X][Pharaoh]; if (c > hi) hi = c; if (c < lo) lo = c; }
      const c = TilesInHand[p][Pharaoh];
      if (hi === lo) return 'all-tied';
      if (c === hi) { let k = 0; for (let X = 1; X <= N; X++) if (TilesInHand[X][Pharaoh] === hi) k++; return k > 1 ? 'tied-lead' : 'lead'; }
      if (c === lo) return 'last';
      return 'middle';
    }
    function auctionRecordStart(cause) {
      const rec = { epoch: Epoch, raTrack: RaTrack, turn: Turn, cause, force: Force, block: AuctionBlock, len: AuctionBlock.length,
        nPhar: 0, nFuneral: 0, sunOnBlock: SunOnBlock, bw: Array.from(BlockIsWorth.slice(0, N + 1)), pharVal: null, standing: null, pharCount: null };
      for (const c of AuctionBlock) { if (c === 'B') rec.nPhar++; if (c === 'T') rec.nFuneral++; }
      if (rec.nPhar || rec.nFuneral) {
        // AI's implied value of the Pharaoh/Funeral part of the lot: tile net with vs without those tiles.
        const saved = AuctionBlock, savedN = Float32Array.from(neurons);
        rec.pharVal = [0]; rec.standing = [null]; rec.pharCount = [0];
        const without = AuctionBlock.replace(/[BT]/g, '');
        for (let p = 1; p <= N; p++) {
          rec.standing.push(standing(p)); rec.pharCount.push(TilesInHand[p][Pharaoh]);
          if (Suns[p][4] <= 0) { rec.pharVal.push(null); continue; }
          AuctionBlock = saved; CalcGround(p); calcneurons(p); const a = neurons[TN];
          AuctionBlock = without; CalcGround(p); calcneurons(p); const b = without === '' ? 0 : neurons[TN];
          rec.pharVal.push(a - b);
        }
        AuctionBlock = saved; neurons.set(savedN);
      }
      return rec;
    }
    // A "Pharaoh lot" = the net Pharaoh change one acquisition caused. At each later scoring we
    // re-score Pharaohs as if that change hadn't happened (everything else equal).
    function addPharLot(p, d, how, auctionIdx) {
      if (d === 0) return;
      log.pharLots.push({ player: p, d, how, auctionIdx, epoch: Epoch, standing: null, own: [0, 0, 0, 0], rel: [0, 0, 0, 0] });
    }
    function settlePharLots(counts) {
      const actual = pharaohPoints(counts);
      for (const L of log.pharLots) {
        if (L.settledThrough >= Epoch) continue;
        const cf = counts.slice(); cf[L.player] = Math.max(0, cf[L.player] - L.d);
        const alt = pharaohPoints(cf);
        const own = actual[L.player] - alt[L.player];
        let oth = 0; for (let X = 1; X <= N; X++) if (X !== L.player) oth += actual[X] - alt[X];
        L.own[Epoch] = own; L.rel[Epoch] = own - oth / (N - 1);
        L.settledThrough = Epoch;
      }
    }

    // =============================================================================
    function play() {
      let guard = 0;
      while (!over) {
        if (++guard > 5000) throw new Error('stuck');
        log.turns++;
        const r = ComputerTakeTurn();
        if (r.type === 'draw') advance();
        else if (r.type === 'god') { AdjustAfterWinning(0); afterAuction(); }
        else if (r.type === 'epochEnd') EpochIsOver();
        else { runAuction(r.cause); afterAuction(); }
      }
      const sunData = collectSun ? sunTargets() : null;
      const samples = collect ? lots.filter(L => L.train).map(L => ({ x: L.x, extra: L.extra, own: L.own, rel: L.own - L.oth / (N - 1), epoch: L.epoch, p: L.p, len: L.len })) : null;
      return { players: N, variants: opts.variants.slice(0, N), pharSets: pharSet.slice(1), scores: Scores.slice(1, N + 1), winner, log, samples, sunData };
    }

    // =============================================================================
    // Human seat (seat 1) — the VB game's human paths
    // =============================================================================
    function drawTile() {
      const BagLoc = Math.floor(TilesInBag.length * rng());
      const t = TilesInBag[BagLoc];
      TilesInBag = TilesInBag.slice(0, BagLoc) + TilesInBag.slice(BagLoc + 1);
      return t;
    }
    // ConfirmStateTwo's valuation pass (human drew a Ra tile, or called Ra)
    function humanAuctionPass(raDrawn) {
      Force = false;
      for (let X = 1; X <= N; X++) {
        if (Suns[X][4] > 0) BlockIsWorth[X] = tileNet(X);
        if (raDrawn && AuctionBlock === '') BlockIsWorth[X] = 0;
        if (Epoch < 3) { CalcSunOnBlockGround(X, SunOnBlock); CalcSunIsWorthNeurons(Epoch + 1, X); SunOnBlockIsWorth[X] = SunIsWorthNeurons[ST]; }
        else SunOnBlockIsWorth[X] = linSun(X, SunOnBlock);
        BlockIsWorth[X] = BlockIsWorth[X] + SunOnBlockIsWorth[X];
      }
      sunTotals();
      sunsPass(false, 'quirk5');
      if (!raDrawn && AuctionBlock.length < 8) Force = true;
    }
    function humanDraw() {
      const c = drawTile();
      if (c !== 'A') { AuctionBlock += c; return { type: 'draw', tile: c.charCodeAt(0) - 65 }; }
      RaTrack++;
      if (RaTrack === MaxRa) return { type: 'epochEnd', raDrawn: true };
      humanAuctionPass(true);
      return { type: 'auction', cause: 'ra', force: false };
    }
    function humanCallRa() { humanAuctionPass(false); return { type: 'auction', cause: 'call', force: Force }; }
    // Exchange a God for the tile at block position pos (1-based). Returns the discards still owed.
    function humanGod(pos) {
      const c = AuctionBlock[pos - 1], t = c.charCodeAt(0) - 65, T = TilesInHand[1];
      if (t === God || T[God] < 1) throw new Error('illegal God use');
      T[God]--;
      AuctionBlock = AuctionBlock.slice(0, pos - 1) + AuctionBlock.slice(pos);
      if (t <= 18) T[t]++;
      if (t === 19) for (let X = 1; X <= 2; X++) if (T[Pharaoh] > 0) T[Pharaoh]--;
      if (t === 20) for (let X = 1; X <= 2; X++) { if (T[Flood] >= 1) T[Flood]--; else if (T[Nile] >= 1) T[Nile]--; }
      const nCul = T[5] + T[6] + T[7] + T[8] + T[9];
      let nMon = 0; for (let k = Mon1; k <= Mon8; k++) nMon += T[k];
      return { tile: t, need: { civ: t === 21 ? Math.min(2, nCul) : 0, mon: t === 22 ? Math.min(2, nMon) : 0 } };
    }
    function humanDiscard(tiles) { for (const t of tiles) if (TilesInHand[1][t] > 0) TilesInHand[1][t]--; }

    // StartAuctionBefore with seat 1 human: AIs after the caller bid now; returns what the human sees.
    function auctionStart(cause) {
      if (analyze) pendingRec = auctionRecordStart(cause);
      {   // catch-up adjustment (not for Easy-mode seats)
        let SumScore = 0, mbw = 0;
        for (let X = 1; X <= N; X++) { SumScore += Scores[X]; if (BlockIsWorth[X] > mbw) mbw = X; }   // VB quirk (value vs index)
        if (Scores[mbw] > SumScore / N)
          for (let X = 1; X <= N; X++) if (!easyFor(X)) BlockIsWorth[X] = BlockIsWorth[X] + catchK(X) * ((BlockIsWorth[mbw] - BlockIsWorth[X]) / (N - 1));
      }
      let cur = 0, old = 0;
      for (let p = 1; p <= N; p++) {
        for (let X = 1; X <= 4; X++) {
          const s = Suns[p][X];
          if (s >= 1 && sunVal(p, s) + bidMarginOf(p) < BlockIsWorth[p] && BlockIsWorth[p] !== 0 && !(V[p].P.cheapSun && Bids[p] > 0)) Bids[p] = s;   // Bids(1) = the AI's guess for the human
        }
        if (Bids[p] > Bids[cur]) { old = cur; cur = p; } else if (Bids[p] > Bids[old]) old = p;
      }
      if (cur > Turn) for (let X = 3; X >= 1; X--) if (Suns[cur][X] > Bids[old]) Bids[cur] = Suns[cur][X];
      cur = 0;
      const phaseA = [];
      for (let p = Turn + 1; p <= N; p++) {
        if (Bids[cur] < Bids[p]) cur = p; else Bids[p] = 0;
        if (Suns[p][4] > 0) phaseA.push({ p, bid: Bids[p] });
      }
      let high = 0, highBidder = 0;
      for (let X = Turn + 1; X <= N; X++) if (Bids[X] > Bids[highBidder]) highBidder = X;
      high = Bids[highBidder];
      const canBid = Suns[1][4] > 0;
      return { phaseA, high, highBidder, canBid, mustBid: canBid && Turn === 1 && Force && highBidder === 0, force: Force };
    }
    let pendingRec = null;
    // EndAuction: the human's bid (0 = pass), then the AIs from seat 2 to the caller.
    function auctionFinish(humanBid) {
      if (Suns[1][4] > 0) Bids[1] = humanBid;
      let cur = 0, old = 0;
      for (let X = Turn + 1; X <= N; X++) { if (Bids[X] > Bids[cur]) { old = cur; cur = X; } else if (Bids[X] > Bids[old]) old = X; }
      if (Bids[1] > Bids[cur]) { old = cur; cur = 1; } else if (Bids[1] > Bids[old]) old = 1;
      const tobid = cur;
      const phaseB = [];
      let forcedBid = false;
      if (Turn !== 1) {
        for (let X = 2; X <= Turn; X++) { if (Bids[X] > Bids[cur]) { old = cur; cur = X; } else if (Bids[X] > Bids[old]) old = X; }
        if (cur === 0 && Force) { cur = Turn; Bids[Turn] = Suns[Turn][4]; forcedBid = true; }
        if (cur !== tobid) for (let X = 3; X >= 1; X--) if (Suns[cur][X] > Bids[old]) Bids[cur] = Suns[cur][X];
        cur = tobid;
        for (let p = 2; p <= Turn; p++) {
          const raised = Bids[p] > Bids[cur];
          if (raised) cur = p;
          if (Suns[p][4] > 0) phaseB.push({ p, bid: raised ? Bids[p] : 0 });
        }
      }
      const w = cur;
      // discards the human will owe (EndAuction caps by tiles in hand + on the block)
      let need = { civ: 0, mon: 0 };
      if (w === 1) {
        const T = TilesInHand[1];
        let dc = 0, dm = 0, cb = 0, mb = 0;
        for (const c of AuctionBlock) { if (c === 'V') dc += 2; if (c === 'W') dm += 2; if ('FGHIJ'.includes(c)) cb++; if ('LMNOPQRS'.includes(c)) mb++; }
        let nm = 0; for (let k = Mon1; k <= Mon8; k++) nm += T[k];
        need = { civ: Math.min(dc, T[5] + T[6] + T[7] + T[8] + T[9] + cb), mon: Math.min(dm, nm + mb) };
      }
      return { winner: w, bid: w ? Bids[w] : 0, phaseB, forcedBid, need, bids: Bids.slice(0, N + 1) };
    }
    // AdjustAfterWinning (in VB: after Continue, or at once when the human owes discards)
    function resolveAuction(w) {
      const before = w ? TilesInHand[w][Pharaoh] : 0, block = AuctionBlock, paid = w ? Bids[w] : 0, got = SunOnBlock;
      AdjustAfterWinning(w);
      if (pendingRec) {
        pendingRec.winner = w; pendingRec.winBid = paid; log.auctions.push(pendingRec);
        if (w && (pendingRec.nPhar || pendingRec.nFuneral)) addPharLot(w, TilesInHand[w][Pharaoh] - before, 'auction', log.auctions.length - 1);
        pendingRec = null;
      }
      return { winner: w, block, paid, gotSun: got, need: humanNeed, discarded: w === 0 && block.length === 8 };
    }
    function epochOver() { for (let X = 1; X <= N; X++) if (Suns[X][4] > 0) return false; return true; }

    // =============================================================================
    // Hint (hint_Click), run on a copy of the AI state so it changes nothing
    // =============================================================================
    function snapshotAI() {
      return { bw: BlockIsWorth.slice(), sob: SunOnBlockIsWorth.slice(), snra: SunsNextRoundAll.slice(), asw: AllSunsAreWorth.slice(),
        n: neurons.slice(), sn: SunIsWorthNeurons.slice(), ab: AuctionBlock, r: aiRng.s };
    }
    function restoreAI(z) {
      BlockIsWorth.set(z.bw); SunOnBlockIsWorth.set(z.sob); SunsNextRoundAll.set(z.snra); AllSunsAreWorth.set(z.asw);
      neurons.set(z.n); SunIsWorthNeurons.set(z.sn); AuctionBlock = z.ab; aiRng.s = z.r;
    }
    const TILE_ARTICLE = [null, 'a Pharaoh', 'a Nile', 'a Flood', 'a God', 'an Astronomy', 'an Art', 'an Agriculture', 'a Writing', 'a Religion', 'a Gold',
      'an Obelisk', 'a Palace', 'a Sphinx', 'a Pyramid', 'a Fortress', 'a Step Pyramid', 'a Temple', 'a Statues', 'a Funeral', 'a Drought', 'an Unrest', 'an Earthquake'];
    const tenth = x => vbStr(Math.floor(10 * x) / 10);
    function snapshotAll() {
      return { ai: snapshotAI(), T: TilesInHand.map(r => r.slice()), S: Suns.map(r => r.slice()), Sc: Scores.slice(), B: Bids.slice(),
        bag: TilesInBag, ra: RaTrack, f: Force, turn: Turn, sob: SunOnBlock, r: rng.s, lg: lastGod, lgv: lastGodVal, ls: lastSkip,
        tst: TempSunTotal.slice(), smin: SunMin, smid: SunMid, calls: JSON.stringify(log.calls) };
    }
    function restoreAll(z) {
      restoreAI(z.ai);
      for (let i = 0; i < TilesInHand.length; i++) TilesInHand[i] = z.T[i];
      for (let i = 0; i < Suns.length; i++) Suns[i] = z.S[i];
      for (let i = 0; i < Scores.length; i++) Scores[i] = z.Sc[i];
      for (let i = 0; i < Bids.length; i++) Bids[i] = z.B[i];
      TilesInBag = z.bag; RaTrack = z.ra; Force = z.f; Turn = z.turn; SunOnBlock = z.sob; rng.s = z.r; lastGod = z.lg; lastGodVal = z.lgv; lastSkip = z.ls;
      TempSunTotal = z.tst; SunMin = z.smin; SunMid = z.smid; log.calls = JSON.parse(z.calls);
    }
    // Turn hint when seat 1 is an improved AI: ask that AI what it would do here.
    function hintAdvice() {
      const z = snapshotAll();
      let r, worth;
      try { r = ComputerTakeTurn(); worth = BlockIsWorth[1] - SunOnBlockIsWorth[1]; adviceSkip = lastSkip; adviceGodVal = lastGodVal; } finally { restoreAll(z); }
      const valueLine = AuctionBlock.length ? '\n\nThe tiles on the block are worth about' + tenth(worth) + ' points to you.' : '';
      if (r.type === 'god') return 'You should exchange your God tile for ' + TILE_ARTICLE[r.tile] + ' tile.  It is worth about' + tenth(adviceGodVal) + ' points to you.';
      if (r.type === 'draw' || r.type === 'epochEnd' || (r.type === 'auction' && r.cause === 'ra')) {
        return (adviceSkip ? 'You should draw a tile.  You hold the highest sun, so you can let the slate grow and still win it later.'
          : 'You should draw a tile.  You can lengthen the slate and possibly win it later.') + valueLine;
      }
      return {
        force: 'You should call Ra.  Another player is going to outbid you no matter what.\nDrawing tiles only gives them more points.',
        auto: 'You should call Ra.  Another player will outbid you if you draw more tiles.',
        defense: 'You should call Ra.  The set is more valuable to another player than to you,\nand you can force them to take it now rather than letting it grow.',
        bargain: 'You should call Ra.  The set is a good bargain for you.',
        full: 'You must call Ra because the slate is full.',
      }[r.cause] + (r.cause === 'full' ? '' : valueLine);
    }
    let adviceSkip = false, adviceGodVal = 0;
    function hint(kind, forced) {
      if (kind === 'turn' && V[1].P && V[1].P.nnet) return hintAdvice();
      const z = snapshotAI();
      try { return kind === 'bid' ? hintBid(forced) : hintTurn(); } finally { restoreAI(z); }
    }
    function hintTurn() {
      for (let X = 1; X <= N; X++) BlockIsWorth[X] = 0;
      for (let X = 1; X <= N; X++) {
        if (Suns[X][4] <= 0) continue;
        BlockIsWorth[X] = tileNet(X);
        if (AuctionBlock === '') BlockIsWorth[X] = 0;
        if (Epoch < 3) { CalcSunOnBlockGround(X, SunOnBlock); CalcSunIsWorthNeurons(Epoch + 1, X); SunOnBlockIsWorth[X] = SunIsWorthNeurons[ST]; }
        else SunOnBlockIsWorth[X] = linSun(X, SunOnBlock);
        BlockIsWorth[X] = BlockIsWorth[X] + SunOnBlockIsWorth[X];
      }
      let SumScore = 0, mbw = 0;
      for (let X = 1; X <= N; X++) { SumScore += Scores[X]; if (BlockIsWorth[X] > mbw) mbw = X; }
      if (Scores[mbw] > SumScore / N) for (let X = 1; X <= N; X++) BlockIsWorth[X] = BlockIsWorth[X] + ((BlockIsWorth[mbw] - BlockIsWorth[X]) / (N - 1));
      for (let X = 1; X <= 16; X++) AllSunsAreWorth[X] = 0;
      sunsPass(true, 'plain');
      let HighestSun = 0; for (let X = 1; X <= N; X++) if (Suns[X][4] > HighestSun) HighestSun = Suns[X][4];
      let Why = 0, UsedGod = false, godPos = 0, godVal = 0;
      const T = Turn;
      if (!(Suns[1][4] === HighestSun && MaxRa - RaTrack > 1 && BlockIsWorth[T] > sunVal(0, HighestSun))) {
        // (4) bargain
        let willUse = 0, has = 0;
        for (let X = 1; X <= N; X++) { if (X === T) continue; for (let Y = 1; Y <= 4; Y++) {
          if (Suns[X][Y] > willUse && sunVal(X, Suns[X][Y]) < BlockIsWorth[X]) willUse = Suns[X][Y];
          if (Suns[X][Y] > has) has = Suns[X][Y]; } }
        for (let X = 1; X <= 4; X++) { const sn = Suns[T][X]; if (sn > 0 && sn > willUse && sn < has && sunVal(T, sn) < BlockIsWorth[T]) { Why = 4; break; } }
        // god
        if (AuctionBlock.length > 0 && Why === 0 && TilesInHand[T][God] >= 1) {
          const TempBlock = AuctionBlock, TT = new Float32Array(9);
          for (let X = 1; X <= TempBlock.length; X++) {
            AuctionBlock = TempBlock[X - 1];
            if (AuctionBlock !== 'E' && AuctionBlock !== 'C' && AuctionBlock !== 'K' && AuctionBlock < 'T') {
              TT[X] = tileNet(T); if (TT[X] > TT[TT[0]]) TT[0] = X;
            } else TT[X] = 0;
          }
          if (TT[TT[0]] > 4) {
            let High = 0; for (let X = 1; X <= N; X++) if (Suns[X][4] > 0 && BlockIsWorth[X] > BlockIsWorth[High]) High = X;
            if (BlockIsWorth[T] < BlockIsWorth[High] - 1 || BlockIsWorth[T] - TT[TT[0]] < 1 || Suns[1][3] < 0) { UsedGod = true; godPos = TT[0]; godVal = TT[TT[0]]; }
          }
          AuctionBlock = TempBlock;
        }
        // (1) force
        if (Why === 0 && BlockIsWorth[T] > sunVal(T, Suns[T][4])) {
          outer: for (let X = 1; X <= N; X++) { if (X === T) continue;
            for (let Y = 1; Y <= 4; Y++) if (Suns[X][Y] > Suns[T][4] && BlockIsWorth[X] > sunVal(X, Suns[X][Y])) { Why = 1; break outer; } }
        }
        // (2) auto
        if (Why === 0 && BlockIsWorth[T] > AllSunsAreWorth[Suns[T][4]] + 0.4 + SunsNextRoundAll[Suns[T][4]]) {
          if (MaxRa - RaTrack === 1) Why = 2;
          else for (let X = 1; X <= N; X++) if (X !== T && Suns[X][4] > Suns[T][4]) { Why = 2; break; }
        }
        // (3) defense
        if (Why === 0) {
          let G = 0;
          for (let Y = 4; Y >= 1; Y--) if (Suns[T][Y] > 0 && sunVal(T, Suns[T][Y]) < BlockIsWorth[T]) { G = Suns[T][Y]; break; }
          if (G !== 0) for (let X = 1; X <= N; X++) {
            if (X === T || !(BlockIsWorth[X] > BlockIsWorth[T] + 1 || Suns[X][4] > Suns[T][4])) continue;
            for (let Y = 1; Y <= 4; Y++) if (Suns[X][Y] > G && sunVal(X, Suns[X][Y]) < BlockIsWorth[X]) { Why = 3; break; }
          }
        }
      }
      if (!UsedGod && AuctionBlock.length === 8) Why = 5;
      if (Why === 0) {
        if (UsedGod) return 'You should exchange your God tile for ' + TILE_ARTICLE[AuctionBlock.charCodeAt(godPos - 1) - 65] +
          ' tile.  You can expect the tile to be worth' + tenth(godVal) + ' points to you.';
        return 'You should draw a tile.  You can lengthen the slate and possibly win it later.';
      }
      return {
        1: 'You should call Ra.  Another player is going to outbid you no matter what.\nDrawing tiles only gives them more points.',
        2: 'You should call Ra.  Another player will outbid you if you draw more tiles.',
        3: 'You should call Ra.  The set is more valuable to another player than to you,\nand you can force them to take it now rather than letting it grow.',
        4: 'You should call Ra.  The set is a good bargain for you.',
        5: 'You must call Ra because the slate is full.',
      }[Why];
    }
    function hintBid(forced) {
      const v = BlockIsWorth[1] - SunOnBlockIsWorth[1];
      let t = 'The tiles are expected to be worth' + (v >= 0 ? '' : ' ') + tenth(v) + ' points to you.\n\n';
      if (Bids[1] === 0) {
        for (let X = 1; X <= 4; X++) if (Suns[1][X] > 0) {
          const sn = Suns[1][X];
          t += 'You can expect' + tenth(AllSunsAreWorth[sn] - SunOnBlockIsWorth[1] + SunsNextRoundAll[sn]) + ' points from your' + vbStr(sn) + ' sun.\n\n';
          break;
        }
        t += 'This makes the slate not worth bidding on at this stage in the round.';
        if (forced) t += '\n\nHowever, you must bid because you voluntarily called Ra.';
      } else {
        if (v < 0) t += 'The sun on the block is worth' + tenth(SunOnBlockIsWorth[1] - SunsNextRoundAll[Bids[1]]) + ' more than your' + vbStr(Bids[1]) + '.\n\n';
        const rec = Bids[1], s = biddingSituation();
        if (rec <= s.high) {
          t += 'This makes the slate worth up to your' + vbStr(rec) + ', but that doesn\'t beat the high bid of ' + s.high + ', so you should pass.';
        } else if (s.sure && s.sure < rec) {
          t += 'This makes the slate worth bidding up to your' + vbStr(rec) + '.\n\nYour ' + s.sure + ' is enough to win: ' + s.who + '.';
        } else {
          t += 'This makes the slate worth bidding your' + vbStr(rec) + '.';
          if (s.later.length && s.maxLater > rec) t += '\n\n' + s.threat + ' can still outbid it.';
          else if (s.sure === rec) t += '\n\nIt is enough to win: ' + s.who + '.';
        }
      }
      if (Bids[1] === 0 && forced) {
        const s = biddingSituation(), legal = Suns[1].slice(1).filter(x => x > s.high);
        if (legal.length) t += ' Your ' + Math.min(...legal) + ' is the cheapest bid.';
      }
      return t;
    }
    // Who still bids after the human in this auction, and the cheapest sun that is sure to win.
    // (The VB hint only gave the AI's own valuation, ignoring the bids still to come.)
    function biddingSituation() {
      let high = 0;
      for (let p = Turn + 1; p <= N; p++) if (Bids[p] > high) high = Bids[p];
      const later = [];
      if (Turn !== 1) for (let p = 2; p <= Turn; p++) if (Suns[p][4] > 0) later.push(p);
      const best = p => Math.max(...Suns[p].slice(1));
      const maxLater = Math.max(0, ...later.map(best));
      const mine = Suns[1].slice(1).filter(x => x > high && x > maxLater);
      const sure = mine.length ? Math.min(...mine) : 0;
      const nm = p => names[p - 1];
      const list = ps => ps.length === 1 ? nm(ps[0]) : ps.slice(0, -1).map(nm).join(', ') + ' and ' + nm(ps[ps.length - 1]);
      let who;
      if (!later.length) who = 'no one bids after you';
      else if (later.length === 1) who = nm(later[0]) + ', the only player still to bid, has no sun above ' + maxLater;
      else who = list(later) + ', the players still to bid, have no sun above ' + maxLater;
      const top = later.filter(p => best(p) === maxLater)[0];
      const threat = top ? nm(top) + ' (still to bid) has a ' + maxLater + ' and' : '';
      return { high, later, maxLater, sure, who, threat };
    }

    // =============================================================================
    // Read-only view for the UI
    // =============================================================================
    function view() {
      return {
        N, MaxRa, Turn, Epoch, RaTrack, SunOnBlock, over, Force, easy, names: names.slice(0, N),
        block: AuctionBlock.split('').map(c => c.charCodeAt(0) - 65), bagCount: TilesInBag.length,
        suns: Suns.slice(1, N + 1).map(r => r.slice(1)), tiles: TilesInHand.slice(1, N + 1).map(r => r.slice()),
        scores: Scores.slice(1, N + 1), scoreAdded: ScoreAdded.slice(1, N + 1), history, winner, lastEpochParts,
        epochHistory: epochHistory.map(e => Object.assign({}, e)),
        bagString: TilesInBag,
      };
    }
    if (human) {
      const word = { 3: 'Three', 4: 'Four', 5: 'Five' }[N];
      const now = opts.now || new Date();
      history = word + ' Player Ra Version 2.0\n' + (easy ? 'Easy Mode\n' : '') + 'Game started on ' + now.toLocaleDateString('en-US') +
        ' at ' + now.toLocaleTimeString('en-US') + '\n--------------\n\n';
    }

    return {
      play, view, hint,
      aiTurn: () => ComputerTakeTurn(), humanDraw, humanCallRa, humanGod, humanDiscard,
      auctionStart, auctionFinish, resolveAuction, epochOver, advance, scoreEpoch, newEpoch: NewEpoch,
      setEasy: e => { easy = !!e; }, setName: (i, nm) => { names[i] = nm; },
    };
  }

  const api = { createGame, getVariant, VARIANTS, PHAR_SETS, TILE_NAMES, vbStr };
  if (typeof module !== 'undefined') module.exports = api; else root.RA_ENGINE = api;
})(this);
