/* Class Register — front-end (vanilla JS, no build step) */
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
  filters: {
    students:   { q: '', grade: '' },
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
  el.innerHTML = `<span>${kind === 'err' ? '⚠️' : '✅'}</span><span>${esc(msg)}</span>`;
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
  b.onclick = () => {
    setLang(nextLang());
    closeModal();
    if ($('#nav')) renderShell();
    else if ($('#setup-form')) renderSetup();
    else if ($('#login-form')) renderLogin();
  };
}

function authShell(inner) {
  $('#app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-side">
          <div class="brand-mini" style="margin:0">
            <div class="m">📚</div>
            <div><b style="color:#fff">Class Register</b><span style="color:rgba(255,255,255,.85)">${T('brand.sub')}</span></div>
          </div>
          <h1>${T('hero.h1')}</h1>
          <p>${T('hero.p')}</p>
          <ul class="auth-points">
            <li>🗓️ <span>${T('hero.point1')}</span></li>
            <li>🔐 <span>${T('hero.point2')}</span></li>
            <li>📊 <span>${T('hero.point3')}</span></li>
          </ul>
          <button class="lang-pill on-dark" id="btn-lang">🌐 ${esc(nextLangLabel())}</button>
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
      <button class="btn btn-primary" style="width:100%;justify-content:center" type="submit">${T('setup.submit')}</button>
    </form>`);
  $('#setup-form').addEventListener('submit', async e => {
    e.preventDefault();
    const a  = $('#admin-code').value.trim(), a2 = $('#admin-code2').value.trim();
    const t  = $('#teacher-code').value.trim(), t2 = $('#teacher-code2').value.trim();
    const box = $('#auth-err');
    box.innerHTML = '';
    const err = m => { box.innerHTML = `<div class="alert">${esc(m)}</div>`; };
    if (a.length < 4 || t.length < 4) return err(T('setup.err.len'));
    if (a !== a2) return err(T('setup.err.aMismatch'));
    if (t !== t2) return err(T('setup.err.tMismatch'));
    if (a === t)  return err(T('setup.err.same'));
    try {
      const r = await api('/api/setup', { method: 'POST', body: { admin_code: a, teacher_code: t } });
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
    $('#code-label').textContent = role === 'admin' ? T('login.label.admin') : T('login.label.teacher');
    $('#code-hint').textContent  = role === 'admin' ? T('login.hint.admin') : T('login.hint.teacher');
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
];

function renderShell() {
  $('#app').innerHTML = `
    <header class="hero">
      <div class="hero-inner">
        <div class="brand">
          <div class="brand-mark">📚</div>
          <div>
            <div class="brand-name">Class Register</div>
            <div class="brand-sub">Attendance &amp; Monthly Performance</div>
          </div>
        </div>
        <div class="hero-actions">
          <span class="role-chip">${App.role === 'admin' ? T('role.admin.chip') : T('role.teacher.chip')}</span>
          <button class="hero-btn lang-btn" id="btn-lang" title="Language">🌐 ${esc(nextLangLabel())}</button>
          ${App.role === 'admin' ? `<button class="hero-btn" id="btn-settings">${T('shell.codes')}</button>` : ''}
          <button class="hero-btn" id="btn-logout">${T('shell.signout')}</button>
        </div>
      </div>
    </header>
    <div class="nav-wrap">
      <nav class="nav" id="nav">
        ${NAV.map(n => `<button data-view="${n.id}"><span>${n.icon}</span>${T(n.key)}</button>`).join('')}
      </nav>
    </div>
    <main class="page" id="view"><div class="boot"><div class="boot-logo">⏳</div></div></main>`;

  $('#btn-logout').onclick = signOut;
  if ($('#btn-settings')) $('#btn-settings').onclick = openCodeModal;
  bindLang();
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]'); if (b) navigate(b.dataset.view);
  });
  navigate(App.view || 'students');
}

function navigate(view) {
  App.view = view;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const v = $('#view');
  v.innerHTML = `<div class="boot"><div class="boot-logo">⏳</div><p>${T('shell.loading')}</p></div>`;
  ({ students: renderStudents, attendance: renderAttendance, scores: renderScores, report: renderReport }[view])();
}

const stat = (cls, label, num, note) => `
  <div class="stat ${cls}"><div class="stat-label">${label}</div>
  <div class="stat-num">${num}</div>${note ? `<div class="stat-note">${note}</div>` : ''}</div>`;

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
      <div class="field"><label>${T('codes.newTeacher')}</label><input class="code-input" type="password" id="new-teacher" placeholder="${T('codes.keep')}"></div>`,
    footer: `<button class="btn btn-ghost" id="m-cancel">${T('btn.cancel')}</button>
             <button class="btn btn-primary" id="save-codes">${T('codes.save')}</button>`,
  });
  $('#m-cancel').onclick = closeModal;
  $('#save-codes').onclick = async () => {
    const body = { admin_code: $('#new-admin').value.trim(), teacher_code: $('#new-teacher').value.trim() };
    if (!body.admin_code && !body.teacher_code) return $('#code-err').innerHTML = `<div class="alert">${T('codes.err.one')}</div>`;
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
  const newThisMonth = students.filter(s => (s.created_at || '').startsWith(thisMonth())).length;

  $('#view').innerHTML = `
    <div class="section-head">
      <div><h2>${T('stu.title')}</h2><p>${T('stu.sub')}</p></div>
      ${isAdmin ? `<button class="btn btn-primary no-print" id="btn-add">${T('stu.add')}</button>` : ''}
    </div>

    <div class="grid grid-3" style="margin-bottom:18px">
      ${stat('v', T('stat.students'), students.length, T('stat.inRegister'))}
      ${stat('p', T('stat.grades'), grades.length, T('stat.classes'))}
      ${stat('m', T('stat.addedMonth'), newThisMonth, monthLabel(thisMonth()))}
    </div>

    <div class="card">
      <div class="toolbar no-print">
        <input class="input" id="f-q" placeholder="${T('stu.search')}" value="${esc(f.q)}">
        <select class="input" id="f-grade">${gradeOptions(grades, f.grade)}</select>
        <div class="spacer"></div>
        <span class="muted" style="font-size:13px">${T('stu.shown', { n: students.length })}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:90px">${T('th.grade')}</th><th style="width:120px">${T('th.roll')}</th><th>${T('th.name')}</th><th style="width:170px">${T('th.added')}</th><th class="no-print" style="width:170px"></th></tr></thead>
          <tbody id="stu-body">
            ${students.length ? students.map(s => `
              <tr class="clickable" data-id="${s.id}">
                <td><span class="grade-pill">${esc(s.grade)}</span></td>
                <td><span class="roll">${esc(s.grade)}-${esc(s.roll3)}</span></td>
                <td class="name-cell">${esc(s.name)}</td>
                <td class="muted">${esc((s.created_at || '').slice(0, 10))}</td>
                <td class="no-print" style="text-align:right;white-space:nowrap">
                  <button class="btn btn-sm btn-ghost" data-act="view">${T('btn.view')}</button>
                  ${isAdmin ? `<button class="btn btn-sm btn-danger" data-act="del">${T('btn.remove')}</button>` : ''}
                </td>
              </tr>`).join('') : ''}
          </tbody>
        </table>
        ${students.length ? '' : `<div class="empty"><span class="emoji">🎒</span><b>${T('stu.empty')}</b>${isAdmin ? T('stu.emptyUse') : T('stu.emptyAsk')}</div>`}
      </div>
    </div>`;

  if (isAdmin) $('#btn-add').onclick = openAddStudent;
  const search = debounce(v => { f.q = v; renderStudents(); }, 220);
  $('#f-q').addEventListener('input', e => search(e.target.value.trim()));
  $('#f-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); f.q = e.target.value.trim(); renderStudents(); } });
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
      <div><h2>${T('att.title')}</h2><p>${T('att.sub')} ${isAdmin ? '' : T('att.subTeacher')}</p></div>
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
      <div class="seg">${btn('present', T('mark.present'))}${btn('absent', T('mark.absent'))}${btn('late', T('mark.late'))}</div>
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
      <div><h2>${T('sc.title')}</h2><p>${T('sc.sub')}</p></div>
      <button class="btn btn-primary no-print" id="btn-new-test">${T('sc.new')}</button>
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
  $('#btn-new-test').onclick = openNewTest;

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
          <button class="btn btn-primary" id="btn-save-scores">${T('entry.save')}</button>
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
                <td class="num"><input class="input score-input" data-sid="${s.id}" inputmode="decimal" value="${esc(pending[s.id])}" placeholder="—"></td>
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
  $('#btn-save-scores').addEventListener('click', async () => {
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
      <div><h2>${T('rep.title')}</h2><p>${T('rep.sub', { m: esc(monthLabel(f.month)) })}</p></div>
      <div class="hero-actions no-print" style="gap:10px">
        <button class="btn btn-ghost" id="btn-print">${T('rep.print')}</button>
        <button class="btn btn-mint" id="btn-csv">${T('rep.csv')}</button>
      </div>
    </div>

    <div class="toolbar no-print">
      <input type="month" class="input" id="r-month" value="${esc(f.month)}">
      <select class="input" id="r-grade">${gradeOptions(grades, f.grade)}</select>
      <span class="muted" style="font-size:13px">${T('rep.clickRow')}</span>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px">
      ${stat('v', T('stat.students'), report.class.students, f.grade ? T('stat.gradeNote', { g: esc(f.grade) }) : T('stat.allGrades'))}
      ${stat('p', T('stat.tests'), report.class.tests, monthLabel(f.month))}
      ${stat('m', T('stat.avg'), report.class.average === null ? '—' : pctText(report.class.average), T('stat.avgNote', { n: report.class.tested }))}
      ${stat('s', T('stat.highest'), report.class.highest === null || report.class.highest === undefined ? '—' : pctText(report.class.highest), T('stat.highestNote'))}
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

  $('#r-month').addEventListener('change', e => { f.month = e.target.value || thisMonth(); renderReport(); });
  $('#r-grade').addEventListener('change', e => { f.grade = e.target.value; renderReport(); });
  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-csv').addEventListener('click', () => exportCsv(f.month, f.grade));
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
