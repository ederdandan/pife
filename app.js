/* ===========================================================================
   PIFE DE VARANDA — MOTOR DO JOGO
   Arraste para ordenar/descartar, pilhas de jogos, solver exato de jogos,
   bots, Solo / 2v2 / 3v3, salas online P2P (BroadcastChannel + PeerJS),
   cadastro de perfil com foto (câmera/galeria) ou ícone.
   =========================================================================== */
(() => {
  'use strict';

  /* -------------------------------------------------------------------------
     0. UTILITÁRIOS & SEGURANÇA
     ------------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  // Só aceita fotos como data URL de imagem em base64 (bloqueia injeção via src).
  const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
  const MAX_PHOTO_LEN = 90000;
  function safePhoto(url) {
    return typeof url === 'string' && url.length <= MAX_PHOTO_LEN && PHOTO_RE.test(url) ? url : null;
  }

  function cleanName(name) {
    const s = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 14);
    return s || 'Jogador';
  }

  function randId(len) {
    let out = '';
    while (out.length < len) out += Math.random().toString(36).slice(2);
    return out.slice(0, len);
  }

  const ID_RE = /^u_[a-z0-9]{4,12}$/;

  /* -------------------------------------------------------------------------
     1. PWA: SERVICE WORKER (arquivo real sw.js — exigido pelos navegadores)
     ------------------------------------------------------------------------- */
  if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  /* -------------------------------------------------------------------------
     2. SINTETIZADOR DE ÁUDIO WEB AUDIO API
     ------------------------------------------------------------------------- */
  class CardSoundFX {
    constructor() {
      this.enabled = true;
      this.ctx = null;
    }
    init() {
      if (!this.enabled) return null;
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) this.ctx = new AC();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      } catch (_) {}
      return this.ctx;
    }
    tone(freq, type = 'triangle', dur = 0.08, vol = 0.07, endFreq = null) {
      const ctx = this.init();
      if (!ctx || !this.enabled) return;
      try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);
        if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, now + dur);
        gain.gain.setValueAtTime(vol, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + dur + 0.01);
      } catch (_) {}
    }
    drawCard() { this.tone(310, 'triangle', 0.06, 0.065, 580); }
    discardCard() { this.tone(420, 'sine', 0.07, 0.065, 220); }
    slideCard() { this.tone(460, 'triangle', 0.04, 0.045, 560); }
    stackMeld() { this.tone(587.33, 'sine', 0.11, 0.07, 880); }
    errorBuzz() { this.tone(180, 'square', 0.09, 0.035, 140); }
    batidaWin() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        setTimeout(() => this.tone(f, 'triangle', 0.18, 0.09), i * 85);
      });
      if (navigator.vibrate) try { navigator.vibrate([40, 30, 60]); } catch (_) {}
    }
  }
  const sfx = new CardSoundFX();

  /* -------------------------------------------------------------------------
     3. PERFIL LOCAL, TEMAS & PERSISTÊNCIA
     ------------------------------------------------------------------------- */
  const THEMES = [
    { id: 'azulejo', label: '🏛️ Azulejo & Cedro', meta: '#5c3317' },
    { id: 'kraft', label: '☕ Café & Papel Kraft', meta: '#3e2c20' },
    { id: 'quiosque', label: '🏖️ Quiosque & Brisa', meta: '#0e7490' },
    { id: 'seresta', label: '🌙 Seresta Noturna', meta: '#071318' }
  ];

  const AVATARS = [
    { id: 'coffee', emoji: '☕', label: 'Cafezinho' },
    { id: 'toucan', emoji: '🦜', label: 'Tucano' },
    { id: 'fox', emoji: '🦊', label: 'Raposa' },
    { id: 'cat', emoji: '🐱', label: 'Gatinho' },
    { id: 'dog', emoji: '🐶', label: 'Cachorro' },
    { id: 'guitar', emoji: '🎸', label: 'Violão' },
    { id: 'sun', emoji: '🌻', label: 'Girassol' },
    { id: 'chef', emoji: '🧑‍🍳', label: 'Mestre' },
    { id: 'crown', emoji: '👑', label: 'Ás da Mesa' },
    { id: 'cactus', emoji: '🌵', label: 'Sertão' },
    { id: 'coconut', emoji: '🥥', label: 'Coco' },
    { id: 'sloth', emoji: '🦥', label: 'Preguiça' },
    { id: 'owl', emoji: '🦉', label: 'Coruja' },
    { id: 'frog', emoji: '🐸', label: 'Sapo' },
    { id: 'moon', emoji: '🌙', label: 'Seresta' },
    { id: 'clover', emoji: '🍀', label: 'Sorte' }
  ];
  const isAvatarId = (id) => AVATARS.some(a => a.id === id);

  const STORAGE_KEY = 'pife_varanda_profile_v3';
  const SESSION_ID_KEY = 'pife_varanda_session_id';
  const SESSION_ROOM_KEY = 'pife_varanda_joined_room';

  function loadProfile() {
    const base = { name: 'Jogador', avatarId: 'coffee', photoDataUrl: null, theme: 'azulejo', wins: 0, games: 0, matchesWon: 0, registered: false };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        return {
          name: cleanName(p.name),
          avatarId: isAvatarId(p.avatarId) ? p.avatarId : 'coffee',
          photoDataUrl: safePhoto(p.photoDataUrl),
          theme: THEMES.some(t => t.id === p.theme) ? p.theme : 'azulejo',
          wins: Number(p.wins) || 0,
          games: Number(p.games) || 0,
          matchesWon: Number(p.matchesWon) || 0,
          registered: !!p.registered
        };
      }
    } catch (_) {}
    return base;
  }

  const profile = loadProfile();

  function applyTheme(themeId) {
    const t = THEMES.find(x => x.id === themeId) || THEMES[0];
    profile.theme = t.id;
    document.body.dataset.theme = t.id;
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', t.meta);
    document.querySelectorAll('[data-set-theme]').forEach(btn => {
      btn.style.borderColor = btn.dataset.setTheme === t.id ? 'var(--accent-primary)' : 'rgba(120,90,60,0.28)';
    });
  }

  function saveProfile() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch (_) {
      showToast('⚠️ Não foi possível salvar o perfil neste aparelho.');
    }
    refreshProfileUI();
    broadcastProfileToRoom();
  }

  const PHOTO_SIZE = 128;

  function drawSquarePhoto(source, srcW, srcH, mirror) {
    const off = document.createElement('canvas');
    off.width = PHOTO_SIZE;
    off.height = PHOTO_SIZE;
    const octx = off.getContext('2d');
    const side = Math.min(srcW, srcH);
    if (mirror) {
      octx.translate(PHOTO_SIZE, 0);
      octx.scale(-1, 1);
    }
    octx.drawImage(source, (srcW - side) / 2, (srcH - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    return safePhoto(off.toDataURL('image/jpeg', 0.8));
  }

  function compressImageFile(file) {
    return new Promise((resolve) => {
      if (!file || !/^image\//.test(file.type || 'image/')) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          try { resolve(drawSquarePhoto(img, img.naturalWidth || img.width, img.naturalHeight || img.height, false)); }
          catch (_) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = ev.target.result;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function renderAvatarHTML(avatarId, photoDataUrl) {
    const photo = safePhoto(photoDataUrl);
    if (photo) return `<img src="${photo}" alt="" />`;
    const av = AVATARS.find(a => a.id === avatarId) || AVATARS[0];
    return av.emoji;
  }

  /* -------------------------------------------------------------------------
     4. ESTADO DO JOGO
     ------------------------------------------------------------------------- */
  const SUITS = [
    { id: 'S', sym: '♠', color: 'black', order: 0 },
    { id: 'H', sym: '♥', color: 'red', order: 1 },
    { id: 'C', sym: '♣', color: 'black', order: 2 },
    { id: 'D', sym: '♦', color: 'red', order: 3 }
  ];

  const RANKS = [
    { val: 1, label: 'A', pts: 1 },
    { val: 2, label: '2', pts: 2 },
    { val: 3, label: '3', pts: 3 },
    { val: 4, label: '4', pts: 4 },
    { val: 5, label: '5', pts: 5 },
    { val: 6, label: '6', pts: 6 },
    { val: 7, label: '7', pts: 7 },
    { val: 8, label: '8', pts: 8 },
    { val: 9, label: '9', pts: 9 },
    { val: 10, label: '10', pts: 10 },
    { val: 11, label: 'J', pts: 10 },
    { val: 12, label: 'Q', pts: 10 },
    { val: 13, label: 'K', pts: 10 }
  ];

  function getSessionId() {
    try {
      let id = sessionStorage.getItem(SESSION_ID_KEY);
      if (!id || !ID_RE.test(id)) {
        id = 'u_' + randId(8);
        sessionStorage.setItem(SESSION_ID_KEY, id);
      }
      return id;
    } catch (_) {
      return 'u_' + randId(8);
    }
  }

  const state = {
    activeTab: 'play',
    gameMode: 'solo', // 'solo' | 'duo' (2v2) | 'team' (3v3)
    soloCount: 4,
    scoringMode: 'points', // 'single' | 'points' (Estouro 100 pts)
    botDiff: 'medium',
    autoStackMelds: true,
    longMelds: false,

    roomCode: 'PIFE',
    isHost: true,
    hostId: null,
    localId: getSessionId(),
    roomMembers: {},

    inMatch: false,
    matchId: null,
    handNumber: 1,
    stock: [],
    remoteStockCount: 0,
    discardPile: [],
    players: [],
    turnIndex: 0,
    turnStep: 'draw', // 'draw' | 'discard' | 'ended'
    lockedDiscardUid: null, // carta pega da lixeira na vez atual (não pode voltar)
    roundEnd: null,

    selectedCardUid: null,
    lastDrawnUid: null,
    sortMode: 'suit',
    stackedMelds: [],
    lastTap: { uid: null, time: 0 },
    lixoConfirm: { uid: null, until: 0 },

    ignoreMatchId: null,
    lastSyncSeq: 0,
    shownRoundKey: null,
    recordedRoundKeys: new Set(),
    spectatorToastFor: null
  };

  let botTimeout = null;
  let syncSeq = 0;

  const LOCK_MSG = '🔒 A carta que você pegou da lixeira não pode ser descartada nesta vez.';

  /* -------------------------------------------------------------------------
     5. BARALHO DUPLO (104 CARTAS) & SOLVER EXATO DE JOGOS
     ------------------------------------------------------------------------- */
  function makeCard(uid, suitId, val) {
    const s = SUITS.find(x => x.id === suitId);
    const r = RANKS.find(x => x.val === val);
    if (!s || !r || !Number.isInteger(uid)) return null;
    return { uid, suit: s.id, sym: s.sym, color: s.color, suitOrder: s.order, val: r.val, label: r.label, pts: r.pts };
  }

  function sanitizeCard(c) {
    return c && typeof c === 'object' ? makeCard(c.uid, c.suit, c.val) : null;
  }

  function buildDoubleDeck104() {
    const deck = [];
    let uid = 1;
    for (let copy = 0; copy < 2; copy++) {
      SUITS.forEach(s => RANKS.forEach(r => deck.push(makeCard(uid++, s.id, r.val))));
    }
    return shuffleCards(deck);
  }

  function shuffleCards(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function isConsecutive(vals) {
    const v = vals.slice().sort((a, b) => a - b);
    for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1] + 1) return false;
    return true;
  }

  // Retorna 'TRINCA' | 'QUADRA' | 'SEQ' ou null.
  function getMeldType(cards, allowLong = state.longMelds) {
    const n = cards.length;
    if (n < 3) return null;
    if (cards.every(c => c.val === cards[0].val)) {
      if (n > 4 || (n === 4 && !allowLong)) return null;
      return new Set(cards.map(c => c.suit)).size === n ? (n === 4 ? 'QUADRA' : 'TRINCA') : null;
    }
    if (n > 3 && !allowLong) return null;
    if (!cards.every(c => c.suit === cards[0].suit)) return null;
    const vals = cards.map(c => c.val);
    if (isConsecutive(vals)) return 'SEQ';
    if (vals.includes(1) && isConsecutive(vals.map(v => (v === 1 ? 14 : v)))) return 'SEQ'; // Q-K-A
    return null;
  }

  const meldCache = new Map();

  function popcount(m) {
    let c = 0;
    while (m) { m &= m - 1; c++; }
    return c;
  }

  // Solver exato: maximiza cartas em jogos (desempate: mais pontos em jogos).
  function analyzeHandMelds(cards) {
    const n = cards.length;
    const key = (state.longMelds ? 'L:' : 'C:') + cards.map(c => c.uid).sort((a, b) => a - b).join(',');
    const hit = meldCache.get(key);
    if (hit) return hit;

    const byLowBit = Array.from({ length: n }, () => []);
    const maxLen = state.longMelds ? n : 3;
    if (n >= 3) {
      for (let mask = 7; mask < (1 << n); mask++) {
        const pc = popcount(mask);
        if (pc < 3 || pc > maxLen) continue;
        const sel = [];
        let low = -1;
        for (let i = 0; i < n; i++) {
          if (mask & (1 << i)) {
            if (low < 0) low = i;
            sel.push(cards[i]);
          }
        }
        const type = getMeldType(sel);
        if (type) byLowBit[low].push({ mask, type, size: pc, pts: sel.reduce((s, c) => s + c.pts, 0), cards: sel });
      }
    }

    const full = (1 << n) - 1;
    const memo = new Map();
    function best(used) {
      if (used === full) return { score: 0, pick: null, next: full };
      const cached = memo.get(used);
      if (cached) return cached;
      let i = 0;
      while (used & (1 << i)) i++;
      const looseNext = used | (1 << i);
      let res = { score: best(looseNext).score, pick: null, next: looseNext };
      for (const m of byLowBit[i]) {
        if (m.mask & used) continue;
        const sc = m.size * 1000 + m.pts + best(used | m.mask).score;
        if (sc > res.score) res = { score: sc, pick: m, next: used | m.mask };
      }
      memo.set(used, res);
      return res;
    }

    const melds = [];
    let covered = 0;
    let coveredPts = 0;
    let u = 0;
    while (n > 0 && u !== full) {
      const r = best(u);
      if (r.pick) {
        melds.push({ type: r.pick.type, cards: r.pick.cards, uids: r.pick.cards.map(c => c.uid) });
        covered += r.pick.size;
        coveredPts += r.pick.pts;
      }
      u = r.next;
    }
    const totalPts = cards.reduce((s, c) => s + c.pts, 0);
    const result = { melds, meldCount: melds.length, covered, loosePoints: totalPts - coveredPts };

    if (meldCache.size > 5000) meldCache.clear();
    meldCache.set(key, result);
    return result;
  }

  function canBatidaWithDiscard(hand10, discardUid) {
    if (hand10.length !== 10 || discardUid === state.lockedDiscardUid) return false;
    const remaining9 = hand10.filter(c => c.uid !== discardUid);
    if (remaining9.length !== 9) return false;
    return analyzeHandMelds(remaining9).covered === 9;
  }

  function findWinningDiscardUid(hand10, preferUnstacked = false) {
    if (hand10.length !== 10) return null;
    if (preferUnstacked) {
      const stackedSet = new Set(state.stackedMelds.flatMap(s => s.uids));
      for (const c of hand10) {
        if (!stackedSet.has(c.uid) && canBatidaWithDiscard(hand10, c.uid)) return c.uid;
      }
    }
    for (const c of hand10) {
      if (canBatidaWithDiscard(hand10, c.uid)) return c.uid;
    }
    return null;
  }

  /* -------------------------------------------------------------------------
     6. PILHAS SOBREPOSTAS & REORDENAÇÃO LIVRE NA MÃO
     ------------------------------------------------------------------------- */
  function sanitizeStackedMelds(hand) {
    const handMap = new Map(hand.map(c => [c.uid, c]));
    const seenUids = new Set();
    const validStacks = [];

    state.stackedMelds.forEach(st => {
      if (st.uids.length < 3) return;
      if (st.uids.some(u => !handMap.has(u) || seenUids.has(u))) return;
      const type = getMeldType(st.uids.map(u => handMap.get(u)));
      if (type) {
        st.uids.forEach(u => seenUids.add(u));
        validStacks.push({ stackId: st.stackId, type, uids: st.uids.slice() });
      }
    });

    state.stackedMelds = validStacks;
  }

  function orderCardsForStack(cards, type) {
    const copy = cards.slice();
    if (type !== 'SEQ') return copy.sort((a, b) => a.suitOrder - b.suitOrder);
    const aceHigh = copy.some(c => c.val === 1) && !isConsecutive(copy.map(c => c.val));
    const v = (c) => (aceHigh && c.val === 1 ? 14 : c.val);
    return copy.sort((a, b) => v(a) - v(b));
  }

  function pushStack(cards, type) {
    const orderedUids = orderCardsForStack(cards, type).map(c => c.uid);
    state.stackedMelds.push({ stackId: 'st_' + randId(6), type, uids: orderedUids });
    return orderedUids;
  }

  function autoGroupValidMelds(hand, silent = false) {
    sanitizeStackedMelds(hand);
    const alreadyStacked = new Set(state.stackedMelds.flatMap(s => s.uids));

    // 1º: trios adjacentes na ordem montada pelo jogador
    const freeCards = hand.filter(c => !alreadyStacked.has(c.uid));
    for (let i = 0; i <= freeCards.length - 3; i++) {
      const trio = freeCards.slice(i, i + 3);
      if (trio.some(c => alreadyStacked.has(c.uid))) continue;
      const type = getMeldType(trio);
      if (type) pushStack(trio, type).forEach(u => alreadyStacked.add(u));
    }

    // 2º: melhores jogos entre as cartas soltas restantes
    const stillFree = hand.filter(c => !alreadyStacked.has(c.uid));
    if (stillFree.length >= 3) {
      analyzeHandMelds(stillFree).melds.forEach(m => pushStack(m.cards, m.type));
    }

    if (!silent) sfx.stackMeld();
  }

  function unstackMeldById(stackId) {
    const idx = state.stackedMelds.findIndex(s => s.stackId === stackId);
    if (idx !== -1) {
      state.stackedMelds.splice(idx, 1);
      sfx.slideCard();
      renderGameUI();
    }
  }

  function reorderLocalCard(fromUid, toUid) {
    const me = getLocalPlayer();
    if (!me || !me.hand || fromUid === toUid) return;

    const fromIdx = me.hand.findIndex(c => c.uid === fromUid);
    const toIdx = me.hand.findIndex(c => c.uid === toUid);
    if (fromIdx === -1 || toIdx === -1) return;

    const [moved] = me.hand.splice(fromIdx, 1);
    me.hand.splice(toIdx, 0, moved);
    sfx.slideCard();

    if (state.autoStackMelds) autoGroupValidMelds(me.hand, true);
    renderGameUI();
  }

  function moveSelectedCardByStep(delta) {
    const me = getLocalPlayer();
    if (!me || !me.hand || state.selectedCardUid === null) return;

    const stackedSet = new Set(state.stackedMelds.flatMap(s => s.uids));
    const freeList = me.hand.filter(c => !stackedSet.has(c.uid));
    const posInFree = freeList.findIndex(c => c.uid === state.selectedCardUid);
    if (posInFree === -1) return;

    const targetPos = posInFree + delta;
    if (targetPos < 0 || targetPos >= freeList.length) return;

    reorderLocalCard(state.selectedCardUid, freeList[targetPos].uid);
  }

  /* -------------------------------------------------------------------------
     7. INÍCIO DE PARTIDA, DISTRIBUIÇÃO & FLUXO DE TURNO (DONO DA MESA)
     ------------------------------------------------------------------------- */
  const BOT_NAMES = [
    { name: 'Seu Zé', avatarId: 'coffee' },
    { name: 'Dona Lúcia', avatarId: 'sun' },
    { name: 'Chico', avatarId: 'guitar' },
    { name: 'Bia', avatarId: 'toucan' },
    { name: 'Rafa', avatarId: 'fox' }
  ];

  function isGameScreenVisible() {
    return !$('game-screen').classList.contains('hidden');
  }

  function showGameScreen() {
    $('lobby-screen').classList.add('hidden');
    $('game-screen').classList.remove('hidden');
  }

  function showLobbyScreen() {
    $('modal-round-end').classList.add('hidden');
    $('game-screen').classList.add('hidden');
    $('lobby-screen').classList.remove('hidden');
    refreshLobbyRoleUI();
  }

  function startMatch() {
    if (!state.isHost) {
      showToast('⏳ Só o dono da mesa pode dar as cartas.');
      return;
    }
    sfx.init();
    clearTimeout(botTimeout);

    const count = state.gameMode === 'duo' ? 4 : (state.gameMode === 'team' ? 6 : state.soloCount);
    // Dono da mesa sempre senta primeiro
    const humans = Object.values(state.roomMembers)
      .sort((a, b) => (b.id === state.localId) - (a.id === state.localId));
    const roster = [];

    humans.slice(0, count).forEach(h => {
      roster.push({ id: h.id, name: h.name, avatarId: h.avatarId, isBot: false });
    });
    if (humans.length > count) {
      showToast(`Mesa cheia: ${humans.length - count} jogador(es) ficam de fora desta partida.`);
    }

    let bi = 0;
    while (roster.length < count) {
      const b = BOT_NAMES[bi % BOT_NAMES.length];
      roster.push({ id: 'bot_' + bi, name: `${b.name} (Bot)`, avatarId: b.avatarId, isBot: true });
      bi++;
    }

    state.players = roster.map((r, idx) => ({
      ...r,
      team: state.gameMode === 'solo' ? null : (idx % 2 === 0 ? 'A' : 'B'),
      penaltyScore: 0,
      lastHandPenalty: 0,
      hand: []
    }));

    state.matchId = 'm_' + randId(8);
    state.inMatch = true;
    state.handNumber = 1;

    $('modal-round-end').classList.add('hidden');
    showGameScreen();
    dealNewHand(true);
  }

  function dealNewHand(firstHand = false) {
    clearTimeout(botTimeout);
    if (!firstHand) state.handNumber++;

    state.inMatch = true;
    state.stock = buildDoubleDeck104();
    state.discardPile = [];
    state.selectedCardUid = null;
    state.lastDrawnUid = null;
    state.lockedDiscardUid = null;
    state.stackedMelds = [];
    state.roundEnd = null;
    state.lixoConfirm = { uid: null, until: 0 };

    state.players.forEach(p => {
      p.hand = [];
      for (let i = 0; i < 9; i++) p.hand.push(state.stock.pop());
      sortPlayerHand(p, state.sortMode);
    });

    const me = getLocalPlayer();
    if (me && state.autoStackMelds) autoGroupValidMelds(me.hand, true);

    state.discardPile.push(state.stock.pop());
    state.turnIndex = (state.handNumber - 1) % state.players.length;
    state.turnStep = 'draw';

    $('modal-round-end').classList.add('hidden');
    renderGameUI();
    syncMatchToPeers();
    scheduleBotIfNeeded();
  }

  function sortPlayerHand(player, mode) {
    player.hand.sort((a, b) => {
      if (mode === 'rank') return a.val !== b.val ? a.val - b.val : a.suitOrder - b.suitOrder;
      return a.suitOrder !== b.suitOrder ? a.suitOrder - b.suitOrder : a.val - b.val;
    });
  }

  function getCurrentPlayer() {
    return state.players[state.turnIndex] || null;
  }

  function getLocalPlayer() {
    return state.players.find(p => p.id === state.localId) || null;
  }

  function isMyTurn() {
    const curr = getCurrentPlayer();
    return !!(state.inMatch && curr && curr.id === state.localId);
  }

  function handCount(p) {
    return Array.isArray(p.hand) ? p.hand.length : (Number(p.handCount) || 0);
  }

  function stockCount() {
    return state.isHost ? state.stock.length : state.remoteStockCount;
  }

  // Monte vazio: reembaralha a lixeira (menos a carta de cima).
  function recycleDiscardIntoStock() {
    if (state.stock.length > 0 || state.discardPile.length <= 1) return;
    const topDiscard = state.discardPile.pop();
    state.stock = shuffleCards(state.discardPile);
    state.discardPile = [topDiscard];
    showToast('🔄 Monte reembaralhado com as cartas da lixeira!');
  }

  function drawCardAction(playerId, source) {
    const curr = getCurrentPlayer();
    if (!state.inMatch || !curr || curr.id !== playerId || state.turnStep !== 'draw') return false;

    let drawn = null;
    if (source === 'discard') {
      if (!state.discardPile.length) return false;
      drawn = state.discardPile.pop();
      state.lockedDiscardUid = drawn.uid;
    } else {
      recycleDiscardIntoStock();
      if (!state.stock.length) {
        // Caso extremo: monte e lixeira esgotados — anula a mão sem pontuar.
        showToast('🃏 O monte acabou e ninguém bateu — mão anulada.');
        dealNewHand(false);
        return false;
      }
      drawn = state.stock.pop();
      state.lockedDiscardUid = null;
    }

    curr.hand.push(drawn);
    state.turnStep = 'discard';

    if (curr.id === state.localId) {
      state.lastDrawnUid = drawn.uid;
      state.selectedCardUid = null;
      sfx.drawCard();
      if (state.autoStackMelds) {
        const prevStacks = state.stackedMelds.length;
        autoGroupValidMelds(curr.hand, true);
        if (state.stackedMelds.length > prevStacks) {
          sfx.stackMeld();
          showToast('📚 Novo jogo empilhado automaticamente!');
        }
      }
    }

    renderGameUI();
    syncMatchToPeers();
    return true;
  }

  function discardCardAction(playerId, cardUid) {
    const curr = getCurrentPlayer();
    if (!state.inMatch || !curr || curr.id !== playerId || state.turnStep !== 'discard') return false;

    const idx = curr.hand.findIndex(c => c.uid === cardUid);
    if (idx === -1) return false;
    if (cardUid === state.lockedDiscardUid) {
      if (playerId === state.localId) { sfx.errorBuzz(); showToast(LOCK_MSG); }
      return false;
    }

    const isWinningMove = canBatidaWithDiscard(curr.hand, cardUid);
    const [discarded] = curr.hand.splice(idx, 1);
    state.discardPile.push(discarded);
    state.lockedDiscardUid = null;

    if (curr.id === state.localId) {
      state.selectedCardUid = null;
      state.lastDrawnUid = null;
      sanitizeStackedMelds(curr.hand);
      sfx.discardCard();
    }

    if (isWinningMove) {
      finishHandWithWinner(curr);
      return true;
    }

    state.turnIndex = (state.turnIndex + 1) % state.players.length;
    state.turnStep = 'draw';

    renderGameUI();
    syncMatchToPeers();
    scheduleBotIfNeeded();
    return true;
  }

  /* -------------------------------------------------------------------------
     8. INTELIGÊNCIA DOS BOTS
     ------------------------------------------------------------------------- */
  function scheduleBotIfNeeded() {
    clearTimeout(botTimeout);
    if (!state.inMatch || !state.isHost || state.turnStep === 'ended') return;
    const curr = getCurrentPlayer();
    if (!curr || !curr.isBot) return;

    const thinkDelay = state.botDiff === 'hard' ? 680 : 880;
    const botId = curr.id;
    botTimeout = setTimeout(() => runBotTurn(botId), thinkDelay);
  }

  function evaluateCardUsefulness(hand, candidateCard) {
    const before = analyzeHandMelds(hand).covered;
    const withCard = analyzeHandMelds([...hand, candidateCard]).covered;
    if (withCard > before) return 100;

    let synergy = 0;
    hand.forEach(c => {
      if (c.val === candidateCard.val && c.suit !== candidateCard.suit) synergy += 14;
      if (c.suit === candidateCard.suit) {
        const diff = Math.abs(c.val - candidateCard.val);
        if (diff === 1 || diff === 2 || (c.val === 1 && candidateCard.val >= 12) || (candidateCard.val === 1 && c.val >= 12)) {
          synergy += 12;
        }
      }
    });
    return synergy;
  }

  function runBotTurn(botId) {
    const bot = getCurrentPlayer();
    if (!state.inMatch || !state.isHost || !bot || bot.id !== botId || !bot.isBot) return;

    if (state.turnStep === 'draw') {
      const topTrash = state.discardPile[state.discardPile.length - 1];
      let takeTrash = false;
      if (topTrash) {
        const score = evaluateCardUsefulness(bot.hand, topTrash);
        const threshold = state.botDiff === 'easy' ? 80 : (state.botDiff === 'hard' ? 14 : 24);
        takeTrash = score >= threshold;
      }
      if (drawCardAction(bot.id, takeTrash ? 'discard' : 'stock')) {
        botTimeout = setTimeout(() => runBotTurn(botId), 650);
      }
      return;
    }

    if (state.turnStep === 'discard') {
      const winUid = findWinningDiscardUid(bot.hand);
      if (winUid !== null) {
        discardCardAction(bot.id, winUid);
        return;
      }

      let worstUid = null;
      let worstScore = Infinity;
      bot.hand.forEach(c => {
        if (c.uid === state.lockedDiscardUid) return;
        const rest = bot.hand.filter(x => x.uid !== c.uid);
        const coveredAfter = analyzeHandMelds(rest).covered;
        const pairHelp = evaluateCardUsefulness(rest, c);
        const totalValue = coveredAfter * 60 + pairHelp - c.pts * 0.4;
        if (totalValue < worstScore) {
          worstScore = totalValue;
          worstUid = c.uid;
        }
      });

      if (worstUid !== null) discardCardAction(bot.id, worstUid);
    }
  }

  /* -------------------------------------------------------------------------
     9. ENCERRAMENTO DE MÃO, CAMPEÃO DA PARTIDA & ESTATÍSTICAS
     ------------------------------------------------------------------------- */
  function finishHandWithWinner(winner) {
    clearTimeout(botTimeout);
    state.turnStep = 'ended';
    const winningMelds = analyzeHandMelds(winner.hand).melds;
    const solo = state.gameMode === 'solo';

    state.players.forEach(p => {
      const isWinnerSide = solo ? p.id === winner.id : p.team === winner.team;
      if (isWinnerSide) {
        p.lastHandPenalty = 0;
      } else {
        const loose = analyzeHandMelds(p.hand).loosePoints;
        p.lastHandPenalty = loose;
        p.penaltyScore += loose;
      }
    });

    const teamTotal = (t) => state.players.filter(p => p.team === t).reduce((s, p) => s + p.penaltyScore, 0);

    let matchOver = state.scoringMode === 'single';
    if (!matchOver) {
      matchOver = solo
        ? state.players.some(p => p.penaltyScore >= 100)
        : (teamTotal('A') >= 100 || teamTotal('B') >= 100);
    }

    let championIds = [];
    let championText = '';
    if (matchOver) {
      if (state.scoringMode === 'single') {
        championIds = solo ? [winner.id] : state.players.filter(p => p.team === winner.team).map(p => p.id);
        championText = solo ? `🏆 Campeão: ${winner.name}` : `🏆 Equipe ${winner.team} venceu a partida!`;
      } else if (solo) {
        const min = Math.min(...state.players.map(p => p.penaltyScore));
        const champs = state.players.filter(p => p.penaltyScore === min);
        championIds = champs.map(p => p.id);
        championText = `🏆 Campeão: ${champs.map(p => p.name).join(' & ')} (${min} pts)`;
      } else {
        const a = teamTotal('A');
        const b = teamTotal('B');
        const champTeam = a === b ? winner.team : (a < b ? 'A' : 'B');
        championIds = state.players.filter(p => p.team === champTeam).map(p => p.id);
        championText = `🏆 Equipe ${champTeam} venceu! (A ${a} × B ${b} pts)`;
      }
      state.inMatch = false;
    }

    state.roundEnd = {
      key: `${state.matchId}#${state.handNumber}`,
      handNumber: state.handNumber,
      gameMode: state.gameMode,
      winnerId: winner.id,
      winnerName: winner.name,
      winnerTeam: winner.team,
      melds: winningMelds.map(m => ({ type: m.type, cards: m.cards.map(c => ({ uid: c.uid, suit: c.suit, val: c.val })) })),
      rows: state.players.map(p => ({ id: p.id, name: p.name, team: p.team, last: p.lastHandPenalty, total: p.penaltyScore })),
      matchOver,
      championIds,
      championText
    };

    renderGameUI();
    handleRoundEnd(state.roundEnd);
    syncMatchToPeers();
  }

  function handleRoundEnd(re) {
    const myRow = re.rows.find(r => r.id === state.localId);
    const localWon = re.gameMode === 'solo'
      ? re.winnerId === state.localId
      : !!(myRow && myRow.team && myRow.team === re.winnerTeam);

    if (!state.recordedRoundKeys.has(re.key) && myRow) {
      state.recordedRoundKeys.add(re.key);
      profile.games++;
      if (re.winnerId === state.localId) profile.wins++;
      if (re.matchOver && re.championIds.includes(state.localId)) profile.matchesWon++;
      saveProfile();
    }

    if (state.shownRoundKey !== re.key) {
      state.shownRoundKey = re.key;
      if (localWon) sfx.batidaWin();
    }
    showRoundEndModal(re, localWon);
  }

  function cardText(c) {
    const card = sanitizeCard(c);
    return card ? `${card.label}${card.sym}` : '?';
  }

  function showRoundEndModal(re, localWon) {
    $('round-end-emoji').textContent = localWon ? '🏆' : '🃏';
    $('round-end-sub').textContent = re.matchOver
      ? 'Fim da Partida!'
      : `Fim da Mão ${re.handNumber}${state.scoringMode === 'points' ? ' • Limite 100 pts' : ''}`;
    $('round-end-title').textContent = re.gameMode === 'solo'
      ? `${re.winnerName} Bateu!`
      : `Equipe ${re.winnerTeam} Bateu (${re.winnerName})!`;

    const champEl = $('round-end-champion');
    if (re.matchOver && re.championText) {
      champEl.textContent = re.championText;
      champEl.classList.remove('hidden');
    } else {
      champEl.classList.add('hidden');
    }

    $('round-end-melds').innerHTML = re.melds.map((m, i) => {
      const cardsTxt = m.cards.map(cardText).join(' ');
      return `<div>Jogo ${i + 1} (${escapeHTML(m.type)}): <strong>${escapeHTML(cardsTxt)}</strong></div>`;
    }).join('');

    $('round-end-list').innerHTML = re.rows.map(r => {
      const teamTag = r.team ? ` [${escapeHTML(r.team)}]` : '';
      const delta = r.last > 0
        ? `<span style="color:var(--accent-danger);">+${Number(r.last) || 0} pts</span>`
        : `<span style="color:var(--accent-win);">0</span>`;
      const isMe = r.id === state.localId ? ' 👈' : '';
      return `
        <div style="display:flex; justify-content:space-between; gap:8px; font-weight:900;">
          <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHTML(r.name)}${teamTag}${isMe}</span>
          <span style="white-space:nowrap;">${delta} &rarr; <strong>${Number(r.total) || 0} pts</strong></span>
        </div>
      `;
    }).join('');

    const nextBtn = $('btn-next-hand');
    if (state.isHost) {
      nextBtn.disabled = false;
      nextBtn.textContent = re.matchOver ? 'Nova Partida' : `Iniciar Mão ${re.handNumber + 1}`;
      nextBtn.dataset.restart = re.matchOver ? '1' : '0';
    } else {
      nextBtn.disabled = true;
      nextBtn.textContent = '⏳ Aguardando o dono…';
      nextBtn.dataset.restart = '0';
    }

    $('modal-round-end').classList.remove('hidden');
  }

  /* -------------------------------------------------------------------------
     10. RENDERIZAÇÃO DA MESA & DA MÃO
     ------------------------------------------------------------------------- */
  function avatarFor(p) {
    if (p.id === state.localId) return renderAvatarHTML(profile.avatarId, profile.photoDataUrl);
    const member = state.roomMembers[p.id];
    return renderAvatarHTML(member ? member.avatarId : p.avatarId, member ? member.photoDataUrl : null);
  }

  function cardFaceHTML(c) {
    const col = c.color === 'red' ? 'var(--suit-red)' : 'var(--suit-black)';
    return `
      <div class="card-corner" style="color:${col};"><span>${c.label}</span><span>${c.sym}</span></div>
      <div class="card-center" style="color:${col};">${c.sym}</div>
    `;
  }

  function renderGameUI() {
    $('game-round-badge').textContent = `Mão ${state.handNumber}`;
    const modeLabel = state.gameMode === 'duo' ? 'Dupla 2v2' : (state.gameMode === 'team' ? 'Equipe 3v3' : `Solo ${state.players.length}P`);
    $('game-mode-badge').textContent = modeLabel;

    const curr = getCurrentPlayer();
    const me = getLocalPlayer();
    const myTurn = isMyTurn();

    // Assentos dos demais jogadores
    const others = state.players.filter(p => p.id !== state.localId);
    $('opponents-strip').innerHTML = others.map(p => {
      const active = curr && curr.id === p.id && state.turnStep !== 'ended';
      const teamBadge = p.team
        ? `<span style="font-size:9px; color:${p.team === 'A' ? 'var(--accent-primary)' : 'var(--accent-danger)'};">[${escapeHTML(p.team)}]</span>`
        : '';
      return `
        <div class="opp-seat ${active ? 'turn-now' : ''}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:4px;">
            <span style="display:flex; align-items:center; gap:4px; min-width:0;">
              <span class="avatar-ring" style="width:20px; height:20px; font-size:11px; border-width:1.5px;">${avatarFor(p)}</span>
              <span style="font-size:11px; font-weight:900; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(p.name)}</span>
              ${teamBadge}
            </span>
            <span style="font-size:10px; font-weight:900; color:var(--accent-gold); white-space:nowrap;">${Number(p.penaltyScore) || 0} pts</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--text-muted); font-weight:800;">
            <span>🃏 ${handCount(p)} cartas</span>
            <span>${active ? '⏳ Jogando' : 'Aguardando'}</span>
          </div>
        </div>
      `;
    }).join('');

    // Status do turno
    const statusPill = $('turn-status-pill');
    if (state.turnStep === 'ended') {
      statusPill.textContent = '🏁 Mão encerrada.';
    } else if (myTurn) {
      if (state.turnStep === 'draw') {
        statusPill.textContent = '👆 Sua vez! Toque no MONTE ou na LIXEIRA para comprar.';
      } else {
        statusPill.textContent = state.lockedDiscardUid !== null
          ? '👇 Descarte uma carta (a 🔒 da lixeira não pode voltar).'
          : '👇 Arraste uma carta para CIMA ou toque 2x nela para descartar.';
      }
    } else if (curr) {
      statusPill.textContent = `⏳ Vez de ${curr.name} (${state.turnStep === 'draw' ? 'comprando' : 'descartando'})...`;
    }

    // Monte & lixeira
    $('stock-count-lbl').textContent = `${stockCount()}`;
    const stockBox = $('stock-card-box');
    const discardBox = $('discard-card-box');
    const drawPhase = myTurn && state.turnStep === 'draw';
    stockBox.classList.toggle('pile-highlight', drawPhase);
    discardBox.classList.toggle('pile-highlight', drawPhase && state.discardPile.length > 0);

    const topDiscard = state.discardPile[state.discardPile.length - 1];
    if (topDiscard) {
      const col = topDiscard.color === 'red' ? 'var(--suit-red)' : 'var(--suit-black)';
      discardBox.innerHTML = `
        <div style="width:100%; display:flex; justify-content:space-between; font-size:13px; font-weight:900; color:${col};">
          <span>${topDiscard.label}</span><span>${topDiscard.sym}</span>
        </div>
        <div style="font-size:26px; color:${col}; line-height:1;">${topDiscard.sym}</div>
        <div style="width:100%; display:flex; justify-content:space-between; font-size:13px; font-weight:900; color:${col}; transform:rotate(180deg);">
          <span>${topDiscard.label}</span><span>${topDiscard.sym}</span>
        </div>
      `;
    } else {
      discardBox.innerHTML = '<span style="font-size:11px; color:var(--text-muted); font-weight:900; margin:auto;">VAZIO</span>';
    }

    renderScorePill();

    if (!me || !me.hand) return;

    sanitizeStackedMelds(me.hand);
    $('local-seat-avatar').innerHTML = renderAvatarHTML(profile.avatarId, profile.photoDataUrl);
    $('local-seat-name').textContent = profile.name;
    $('local-points-badge').textContent = `${me.penaltyScore} pts`;

    const teamBadge = $('local-team-badge');
    if (me.team) {
      teamBadge.classList.remove('hidden');
      teamBadge.textContent = `EQUIPE ${me.team}`;
      teamBadge.style.background = 'rgba(29, 78, 216, 0.14)';
      teamBadge.style.color = 'var(--accent-primary)';
    } else {
      teamBadge.classList.add('hidden');
    }

    const analysis = analyzeHandMelds(me.hand);
    $('melds-summary-pill').textContent = `📚 Em jogos: ${Math.min(analysis.covered, 9)}/9 • Montinhos: ${state.stackedMelds.length}`;

    const board = $('hand-board-area');
    const handMap = new Map(me.hand.map(c => [c.uid, c]));
    const stackedUids = new Set();

    const stacksHTML = state.stackedMelds.map(st => {
      st.uids.forEach(u => stackedUids.add(u));
      const n = st.uids.length;
      const mid = (n - 1) / 2;
      const leaves = st.uids.map((u, i) => {
        const c = handMap.get(u);
        const col = c.color === 'red' ? 'var(--suit-red)' : 'var(--suit-black)';
        const rot = n > 1 ? ((i - mid) / mid) * 3 : 0;
        return `
          <div class="stacked-leaf-card" style="left:calc(2px + ${i} * var(--card-w) * 0.46); z-index:${i + 2}; transform:rotate(${rot.toFixed(1)}deg);">
            <div style="display:flex; flex-direction:column; align-items:flex-start; font-size:var(--card-font); font-weight:900; color:${col}; line-height:1.05;">
              <span>${c.label}</span>
              <span>${c.sym}</span>
            </div>
            <div style="font-size:15px; color:${col}; align-self:flex-end; line-height:1;">${c.sym}</div>
          </div>
        `;
      }).join('');

      return `
        <div class="meld-stack-group" data-unstack-id="${escapeHTML(st.stackId)}" title="Toque para abrir este jogo"
             style="width:calc(var(--card-w) + ${n - 1} * var(--card-w) * 0.46 + 6px);">
          <span class="meld-stack-badge">${escapeHTML(st.type)}</span>
          ${leaves}
        </div>
      `;
    }).join('');

    const freeCards = me.hand.filter(c => !stackedUids.has(c.uid));
    const freeHTML = freeCards.map(c => {
      const cls = [
        'pife-card-unit',
        state.selectedCardUid === c.uid ? 'selected-card' : '',
        state.lastDrawnUid === c.uid ? 'new-card' : '',
        myTurn && state.lockedDiscardUid === c.uid ? 'locked-card' : ''
      ].join(' ');
      return `<div class="${cls}" data-card-uid="${c.uid}" role="button" tabindex="0" aria-label="${c.label} de ${c.sym}">${cardFaceHTML(c)}</div>`;
    }).join('');

    board.innerHTML = stacksHTML + freeHTML;

    const selFreeIdx = freeCards.findIndex(c => c.uid === state.selectedCardUid);
    $('btn-move-left').disabled = selFreeIdx <= 0;
    $('btn-move-right').disabled = selFreeIdx === -1 || selFreeIdx >= freeCards.length - 1;
    $('btn-expand-all').disabled = state.stackedMelds.length === 0;

    const canDiscard = myTurn && state.turnStep === 'discard' && selFreeIdx !== -1 && state.selectedCardUid !== state.lockedDiscardUid;
    $('btn-discard-selected').disabled = !canDiscard;

    const winUid = myTurn && state.turnStep === 'discard' ? findWinningDiscardUid(me.hand, true) : null;
    const baterBtn = $('btn-bater');
    baterBtn.disabled = winUid === null;
    baterBtn.className = winUid !== null ? 'btn-bater-ready' : 'btn-primary';
  }

  function renderScorePill() {
    const pill = $('score-pill');
    if (state.scoringMode !== 'points' || !state.players.length) {
      pill.classList.add('hidden');
      return;
    }
    pill.classList.remove('hidden');
    if (state.gameMode === 'solo') {
      const worst = state.players.reduce((a, b) => (b.penaltyScore > a.penaltyScore ? b : a));
      const me = getLocalPlayer();
      pill.textContent = worst.penaltyScore === 0
        ? '📊 Estouro em 100 pts • ninguém pontuou'
        : `📊 Você ${me ? me.penaltyScore : 0} • Maior: ${worst.id === state.localId ? 'você' : worst.name.replace(' (Bot)', '')} ${worst.penaltyScore}/100`;
    } else {
      const total = (t) => state.players.filter(p => p.team === t).reduce((s, p) => s + p.penaltyScore, 0);
      pill.textContent = `📊 A ${total('A')} × B ${total('B')} • Limite 100`;
    }
  }

  /* -------------------------------------------------------------------------
     11. AÇÕES DO JOGADOR LOCAL (DONO OU CONVIDADO)
     ------------------------------------------------------------------------- */
  function notYourTurnFeedback() {
    const curr = getCurrentPlayer();
    if (!state.inMatch || state.turnStep === 'ended') return;
    sfx.errorBuzz();
    showToast(curr ? `⏳ Aguarde: é a vez de ${curr.name}.` : '⏳ Aguarde sua vez.');
  }

  function performLocalDraw(source) {
    if (!state.inMatch) return;
    if (!isMyTurn()) { notYourTurnFeedback(); return; }
    if (state.turnStep !== 'draw') {
      showToast('Você já comprou. Agora descarte uma carta.');
      return;
    }
    if (source === 'discard' && !state.discardPile.length) {
      showToast('A lixeira está vazia — compre do MONTE.');
      return;
    }
    if (state.isHost) drawCardAction(state.localId, source);
    else sendRoomPacket({ type: 'CLIENT_MOVE', move: 'draw', source });
  }

  function performLocalDiscard(uid) {
    if (uid === null || uid === undefined) return;
    if (!isMyTurn()) { notYourTurnFeedback(); renderGameUI(); return; }
    if (state.turnStep !== 'discard') {
      showToast('Primeiro compre uma carta do MONTE ou da LIXEIRA.');
      renderGameUI();
      return;
    }
    if (uid === state.lockedDiscardUid) {
      sfx.errorBuzz();
      showToast(LOCK_MSG);
      renderGameUI();
      return;
    }
    state.lixoConfirm = { uid: null, until: 0 };
    if (state.isHost) {
      discardCardAction(state.localId, uid);
    } else {
      // Remoção otimista local; o sync do dono confirma.
      const me = getLocalPlayer();
      if (me && me.hand) {
        const isWin = canBatidaWithDiscard(me.hand, uid);
        me.hand = me.hand.filter(c => c.uid !== uid);
        state.selectedCardUid = null;
        state.lastDrawnUid = null;
        sfx.discardCard();
        if (isWin) sfx.stackMeld();
      }
      sendRoomPacket({ type: 'CLIENT_MOVE', move: 'discard', cardUid: uid });
      renderGameUI();
    }
  }

  // Toque na lixeira durante o descarte pede confirmação (evita descarte acidental).
  function onDiscardPileTap() {
    if (!state.inMatch) return;
    if (!isMyTurn()) { notYourTurnFeedback(); return; }
    if (state.turnStep === 'draw') { performLocalDraw('discard'); return; }
    if (state.turnStep !== 'discard') return;

    const uid = state.selectedCardUid;
    const me = getLocalPlayer();
    const card = me && me.hand ? me.hand.find(c => c.uid === uid) : null;
    if (!card) {
      showToast('Toque numa carta para selecionar, ou arraste-a para cima.');
      return;
    }
    if (uid === state.lockedDiscardUid) { sfx.errorBuzz(); showToast(LOCK_MSG); return; }

    const now = Date.now();
    if (state.lixoConfirm.uid === uid && now < state.lixoConfirm.until) {
      performLocalDiscard(uid);
    } else {
      state.lixoConfirm = { uid, until: now + 2500 };
      showToast(`Toque de novo na LIXEIRA para descartar ${card.label}${card.sym}`);
    }
  }

  /* -------------------------------------------------------------------------
     12. INTERAÇÃO COM POINTER CAPTURE
         - arrastar para os lados = reorganizar
         - arrastar para cima = descartar (ou bater)
         - toque = selecionar • dois toques rápidos = descartar
     ------------------------------------------------------------------------- */
  const DOUBLE_TAP_MS = 450;

  function setupHandPointerInteractions() {
    const board = $('hand-board-area');
    const discardBox = $('discard-card-box');
    const discardBanner = $('drag-discard-hint');

    let activeCardEl = null;
    let activeStackId = null;
    let activeUid = null;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let isDragging = false;
    let isDraggingUpToDiscard = false;
    let currentDropUid = null;

    function resetDragVisuals() {
      if (activeCardEl) {
        activeCardEl.style.transform = '';
        activeCardEl.classList.remove('dragging-free', 'dragging-to-trash');
      }
      board.querySelectorAll('.drop-target-card').forEach(el => el.classList.remove('drop-target-card'));
      discardBox.classList.remove('discard-drop-active', 'discard-drop-win');
      discardBanner.classList.add('hidden');
      discardBanner.classList.remove('win-ready');

      activeCardEl = null;
      activeStackId = null;
      activeUid = null;
      pointerId = null;
      isDragging = false;
      isDraggingUpToDiscard = false;
      currentDropUid = null;
    }

    board.addEventListener('pointerdown', (e) => {
      if (pointerId !== null) return;

      const stackEl = e.target.closest('.meld-stack-group');
      const cardEl = stackEl ? null : e.target.closest('.pife-card-unit');
      if (!stackEl && !cardEl) return;

      activeStackId = stackEl ? stackEl.dataset.unstackId : null;
      activeCardEl = cardEl;
      activeUid = cardEl ? Number(cardEl.dataset.cardUid) : null;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      isDragging = false;
      isDraggingUpToDiscard = false;
      currentDropUid = null;

      try { board.setPointerCapture(pointerId); } catch (_) {}
    });

    board.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!isDragging && Math.hypot(dx, dy) > 8) isDragging = true;
      if (!isDragging || !activeCardEl || activeUid === null) return;

      if (state.selectedCardUid !== activeUid) {
        state.selectedCardUid = activeUid;
        activeCardEl.classList.add('selected-card');
      }

      const me = getLocalPlayer();
      const canDiscardNow = isMyTurn() && state.turnStep === 'discard' && me && me.hand;

      const discardRect = discardBox.getBoundingClientRect();
      const overDiscardZone = e.clientY <= discardRect.bottom + 36;
      const pulledUpward = dy < -65;

      if (canDiscardNow && (pulledUpward || overDiscardZone)) {
        isDraggingUpToDiscard = true;
        currentDropUid = null;
        board.querySelectorAll('.drop-target-card').forEach(el => el.classList.remove('drop-target-card'));

        activeCardEl.classList.remove('dragging-free');
        activeCardEl.classList.add('dragging-to-trash');
        activeCardEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.08) rotate(${Math.max(-10, Math.min(10, dx * 0.05))}deg)`;

        discardBanner.classList.remove('hidden');
        discardBox.classList.remove('discard-drop-active', 'discard-drop-win');
        if (activeUid === state.lockedDiscardUid) {
          discardBanner.textContent = '🔒 ESTA CARTA NÃO PODE VOLTAR';
          discardBanner.classList.remove('win-ready');
        } else if (canBatidaWithDiscard(me.hand, activeUid)) {
          discardBanner.textContent = '🏆 SOLTE PARA BATER!';
          discardBanner.classList.add('win-ready');
          discardBox.classList.add('discard-drop-win');
        } else {
          discardBanner.textContent = '🗑️ SOLTE PARA DESCARTAR';
          discardBanner.classList.remove('win-ready');
          discardBox.classList.add('discard-drop-active');
        }
      } else {
        isDraggingUpToDiscard = false;
        discardBox.classList.remove('discard-drop-active', 'discard-drop-win');
        discardBanner.classList.add('hidden');

        activeCardEl.classList.remove('dragging-to-trash');
        activeCardEl.classList.add('dragging-free');
        activeCardEl.style.transform = `translate(${dx}px, ${Math.max(-28, Math.min(18, dy))}px) scale(1.06)`;

        board.querySelectorAll('.drop-target-card').forEach(el => el.classList.remove('drop-target-card'));
        const elUnder = document.elementFromPoint(e.clientX, e.clientY);
        const targetCard = elUnder && elUnder.closest('.pife-card-unit');
        if (targetCard && Number(targetCard.dataset.cardUid) !== activeUid) {
          targetCard.classList.add('drop-target-card');
          currentDropUid = Number(targetCard.dataset.cardUid);
        } else {
          currentDropUid = null;
        }
      }
    });

    function finishPointerGesture(e) {
      if (e.pointerId !== pointerId) return;
      try {
        if (board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
      } catch (_) {}

      const stackId = activeStackId;
      const releasedUid = activeUid;
      const wasDragging = isDragging;
      const shouldDiscard = isDraggingUpToDiscard;
      const dropTargetUid = currentDropUid;

      resetDragVisuals();

      // Montinho: abre só com toque (sem arraste), evitando aberturas acidentais.
      if (stackId) {
        if (!wasDragging) unstackMeldById(stackId);
        return;
      }
      if (releasedUid === null) return;

      if (wasDragging) {
        if (shouldDiscard) performLocalDiscard(releasedUid);
        else if (dropTargetUid !== null) reorderLocalCard(releasedUid, dropTargetUid);
        else renderGameUI();
        return;
      }

      handleCardTap(releasedUid);
    }

    board.addEventListener('pointerup', finishPointerGesture);
    board.addEventListener('pointercancel', (e) => {
      if (e.pointerId === pointerId) {
        resetDragVisuals();
        renderGameUI();
      }
    });
  }

  function handleCardTap(uid) {
    const now = Date.now();
    const isDoubleTap = state.lastTap.uid === uid && now - state.lastTap.time < DOUBLE_TAP_MS;
    if (isDoubleTap && isMyTurn() && state.turnStep === 'discard') {
      state.lastTap = { uid: null, time: 0 };
      performLocalDiscard(uid);
      return;
    }
    state.lastTap = { uid, time: now };
    state.selectedCardUid = uid;
    renderGameUI();
  }

  function focusSelectedCard() {
    if (state.selectedCardUid === null) return;
    const el = document.querySelector(`[data-card-uid="${state.selectedCardUid}"]`);
    if (el) el.focus();
  }

  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('modal-rules').classList.contains('hidden')) { $('modal-rules').classList.add('hidden'); return; }
        if (!$('modal-profile').classList.contains('hidden') && profile.registered) { closeProfileModal(); return; }
      }

      const t = e.target;
      if (!(t instanceof HTMLElement) || t.tagName === 'INPUT' || t.tagName === 'BUTTON') return;

      const cardEl = t.closest('.pife-card-unit');
      if (cardEl) {
        const uid = Number(cardEl.dataset.cardUid);
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          state.selectedCardUid = uid;
          renderGameUI();
          focusSelectedCard();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          performLocalDiscard(uid);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          state.selectedCardUid = uid;
          moveSelectedCardByStep(e.key === 'ArrowLeft' ? -1 : 1);
          focusSelectedCard();
        }
        return;
      }

      if (t.getAttribute('role') === 'button' && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        t.click();
      }
    });
  }

  /* -------------------------------------------------------------------------
     13. SALAS ONLINE P2P (BROADCASTCHANNEL + PEERJS) & QR CODE REAL
     ------------------------------------------------------------------------- */
  let bc = null;
  let peer = null;
  let peerKey = '';
  let peerConns = [];
  let peerScriptPromise = null;
  let qrLibPromise = null;
  let joinTimer = null;

  function makeCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function sanitizeCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function inviteURL() {
    return `${window.location.origin}${window.location.pathname}?room=${state.roomCode}`;
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
  }

  function loadPeerJS() {
    if (typeof window.Peer !== 'undefined') return Promise.resolve();
    if (!peerScriptPromise) {
      peerScriptPromise = loadScriptOnce('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js')
        .catch((err) => { peerScriptPromise = null; throw err; });
    }
    return peerScriptPromise;
  }

  function loadQRLib() {
    if (typeof window.qrcode === 'function') return Promise.resolve();
    if (!qrLibPromise) {
      qrLibPromise = loadScriptOnce('https://unpkg.com/qrcode-generator@1.4.4/qrcode.js')
        .catch((err) => { qrLibPromise = null; throw err; });
    }
    return qrLibPromise;
  }

  function renderRoomQR() {
    const slot = $('room-qr-svg');
    const url = inviteURL();
    $('room-qr-url').textContent = url;
    slot.textContent = 'Gerando QR Code…';
    loadQRLib().then(() => {
      if (inviteURL() !== url) return; // sala mudou enquanto carregava
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 2;
      let d = '';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
        }
      }
      const size = n + quiet * 2;
      slot.innerHTML = `<svg width="168" height="168" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR Code do convite"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
    }).catch(() => {
      slot.textContent = 'QR Code indisponível sem internet. Use o link abaixo.';
    });
  }

  function destroyPeer() {
    if (peer) {
      try { peer.destroy(); } catch (_) {}
    }
    peer = null;
    peerKey = '';
    peerConns = [];
  }

  function currentPeerKey() {
    return `${state.roomCode}|${state.isHost ? 'host' : 'guest'}`;
  }

  // Cria o nó P2P apenas uma vez por sala/papel (não derruba conexões existentes).
  function ensurePeer() {
    const wanted = currentPeerKey();
    if (peer && !peer.destroyed && peerKey === wanted) return;
    loadPeerJS().then(() => {
      const key = currentPeerKey();
      if (peer && !peer.destroyed && peerKey === key) return;
      setupPeerNode();
    }).catch(() => {
      showToast('⚠️ Sala online indisponível (sem internet?).');
    });
  }

  function setupPeerNode() {
    destroyPeer();
    const code = state.roomCode;
    const hosting = state.isHost;
    let p;
    try {
      p = new window.Peer(hosting ? `pife-varanda-${code}` : undefined, { debug: 0 });
    } catch (_) {
      return;
    }
    peer = p;
    peerKey = currentPeerKey();

    p.on('open', () => {
      if (!hosting && peer === p) {
        const conn = p.connect(`pife-varanda-${code}`, { reliable: true });
        wirePeerConn(conn, true);
      }
    });
    p.on('connection', (conn) => {
      if (peer !== p) return;
      if (hosting) wirePeerConn(conn, false);
      else try { conn.close(); } catch (_) {}
    });
    p.on('disconnected', () => {
      if (peer === p && !p.destroyed) {
        try { p.reconnect(); } catch (_) {}
      }
    });
    p.on('error', (err) => {
      if (peer !== p) return;
      const type = err && err.type;
      if (type === 'unavailable-id' && hosting) {
        showToast('Código de mesa em uso — gerando outro…');
        initRoom(makeCode(), false);
        ensurePeer();
      } else if (type === 'peer-unavailable' && !hosting && !state.hostId) {
        // (se já falamos com o dono via BroadcastChannel, a sala existe — ignora)
        showToast(`❌ Mesa ${code} não encontrada. Criamos uma mesa nova para você.`);
        initRoom(makeCode(), false);
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error') {
        showToast('⚠️ Falha de rede na sala online.');
      }
    });
  }

  function wirePeerConn(conn, toHost) {
    const owner = peer;
    conn.memberId = null;
    conn.isHostLink = toHost;
    peerConns.push(conn);
    conn.on('open', () => {
      try {
        conn.send({ type: 'MEMBER_HELLO', member: selfMember(), senderId: state.localId, room: state.roomCode });
      } catch (_) {}
    });
    conn.on('data', (d) => onRoomPacket(d, conn));
    conn.on('close', () => {
      if (owner !== peer) return; // conexão de uma sala antiga (já destruída)
      peerConns = peerConns.filter(c => c !== conn);
      if (state.isHost && conn.memberId) handleMemberLeft(conn.memberId);
      else if (!state.isHost && toHost && state.hostId) handleMemberLeft(state.hostId);
    });
    conn.on('error', () => {});
  }

  function sendRoomPacket(payload) {
    const pkt = { ...payload, senderId: state.localId, room: state.roomCode };
    if (bc) { try { bc.postMessage(pkt); } catch (_) {} }
    peerConns.forEach(c => { if (c.open) { try { c.send(pkt); } catch (_) {} } });
  }

  function sendTo(memberId, payload) {
    const pkt = { ...payload, to: memberId, senderId: state.localId, room: state.roomCode };
    if (bc) { try { bc.postMessage(pkt); } catch (_) {} }
    peerConns.forEach(c => {
      if (c.open && (c.memberId === memberId || c.isHostLink)) { try { c.send(pkt); } catch (_) {} }
    });
  }

  function selfMember() {
    return {
      id: state.localId,
      name: profile.name,
      avatarId: profile.avatarId,
      photoDataUrl: profile.photoDataUrl,
      isHost: state.isHost
    };
  }

  function sanitizeMember(m, senderId) {
    if (!m || typeof m !== 'object') return null;
    return {
      id: senderId,
      name: cleanName(m.name),
      avatarId: isAvatarId(m.avatarId) ? m.avatarId : 'coffee',
      photoDataUrl: safePhoto(m.photoDataUrl),
      isHost: !!m.isHost
    };
  }

  function broadcastProfileToRoom() {
    state.roomMembers[state.localId] = selfMember();
    refreshRoomRosterUI();
    sendRoomPacket({ type: 'MEMBER_HELLO', member: state.roomMembers[state.localId] });
    if (state.isHost) broadcastRoster();
  }

  function broadcastRoster() {
    if (!state.isHost) return;
    sendRoomPacket({ type: 'ROSTER', members: Object.values(state.roomMembers) });
  }

  function buildSyncFor(memberId) {
    return {
      type: 'PIFE_SYNC',
      seq: ++syncSeq,
      matchId: state.matchId,
      inMatch: state.inMatch,
      aborted: false,
      gameMode: state.gameMode,
      scoringMode: state.scoringMode,
      longMelds: state.longMelds,
      handNumber: state.handNumber,
      stockCount: state.stock.length,
      discardTop: state.discardPile.slice(-2),
      turnIndex: state.turnIndex,
      turnStep: state.turnStep,
      lockedDiscardUid: state.lockedDiscardUid,
      roundEnd: state.roundEnd,
      // Cada convidado só recebe a PRÓPRIA mão; dos outros vai apenas a contagem.
      players: state.players.map(p => ({
        id: p.id,
        name: p.name,
        avatarId: p.avatarId,
        isBot: p.isBot,
        team: p.team,
        penaltyScore: p.penaltyScore,
        handCount: p.hand.length,
        hand: p.id === memberId ? p.hand : null
      }))
    };
  }

  function remoteHumanIds() {
    return Object.keys(state.roomMembers).filter(id => id !== state.localId);
  }

  function syncMatchToPeers() {
    if (!state.isHost || !state.matchId) return;
    remoteHumanIds().forEach(id => sendTo(id, buildSyncFor(id)));
  }

  function sendAbortToPeers() {
    if (!state.isHost || !state.matchId) return;
    remoteHumanIds().forEach(id => sendTo(id, { type: 'PIFE_SYNC', seq: ++syncSeq, matchId: state.matchId, aborted: true }));
  }

  function clearJoinTimer() {
    clearTimeout(joinTimer);
    joinTimer = null;
  }

  function initRoom(code, joining = false) {
    clearJoinTimer();
    if (bc) { try { bc.close(); } catch (_) {} bc = null; }
    destroyPeer();

    state.roomCode = sanitizeCode(code) || makeCode();
    state.isHost = !joining;
    state.hostId = joining ? null : state.localId;
    state.roomMembers = {};
    state.lastSyncSeq = 0;

    try {
      if (joining) sessionStorage.setItem(SESSION_ROOM_KEY, state.roomCode);
      else sessionStorage.removeItem(SESSION_ROOM_KEY);
    } catch (_) {}

    $('room-code-display').textContent = state.roomCode;
    if (!$('room-qr-box').classList.contains('hidden')) renderRoomQR();

    if ('BroadcastChannel' in window) {
      try {
        bc = new BroadcastChannel('pife_varanda_' + state.roomCode);
        bc.onmessage = (e) => onRoomPacket(e.data, null);
      } catch (_) {}
    }

    broadcastProfileToRoom();
    refreshLobbyRoleUI();

    if (joining) {
      ensurePeer();
      // Sem resposta do dono em 15s: volta a ser dono da própria mesa.
      joinTimer = setTimeout(() => {
        if (!state.isHost && !state.hostId) {
          showToast(`❌ Não encontramos a mesa ${state.roomCode}. Criamos uma mesa nova para você.`);
          initRoom(makeCode(), false);
        }
      }, 15000);
    } else if (state.activeTab === 'room') {
      ensurePeer();
    }
  }

  function leaveGuestRoom() {
    if (state.isHost) return;
    sendRoomPacket({ type: 'MEMBER_BYE' });
    if (isGameScreenVisible()) showLobbyScreen();
    state.players = [];
    state.inMatch = false;
    initRoom(makeCode(), false);
    showToast('🚪 Você saiu da mesa. Agora você é dono da sua.');
  }

  function convertSeatToBot(playerId) {
    const p = state.players.find(x => x.id === playerId);
    if (!p || p.isBot) return;
    p.isBot = true;
    if (!/\(Bot\)$/.test(p.name)) p.name = `${p.name} (Bot)`;
    showToast(`🤖 ${p.name.replace(' (Bot)', '')} saiu — um bot assume o lugar.`);
    renderGameUI();
    syncMatchToPeers();
    scheduleBotIfNeeded();
  }

  function handleMemberLeft(memberId) {
    if (!state.roomMembers[memberId] || memberId === state.localId) return;
    const name = state.roomMembers[memberId].name;
    delete state.roomMembers[memberId];
    refreshRoomRosterUI();

    if (state.isHost) {
      broadcastRoster();
      if (state.inMatch) convertSeatToBot(memberId);
      else showToast(`👋 ${name} saiu da mesa.`);
    } else if (memberId === state.hostId) {
      showToast('🔌 O dono da mesa saiu. Criamos uma mesa nova para você.');
      if (isGameScreenVisible()) showLobbyScreen();
      state.players = [];
      state.inMatch = false;
      initRoom(makeCode(), false);
    }
  }

  function onRoomPacket(msg, conn) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || typeof msg.senderId !== 'string') return;
    if (msg.senderId === state.localId || msg.room !== state.roomCode) return;
    if (msg.to && msg.to !== state.localId) return;
    if (!ID_RE.test(msg.senderId)) return;

    // Amarra cada conexão P2P a um remetente (impede pacotes forjados).
    if (conn) {
      if (state.isHost) {
        if (!conn.memberId) {
          if (msg.type !== 'MEMBER_HELLO') return;
          conn.memberId = msg.senderId;
        }
        if (msg.senderId !== conn.memberId) return;
      } else {
        if (!state.hostId) state.hostId = msg.senderId;
        if (msg.senderId !== state.hostId) return;
      }
    }

    const fromHost = !state.isHost && msg.senderId === state.hostId;

    switch (msg.type) {
      case 'MEMBER_HELLO': {
        const m = sanitizeMember(msg.member, msg.senderId);
        if (!m) return;
        if (state.isHost) {
          m.isHost = false;
        } else if (m.isHost) {
          if (!state.hostId) state.hostId = m.id;
          if (m.id !== state.hostId) m.isHost = false;
        }
        const isNew = !state.roomMembers[m.id];
        state.roomMembers[m.id] = m;
        if (!state.isHost && m.id === state.hostId && joinTimer) {
          clearJoinTimer();
          showToast(`✅ Conectado à mesa ${state.roomCode}!`);
        }
        refreshRoomRosterUI();
        refreshLobbyRoleUI();
        if (isNew) {
          if (m.id !== state.hostId) showToast(`👋 ${m.name} sentou na mesa!`);
          sendTo(m.id, { type: 'MEMBER_HELLO', member: selfMember() });
        }
        if (state.isHost) broadcastRoster();
        if (state.inMatch) renderGameUI();
        break;
      }
      case 'ROSTER': {
        if (!fromHost || !Array.isArray(msg.members)) return;
        const next = {};
        msg.members.slice(0, 12).forEach(raw => {
          if (!raw || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return;
          const m = sanitizeMember(raw, raw.id);
          if (m) {
            m.isHost = raw.id === state.hostId;
            next[m.id] = m;
          }
        });
        next[state.localId] = selfMember();
        state.roomMembers = next;
        refreshRoomRosterUI();
        break;
      }
      case 'MEMBER_BYE':
        handleMemberLeft(msg.senderId);
        break;
      case 'CLIENT_MOVE': {
        if (!state.isHost) return;
        if (msg.move === 'draw' && (msg.source === 'stock' || msg.source === 'discard')) {
          drawCardAction(msg.senderId, msg.source);
        } else if (msg.move === 'discard' && Number.isInteger(msg.cardUid)) {
          if (!discardCardAction(msg.senderId, msg.cardUid)) syncMatchToPeers(); // desfaz remoção otimista do convidado
        } else if (msg.move === 'leave') {
          convertSeatToBot(msg.senderId);
        }
        break;
      }
      case 'PIFE_SYNC':
        if (fromHost) applySync(msg);
        break;
      default:
        break;
    }
  }

  function sanitizeRemotePlayer(p) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string') return null;
    return {
      id: p.id,
      name: cleanName(p.name),
      avatarId: isAvatarId(p.avatarId) ? p.avatarId : 'coffee',
      isBot: !!p.isBot,
      team: p.team === 'A' || p.team === 'B' ? p.team : null,
      penaltyScore: Number(p.penaltyScore) || 0,
      handCount: Number(p.handCount) || 0,
      hand: Array.isArray(p.hand) ? p.hand.map(sanitizeCard).filter(Boolean).slice(0, 12) : null
    };
  }

  function sanitizeRoundEnd(re) {
    if (!re || typeof re !== 'object' || typeof re.key !== 'string') return null;
    return {
      key: re.key,
      handNumber: Number(re.handNumber) || 1,
      gameMode: ['solo', 'duo', 'team'].includes(re.gameMode) ? re.gameMode : 'solo',
      winnerId: String(re.winnerId || ''),
      winnerName: cleanName(re.winnerName),
      winnerTeam: re.winnerTeam === 'A' || re.winnerTeam === 'B' ? re.winnerTeam : null,
      melds: Array.isArray(re.melds) ? re.melds.slice(0, 5).map(m => ({
        type: ['TRINCA', 'QUADRA', 'SEQ'].includes(m && m.type) ? m.type : '?',
        cards: Array.isArray(m && m.cards) ? m.cards.slice(0, 13) : []
      })) : [],
      rows: Array.isArray(re.rows) ? re.rows.slice(0, 8).map(r => ({
        id: String((r && r.id) || ''),
        name: cleanName(r && r.name),
        team: r && (r.team === 'A' || r.team === 'B') ? r.team : null,
        last: Number(r && r.last) || 0,
        total: Number(r && r.total) || 0
      })) : [],
      matchOver: !!re.matchOver,
      championIds: Array.isArray(re.championIds) ? re.championIds.map(String) : [],
      championText: typeof re.championText === 'string' ? re.championText.slice(0, 80) : ''
    };
  }

  function mergeGuestHand(prevHand, newHand) {
    if (!prevHand) return { hand: newHand.slice(), added: [] };
    const newMap = new Map(newHand.map(c => [c.uid, c]));
    const out = [];
    prevHand.forEach(c => {
      if (newMap.has(c.uid)) {
        out.push(newMap.get(c.uid));
        newMap.delete(c.uid);
      }
    });
    const added = [...newMap.values()];
    return { hand: out.concat(added), added };
  }

  function applySync(msg) {
    if (typeof msg.seq !== 'number') return;
    if (msg.matchId === state.matchId && msg.seq <= state.lastSyncSeq) return;

    if (msg.aborted) {
      if (msg.matchId === state.matchId) {
        state.lastSyncSeq = msg.seq;
        state.inMatch = false;
        if (isGameScreenVisible()) {
          showToast('🚪 O dono da mesa encerrou a partida.');
          showLobbyScreen();
        }
      }
      return;
    }
    if (state.ignoreMatchId && msg.matchId === state.ignoreMatchId) return;

    const players = Array.isArray(msg.players) ? msg.players.slice(0, 8).map(sanitizeRemotePlayer).filter(Boolean) : [];
    const meRemote = players.find(p => p.id === state.localId);
    if (!meRemote || !meRemote.hand) {
      if (msg.inMatch && state.spectatorToastFor !== msg.matchId) {
        state.spectatorToastFor = msg.matchId;
        showToast('🃏 Partida em andamento — você entra na próxima.');
      }
      return;
    }

    const handNumber = Number(msg.handNumber) || 1;
    const sameHand = msg.matchId === state.matchId && handNumber === state.handNumber;
    const prevMe = sameHand ? getLocalPlayer() : null;
    const { hand, added } = mergeGuestHand(prevMe && prevMe.hand ? prevMe.hand : null, meRemote.hand);
    meRemote.hand = hand;
    players.forEach(p => { if (p.id !== state.localId) p.hand = null; });

    const longMelds = !!msg.longMelds;
    if (longMelds !== state.longMelds) meldCache.clear();

    state.matchId = msg.matchId;
    state.lastSyncSeq = msg.seq;
    state.gameMode = ['solo', 'duo', 'team'].includes(msg.gameMode) ? msg.gameMode : 'solo';
    state.scoringMode = msg.scoringMode === 'single' ? 'single' : 'points';
    state.longMelds = longMelds;
    state.handNumber = handNumber;
    state.remoteStockCount = Number(msg.stockCount) || 0;
    state.discardPile = Array.isArray(msg.discardTop) ? msg.discardTop.map(sanitizeCard).filter(Boolean) : [];
    state.players = players;
    state.turnIndex = Math.max(0, Math.min(players.length - 1, Number(msg.turnIndex) || 0));
    state.turnStep = ['draw', 'discard', 'ended'].includes(msg.turnStep) ? msg.turnStep : 'draw';
    state.lockedDiscardUid = Number.isInteger(msg.lockedDiscardUid) ? msg.lockedDiscardUid : null;
    state.inMatch = !!msg.inMatch;

    if (!prevMe) {
      state.stackedMelds = [];
      state.selectedCardUid = null;
      state.lastDrawnUid = null;
      sortPlayerHand(meRemote, state.sortMode);
      if (state.autoStackMelds) autoGroupValidMelds(meRemote.hand, true);
    } else if (added.length === 1 && isMyTurn() && state.turnStep === 'discard') {
      state.lastDrawnUid = added[0].uid;
      sfx.drawCard();
      if (state.autoStackMelds) autoGroupValidMelds(meRemote.hand, true);
    }
    if (!meRemote.hand.some(c => c.uid === state.selectedCardUid)) state.selectedCardUid = null;
    if (!meRemote.hand.some(c => c.uid === state.lastDrawnUid)) state.lastDrawnUid = null;

    showGameScreen();
    renderGameUI();

    const re = sanitizeRoundEnd(msg.roundEnd);
    if (re) {
      state.roundEnd = re;
      handleRoundEnd(re);
    } else {
      state.roundEnd = null;
      $('modal-round-end').classList.add('hidden');
    }
  }

  function refreshRoomRosterUI() {
    const members = Object.values(state.roomMembers);
    const countEl = $('room-members-count');
    const listEl = $('room-members-list');
    if (countEl) countEl.textContent = `${members.length} sentado${members.length > 1 ? 's' : ''}`;
    if (!listEl) return;

    listEl.innerHTML = members.map(m => {
      const isHost = m.id === state.hostId;
      const you = m.id === state.localId ? ' (você)' : '';
      return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:5px 8px; border-radius:10px; background:var(--row-bg);">
          <div style="display:flex; align-items:center; gap:8px; min-width:0;">
            <div class="avatar-ring" style="width:28px; height:28px; font-size:14px; border-width:1.5px;">
              ${renderAvatarHTML(m.avatarId, m.photoDataUrl)}
            </div>
            <span style="font-size:12px; font-weight:900; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(m.name)}${you}</span>
          </div>
          <span style="font-size:10px; font-weight:900; white-space:nowrap; color:${isHost ? 'var(--accent-gold)' : 'var(--accent-win)'};">${isHost ? '👑 Dono da Mesa' : 'Pronto'}</span>
        </div>
      `;
    }).join('');
  }

  function refreshLobbyRoleUI() {
    const btn = $('btn-start-match');
    const lbl = $('start-match-label');
    if (state.isHost) {
      btn.disabled = false;
      lbl.textContent = 'DAR AS CARTAS (9 CARTAS)';
    } else {
      btn.disabled = true;
      lbl.textContent = '⏳ AGUARDANDO O DONO DA MESA';
    }
    $('btn-room-leave').classList.toggle('hidden', state.isHost);
    $('room-role-line').textContent = state.isHost
      ? '👑 Você é o dono desta mesa. Convide pelo link ou QR Code.'
      : (state.hostId
        ? `✅ Conectado à mesa ${state.roomCode}. O dono da mesa dá as cartas.`
        : `🔌 Conectando à mesa ${state.roomCode}…`);
  }

  /* -------------------------------------------------------------------------
     14. CADASTRO / EDIÇÃO DE PERFIL (CÂMERA, GALERIA, ÍCONES)
     ------------------------------------------------------------------------- */
  const draft = { name: '', avatarId: 'coffee', photo: null };
  let camStream = null;
  let camFacing = 'user';

  function buildAvatarPicker() {
    $('avatar-picker-grid').innerHTML = AVATARS.map(av => `
      <button type="button" data-avatar="${av.id}" class="soft-box choice-btn avatar-choice" aria-label="Ícone ${av.label}">
        <div style="font-size:24px; line-height:1;">${av.emoji}</div>
        <div style="font-size:9px; font-weight:900; margin-top:4px;">${av.label}</div>
      </button>
    `).join('');
  }

  function refreshDraftUI() {
    $('profile-draft-ring').innerHTML = renderAvatarHTML(draft.avatarId, draft.photo);
    $('btn-photo-remove').classList.toggle('hidden', !draft.photo);
    document.querySelectorAll('[data-avatar]').forEach(btn => {
      btn.classList.toggle('is-active', !draft.photo && btn.dataset.avatar === draft.avatarId);
    });
  }

  function openProfileModal(firstRun = false) {
    draft.name = profile.name;
    draft.avatarId = profile.avatarId;
    draft.photo = profile.photoDataUrl;
    $('input-draft-name').value = draft.name === 'Jogador' ? '' : draft.name;
    $('profile-form-error').textContent = '';
    $('profile-modal-title').textContent = firstRun ? 'Bem-vindo à Varanda! ☕' : 'Editar Perfil';
    $('profile-modal-sub').textContent = firstRun
      ? 'Crie seu perfil para sentar à mesa. Fica salvo só neste aparelho.'
      : 'Mude seu nome, foto ou ícone.';
    $('btn-profile-save').textContent = firstRun ? 'Sentar à Mesa ➜' : 'Salvar Perfil';
    $('btn-close-profile').classList.toggle('hidden', firstRun);
    $('camera-fallback-label').classList.add('hidden');
    refreshDraftUI();
    $('modal-profile').classList.remove('hidden');
    if (!firstRun) return;
    setTimeout(() => $('input-draft-name').focus(), 50);
  }

  function closeProfileModal() {
    stopCamera();
    $('modal-profile').classList.add('hidden');
  }

  function saveDraftProfile() {
    const name = $('input-draft-name').value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
    if (name.length < 2) {
      $('profile-form-error').textContent = 'Digite seu nome (mínimo 2 letras).';
      $('input-draft-name').focus();
      return;
    }
    profile.name = cleanName(name);
    profile.avatarId = draft.avatarId;
    profile.photoDataUrl = safePhoto(draft.photo);
    const firstRun = !profile.registered;
    profile.registered = true;
    saveProfile();
    closeProfileModal();
    if (state.inMatch) renderGameUI();
    showToast(firstRun ? `☕ Bem-vindo, ${profile.name}! Escolha a mesa e dê as cartas.` : '✅ Perfil salvo!');
  }

  function stopCamera() {
    if (camStream) {
      camStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    }
    camStream = null;
    const v = $('camera-video');
    if (v) v.srcObject = null;
    $('camera-box').classList.add('hidden');
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Sem getUserMedia (ex.: HTTP sem TLS): usa a câmera nativa via input capture.
      $('input-photo-capture').click();
      return;
    }
    stopCamera();
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: camFacing, width: { ideal: 640 }, height: { ideal: 640 } },
        audio: false
      });
      const v = $('camera-video');
      v.srcObject = camStream;
      v.style.transform = camFacing === 'user' ? 'scaleX(-1)' : '';
      $('camera-box').classList.remove('hidden');
      await v.play().catch(() => {});
    } catch (err) {
      stopCamera();
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showToast(denied ? '📷 Permissão da câmera negada.' : '📷 Câmera indisponível.');
      $('camera-fallback-label').classList.remove('hidden');
    }
  }

  function capturePhoto() {
    const v = $('camera-video');
    if (!camStream || !v.videoWidth) {
      showToast('Aguarde a câmera abrir…');
      return;
    }
    const photo = drawSquarePhoto(v, v.videoWidth, v.videoHeight, camFacing === 'user');
    stopCamera();
    if (photo) {
      draft.photo = photo;
      refreshDraftUI();
      sfx.stackMeld();
    } else {
      showToast('Não foi possível capturar a foto.');
    }
  }

  async function onPhotoFileChosen(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const compressed = await compressImageFile(file);
    if (compressed) {
      draft.photo = compressed;
      refreshDraftUI();
    } else {
      showToast('⚠️ Não foi possível ler essa imagem.');
    }
  }

  /* -------------------------------------------------------------------------
     15. LOBBY, NAVEGAÇÃO & DELEGAÇÃO DE EVENTOS
     ------------------------------------------------------------------------- */
  function switchTab(tabKey) {
    state.activeTab = tabKey;
    document.querySelectorAll('[data-tab]').forEach(btn => {
      const active = btn.dataset.tab === tabKey;
      btn.style.background = active ? 'var(--accent-primary)' : 'transparent';
      btn.style.color = active ? 'var(--accent-primary-txt)' : 'var(--text-main)';
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    ['play', 'profile', 'room'].forEach(k => {
      const panel = $(`panel-${k}`);
      if (panel) panel.classList.toggle('hidden', k !== tabKey);
    });

    if (tabKey === 'room') ensurePeer();
  }

  function refreshProfileUI() {
    const ringHtml = renderAvatarHTML(profile.avatarId, profile.photoDataUrl);
    $('lobby-avatar-ring').innerHTML = ringHtml;
    $('profile-preview-ring').innerHTML = ringHtml;
    $('lobby-player-name').textContent = profile.name;
    $('profile-preview-name').textContent = profile.name;
    $('lobby-wins-badge').textContent = `🏆 ${profile.wins} batida${profile.wins === 1 ? '' : 's'}`;
    $('profile-stats-row').innerHTML = `
      <span>🏆 ${profile.wins} batidas</span>
      <span>🥇 ${profile.matchesWon} partidas vencidas</span>
      <span>🃏 ${profile.games} mãos</span>
    `;
  }

  function refreshMatchSettingsUI() {
    const modeTxt = state.gameMode === 'duo'
      ? '🤝 Em Dupla (2v2)'
      : (state.gameMode === 'team' ? '🛡️ Em Equipe (3v3)' : `👤 Solo (${state.soloCount}P)`);
    const ruleTxt = state.scoringMode === 'single' ? 'Batida Única' : 'Estouro 100 pts';
    const diffTxt = state.botDiff === 'easy' ? 'Fácil' : (state.botDiff === 'hard' ? 'Mestre' : 'Médio');
    $('lobby-match-summary').textContent = `${modeTxt} · ${ruleTxt} · Bots ${diffTxt}${state.longMelds ? ' · Jogos longos' : ''}`;

    $('solo-count-box').classList.toggle('hidden', state.gameMode !== 'solo');

    const mark = (sel, isActive) => document.querySelectorAll(sel).forEach(b => {
      b.style.borderColor = isActive(b) ? 'var(--accent-primary)' : 'rgba(120,90,60,0.28)';
    });
    mark('[data-mode]', b => b.dataset.mode === state.gameMode);
    mark('[data-count]', b => Number(b.dataset.count) === state.soloCount);
    mark('[data-scoring]', b => b.dataset.scoring === state.scoringMode);
    mark('[data-diff]', b => b.dataset.diff === state.botDiff);

    const autoBtn = $('btn-toggle-autostack');
    autoBtn.textContent = state.autoStackMelds ? 'ATIVO' : 'MANUAL';
    autoBtn.style.opacity = state.autoStackMelds ? '1' : '0.68';

    const longBtn = $('btn-toggle-longmelds');
    longBtn.textContent = state.longMelds ? 'LONGOS' : 'CLÁSSICO';
    longBtn.style.opacity = state.longMelds ? '1' : '0.68';
  }

  let toastTimer = null;
  function showToast(text) {
    const slot = $('toast-slot');
    if (!slot) return;
    clearTimeout(toastTimer);
    slot.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'toast-pill paper-card';
    div.textContent = text;
    slot.appendChild(div);
    toastTimer = setTimeout(() => { if (div.parentNode) div.remove(); }, 2700);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.setAttribute('readonly', '');
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      document.body.appendChild(tmp);
      tmp.select();
      const ok = document.execCommand('copy');
      tmp.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  function leaveMatchToLobby() {
    clearTimeout(botTimeout);
    if (state.isHost) {
      if (state.inMatch) sendAbortToPeers();
      state.inMatch = false;
    } else {
      // Convidado: avisa o dono (vira bot) e ignora esta partida.
      if (state.matchId && state.inMatch) sendRoomPacket({ type: 'CLIENT_MOVE', move: 'leave' });
      state.ignoreMatchId = state.matchId;
      state.inMatch = false;
    }
    showLobbyScreen();
  }

  $('input-photo-gallery').addEventListener('change', onPhotoFileChosen);
  $('input-photo-capture').addEventListener('change', onPhotoFileChosen);
  $('input-draft-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveDraftProfile(); }
  });
  $('input-room-join').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('btn-room-join').click(); }
  });

  $('pile-stock-btn').addEventListener('click', () => performLocalDraw('stock'));
  $('pile-discard-btn').addEventListener('click', onDiscardPileTap);

  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;

    if (btn.dataset.tab) { sfx.init(); switchTab(btn.dataset.tab); return; }
    if (btn.dataset.mode) { sfx.init(); state.gameMode = btn.dataset.mode; refreshMatchSettingsUI(); return; }
    if (btn.dataset.count) { sfx.init(); state.soloCount = Number(btn.dataset.count); refreshMatchSettingsUI(); return; }
    if (btn.dataset.scoring) { sfx.init(); state.scoringMode = btn.dataset.scoring; refreshMatchSettingsUI(); return; }
    if (btn.dataset.diff) { sfx.init(); state.botDiff = btn.dataset.diff; refreshMatchSettingsUI(); return; }
    if (btn.dataset.setTheme) {
      sfx.init();
      applyTheme(btn.dataset.setTheme);
      saveProfile();
      showToast(`Tema: ${THEMES.find(t => t.id === btn.dataset.setTheme).label}`);
      return;
    }
    if (btn.dataset.avatar) {
      sfx.init();
      draft.avatarId = btn.dataset.avatar;
      draft.photo = null;
      refreshDraftUI();
      return;
    }

    switch (btn.id) {
      case 'btn-cycle-theme':
      case 'btn-game-theme': {
        sfx.init();
        const idx = THEMES.findIndex(t => t.id === profile.theme);
        const next = THEMES[(idx + 1) % THEMES.length];
        applyTheme(next.id);
        saveProfile();
        showToast(`Tema: ${next.label}`);
        break;
      }
      case 'btn-mute':
      case 'btn-game-mute': {
        sfx.enabled = !sfx.enabled;
        const icon = sfx.enabled ? '🔊' : '🔇';
        $('btn-mute').textContent = icon;
        $('btn-game-mute').textContent = icon;
        break;
      }
      case 'btn-help':
      case 'btn-game-help':
        $('modal-rules').classList.remove('hidden');
        break;
      case 'btn-close-rules':
      case 'btn-ok-rules':
        $('modal-rules').classList.add('hidden');
        break;
      case 'btn-edit-profile-shortcut':
      case 'btn-open-profile':
        openProfileModal(false);
        break;
      case 'btn-close-profile':
        closeProfileModal();
        break;
      case 'btn-profile-save':
        saveDraftProfile();
        break;
      case 'btn-photo-camera':
        sfx.init();
        startCamera();
        break;
      case 'btn-camera-shot':
        capturePhoto();
        break;
      case 'btn-camera-flip':
        camFacing = camFacing === 'user' ? 'environment' : 'user';
        startCamera();
        break;
      case 'btn-camera-cancel':
        stopCamera();
        break;
      case 'btn-photo-remove':
        draft.photo = null;
        refreshDraftUI();
        break;
      case 'btn-toggle-autostack':
        state.autoStackMelds = !state.autoStackMelds;
        refreshMatchSettingsUI();
        break;
      case 'btn-toggle-longmelds':
        state.longMelds = !state.longMelds;
        meldCache.clear();
        refreshMatchSettingsUI();
        showToast(state.longMelds ? '🧩 Jogos longos: sequências 4+ e quadras valem.' : '🃏 Clássico: só jogos de 3 cartas.');
        break;
      case 'btn-toggle-qr': {
        const box = $('room-qr-box');
        box.classList.toggle('hidden');
        if (!box.classList.contains('hidden')) {
          ensurePeer();
          renderRoomQR();
        }
        break;
      }
      case 'btn-share-link': {
        ensurePeer();
        const url = inviteURL();
        if (navigator.share) {
          navigator.share({ title: 'Pife de Varanda', text: `Senta na minha mesa de Pife! Código ${state.roomCode}`, url }).catch(() => {});
        } else {
          copyText(url).then(ok => {
            const lbl = $('share-link-lbl');
            lbl.textContent = ok ? 'Copiado!' : 'Copie o link';
            if (!ok) {
              $('room-qr-box').classList.remove('hidden');
              renderRoomQR();
            }
            setTimeout(() => { lbl.textContent = '🔗 Convidar'; }, 1800);
          });
        }
        break;
      }
      case 'btn-room-join': {
        const inp = $('input-room-join');
        const c = sanitizeCode(inp.value);
        if (c.length < 4) {
          showToast('Digite o código de 4 letras da mesa.');
          break;
        }
        if (c === state.roomCode) {
          showToast(state.isHost ? 'Esse é o código da sua própria mesa.' : 'Você já está nessa mesa.');
          break;
        }
        if (!state.isHost) sendRoomPacket({ type: 'MEMBER_BYE' });
        initRoom(c, true);
        inp.value = '';
        break;
      }
      case 'btn-room-leave':
        leaveGuestRoom();
        break;
      case 'btn-start-match':
        startMatch();
        break;
      case 'btn-move-left':
        moveSelectedCardByStep(-1);
        break;
      case 'btn-move-right':
        moveSelectedCardByStep(1);
        break;
      case 'btn-stack-melds': {
        const me = getLocalPlayer();
        if (me && me.hand) {
          const before = state.stackedMelds.length;
          autoGroupValidMelds(me.hand, false);
          showToast(state.stackedMelds.length === before
            ? 'Nenhum jogo novo pronto encontrado.'
            : `📚 ${state.stackedMelds.length} jogo(s) empilhado(s)!`);
          renderGameUI();
        }
        break;
      }
      case 'btn-expand-all':
        state.stackedMelds = [];
        sfx.slideCard();
        renderGameUI();
        break;
      case 'btn-sort-hand': {
        const me = getLocalPlayer();
        if (me && me.hand) {
          state.sortMode = state.sortMode === 'suit' ? 'rank' : 'suit';
          sortPlayerHand(me, state.sortMode);
          sfx.slideCard();
          showToast(state.sortMode === 'suit' ? '🪄 Ordenado por naipe' : '🪄 Ordenado por valor');
          renderGameUI();
        }
        break;
      }
      case 'btn-discard-selected':
        performLocalDiscard(state.selectedCardUid);
        break;
      case 'btn-bater': {
        const me = getLocalPlayer();
        if (me && me.hand) {
          const winUid = findWinningDiscardUid(me.hand, true);
          if (winUid !== null) performLocalDiscard(winUid);
        }
        break;
      }
      case 'btn-next-hand':
        if (!state.isHost) break;
        $('modal-round-end').classList.add('hidden');
        if (btn.dataset.restart === '1') startMatch();
        else dealNewHand(false);
        break;
      case 'btn-game-exit':
      case 'btn-end-lobby':
        leaveMatchToLobby();
        break;
      default:
        break;
    }
  });

  window.addEventListener('pagehide', () => {
    try { sendRoomPacket({ type: 'MEMBER_BYE' }); } catch (_) {}
    stopCamera();
  });

  /* -------------------------------------------------------------------------
     16. INICIALIZAÇÃO
     ------------------------------------------------------------------------- */
  setupHandPointerInteractions();
  setupKeyboard();
  applyTheme(profile.theme);
  buildAvatarPicker();
  refreshProfileUI();
  refreshMatchSettingsUI();
  switchTab('play');

  // Convite via ?room=XXXX: entra como convidado e limpa a URL
  // (assim recarregar a página do dono nunca o transforma em convidado).
  let joinCode = null;
  try {
    const u = new URL(window.location.href);
    const r = u.searchParams.get('room');
    if (r) {
      joinCode = r;
      u.searchParams.delete('room');
      window.history.replaceState({}, '', u.toString());
    }
  } catch (_) {}
  if (!joinCode) {
    try { joinCode = sessionStorage.getItem(SESSION_ROOM_KEY); } catch (_) {}
  }
  joinCode = sanitizeCode(joinCode);

  if (joinCode.length >= 4) {
    initRoom(joinCode, true);
    switchTab('room');
  } else {
    initRoom(makeCode(), false);
  }

  if (!profile.registered) openProfileModal(true);
})();
