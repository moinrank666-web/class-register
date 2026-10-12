/* ---------------------------------------------------------------------------
   Academic Ledger — hidden easter egg.
   Type  t e t r i s  anywhere in the app to play.
   Deliberately not linked from the menu, the command palette or :help, so it
   never shows up unless someone already knows the word. Nothing here touches
   the register's data or the API.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  const COLS = 10, ROWS = 20;
  const SEED = [
    [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]], // I
    [[1, 1], [1, 1]],                                         // O
    [[0, 1, 0], [1, 1, 1], [0, 0, 0]],                        // T
    [[0, 1, 1], [1, 1, 0], [0, 0, 0]],                        // S
    [[1, 1, 0], [0, 1, 1], [0, 0, 0]],                        // Z
    [[1, 0, 0], [1, 1, 1], [0, 0, 0]],                        // J
    [[0, 0, 1], [1, 1, 1], [0, 0, 0]],                        // L
  ];
  const KEYS = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  const HUE = { I: '#3DD9E0', O: '#FFC94A', T: '#B079FF', S: '#3DD68C', Z: '#FF5C7A', J: '#5B8DEF', L: '#FF9A5B' };
  const HI_KEY = 'cr_tetris_hi';

  let root = null, cv = null, ctx = null, nx = null, nctx = null, hx = null, hctx = null;
  let cell = 26, pad = 0;
  let board, cur, next, hold, canHold;
  let score = 0, lines = 0, level = 1, best = 0;
  let over = false, paused = false, running = false;
  let raf = 0, last = 0, acc = 0;
  let bag = [];

  /* ------------------------------- helpers ------------------------------ */
  const rot = m => m[0].map((_, c) => m.map(r => r[c]).reverse());

  function readBest() {
    try { return Number(localStorage.getItem(HI_KEY)) || 0; } catch (_) { return 0; }
  }
  function writeBest(v) {
    try { localStorage.setItem(HI_KEY, String(v)); } catch (_) { /* private mode */ }
  }
  function shuffle() {
    bag = KEYS.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }
  }
  function draw() {
    if (!bag.length) shuffle();
    const k = bag.pop();
    return { k, m: SEED[KEYS.indexOf(k)].map(r => r.slice()) };
  }
  const gravity = () => Math.max(70, 800 - (level - 1) * 68);

  /* -------------------------------- rules ------------------------------- */
  function collide(m, x, y) {
    for (let r = 0; r < m.length; r++) {
      for (let c = 0; c < m[r].length; c++) {
        if (!m[r][c]) continue;
        const bx = x + c, by = y + r;
        if (bx < 0 || bx >= COLS || by >= ROWS) return true;
        if (by >= 0 && board[by][bx]) return true;
      }
    }
    return false;
  }
  function spawn() {
    const p = next || draw();
    next = draw();
    cur = { k: p.k, m: p.m, x: Math.floor((COLS - p.m[0].length) / 2), y: p.k === 'I' ? -1 : 0 };
    canHold = true;
    if (collide(cur.m, cur.x, cur.y)) { gameOver(); return false; }
    return true;
  }
  function lock() {
    cur.m.forEach((row, r) => row.forEach((v, c) => {
      if (v && cur.y + r >= 0) board[cur.y + r][cur.x + c] = cur.k;
    }));
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r].every(Boolean)) {
        board.splice(r, 1);
        board.unshift(new Array(COLS).fill(null));
        cleared++; r++;
      }
    }
    if (cleared) {
      score += [0, 100, 300, 500, 800][cleared] * level;
      lines += cleared;
      const nl = 1 + Math.floor(lines / 10);
      if (nl !== level) { level = nl; }
    }
    spawn();
  }
  function move(dx) {
    if (over || paused) return;
    if (!collide(cur.m, cur.x + dx, cur.y)) { cur.x += dx; paint(); }
  }
  function rotate() {
    if (over || paused) return;
    const m = rot(cur.m);
    for (const k of [0, -1, 1, -2, 2]) {
      if (!collide(m, cur.x + k, cur.y)) { cur.m = m; cur.x += k; paint(); return; }
    }
  }
  function soft() {
    if (over || paused) return;
    if (!collide(cur.m, cur.x, cur.y + 1)) { cur.y++; score += 1; paint(); }
    else { lock(); paint(); }
  }
  function hard() {
    if (over || paused) return;
    let d = 0;
    while (!collide(cur.m, cur.x, cur.y + 1)) { cur.y++; d++; }
    score += d * 2;
    lock();
    paint();
  }
  function swap() {
    if (over || paused || !canHold) return;
    const h = hold;
    hold = { k: cur.k, m: SEED[KEYS.indexOf(cur.k)].map(r => r.slice()) };
    if (h) {
      cur = { k: h.k, m: h.m, x: Math.floor((COLS - h.m[0].length) / 2), y: 0 };
      if (collide(cur.m, cur.x, cur.y)) gameOver();
    } else if (!spawn()) {
      /* spawn() already ended the game */
    }
    canHold = false;
    paint();
  }
  function gameOver() {
    over = true; running = false;
    cancelAnimationFrame(raf);
    if (score > best) { best = score; writeBest(best); }
    paint();
    const plate = root && root.querySelector('#tt-plate');
    if (plate) {
      plate.hidden = false;
      const fin = plate.querySelector('#tt-final');
      const pb = plate.querySelector('#tt-best-2');
      if (fin) fin.textContent = score.toLocaleString();
      if (pb) pb.textContent = best.toLocaleString();
    }
  }
  function reset() {
    board = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
    bag = []; next = null; hold = null; canHold = true;
    score = 0; lines = 0; level = 1; over = false; paused = false; acc = 0;
    const plate = root && root.querySelector('#tt-plate');
    if (plate) plate.hidden = true;
    if (!spawn()) return;
    start();
    paint();
  }

  /* ------------------------------ rendering ----------------------------- */
  function fit() {
    const maxW = Math.min(window.innerWidth - 96, 320);
    const maxH = window.innerHeight - 210;
    cell = Math.max(12, Math.floor(Math.min(maxW / COLS, maxH / ROWS)));
    const dpr = window.devicePixelRatio || 1;
    [cv, nx, hx].forEach(c => {
      if (!c) return;
      const w = Number(c.dataset.w) * cell, h = Number(c.dataset.h) * cell;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + 'px'; c.style.height = h + 'px';
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
  }
  function block(g, x, y, color, alpha, size) {
    const s = (size || cell) - 2;
    g.globalAlpha = alpha === undefined ? 1 : alpha;
    g.fillStyle = color;
    if (g.roundRect) { g.beginPath(); g.roundRect(x + 1, y + 1, s, s, Math.max(2, cell * 0.16)); g.fill(); }
    else g.fillRect(x + 1, y + 1, s, s);
    g.globalAlpha = 1;
  }
  function grid() {
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.lineWidth = 1;
    for (let c = 1; c < COLS; c++) { ctx.beginPath(); ctx.moveTo(c * cell, 0); ctx.lineTo(c * cell, ROWS * cell); ctx.stroke(); }
    for (let r = 1; r < ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * cell); ctx.lineTo(COLS * cell, r * cell); ctx.stroke(); }
  }
  function paint() {
    if (!ctx) return;
    ctx.clearRect(0, 0, COLS * cell, ROWS * cell);
    ctx.fillStyle = '#12102A';
    ctx.fillRect(0, 0, COLS * cell, ROWS * cell);
    grid();
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (board[r][c]) block(ctx, c * cell, r * cell, HUE[board[r][c]]);
    if (cur && !over) {
      for (let r = 0; r < cur.m.length; r++)
        for (let c = 0; c < cur.m[r].length; c++) {
          if (!cur.m[r][c]) continue;
          let gy = cur.y + r;
          const gx = cur.x + c;
          while (!collide(cur.m, cur.x, gy + 1) && gy + 1 < ROWS) gy++;
          if (gy !== cur.y + r) block(ctx, gx * cell, gy * cell, HUE[cur.k], 0.16);
        }
      for (let r = 0; r < cur.m.length; r++)
        for (let c = 0; c < cur.m[r].length; c++)
          if (cur.m[r][c] && cur.y + r >= 0) block(ctx, (cur.x + c) * cell, (cur.y + r) * cell, HUE[cur.k]);
    }
    mini(nctx, next, 4, 4, nx);
    mini(hctx, hold, 4, 2, hx);
    const s = root && root.querySelector('#tt-score');
    if (s) s.textContent = score.toLocaleString();
    ['level', 'lines', 'best'].forEach(k => {
      const el = root && root.querySelector('#tt-' + k);
      if (el) el.textContent = String(k === 'best' ? Math.max(best, score) : k === 'level' ? level : lines);
    });
  }
  function mini(g, piece, w, h, canvas) {
    if (!g || !canvas) return;
    g.clearRect(0, 0, w * cell, h * cell);
    if (!piece) return;
    const m = piece.m, size = w * cell;
    const bw = m[0].length, bh = m.length;
    const off = Math.max(0, (size - bw * 14) / 2);
    m.forEach((row, r) => row.forEach((v, c) => {
      if (v) block(g, off + c * 14, 6 + r * 14, HUE[piece.k], 1, 14);
    }));
  }

  /* -------------------------------- loop -------------------------------- */
  function start() {
    if (running) return;
    running = true; last = 0;
    raf = requestAnimationFrame(function tick(t) {
      if (!running) return;
      if (!last) last = t;
      const dt = t - last; last = t;
      if (!over && !paused && document.visibilityState !== 'hidden') {
        acc += dt;
        while (acc >= gravity()) {
          acc -= gravity();
          if (!collide(cur.m, cur.x, cur.y + 1)) cur.y++;
          else { lock(); }
          if (over) break;
        }
        paint();
      }
      raf = requestAnimationFrame(tick);
    });
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  /* --------------------------------- UI --------------------------------- */
  function key(k, label) {
    return '<button type="button" class="tt-key" data-k="' + k + '" aria-label="' + label + '">' + label + '</button>';
  }
  function build() {
    root = document.createElement('div');
    root.id = 'tetris-root';
    root.innerHTML =
      '<div class="tt-back" id="tt-back">' +
        '<div class="tt" role="dialog" aria-modal="true" aria-label="Tetris">' +
          '<div class="tt-head">' +
            '<span class="tt-title">TETRIS</span>' +
            '<div class="tt-stats">' +
              '<div><b id="tt-score">0</b><i>score</i></div>' +
              '<div><b id="tt-level">1</b><i>level</i></div>' +
              '<div><b id="tt-lines">0</b><i>lines</i></div>' +
              '<div><b id="tt-best">0</b><i>best</i></div>' +
            '</div>' +
            '<button class="tt-x" id="tt-x" aria-label="Close game">✕</button>' +
          '</div>' +
          '<div class="tt-play">' +
            '<div class="tt-side">' +
              '<span class="tt-lbl">next</span><canvas id="tt-next" data-w="4" data-h="4" width="104" height="104"></canvas>' +
              '<span class="tt-lbl">hold</span><canvas id="tt-hold" data-w="4" data-h="2" width="104" height="52"></canvas>' +
            '</div>' +
            '<div class="tt-board-wrap">' +
              '<canvas id="tt-board" data-w="10" data-h="20" width="260" height="520"></canvas>' +
              '<div class="tt-plate" id="tt-plate" hidden>' +
                '<b>GAME OVER</b>' +
                '<span>score <em id="tt-final">0</em></span>' +
                '<span>best <em id="tt-best-2">0</em></span>' +
                '<button type="button" class="tt-again" id="tt-again">Play again ⏎</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="tt-pad">' +
            key('left', '◀') + key('rot', '⟳') + key('right', '▶') +
            key('soft', '◀◀') + key('hard', '⤓') + key('hold', '⇄') +
          '</div>' +
          '<div class="tt-foot">← → move · ↑ rotate · ↓ soft drop · space hard drop · C hold · P pause · Esc quit</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    cv = root.querySelector('#tt-board'); ctx = cv.getContext('2d');
    nx = root.querySelector('#tt-next'); nctx = nx.getContext('2d');
    hx = root.querySelector('#tt-hold'); hctx = hx.getContext('2d');

    root.querySelector('#tt-x').onclick = close;
    root.querySelector('#tt-again').onclick = reset;
    root.querySelector('#tt-back').addEventListener('click', e => { if (e.target.id === 'tt-back') close(); });
    const tap = e => {
      const b = e.target.closest('.tt-key'); if (!b) return;
      e.preventDefault();
      act(b.dataset.k);
    };
    root.querySelectorAll('.tt-key').forEach(b => {
      let repeat = 0;
      const down = e => {
        e.preventDefault(); act(b.dataset.k);
        const k = b.dataset.k;
        if (k === 'left' || k === 'right' || k === 'soft') {
          repeat = setTimeout(function again() { act(k); repeat = setTimeout(again, 90); }, 260);
        }
      };
      const up = () => { clearTimeout(repeat); };
      b.addEventListener('touchstart', down, { passive: false });
      b.addEventListener('touchend', up);
      b.addEventListener('mousedown', down);
      b.addEventListener('mouseup', up);
      b.addEventListener('mouseleave', up);
    });
    window.addEventListener('resize', () => { if (root) { fit(); paint(); } });
    document.addEventListener('visibilitychange', () => {
      if (root && document.visibilityState === 'hidden') togglePause(true);
    });
  }
  function act(k) {
    if (k === 'left') move(-1);
    else if (k === 'right') move(1);
    else if (k === 'rot') rotate();
    else if (k === 'soft') soft();
    else if (k === 'hard') hard();
    else if (k === 'hold') swap();
  }
  function togglePause(force) {
    if (over) return;
    paused = force === true ? true : !paused;
    const t = root && root.querySelector('.tt-title');
    if (t) t.textContent = paused ? 'PAUSED' : 'TETRIS';
    paint();
  }

  function open() {
    if (root) { root.querySelector('.tt-back').focus?.(); return; }
    build();
    best = readBest();
    const b2 = root.querySelector('#tt-best-2');
    if (b2) b2.textContent = best.toLocaleString();
    fit();
    reset();
  }
  function close() {
    stop();
    if (root) { root.remove(); root = null; }
    cv = ctx = nx = nctx = hx = hctx = null;
    cur = null;
  }

  /* One document listener, registered before app.js is parsed, so it can
     swallow the keys it owns while the game is up. */
  let buf = '';
  document.addEventListener('keydown', function (e) {
    if (root) {
      const k = e.key;
      if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      if (k === 'p' || k === 'P') { e.preventDefault(); e.stopImmediatePropagation(); togglePause(); return; }
      if (k === 'c' || k === 'C') { e.preventDefault(); e.stopImmediatePropagation(); swap(); return; }
      if (k === 'r' || k === 'R') { e.preventDefault(); e.stopImmediatePropagation(); reset(); return; }
      if (over && (k === 'Enter' || k === ' ')) { e.preventDefault(); e.stopImmediatePropagation(); reset(); return; }
      if (k === 'ArrowLeft')  { e.preventDefault(); e.stopImmediatePropagation(); move(-1); return; }
      if (k === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); move(1); return; }
      if (k === 'ArrowDown')  { e.preventDefault(); e.stopImmediatePropagation(); soft(); return; }
      if (k === 'ArrowUp' || k === 'x' || k === 'X') { e.preventDefault(); e.stopImmediatePropagation(); rotate(); return; }
      if (k === ' ' || k === 'Spacebar') { e.preventDefault(); e.stopImmediatePropagation(); hard(); return; }
      if (k.length === 1 || k === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    /* secret word — only from a naked body-wide typing streak */
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (typeof e.key !== 'string' || e.key.length !== 1) return;
    buf = (buf + e.key.toLowerCase()).slice(-16);
    if (buf.endsWith('tetris')) { buf = ''; open(); }
  });

  window.openTetris = open;
  window.closeTetris = close;
})();
