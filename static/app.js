/* Academic Ledger — front-end (vanilla JS, no build step) */
(() => {
'use strict';

/* ------------------------------ helpers ------------------------------ */
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const monthNames = () => (window.MONTHS[getLang()] || window.MONTHS.en);
const pad = n => String(n).padStart(2, '0');
const todayISO  = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const thisMonth = () => todayISO().slice(0, 7);
const monthLabel = m => {
  const [y, mm] = String(m).split('-'); const i = Number(mm) - 1;
  return `${monthNames()[i] || window.MONTHS.en[i] || ''} ${y}`;
};
const AVATAR = ['#7C5CFC','#FF6B9D','#2EC4B6','#F2A93B','#FF8A5B','#5B8DEF','#A78BFA','#1FA598','#E13A5B'];
const avColor = key => AVATAR[String(key).split('').reduce((a,c)=>a + c.charCodeAt(0), 0) % AVATAR.length];
const initials = name => String(name || '?').trim().split(/\s+/).slice(0,2).map(w => w[0].toUpperCase()).join('');
const fmt = v => (v === null || v === undefined || v === '') ? '—' : (Math.round(v*10)/10).toString().replace(/\.0$/, '');
const pctText = v => (v === null || v === undefined) ? '—' : `${fmt(v)}%`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* Server errors arrive in English — map them (and rate-limit countdowns) to the active language. */
function trErr(msg) {
  const m = /Try again in (\d+) seconds/.exec(String(msg || ''));
  if (m) return T('Too many attempts. Try again in {n} seconds.', { n: m[1] });
  return T(msg || '');
}

const App = {
  token: sessionStorage.getItem('cr_token') || null,
  role:  sessionStorage.getItem('cr_role')  || null,
  view: 'students',
  animateStats: false,
  clock: null,
  filters: {
    students:   { q: '', grade: '', sort: 'grade', sortDir: 1 },
    attendance: { date: todayISO(), grade: '', month: thisMonth() },
    scores:     { month: thisMonth(), grade: '', testId: null },
    report:     { month: thisMonth(), grade: '' },
  },
};

/* ------------------------------ api ------------------------------ */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(App.token ? { Authorization: 'Bearer ' + App.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  if (res.status === 401) { await signOut(); throw new Error(data.error ? trErr(data.error) : T('api.401')); }
  if (!res.ok) throw new Error(data.error ? trErr(data.error) : T('api.fail', { status: res.status }));
  return data;
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<i class="toast-bar"></i><span>${kind === 'err' ? '⚠️' : '✅'}</span><span>${esc(msg)}</span>`;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(30px)'; el.style.transition = '.3s'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}
const warn = m => toast(m, 'err');

function openModal({ title, body = '', footer = '', wide = false }) {
  $('#modal-root').innerHTML = `
    <div class="modal-back" id="modal-back">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${title}</h3><button class="x-btn" id="modal-x" aria-label="${T('modal.close')}">✕</button></div>
        <div class="modal-body" id="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  $('#modal-x').onclick = closeModal;
  $('#modal-back').addEventListener('click', e => { if (e.target.id === 'modal-back') closeModal(); });
  document.addEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() { $('#modal-root').innerHTML = ''; document.removeEventListener('keydown', escClose); }

/* ------------------------------ auth ------------------------------ */
async function signOut() {
  closePalette(); closeMenu();
  const t = App.token;
  App.token = null; App.role = null;
  sessionStorage.removeItem('cr_token');
  sessionStorage.removeItem('cr_role');
  if (t) { try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }); } catch (_) {} }
  renderLogin();
}

/* Language toggle — re-renders whatever screen is showing, in the new language. */
function bindLang() {
  const b = $('#btn-lang'); if (!b) return;
  b.onclick = openLangPicker;
}

/* language picker — 10 languages in one modal (works on auth screens too) */
function openLangPicker() {
  const cur = getLang();
  openModal({
    title: T('lang.pick'),
    body: `<div class="lang-grid">${(window.LANGS || []).map(([code, native, enName]) => `
      <button type="button" class="lang-opt${code === cur ? ' on' : ''}" data-l="${code}">
        <span class="lo-native">${esc(native)}</span>
        <span class="lo-en">${esc(enName)}</span>
        ${code === cur ? '<span class="lo-check">✓</span>' : ''}
      </button>`).join('')}</div>`,
  });
  $('#modal-body').addEventListener('click', e => {
    const b = e.target.closest('button[data-l]'); if (!b) return;
    const code = b.dataset.l;
    closeModal();
    if (code === cur) return;
    setLang(code);
    toast('🌐 ' + code.toUpperCase());
    if ($('#nav')) renderShell();
    else if ($('#setup-form')) renderSetup();
    else if ($('#login-form')) renderLogin();
  });
}

function authShell(inner) {
  $('#app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-side">
          <div class="brand-mini" style="margin:0">
            <div class="m">📚</div>
            <div><b style="color:#fff">Academic Ledger</b><span style="color:rgba(255,255,255,.85)">${T('brand.sub')}</span></div>
          </div>
          <h1>${T('hero.h1')}</h1>
          <p>${T('hero.p')}</p>
          <ul class="auth-points">
            <li>🗓️ <span>${T('hero.point1')}</span></li>
            <li>🔐 <span>${T('hero.point2')}</span></li>
            <li>📊 <span>${T('hero.point3')}</span></li>
          </ul>
          <button class="lang-pill on-dark" id="btn-lang">🌐 ${T('menu.lang')}</button>
        </div>
        <div class="auth-form">${inner}</div>
      </div>
    </div>`;
  bindLang();
}

function renderSetup() {
  authShell(`
    <div class="brand-mini"><div class="m">✨</div><div><b>${T('setup.brand')}</b><span>${T('setup.brand.sub')}</span></div></div>
    <div class="notice">${T('setup.notice')}</div>
    <div id="auth-err"></div>
    <form id="setup-form" novalidate>
      <div class="field"><label>${T('setup.admin.label')}</label>
        <input class="code-input" type="password" id="admin-code" autocomplete="new-password" placeholder="••••" minlength="4" required>
        <span class="hint">${T('setup.admin.hint')}</span></div>
      <div class="field"><label>${T('setup.admin2')}</label>
        <input class="code-input" type="password" id="admin-code2" autocomplete="new-password" placeholder="••••" required></div>
      <div class="field"><label>${T('setup.teacher.label')}</label>
        <input class="code-input" type="password" id="teacher-code" autocomplete="new-password" placeholder="••••" minlength="4" required>
        <span class="hint">${T('setup.teacher.hint')}</span></div>
      <div class="field"><label>${T('setup.teacher2')}</label>
        <input class="code-input" type="password" id="teacher-code2" autocomplete="new-password" placeholder="••••" required></div>
      <div class="field"><label>${T('setup.observer.label')}</label>
        <input class="code-input" type="password" id="observer-code" autocomplete="new-password" placeholder="••••" minlength="4">
        <span class="hint">${T('setup.observer.hint')}</span></div>
      <button class="btn btn-primary" style="width:100%;justify-content:center" type="submit">${T('setup.submit')}</button>
    </form>`);
  $('#setup-form').addEventListener('submit', async e => {
    e.preventDefault();
    const a  = $('#admin-code').value.trim(), a2 = $('#admin-code2').value.trim();
    const t  = $('#teacher-code').value.trim(), t2 = $('#teacher-code2').value.trim();
    const ob = $('#observer-code').value.trim();
    const box = $('#auth-err');
    box.innerHTML = '';
    const err = m => { box.innerHTML = `<div class="alert">${esc(m)}</div>`; };
    if (a.length < 4 || t.length < 4) return err(T('setup.err.len'));
    if (a !== a2) return err(T('setup.err.aMismatch'));
    if (t !== t2) return err(T('setup.err.tMismatch'));
    if (a === t)  return err(T('setup.err.same'));
    if (ob && ob.length < 4) return err(T('setup.err.len'));
    if (ob && (ob === a || ob === t)) return err(T('All codes must be different.'));
    try {
      const r = await api('/api/setup', { method: 'POST',
        body: { admin_code: a, teacher_code: t, ...(ob ? { observer_code: ob } : {}) } });
      App.token = r.token; App.role = r.role;
      sessionStorage.setItem('cr_token', r.token);
      sessionStorage.setItem('cr_role', r.role);
      toast(T('toast.created'));
      renderShell();
    } catch (ex) { err(ex.message); }
  });
}

function renderLogin(message = '') {
  authShell(`
    <div class="brand-mini"><div class="m">🔐</div><div><b>${T('login.brand')}</b><span>${T('login.brand.sub')}</span></div></div>
    <div id="auth-err">${message ? `<div class="alert">${esc(message)}</div>` : ''}</div>
    <div class="role-tabs" id="role-tabs">
      <button type="button" data-role="admin" class="on">${T('role.admin.tab')}</button>
      <button type="button" data-role="teacher">${T('role.teacher.tab')}</button>
      <button type="button" data-role="observer">${T('role.observer.tab')}</button>
    </div>
    <form id="login-form" novalidate>
      <div class="field"><label id="code-label">${T('login.label.admin')}</label>
        <input class="code-input" type="password" id="login-code" autocomplete="current-password" placeholder="••••" required>
        <span class="hint" id="code-hint">${T('login.hint.admin')}</span></div>
      <button class="btn btn-primary" style="width:100%;justify-content:center" type="submit">${T('login.submit')}</button>
    </form>
    <p class="muted" style="font-size:12.6px;margin-top:18px;text-align:center">
      ${T('login.lost')}
    </p>`);
  let role = 'admin';
  $('#role-tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-role]'); if (!b) return;
    role = b.dataset.role;
    $$('#role-tabs button').forEach(x => x.classList.toggle('on', x === b));
    $('#code-label').textContent = T('login.label.' + role);
    $('#code-hint').textContent  = T('login.hint.' + role);
    $('#login-code').focus();
  });
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('#login-code').value;
    $('#auth-err').innerHTML = '';
    try {
      const r = await api('/api/login', { method: 'POST', body: { role, code } });
      App.token = r.token; App.role = r.role;
      sessionStorage.setItem('cr_token', r.token);
      sessionStorage.setItem('cr_role', r.role);
      toast(T('toast.signedin', { role: T('role.' + r.role + '.name') }));
      renderShell();
    } catch (ex) {
      $('#auth-err').innerHTML = `<div class="alert">${esc(ex.message)}</div>`;
      $('#login-code').value = '';
      $('#login-code').focus();
    }
  });
  setTimeout(() => $('#login-code').focus(), 60);
}

/* ------------------------------ shell ------------------------------ */
const NAV = [
  { id: 'students',   key: 'nav.students',   icon: '🎓' },
  { id: 'attendance', key: 'nav.attendance', icon: '🗓️' },
  { id: 'scores',     key: 'nav.scores',     icon: '📝' },
  { id: 'report',     key: 'nav.reports',    icon: '📊' },
  { id: 'activity',   key: 'nav.activity',   icon: '🕓' },
];

function renderShell() {
  $('#app').innerHTML = `
    <header class="hero">
      <div class="hero-inner">
        <div class="brand">
          <div class="brand-mark">📚</div>
          <div>
            <div class="brand-name">Academic Ledger</div>
            <div class="brand-sub">${T('brand.sub')}</div>
          </div>
        </div>
        <div class="hero-actions">
          <span class="role-chip">${T('role.' + (App.role || 'teacher') + '.chip')}</span>
          <div class="menu-anchor">
            <button class="hero-btn menu-btn" id="btn-menu" aria-haspopup="menu" aria-expanded="false">${T('menu.open')}</button>
            <div class="menu-pop" id="menu-pop" role="menu" hidden>${menuHtml()}</div>
          </div>
        </div>
      </div>
    </header>
    <div class="nav-wrap">
      <nav class="nav" id="nav">
        <button class="cmd-pill" id="btn-pal" title="${esc(T('pal.placeholder'))}"><span class="cp-ic">⌕</span><span class="cp-tx">${T('pal.open')}</span><kbd>${PAL_KEYS}</kbd></button>
        ${NAV.filter(n => n.id !== 'activity' || App.role === 'admin')
          .map(n => `<button data-view="${n.id}"><span>${n.icon}</span>${T(n.key)}</button>`).join('')}
      </nav>
    </div>
    <main class="page" id="view"><div class="boot"><div class="boot-logo">⏳</div></div></main>
    <footer class="app-foot no-print">
      <span class="foot-brand">📚 Academic Ledger <em>v2026.10</em></span>
      <span class="foot-clock" id="foot-clock">🕐 --:--:--</span>
      <span class="foot-status"><i></i>${T('foot.ok')}</span>
    </footer>`;

  $('#btn-menu').onclick = e => { e.stopPropagation(); toggleMenu(); };
  $('#btn-pal').onclick = openPalette;
  $('#menu-pop').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    closeMenu(); runAction(b.dataset.a);
  });
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]'); if (b) navigate(b.dataset.view);
  });
  startClock();
  // never resume into the admin-only Activity tab as another role
  const start = (App.view === 'activity' && App.role !== 'admin') ? 'students' : (App.view || 'students');
  navigate(start);
}

function navigate(view) {
  App.view = view;
  App.animateStats = true;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const v = $('#view');
  v.innerHTML = `
    <div class="sk sk-title"></div>
    <div class="grid grid-3" style="margin-bottom:18px"><div class="sk sk-card"></div><div class="sk sk-card"></div><div class="sk sk-card"></div></div>
    <div class="sk sk-panel"></div>`;
  v.classList.add('view-enter');
  setTimeout(() => v.classList.remove('view-enter'), 700);
  ({ students: renderStudents, attendance: renderAttendance, scores: renderScores,
     report: renderReport, activity: renderActivity }[view])();
}

const stat = (cls, label, num, note, icon = '') => `
  <div class="stat ${cls}"><div class="stat-top">${icon ? `<span class="stat-ic">${icon}</span>` : ''}<span class="stat-label">${label}</span></div>
  <div class="stat-num">${num}</div>${note ? `<div class="stat-note">${note}</div>` : ''}</div>`;

/* count-up: animate stat numbers once per view entry (skipped under reduced-motion) */
function animateStats() {
  if (!App.animateStats) return;
  App.animateStats = false;
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch (_) {}
  $$('#view .stat-num').forEach(el => {
    const final = el.textContent.trim();
    const m = /^(\d+(?:\.\d+)?)(.*)$/.exec(final);
    if (!m) return;
    const target = parseFloat(m[1]);
    if (!isFinite(target) || target === 0) return;
    const suffix = m[2];
    const decs = (m[1].split('.')[1] || '').length;
    const t0 = performance.now(), dur = 750;
    const tick = now => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (target * eased).toFixed(decs) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = final;
    };
    requestAnimationFrame(tick);
  });
}

/* live clock in the app footer (re-render safe — one interval total) */
function startClock() {
  if (App.clock) clearInterval(App.clock);
  const tick = () => {
    const el = $('#foot-clock'); if (!el) return;
    const d = new Date();
    let s;
    try { s = d.toLocaleTimeString(getLang() || 'en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (_) { s = d.toLocaleTimeString(); }
    el.textContent = `🕐 ${s}`;
  };
  tick();
  App.clock = setInterval(tick, 1000);
}

function gradeOptions(grades, sel) {
  return `<option value="">${T('options.all')}</option>` +
    grades.map(g => `<option value="${esc(g)}" ${g === sel ? 'selected' : ''}>${esc(g)}</option>`).join('');
}

async function openCodeModal() {
  openModal({
    title: T('codes.title'),
    body: `
      <div class="notice">${T('codes.notice')}</div>
      <div id="code-err"></div>
      <div class="field"><label>${T('codes.newAdmin')}</label><input class="code-input" type="password" id="new-admin" placeholder="${T('codes.keep')}"></div>
      <div class="field"><label>${T('codes.newTeacher')}</label><input class="code-input" type="password" id="new-teacher" placeholder="${T('codes.keep')}"></div>
      <div class="field"><label>${T('codes.newObserver')}</label><input class="code-input" type="password" id="new-observer" placeholder="${T('codes.keep')}"></div>`,
    footer: `<button class="btn btn-ghost" id="m-cancel">${T('btn.cancel')}</button>
             <button class="btn btn-primary" id="save-codes">${T('codes.save')}</button>`,
  });
  $('#m-cancel').onclick = closeModal;
  $('#save-codes').onclick = async () => {
    const body = { admin_code: $('#new-admin').value.trim(), teacher_code: $('#new-teacher').value.trim(),
                   observer_code: $('#new-observer').value.trim() };
    if (!body.admin_code && !body.teacher_code && !body.observer_code) return $('#code-err').innerHTML = `<div class="alert">${T('codes.err.one')}</div>`;
    try {
      await api('/api/codes', { method: 'POST', body });
      closeModal(); toast(T('toast.codes'));
    } catch (ex) { $('#code-err').innerHTML = `<div class="alert">${esc(ex.message)}</div>`; }
  };
}

/* ------------------------------ students ------------------------------ */
async function renderStudents() {
  const f = App.filters.students;
  let data;
  try { data = await api(`/api/students?q=${encodeURIComponent(f.q)}&grade=${encodeURIComponent(f.grade)}`); }
  catch (ex) { warn(ex.message); return; }
  const { students, grades } = data;
  const isAdmin = App.role === 'admin';
  const canAdd = isAdmin || App.role === 'teacher';
  const newThisMonth = students.filter(s => (s.created_at || '').startsWith(thisMonth())).length;

  // client-side roster sort — headers or the hidden :sort command
  const dir = f.sortDir === -1 ? -1 : 1;
  const gnum = g => Number(String(g).replace(/\D/g, '')) || 0;
  const keyf = {
    name:  s => String(s.name || '').toLowerCase(),
    grade: s => gnum(s.grade) * 100000 + (Number(s.roll3) || 0),
    roll:  s => String(s.roll3 || ''),
    added: s => String(s.created_at || ''),
  };
  const kf = keyf[f.sort] || keyf.grade;
  students.sort((a, b) => (kf(a) < kf(b) ? -1 : kf(a) > kf(b) ? 1 : 0) * dir ||
    String(a.name).localeCompare(String(b.name)));

  $('#view').innerHTML = `
    <div class="section-head">
      <div><span class="eyebrow">${T('nav.students')}</span><h2>${T('stu.title')}</h2><p>${T('stu.sub')}</p></div>
    </div>

    <div class="grid grid-3" style="margin-bottom:18px">
      ${stat('v', T('stat.students'), students.length, T('stat.inRegister'), '🎓')}
      ${stat('p', T('stat.grades'), grades.length, T('stat.classes'), '🏷️')}
      ${stat('m', T('stat.addedMonth'), newThisMonth, monthLabel(thisMonth()), '✨')}
    </div>

    <div class="card">
      <div class="toolbar no-print">
        <div class="search-wrap">
          <input class="input" id="f-q" placeholder="${T('stu.search')}" value="${esc(f.q)}" autocomplete="off">
          <div class="cmd-peek" id="cmd-peek" hidden></div>
        </div>
        <select class="input" id="f-grade">${gradeOptions(grades, f.grade)}</select>
        <span class="hint-chip">${T('cmd.hint')}</span>
        <div class="spacer"></div>
        <span class="muted" style="font-size:13px">${T('stu.shown', { n: students.length })}</span>
      </div>
      <div class="table-wrap">
        <table>              <thead><tr><th data-sort="grade" class="${f.sort === 'grade' ? 'on' : ''}" style="width:90px">${T('th.grade')}<i>${sortIc('grade', f)}</i></th><th data-sort="roll" class="${f.sort === 'roll' ? 'on' : ''}" style="width:120px">${T('th.roll')}<i>${sortIc('roll', f)}</i></th><th data-sort="name" class="${f.sort === 'name' ? 'on' : ''}">${T('th.name')}<i>${sortIc('name', f)}</i></th><th data-sort="added" class="no-print${f.sort === 'added' ? ' on' : ''}" style="width:170px">${T('th.added')}<i>${sortIc('added', f)}</i></th><th class="no-print" style="width:170px"></th></tr></thead>
          <tbody id="stu-body">
            ${students.length ? students.map(s => `
              <tr class="clickable" data-id="${s.id}">
                <td><span class="grade-pill">${esc(s.grade)}</span></td>
                <td><span class="roll">${esc(s.grade)}-${esc(s.roll3)}</span></td>
                <td class="name-cell"><span class="t-av" style="background:${avColor(s.id)}">${esc(initials(s.name))}</span>${esc(s.name)}</td>
                <td class="muted">${esc((s.created_at || '').slice(0, 10))}</td>
                <td class="no-print row-act" style="text-align:right;white-space:nowrap">
                  <button class="btn btn-sm btn-ghost" data-act="view">${T('btn.view')}</button>
                  ${isAdmin ? `<button class="btn btn-sm btn-danger" data-act="del">${T('btn.remove')}</button>` : ''}
                </td>
              </tr>`).join('') : ''}
          </tbody>
        </table>
        ${students.length ? '' : `<div class="empty"><span class="emoji">🎒</span><b>${T('stu.empty')}</b>${canAdd ? T('stu.emptyUse') : T('stu.emptyAsk')}</div>`}
      </div>
    </div>`;

  animateStats();
  const search = debounce(v => { f.q = v; renderStudents(); }, 220);
  const qEl = $('#f-q');
  qEl.addEventListener('input', e => {
    const v = e.target.value.trim();
    if (v.startsWith(':')) showPeek(v); else { hidePeek(); search(v); }
  });
  qEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = e.target.value.trim();
      if (v.startsWith(':')) {
        if (runCommand(v)) { e.target.value = ''; hidePeek(); }
      } else { f.q = v; renderStudents(); }
    } else if (e.key === 'Escape') { hidePeek(); e.target.value = f.q; }
  });
  const peek = $('#cmd-peek');
  peek.addEventListener('click', e => {
    const b = e.target.closest('button[data-cmd]'); if (!b) return;
    const v = b.dataset.cmd; const el = $('#f-q');
    if (NO_ARG.has(v)) { if (runCommand(v)) { el.value = ''; hidePeek(); } }
    else { el.value = v + ' '; el.focus(); showPeek(v); }
  });
  $$('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (f.sort === k) f.sortDir = f.sortDir === -1 ? 1 : -1;
    else { f.sort = k; f.sortDir = 1; }
    renderStudents();
  }));
  $('#f-grade').addEventListener('change', e => { f.grade = e.target.value; renderStudents(); });

  $('#stu-body').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (btn && btn.dataset.act === 'del') {
      const name = row.querySelector('.name-cell').textContent;
      openModal({
        title: T('modal.removeStu'),
        body: `<p style="margin:0;line-height:1.6">${T('modal.removeBody', { name: esc(name) })}</p>`,
        footer: `<button class="btn btn-ghost" id="m-cancel">${T('btn.cancel')}</button><button class="btn btn-danger" id="m-ok">${T('btn.remove')}</button>`,
      });
      $('#m-cancel').onclick = closeModal;
      $('#m-ok').onclick = async () => {
        try { await api(`/api/students?id=${id}`, { method: 'DELETE' }); closeModal(); toast(T('toast.stuRemoved')); renderStudents(); }
        catch (ex) { warn(ex.message); }
      };
      return;
    }
    openStudent(id);
  });
}

function openAddStudent() {
  openModal({
    title: T('add.title'),
    body: `
      <div id="add-err"></div>
      <div class="field"><label>${T('add.name')}</label><input id="s-name" placeholder="e.g. Ayesha Khan" autocomplete="off"></div>
      <div class="row">
        <div class="field"><label>${T('add.grade')}</label>
          <input id="s-grade" list="grade-list" placeholder="e.g. 5" autocomplete="off">
          <datalist id="grade-list">${['1','2','3','4','5','6','7','8','9','10','11','12'].map(g => `<option value="${g}">`).join('')}</datalist>
        </div>
        <div class="field"><label>${T('add.roll')}</label>
          <input id="s-roll" inputmode="numeric" maxlength="3" placeholder="042" autocomplete="off">
          <span class="hint">${T('add.rollHint')}</span>
        </div>
      </div>
      <div class="notice" id="roll-preview" style="margin-top:4px">${T('add.preview', { roll: '<b>—</b>' })}</div>`,
    footer: `<button class="btn btn-ghost" id="m-cancel">${T('btn.cancel')}</button><button class="btn btn-primary" id="m-save">${T('stu.add')}</button>`,
  });

  const roll = $('#s-roll'), grade = $('#s-grade');
  const preview = () => {
    const r = roll.value.replace(/\D/g, '').slice(0, 3);
    roll.value = r;
    $('#roll-preview').innerHTML = T('add.preview', { roll: `<b>${esc(grade.value.trim() || '—')}-${esc(r || '•••')}</b>` });
  };
  roll.addEventListener('input', preview);
  grade.addEventListener('input', preview);
  $('#s-name').focus();
  $('#m-cancel').onclick = closeModal;
  $('#m-save').onclick = async () => {
    const body = { name: $('#s-name').value, grade: grade.value, roll3: roll.value };
    $('#add-err').innerHTML = '';
    if (body.roll3.length !== 3) { $('#add-err').innerHTML = `<div class="alert">${T('add.err.roll')}</div>`; roll.focus(); return; }
    try {
      await api('/api/students', { method: 'POST', body });
      closeModal(); toast(T('toast.added', { name: body.name })); renderStudents();
    } catch (ex) { $('#add-err').innerHTML = `<div class="alert">${esc(ex.message)}</div>`; }
  };
}

/* ------------------------------ attendance ------------------------------ */
async function renderAttendance() {
  const f = App.filters.attendance;
  const isAdmin = App.role === 'admin';
  let day, month, grades;
  try {
    const [d, m, g] = await Promise.all([
      api(`/api/attendance/day?date=${f.date}&grade=${encodeURIComponent(f.grade)}`),
      api(`/api/attendance/month?month=${f.month}&grade=${encodeURIComponent(f.grade)}`),
      api('/api/students'),
    ]);
    day = d; month = m; grades = g.grades;
  } catch (ex) { warn(ex.message); return; }

  const pending = {};
  day.students.forEach(s => { pending[s.id] = s.status; });

  $('#view').innerHTML = `
    <div class="section-head">
      <div><span class="eyebrow">${T('nav.attendance')}</span><h2>${T('att.title')}</h2><p>${T('att.sub')} ${isAdmin ? '' : T('att.subTeacher')}</p></div>
    </div>

    <div class="card">
      <div class="card-title">
        <h3>${T('att.markFor')} <span id="day-label">${esc(f.date)}</span></h3>
        <div class="month-nav no-print">
          <input type="date" class="input" id="a-date" value="${esc(f.date)}">
          <select class="input" id="a-grade">${gradeOptions(grades, f.grade)}</select>
        </div>
      </div>
      ${isAdmin ? `
      <div class="toolbar no-print" style="margin-bottom:6px">
        <button class="btn btn-sm btn-mint" data-all="present">${T('att.allPresent')}</button>
        <button class="btn btn-sm btn-danger" data-all="absent">${T('att.allAbsent')}</button>
        <button class="btn btn-sm btn-ghost" data-all="clear">${T('att.clear')}</button>
        <div class="spacer"></div>
        <span class="muted" id="tally" style="font-size:13.2px"></span>
        <button class="btn btn-primary" id="btn-save-att">${T('att.save')}</button>
      </div>` : ''}
      <div id="mark-list">
        ${day.students.length ? day.students.map(s => markRow(s)).join('') : ''}
      </div>
      ${day.students.length ? '' : `<div class="empty"><span class="emoji">🏫</span><b>${T('att.empty')}</b>${T('att.emptyHint')}</div>`}
    </div>

    <div class="card">
      <div class="card-title">
        <h3>${T('att.summary')}</h3>
        <div class="month-nav no-print">
          <input type="month" class="input" id="a-month" value="${esc(f.month)}">
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>${T('th.grade')}</th><th>${T('th.roll')}</th><th>${T('th.student')}</th><th class="num">${T('th.present')}</th><th class="num">${T('th.absent')}</th><th class="num">${T('th.late')}</th><th style="width:170px">${T('th.attendance')}</th></tr></thead>
          <tbody id="sum-body">
            ${month.rows.map(r => `
              <tr class="clickable" data-id="${r.id}">
                <td><span class="grade-pill">${esc(r.grade)}</span></td>
                <td><span class="roll">${esc(r.grade)}-${esc(r.roll3)}</span></td>
                <td class="name-cell">${esc(r.name)}</td>
                <td class="num">${r.present}</td>
                <td class="num">${r.absent}</td>
                <td class="num">${r.late}</td>
                <td>${attBar(r)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${month.rows.length ? '' : `<div class="empty"><span class="emoji">📭</span><b>${T('att.empty2')}</b>${T('att.empty2Hint')}</div>`}
      </div>
      <div class="legend">
        <span>${T('att.legend1')}</span><span>${T('att.legend2')}</span><span>${T('att.legend3')}</span>
        <span>${T('att.legend4')}</span>
      </div>
    </div>`;

  const tally = () => {
    const c = { present: 0, absent: 0, late: 0, null: 0 };
    Object.values(pending).forEach(v => c[v === null ? 'null' : v]++);
    const el = $('#tally');
    if (el) el.textContent = T('att.tally', { p: c.present, a: c.absent, l: c.late, u: c.null });
  };
  const paintRow = sid => {
    $$(`#mark-list button[data-sid="${sid}"]`).forEach(b =>
      b.classList.toggle('on', b.dataset.v === (pending[sid] || '__none__')));
  };

  $('#a-date').addEventListener('change', e => { f.date = e.target.value || todayISO(); renderAttendance(); });
  $('#a-grade').addEventListener('change', e => { f.grade = e.target.value; renderAttendance(); });
  $('#a-month').addEventListener('change', e => { f.month = e.target.value || thisMonth(); renderAttendance(); });

  const list = $('#mark-list');
  if (list) list.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    const sid = b.dataset.sid;
    pending[sid] = pending[sid] === b.dataset.v ? null : b.dataset.v;
    paintRow(sid); tally();
  });

  if (isAdmin) {
    $$('[data-all]').forEach(btn => btn.addEventListener('click', () => {
      const mode = btn.dataset.all;
      day.students.forEach(s => { pending[s.id] = mode === 'clear' ? null : mode; });
      day.students.forEach(s => paintRow(s.id));
      tally();
    }));
    $('#btn-save-att').addEventListener('click', async () => {
      const entries = Object.entries(pending).map(([id, status]) => ({ student_id: Number(id), status }));
      try {
        await api('/api/attendance', { method: 'POST', body: { date: f.date, entries } });
        toast(T('toast.attSaved', { date: f.date }));
        renderAttendance();
      } catch (ex) { warn(ex.message); }
    });
  }
  tally();
  const sumBody = $('#sum-body');
  if (sumBody) sumBody.addEventListener('click', e => {
    const row = e.target.closest('tr[data-id]'); if (row) openStudent(Number(row.dataset.id));
  });
}

function markRow(s) {
  const btn = (v, label) =>
    `<button data-v="${v}" data-sid="${s.id}" class="${s.status === v ? 'on' : ''}">${label}</button>`;
  return `
    <div class="mark-row">
      <div class="mark-who">
        <div class="avatar" style="background:${avColor(s.id)}">${esc(initials(s.name))}</div>
        <div>
          <div class="mark-name">${esc(s.name)}</div>
          <div class="mark-sub">${T('mark.gradeRoll', { g: esc(s.grade), r: esc(s.roll3) })}</div>
        </div>
      </div>
      ${App.role === 'admin'
        ? `<div class="seg">${btn('present', T('mark.present'))}${btn('absent', T('mark.absent'))}${btn('late', T('mark.late'))}</div>`
        : `<span class="chip ${s.status === 'present' ? 'green' : s.status === 'absent' ? 'red' : s.status === 'late' ? 'amber' : 'grey'}">${s.status ? T('mark.' + s.status) : T('chip.notMarked')}</span>`}
    </div>`;
}

function attBar(r) {
  if (!r.marked) return `<span class="chip grey">${T('chip.notMarked')}</span>`;
  const good = r.percent >= 90;
  return `<div style="display:flex;align-items:center;gap:9px">
      <div class="bar"><i style="width:${Math.max(3, r.percent)}%"></i></div>
      <span class="chip ${good ? 'green' : r.percent >= 75 ? 'amber' : 'red'}">${pctText(r.percent)}</span>
    </div>`;
}

/* ------------------------------ test scores ------------------------------ */
async function renderScores() {
  const f = App.filters.scores;
  let tests, grades;
  try {
    const [t, g] = await Promise.all([
      api(`/api/tests?month=${f.month}`),
      api('/api/students'),
    ]);
    tests = t.tests; grades = g.grades;
  } catch (ex) { warn(ex.message); return; }

  if (f.testId && !tests.some(t => t.id === f.testId)) f.testId = null;

  $('#view').innerHTML = `
    <div class="section-head">
      <div><span class="eyebrow">${T('nav.scores')}</span><h2>${T('sc.title')}</h2><p>${T('sc.sub')}</p></div>
    </div>

    <div class="card">
      <div class="card-title">
        <h3>${T('sc.testsIn', { m: esc(monthLabel(f.month)) })}</h3>
        <div class="month-nav no-print">
          <input type="month" class="input" id="t-month" value="${esc(f.month)}">
          <select class="input" id="t-grade">${gradeOptions(grades, f.grade)}</select>
        </div>
      </div>
      <div class="grid grid-2" id="test-grid">
        ${tests.map(t => `
          <div class="test-card ${t.id === f.testId ? 'sel' : ''}" data-id="${t.id}">
            <div>
              <div class="test-name">${esc(t.name)}</div>
              <div class="test-meta">${t.test_date ? '📅 ' + esc(t.test_date) + ' · ' : ''}${T('sc.outOf')} <b>${fmt(t.max_score)}</b> · ${esc(monthLabel(t.month))}</div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm ${t.id === f.testId ? 'btn-primary' : 'btn-ghost'}" data-act="open">${t.id === f.testId ? T('sc.editing') : T('sc.enter')}</button>
              ${App.role === 'admin' ? '<button class="btn btn-sm btn-danger" data-act="del">✕</button>' : ''}
            </div>
          </div>`).join('')}
      </div>
      ${tests.length ? '' : `<div class="empty"><span class="emoji">📄</span><b>${T('sc.empty', { m: esc(monthLabel(f.month)) })}</b>${T('sc.emptyHint')}</div>`}
    </div>

    <div id="entry-slot"></div>`;

  $('#t-month').addEventListener('change', e => { f.month = e.target.value || thisMonth(); f.testId = null; renderScores(); });
  $('#t-grade').addEventListener('change', e => { f.grade = e.target.value; renderScores(); });
  $('#test-grid').addEventListener('click', async e => {
    const card = e.target.closest('.test-card'); if (!card) return;
    const id = Number(card.dataset.id);
    const btn = e.target.closest('button[data-act]');
    if (btn && btn.dataset.act === 'del') {
      openModal({
        title: T('del.title'),
        body: `<p style="margin:0;line-height:1.6">${T('del.body')}</p>`,
        footer: `<button class="btn btn-ghost" id="m-cancel">${T('btn.cancel')}</button><button class="btn btn-danger" id="m-ok">${T('del.btn')}</button>`,
      });
      $('#m-cancel').onclick = closeModal;
      $('#m-ok').onclick = async () => {
        try { await api(`/api/tests?id=${id}`, { method: 'DELETE' }); closeModal(); toast(T('toast.testDel')); f.testId = null; renderScores(); }
        catch (ex) { warn(ex.message); }
      };
      return;
    }
    f.testId = id;
    renderScores();
  });

  if (f.testId) await renderScoreEntry(f.testId);
}

function openNewTest() {
  const f = App.filters.scores;
  openModal({
    title: T('new.title'),
    body: `
      <div id="test-err"></div>
      <div class="field"><label>${T('new.name')}</label><input id="t-name" placeholder="e.g. Unit Test 1" autocomplete="off"></div>
      <div class="row">
        <div class="field"><label>${T('new.month')}</label><input type="month" id="t-m" value="${esc(f.month)}"></div>
        <div class="field"><label>${T('new.date')}</label><input type="date" id="t-d"></div>
        <div class="field"><label>${T('new.max')}</label><input id="t-max" inputmode="decimal" placeholder="25" value="25"></div>
      </div>`,
    footer: `<button class="btn btn-ghost" id="m-cancel">${T('btn.cancel')}</button><button class="btn btn-primary" id="m-save">${T('new.create')}</button>`,
  });
  $('#t-name').focus();
  $('#m-cancel').onclick = closeModal;
  $('#m-save').onclick = async () => {
    const body = { name: $('#t-name').value, month: $('#t-m').value, test_date: $('#t-d').value, max_score: $('#t-max').value };
    $('#test-err').innerHTML = '';
    try {
      const r = await api('/api/tests', { method: 'POST', body });
      closeModal(); toast(T('toast.testCreated'));
      f.month = body.month; f.testId = r.id;
      renderScores();
    } catch (ex) { $('#test-err').innerHTML = `<div class="alert">${esc(ex.message)}</div>`; }
  };
}

async function renderScoreEntry(testId) {
  const f = App.filters.scores;
  let data;
  try { data = await api(`/api/scores?test_id=${testId}&grade=${encodeURIComponent(f.grade)}`); }
  catch (ex) { warn(ex.message); return; }
  const { test, students } = data;
  const pending = {};
  students.forEach(s => { pending[s.id] = s.score === null || s.score === undefined ? '' : String(s.score); });

  $('#entry-slot').innerHTML = `
    <div class="card" id="entry-card">
      <div class="card-title">
        <div>
          <h3>${esc(test.name)} ${T('entry.title')}</h3>
          <p class="muted" style="margin:5px 0 0;font-size:13.4px">${T('entry.sub', { max: `<b>${fmt(test.max_score)}</b>`, m: esc(monthLabel(test.month)), n: students.length })}</p>
        </div>
        <div class="month-nav no-print">
          <span class="muted" id="entry-tally" style="font-size:13.2px"></span>
          ${App.role === 'observer' ? '' : `<button class="btn btn-primary" id="btn-save-scores">${T('entry.save')}</button>`}
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:90px">${T('th.grade')}</th><th style="width:120px">${T('th.roll')}</th><th>${T('th.student')}</th>
            <th class="num" style="width:120px">${T('th.score')}</th><th class="num" style="width:110px">%</th><th style="width:90px">${T('th.gradeLetter')}</th></tr></thead>
          <tbody id="score-body">
            ${students.map(s => `
              <tr data-id="${s.id}">
                <td><span class="grade-pill">${esc(s.grade)}</span></td>
                <td><span class="roll">${esc(s.grade)}-${esc(s.roll3)}</span></td>
                <td class="name-cell">${esc(s.name)}</td>
                <td class="num"><input class="input score-input" data-sid="${s.id}" inputmode="decimal" value="${esc(pending[s.id])}" placeholder="—"${App.role === 'observer' ? ' disabled' : ''}></td>
                <td class="num pct-cell">—</td>
                <td class="grade-cell"><span class="chip grey">—</span></td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${students.length ? '' : `<div class="empty"><span class="emoji">🙈</span><b>${T('entry.empty')}</b>${T('entry.emptyHint')}</div>`}
      </div>
      <div class="legend"><span>${T('entry.legend')}</span></div>
    </div>`;

  $('#entry-card').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const ceiling = Number(test.max_score);
  const recalc = () => {
    let filled = 0, sum = 0;
    $$('#score-body tr').forEach(tr => {
      const sid = tr.dataset.id;
      const raw = pending[sid];
      const cellPct = tr.querySelector('.pct-cell');
      const cellGrade = tr.querySelector('.grade-cell');
      const input = tr.querySelector('.score-input');
      input.classList.remove('ok', 'bad');
      if (raw === '' || raw === null) { cellPct.textContent = '—'; cellGrade.innerHTML = '<span class="chip grey">—</span>'; return; }
      const val = Number(raw);
      if (Number.isNaN(val) || val < 0 || val > ceiling) {
        input.classList.add('bad');
        cellPct.innerHTML = `<span class="chip red">${T('entry.invalid')}</span>`;
        cellGrade.innerHTML = '<span class="chip grey">—</span>';
        return;
      }
      input.classList.add('ok');
      filled++; sum += val;
      const p = (100 * val) / ceiling;
      cellPct.textContent = `${Math.round(p)}%`;
      cellGrade.innerHTML = `<span class="chip ${p >= 90 ? 'green' : p >= 60 ? 'violet' : p >= 40 ? 'amber' : 'red'}">${letter(p)}</span>`;
    });
    $('#entry-tally').textContent = filled ? T('entry.tally', { n: filled, avg: Math.round(sum / filled), max: fmt(ceiling) }) : T('entry.noScores');
  };

  $('#score-body').addEventListener('input', e => {
    const inp = e.target.closest('.score-input'); if (!inp) return;
    const sid = inp.dataset.sid;
    inp.value = inp.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
    pending[sid] = inp.value;
    recalc();
  });
  const saveBtn = $('#btn-save-scores');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const entries = Object.entries(pending).map(([id, score]) => ({ student_id: Number(id), score }));
    try {
      await api('/api/scores', { method: 'POST', body: { test_id: testId, entries } });
      toast(T('toast.scoresSaved', { name: test.name }));
      renderScoreEntry(testId);
    } catch (ex) { warn(ex.message); }
  });
  recalc();
}

const letter = p => (p >= 90 ? 'A+' : p >= 80 ? 'A' : p >= 70 ? 'B+' : p >= 60 ? 'B' : p >= 50 ? 'C' : p >= 40 ? 'D' : 'F');

/* ------------------------------ reports ------------------------------ */
async function renderReport() {
  const f = App.filters.report;
  let report, grades;
  try {
    const [r, g] = await Promise.all([
      api(`/api/report?month=${f.month}&grade=${encodeURIComponent(f.grade)}`),
      api('/api/students'),
    ]);
    report = r; grades = g.grades;
  } catch (ex) { warn(ex.message); return; }

  const rankChip = r => r.rank === null ? '<span class="muted">—</span>'
    : `<span class="chip ${r.rank === 1 ? 'amber' : r.rank <= 3 ? 'violet' : 'grey'}">#${r.rank}</span>`;

  $('#view').innerHTML = `
    <div class="section-head">
      <div><span class="eyebrow">${T('nav.reports')}</span><h2>${T('rep.title')}</h2><p>${T('rep.sub', { m: esc(monthLabel(f.month)) })}</p></div>
    </div>

    <div class="toolbar no-print">
      <input type="month" class="input" id="r-month" value="${esc(f.month)}">
      <select class="input" id="r-grade">${gradeOptions(grades, f.grade)}</select>
      <span class="muted" style="font-size:13px">${T('rep.clickRow')}</span>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px">
      ${stat('v', T('stat.students'), report.class.students, f.grade ? T('stat.gradeNote', { g: esc(f.grade) }) : T('stat.allGrades'), '👥')}
      ${stat('p', T('stat.tests'), report.class.tests, monthLabel(f.month), '📝')}
      ${stat('m', T('stat.avg'), report.class.average === null ? '—' : pctText(report.class.average), T('stat.avgNote', { n: report.class.tested }), '📈')}
      ${stat('s', T('stat.highest'), report.class.highest === null || report.class.highest === undefined ? '—' : pctText(report.class.highest), T('stat.highestNote'), '🏆')}
    </div>

    <div class="card">
      <div class="card-title"><h3>${T('rep.card', { m: esc(monthLabel(f.month)) })}</h3></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:80px">${T('th.grade')}</th><th style="width:115px">${T('th.roll')}</th><th>${T('th.student')}</th>
              ${report.tests.map(t => `<th class="num">${esc(t.name)}<br><span style="font-weight:400;text-transform:none;letter-spacing:0">/${fmt(t.max_score)}</span></th>`).join('')}
              <th class="num">${T('th.total')}</th><th class="num">%</th><th>${T('th.gradeLetter')}</th><th class="num">${T('th.rank')}</th><th style="width:150px">${T('th.attendance')}</th>
            </tr>
          </thead>
          <tbody id="rep-body">
            ${report.rows.map(r => `
              <tr class="clickable" data-id="${r.student_id}">
                <td><span class="grade-pill">${esc(r.grade)}</span></td>
                <td><span class="roll">${esc(r.grade)}-${esc(r.roll3)}</span></td>
                <td class="name-cell">${esc(r.name)}</td>
                ${report.tests.map(t => {
                  const v = r.marks[t.id];
                  return `<td class="num">${v === null || v === undefined ? '<span class="muted">—</span>' : esc(fmt(v))}</td>`;
                }).join('')}
                <td class="num"><b>${esc(fmt(r.obtained))}</b><span class="muted">/${esc(fmt(r.max_total))}</span></td>
                <td class="num">${r.percent === null ? '<span class="muted">—</span>' : `<b>${esc(pctText(r.percent))}</b>`}</td>
                <td>${r.grade_letter === '-' ? '<span class="muted">—</span>' : `<span class="chip ${r.grade_letter === 'F' ? 'red' : r.grade_letter.startsWith('A') ? 'green' : 'violet'}">${r.grade_letter}</span>`}</td>
                <td class="num">${rankChip(r)}</td>
                <td>${attBar(r.attendance)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${report.rows.length ? '' : `<div class="empty"><span class="emoji">📉</span><b>${T('rep.empty')}</b>${T('rep.emptyHint')}</div>`}
      </div>
      <div class="legend">
        <span>${T('rep.legend1')}</span>
        <span>${T('rep.legend2')}</span>
      </div>
    </div>`;

  animateStats();
  $('#r-month').addEventListener('change', e => { f.month = e.target.value || thisMonth(); renderReport(); });
  $('#r-grade').addEventListener('change', e => { f.grade = e.target.value; renderReport(); });
  $('#rep-body').addEventListener('click', e => {
    const row = e.target.closest('tr[data-id]'); if (row) openStudent(Number(row.dataset.id));
  });
}

async function exportCsv(month, grade) {
  try {
    const res = await fetch(`/api/export?month=${month}&grade=${encodeURIComponent(grade || '')}`,
      { headers: { Authorization: 'Bearer ' + App.token } });
    if (!res.ok) throw new Error(T('err.export'));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `report_${month}${grade ? '_' + grade : ''}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(T('toast.csv'));
  } catch (ex) { warn(ex.message); }
}

/* ------------------------------ activity (admin only) ------------------------------ */
async function renderActivity() {
  let data;
  try { data = await api('/api/activity'); }
  catch (ex) { warn(ex.message); return; }
  const rows = data.activity || [];
  const roleChip = r => `<span class="chip ${r === 'admin' ? 'violet' : r === 'teacher' ? 'green' : 'grey'}">${T('role.' + r + '.name')}</span>`;
  const stamp = v => String(v || '').replace('T', ' ').slice(0, 16);

  $('#view').innerHTML = `
    <div class="section-head">
      <div><span class="eyebrow">${T('nav.activity')}</span><h2>${T('act.title')}</h2><p>${T('act.sub')}</p></div>
    </div>
    <div class="card">
      ${rows.length ? `<div class="act-list">${rows.map(a => `
        <div class="act-row">
          ${roleChip(a.role)}
          <div class="act-main"><b>${T('act.' + a.action)}</b>${a.detail ? `<span class="muted"> — ${esc(a.detail)}</span>` : ''}</div>
          <span class="act-time">${esc(stamp(a.created_at))}</span>
        </div>`).join('')}</div>`
      : `<div class="empty"><span class="emoji">🕓</span><b>${T('act.empty')}</b>${T('act.emptyHint')}</div>`}
    </div>`;
}

/* ------------------------------ student detail ------------------------------ */
async function openStudent(id) {
  openModal({ title: T('rec.title'), wide: true, body: '<div class="boot"><div class="boot-logo">⏳</div></div>' });
  let d;
  try { d = await api(`/api/student?id=${id}`); }
  catch (ex) { $('#modal-body').innerHTML = `<div class="alert">${esc(ex.message)}</div>`; return; }
  $('#modal-body').innerHTML = studentHtml(d);
}

function studentHtml(d) {
  const s = d.student;
  const t = d.attendance_months.reduce((a, m) => ({
    p: a.p + m.present, ab: a.ab + m.absent, l: a.l + m.late, n: a.n + m.marked,
  }), { p: 0, ab: 0, l: 0, n: 0 });
  const attPct = t.n ? (100 * (t.p + t.l) / t.n) : null;
  const best = d.performance.filter(p => p.percent !== null).sort((a, b) => b.percent - a.percent)[0];

  return `
    <div style="display:flex;gap:16px;align-items:center;margin-bottom:18px;flex-wrap:wrap">
      <div class="avatar" style="width:62px;height:62px;border-radius:20px;font-size:23px;background:${avColor(s.id)}">${esc(initials(s.name))}</div>
      <div style="flex:1;min-width:180px">
        <div style="font-family:'Fredoka',sans-serif;font-size:23px">${esc(s.name)}</div>
        <div class="muted" style="font-size:13.6px">${T('rec.gradeRoll', { g: esc(s.grade) })} <span class="roll">${esc(s.grade)}-${esc(s.roll3)}</span></div>
      </div>
      <span class="chip ${attPct === null ? 'grey' : attPct >= 90 ? 'green' : attPct >= 75 ? 'amber' : 'red'}">
        ${attPct === null ? T('rec.attNone') : T('rec.attOverall', { p: pctText(attPct) })}
      </span>
    </div>

    <div class="kv">
      <div><div class="k">${T('kv.daysPresent')}</div><div class="v">${t.p}</div></div>
      <div><div class="k">${T('kv.daysAbsent')}</div><div class="v">${t.ab}</div></div>
      <div><div class="k">${T('kv.lateArr')}</div><div class="v">${t.l}</div></div>
      <div><div class="k">${T('kv.bestMonth')}</div><div class="v">${best ? pctText(best.percent) : '—'}</div></div>
    </div>

    <h4 style="margin:20px 0 8px">${T('rec.attH')}</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>${T('th.month')}</th><th class="num">${T('th.present')}</th><th class="num">${T('th.absent')}</th><th class="num">${T('th.late')}</th><th style="width:150px">${T('th.attendance')}</th></tr></thead>
        <tbody>
          ${d.attendance_months.length ? d.attendance_months.map(m => `
            <tr><td>${esc(monthLabel(m.month))}</td><td class="num">${m.present}</td><td class="num">${m.absent}</td>
            <td class="num">${m.late}</td><td>${attBar({ percent: m.percent, marked: m.marked })}</td></tr>`).join('')
          : `<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">${T('rec.noAtt')}</td></tr>`}
        </tbody>
      </table>
    </div>

    <h4 style="margin:20px 0 8px">${T('rec.perfH')}</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>${T('th.month')}</th><th class="num">${T('th.tests')}</th><th class="num">${T('th.score')}</th><th class="num">%</th><th>${T('th.gradeLetter')}</th></tr></thead>
        <tbody>
          ${d.performance.length ? d.performance.map(p => `
            <tr><td>${esc(monthLabel(p.month))}</td><td class="num">${p.tests}</td>
            <td class="num"><b>${esc(fmt(p.obtained))}</b><span class="muted">/${esc(fmt(p.maximum))}</span></td>
            <td class="num"><b>${esc(pctText(p.percent))}</b></td>
            <td><span class="chip ${p.grade_letter === 'F' ? 'red' : p.grade_letter.startsWith('A') ? 'green' : 'violet'}">${p.grade_letter}</span></td></tr>`).join('')
          : `<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">${T('rec.noPerf')}</td></tr>`}
        </tbody>
      </table>
    </div>

    <h4 style="margin:20px 0 8px">${T('rec.testsH')}</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>${T('th.test')}</th><th>${T('th.month')}</th><th class="num">${T('th.max')}</th><th class="num">${T('th.score')}</th><th class="num">%</th></tr></thead>
        <tbody>
          ${d.tests.length ? d.tests.map(t => {
            const has = t.score !== null && t.score !== undefined;
            const p = has ? (100 * t.score) / t.max_score : null;
            return `<tr><td class="name-cell">${esc(t.name)}</td><td>${esc(monthLabel(t.month))}</td>
              <td class="num">${esc(fmt(t.max_score))}</td>
              <td class="num">${has ? `<b>${esc(fmt(t.score))}</b>` : `<span class="muted">${T('rec.notEntered')}</span>`}</td>
              <td class="num">${has ? esc(pctText(p)) : '—'}</td></tr>`;
          }).join('') : `<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">${T('rec.noTests')}</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

/* ------------------------- menu · palette · hidden commands ---------- */
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || '');
const PAL_KEYS = IS_MAC ? '⌘K' : 'Ctrl K';
const langNative = c => { const r = (window.LANGS || []).find(l => l[0] === c); return r ? r[1] : 'EN'; };

function menuHtml() {
  const canAdd = App.role === 'admin' || App.role === 'teacher';
  const item = (a, icon, label, right) =>
    `<button type="button" data-a="${a}" role="menuitem"><span class="mi-ic">${icon}</span><span>${label}</span>${right ? `<kbd>${esc(right)}</kbd>` : ''}</button>`;
  return `
    <div class="menu-group"><span class="menu-label">${T('menu.actions')}</span>
      ${canAdd ? item('add', '➕', T('menu.add')) : ''}
      ${App.role !== 'observer' ? item('test', '📝', T('menu.test')) : ''}
      ${item('export', '⬇️', T('menu.export'))}
      ${item('print', '🖨️', T('menu.print'))}
    </div>
    <div class="menu-group"><span class="menu-label">${T('menu.prefs')}</span>
      ${item('lang', '🌐', T('menu.lang'), langNative(getLang()))}
      ${App.role === 'admin' ? item('codes', '⚙️', T('menu.codes')) : ''}
      ${item('help', '', T('cmd.help.title'))}
    </div>
    <div class="menu-group">
      ${item('out', '⎋', T('menu.out'))}
    </div>`;
}

function toggleMenu() {
  const p = $('#menu-pop'); if (!p) return;
  p.hidden = !p.hidden;
  $('#btn-menu').setAttribute('aria-expanded', String(!p.hidden));
}
function closeMenu() {
  const p = $('#menu-pop'); if (!p || p.hidden) return;
  p.hidden = true;
  const b = $('#btn-menu'); if (b) b.setAttribute('aria-expanded', 'false');
}

/* one dispatcher for menu items and palette actions */
function runAction(a) {
  if (a === 'lang')   { openLangPicker(); return; }
  if (a === 'print')  { window.print(); return; }
  if (a === 'export') { exportCsv(App.filters.report.month, App.filters.report.grade); return; }
  if (a === 'out')    { signOut(); return; }
  if (a === 'help')   { showCmdHelp(); return; }
  if (a === 'codes')  { if (App.role === 'admin') openCodeModal(); return; }
  if (a === 'add')    { if (App.role === 'admin' || App.role === 'teacher') openAddStudent(); return; }
  if (a === 'test')   { if (App.role !== 'observer') openNewTest(); return; }
  if (NAV.some(n => n.id === a)) {
    if (a === 'activity' && App.role !== 'admin') return;
    closePalette(); navigate(a);
  }
}

function paletteItems() {
  const items = [];
  NAV.filter(n => n.id !== 'activity' || App.role === 'admin')
     .forEach(n => items.push({ g: 'nav', icon: n.icon, label: T(n.key), run: () => runAction(n.id) }));
  if (App.role === 'admin' || App.role === 'teacher')
    items.push({ g: 'act', icon: '➕', label: T('menu.add'), run: () => runAction('add') });
  if (App.role !== 'observer')
    items.push({ g: 'act', icon: '📝', label: T('menu.test'), run: () => runAction('test') });
  items.push({ g: 'act', icon: '⬇️', label: T('menu.export'), run: () => runAction('export') });
  items.push({ g: 'act', icon: '🖨️', label: T('menu.print'), run: () => runAction('print') });
  items.push({ g: 'prefs', icon: '🌐', label: T('menu.lang'), right: langNative(getLang()), run: () => runAction('lang') });
  if (App.role === 'admin')
    items.push({ g: 'prefs', icon: '⚙️', label: T('menu.codes'), run: () => runAction('codes') });
  items.push({ g: 'prefs', icon: '', label: T('cmd.help.title'), run: showCmdHelp });
  items.push({ g: 'prefs', icon: '⎋', label: T('menu.out'), run: () => runAction('out') });
  return items;
}

function openPalette() {
  if (!$('#nav') || $('#pal-back')) return;
  closeMenu();
  $('#palette-root').innerHTML = `
    <div class="pal-back" id="pal-back">
      <div class="pal" role="dialog" aria-modal="true" aria-label="${esc(T('pal.open'))}">
        <div class="pal-input"><span>⌕</span><input id="pal-q" placeholder="${esc(T('pal.placeholder'))}" autocomplete="off"><kbd>esc</kbd></div>
        <div class="pal-list" id="pal-list"></div>
        <div class="pal-foot">${T('pal.hint')}</div>
      </div>
    </div>`;
  let flat = [], idx = 0;
  const list = $('#pal-list');
  const draw = () => {
    const q = $('#pal-q').value.trim().toLowerCase();
    const hits = paletteItems().filter(i => !q || i.label.toLowerCase().includes(q));
    flat = hits;
    if (idx >= hits.length) idx = hits.length - 1;
    if (idx < 0) idx = 0;
    const groups = [['nav', 'pal.group.nav'], ['act', 'pal.group.act'], ['prefs', 'pal.group.prefs']];
    list.innerHTML = hits.length ? groups.map(([g, key]) => {
      const rows = hits.filter(i => i.g === g);
      if (!rows.length) return '';
      return `<div class="pal-g">${T(key)}</div>` + rows.map(i => {
        const k = hits.indexOf(i);
        return `<button type="button" class="pal-item${k === idx ? ' on' : ''}" data-k="${k}">` +
          `<span class="pi-ic">${i.icon || ''}</span><span class="pi-tx">${esc(i.label)}</span>` +
          `${i.right ? `<kbd>${esc(i.right)}</kbd>` : ''}</button>`;
      }).join('');
    }).join('') : `<div class="pal-none">${T('pal.empty')}</div>`;
  };
  const scrollOn = () => { const on = list.querySelector('.pal-item.on'); if (on) on.scrollIntoView({ block: 'nearest' }); };
  const run = k => { const it = flat[k]; if (!it) return; closePalette(); it.run(); };
  $('#pal-q').addEventListener('input', () => { idx = 0; draw(); });
  $('#pal-q').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (flat.length) { idx = (idx + 1) % flat.length; draw(); scrollOn(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (flat.length) { idx = (idx - 1 + flat.length) % flat.length; draw(); scrollOn(); } }
    else if (e.key === 'Enter') { e.preventDefault(); run(idx); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  list.addEventListener('click', e => { const b = e.target.closest('.pal-item'); if (b) run(Number(b.dataset.k)); });
  $('#pal-back').addEventListener('click', e => { if (e.target.id === 'pal-back') closePalette(); });
  draw();
  $('#pal-q').focus();
}
function closePalette() { const r = $('#palette-root'); if (r) r.innerHTML = ''; }

/* accent themes — hidden :accent command, persisted per browser */
const ACCENTS = {
  violet: { v: '#7C5CFC', d: '#6544E8', l: '#A78BFA', g: 'linear-gradient(135deg,#6D4AFF 0%,#9B7BFF 45%,#FF6B9D 100%)', t: 'linear-gradient(115deg,#6D4AFF 0%,#A87CFF 50%,#FF6B9D 100%)', r: 'rgba(124,92,252,.18)' },
  rose:   { v: '#FF5C7A', d: '#E13A5B', l: '#FF9AB0', g: 'linear-gradient(135deg,#FF4D6D 0%,#FF7BA3 50%,#FFB88C 100%)', t: 'linear-gradient(115deg,#FF4D6D 0%,#FF8AA6 50%,#FFB88C 100%)', r: 'rgba(255,92,122,.18)' },
  mint:   { v: '#2EC4B6', d: '#0E8C7E', l: '#6FE3D6', g: 'linear-gradient(135deg,#0FA396 0%,#2EC4B6 55%,#8CE8DC 100%)', t: 'linear-gradient(115deg,#0E8C7E 0%,#2EC4B6 55%,#8CE8DC 100%)', r: 'rgba(46,196,182,.2)' },
  ocean:  { v: '#5B8DEF', d: '#2B5FD9', l: '#93B7FF', g: 'linear-gradient(135deg,#2B5FD9 0%,#5B8DEF 50%,#8F7BFC 100%)', t: 'linear-gradient(115deg,#2B5FD9 0%,#5B8DEF 50%,#A78BFA 100%)', r: 'rgba(91,141,239,.2)' },
  sun:    { v: '#F2A93B', d: '#D97706', l: '#FFC94A', g: 'linear-gradient(135deg,#E8930C 0%,#FFC94A 50%,#FF8A5B 100%)', t: 'linear-gradient(115deg,#E8930C 0%,#FFC94A 50%,#FF8A5B 100%)', r: 'rgba(242,169,59,.22)' },
};
function applyAccent(name) {
  const a = ACCENTS[name]; if (!a) return false;
  const r = document.documentElement.style;
  r.setProperty('--violet', a.v); r.setProperty('--violet-d', a.d); r.setProperty('--violet-l', a.l);
  r.setProperty('--grad', a.g); r.setProperty('--grad-text', a.t); r.setProperty('--ring', a.r);
  try { localStorage.setItem('cr_accent', name); } catch (_) { /* private mode */ }
  return true;
}
function loadAccent() {
  try { const n = localStorage.getItem('cr_accent'); if (n && ACCENTS[n]) applyAccent(n); } catch (_) { /* ignore */ }
}

/* the hidden command bar — type it into the roster search field */
const CMD_META = [
  { s: ':help',   d: 'cmd.desc.help' },
  { s: ':nav',    d: 'cmd.desc.nav' },
  { s: ':lang',   d: 'cmd.desc.lang' },
  { s: ':accent', d: 'cmd.desc.accent' },
  { s: ':sort',   d: 'cmd.desc.sort' },
  { s: ':grade',  d: 'cmd.desc.grade' },
  { s: ':add',    d: 'cmd.desc.add',  gate: 'edit' },
  { s: ':test',   d: 'cmd.desc.test', gate: 'edit' },
  { s: ':codes',  d: 'cmd.desc.codes', gate: 'admin' },
  { s: ':export', d: 'cmd.desc.export' },
  { s: ':print',  d: 'cmd.desc.print' },
  { s: ':clear',  d: 'cmd.desc.clear' },
];
const NO_ARG = new Set([':help', ':add', ':test', ':codes', ':export', ':print', ':clear']);
const cmdLocked = m => (m.gate === 'admin' && App.role !== 'admin') ||
  (m.gate === 'edit' && !(App.role === 'admin' || App.role === 'teacher'));
const sortIc = (k, f) => (f.sort !== k ? ' ⇅' : f.sortDir === -1 ? ' ▼' : ' ▲');

function showPeek(typed) {
  const peek = $('#cmd-peek'); if (!peek) return;
  const t = typed.toLowerCase();
  const hits = CMD_META.filter(m => m.s.startsWith(t));
  peek.innerHTML = hits.map(m => `
    <button type="button" data-cmd="${m.s}"><code>${m.s}</code><span>${esc(T(m.d))}</span>${cmdLocked(m) ? '<em>🔒</em>' : ''}</button>`).join('');
  peek.hidden = !hits.length;
}
function hidePeek() { const p = $('#cmd-peek'); if (p) { p.hidden = true; p.innerHTML = ''; } }

function showCmdHelp() {
  openModal({
    title: T('cmd.help.title'),
    body: `<p class="muted" style="margin:0 0 14px;font-size:13.4px">${esc(T('cmd.help.sub'))}</p>
      <div class="cmd-help">${CMD_META.map(m => `
        <div class="cmd-row${cmdLocked(m) ? ' locked' : ''}"><code>${m.s}</code><span>${esc(T(m.d))}</span>${cmdLocked(m) ? `<em>${T('cmd.locked')}</em>` : ''}</div>`).join('')}</div>`,
  });
}

const unknownCmd = () => { warn(T('cmd.unknown')); return true; };
const lockedCmd  = () => { warn(T('cmd.locked')); return true; };

function runCommand(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith(':')) return false;
  const parts = s.slice(1).split(/\s+/).filter(Boolean);
  const cmd = (parts[0] || '').toLowerCase();
  const arg = (parts[1] || '').toLowerCase();
  const isAdmin = App.role === 'admin';
  const canEdit = isAdmin || App.role === 'teacher';
  const goStudents = () => { if (App.view !== 'students') navigate('students'); else renderStudents(); };
  switch (cmd) {
    case 'help': showCmdHelp(); return true;
    case 'nav': {
      const views = ['students', 'attendance', 'scores', 'report', 'activity'];
      if (!views.includes(arg)) return unknownCmd();
      if (arg === 'activity' && !isAdmin) return lockedCmd();
      closePalette(); navigate(arg); toast('✓ ' + s); return true;
    }
    case 'lang':
      if (!(window.LANGS || []).some(l => l[0] === arg)) return unknownCmd();
      setLang(arg); closePalette(); renderShell(); toast('✓ ' + s); return true;
    case 'accent':
      if (!applyAccent(arg)) return unknownCmd();
      toast('✓ ' + s); return true;
    case 'sort':
      if (!['name', 'grade', 'roll', 'added'].includes(arg)) return unknownCmd();
      App.filters.students.sort = arg; App.filters.students.sortDir = 1;
      goStudents(); toast('✓ ' + s); return true;
    case 'grade':
      if (arg && arg !== 'all') App.filters.students.grade = arg;
      else App.filters.students.grade = '';
      goStudents(); toast('✓ ' + s); return true;
    case 'add':   if (!canEdit) return lockedCmd(); openAddStudent(); return true;
    case 'test':  if (!canEdit) return lockedCmd(); openNewTest(); return true;
    case 'codes': if (!isAdmin) return lockedCmd(); openCodeModal(); return true;
    case 'export': exportCsv(App.filters.report.month, App.filters.report.grade); return true;
    case 'print': window.print(); return true;
    case 'clear':
      App.filters.students = { q: '', grade: '', sort: 'grade', sortDir: 1 };
      goStudents(); toast('✓ ' + s); return true;
    default: return unknownCmd();
  }
}

/* one-time global listeners: palette shortcut, menu dismissal */
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === 'k') {
    if ($('#nav')) { e.preventDefault(); if ($('#pal-back')) closePalette(); else openPalette(); }
  } else if (e.key === 'Escape') {
    closeMenu();
    if ($('#pal-back')) closePalette();
  }
});
document.addEventListener('click', e => { if (!e.target.closest('.menu-anchor')) closeMenu(); });

/* ------------------------------ boot ------------------------------ */
function detectForcedDark() {
  // Chrome may auto-darken light sites; when that happens we swap in a curated palette.
  try {
    const d = document.createElement('div');
    d.style.cssText = 'display:none;background-color:canvas;color-scheme:light';
    document.body.appendChild(d);
    const dark = getComputedStyle(d).backgroundColor !== 'rgb(255, 255, 255)';
    d.remove();
    if (dark) document.documentElement.classList.add('forced-dark');
  } catch (_) { /* detection is best-effort */ }
}

async function boot() {
  detectForcedDark();
  loadAccent();
  document.documentElement.lang = getLang();
  const bootP = document.querySelector('#app .boot p');
  if (bootP) bootP.textContent = T('shell.loading');
  try {
    const s = await api('/api/status');
    if (s.setup_required) return renderSetup();
    if (!App.token) return renderLogin();
    const me = await api('/api/me');
    App.role = me.role;
    renderShell();
  } catch (ex) {
    renderLogin(ex.message && !/Session expired/.test(ex.message) ? ex.message : '');
  }
}
boot();
})();
