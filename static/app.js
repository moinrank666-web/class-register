/* Class Register — front-end (vanilla JS, no build step) */
(() => {
'use strict';

/* ------------------------------ helpers ------------------------------ */
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const MONTH_NAMES = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];
const pad = n => String(n).padStart(2, '0');
const todayISO  = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const thisMonth = () => todayISO().slice(0, 7);
const monthLabel = m => { const [y, mm] = String(m).split('-'); return `${MONTH_NAMES[Number(mm)-1] || ''} ${y}`; };
const AVATAR = ['#7C5CFC','#FF6B9D','#2EC4B6','#F2A93B','#FF8A5B','#5B8DEF','#A78BFA','#1FA598','#E13A5B'];
const avColor = key => AVATAR[String(key).split('').reduce((a,c)=>a + c.charCodeAt(0), 0) % AVATAR.length];
const initials = name => String(name || '?').trim().split(/\s+/).slice(0,2).map(w => w[0].toUpperCase()).join('');
const fmt = v => (v === null || v === undefined || v === '') ? '—' : (Math.round(v*10)/10).toString().replace(/\.0$/, '');
const pctText = v => (v === null || v === undefined) ? '—' : `${fmt(v)}%`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

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
  if (res.status === 401) { await signOut(); throw new Error(data.error || 'Session expired — please sign in again.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
        <div class="modal-head"><h3>${title}</h3><button class="x-btn" id="modal-x" aria-label="Close">✕</button></div>
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

function authShell(inner) {
  $('#app').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-side">
          <div class="brand-mini" style="margin:0">
            <div class="m">📚</div>
            <div><b style="color:#fff">Class Register</b><span style="color:rgba(255,255,255,.85)">Attendance &amp; Performance</span></div>
          </div>
          <h1>Every name,<br>every mark —<br>in one tidy place.</h1>
          <p>A password-protected register for student attendance and monthly test performance.</p>
          <ul class="auth-points">
            <li>🗓️ <span>Grade + last-3-digit roll, kept in a neat sortable table</span></li>
            <li>🔐 <span>Two separate codes: one for you (admin), one for the teacher</span></li>
            <li>📊 <span>Test scores auto-allotted per student with totals, grades &amp; ranks</span></li>
          </ul>
        </div>
        <div class="auth-form">${inner}</div>
      </div>
    </div>`;
}

function renderSetup() {
  authShell(`
    <div class="brand-mini"><div class="m">✨</div><div><b>First-time setup</b><span>Create the two codes that open this register</span></div></div>
    <div class="notice">🔐 These codes are stored as salted hashes — <b>they cannot be recovered</b>. Write them down somewhere safe.</div>
    <div id="auth-err"></div>
    <form id="setup-form" novalidate>
      <div class="field"><label>YOUR admin code</label>
        <input class="code-input" type="password" id="admin-code" autocomplete="new-password" placeholder="••••" minlength="4" required>
        <span class="hint">Min 4 characters — manages students &amp; attendance</span></div>
      <div class="field"><label>Confirm admin code</label>
        <input class="code-input" type="password" id="admin-code2" autocomplete="new-password" placeholder="••••" required></div>
      <div class="field"><label>TEACHER code</label>
        <input class="code-input" type="password" id="teacher-code" autocomplete="new-password" placeholder="••••" minlength="4" required>
        <span class="hint">Must be different — enters monthly test scores</span></div>
      <div class="field"><label>Confirm teacher code</label>
        <input class="code-input" type="password" id="teacher-code2" autocomplete="new-password" placeholder="••••" required></div>
      <button class="btn btn-primary" style="width:100%;justify-content:center" type="submit">Create codes &amp; open register →</button>
    </form>`);
  $('#setup-form').addEventListener('submit', async e => {
    e.preventDefault();
    const a  = $('#admin-code').value.trim(), a2 = $('#admin-code2').value.trim();
    const t  = $('#teacher-code').value.trim(), t2 = $('#teacher-code2').value.trim();
    const box = $('#auth-err');
    box.innerHTML = '';
    const err = m => { box.innerHTML = `<div class="alert">${esc(m)}</div>`; };
    if (a.length < 4 || t.length < 4) return err('Each code must be at least 4 characters.');
    if (a !== a2) return err('The two admin code entries do not match.');
    if (t !== t2) return err('The two teacher code entries do not match.');
    if (a === t)  return err('The admin and teacher codes must be different.');
    try {
      const r = await api('/api/setup', { method: 'POST', body: { admin_code: a, teacher_code: t } });
      App.token = r.token; App.role = r.role;
      sessionStorage.setItem('cr_token', r.token);
      sessionStorage.setItem('cr_role', r.role);
      toast('Register created — welcome!');
      renderShell();
    } catch (ex) { err(ex.message); }
  });
}

function renderLogin(message = '') {
  authShell(`
    <div class="brand-mini"><div class="m">🔐</div><div><b>Sign in</b><span>Enter the code for your role</span></div></div>
    <div id="auth-err">${message ? `<div class="alert">${esc(message)}</div>` : ''}</div>
    <div class="role-tabs" id="role-tabs">
      <button type="button" data-role="admin" class="on">🛡️ Admin</button>
      <button type="button" data-role="teacher">👩‍🏫 Teacher</button>
    </div>
    <form id="login-form" novalidate>
      <div class="field"><label id="code-label">Admin code</label>
        <input class="code-input" type="password" id="login-code" autocomplete="current-password" placeholder="••••" required>
        <span class="hint" id="code-hint">Manages the student roster and attendance</span></div>
      <button class="btn btn-primary" style="width:100%;justify-content:center" type="submit">Open register →</button>
    </form>
    <p class="muted" style="font-size:12.6px;margin-top:18px;text-align:center">
      Lost a code? It can only be reset while signed in as admin.
    </p>`);
  let role = 'admin';
  $('#role-tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-role]'); if (!b) return;
    role = b.dataset.role;
    $$('#role-tabs button').forEach(x => x.classList.toggle('on', x === b));
    $('#code-label').textContent = role === 'admin' ? 'Admin code' : 'Teacher code';
    $('#code-hint').textContent  = role === 'admin'
      ? 'Manages the student roster and attendance'
      : 'Enters monthly test scores and reads reports';
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
      toast(`Signed in as ${r.role}`);
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
  { id: 'students',   label: 'Students',    icon: '🎓' },
  { id: 'attendance', label: 'Attendance',  icon: '🗓️' },
  { id: 'scores',     label: 'Test Scores', icon: '📝' },
  { id: 'report',     label: 'Reports',     icon: '📊' },
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
          <span class="role-chip">${App.role === 'admin' ? '🛡️ Admin access' : '👩‍🏫 Teacher access'}</span>
          ${App.role === 'admin' ? '<button class="hero-btn" id="btn-settings">⚙️ Codes</button>' : ''}
          <button class="hero-btn" id="btn-logout">Sign out</button>
        </div>
      </div>
    </header>
    <div class="nav-wrap">
      <nav class="nav" id="nav">
        ${NAV.map(n => `<button data-view="${n.id}"><span>${n.icon}</span>${n.label}</button>`).join('')}
      </nav>
    </div>
    <main class="page" id="view"><div class="boot"><div class="boot-logo">⏳</div></div></main>`;

  $('#btn-logout').onclick = signOut;
  if ($('#btn-settings')) $('#btn-settings').onclick = openCodeModal;
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]'); if (b) navigate(b.dataset.view);
  });
  navigate(App.view || 'students');
}

function navigate(view) {
  App.view = view;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const v = $('#view');
  v.innerHTML = '<div class="boot"><div class="boot-logo">⏳</div><p>Loading…</p></div>';
  ({ students: renderStudents, attendance: renderAttendance, scores: renderScores, report: renderReport }[view])();
}

const stat = (cls, label, num, note) => `
  <div class="stat ${cls}"><div class="stat-label">${label}</div>
  <div class="stat-num">${num}</div>${note ? `<div class="stat-note">${note}</div>` : ''}</div>`;

function gradeOptions(grades, sel) {
  return `<option value="">All grades</option>` +
    grades.map(g => `<option value="${esc(g)}" ${g === sel ? 'selected' : ''}>${esc(g)}</option>`).join('');
}

async function openCodeModal() {
  openModal({
    title: '⚙️ Change access codes',
    body: `
      <div class="notice">Both codes must be at least 4 characters and different from each other. Leave a field blank to keep the current code.</div>
      <div id="code-err"></div>
      <div class="field"><label>New admin code</label><input class="code-input" type="password" id="new-admin" placeholder="leave blank to keep"></div>
      <div class="field"><label>New teacher code</label><input class="code-input" type="password" id="new-teacher" placeholder="leave blank to keep"></div>`,
    footer: `<button class="btn btn-ghost" id="m-cancel">Cancel</button>
             <button class="btn btn-primary" id="save-codes">Save codes</button>`,
  });
  $('#m-cancel').onclick = closeModal;
  $('#save-codes').onclick = async () => {
    const body = { admin_code: $('#new-admin').value.trim(), teacher_code: $('#new-teacher').value.trim() };
    if (!body.admin_code && !body.teacher_code) return $('#code-err').innerHTML = '<div class="alert">Enter at least one new code.</div>';
    try {
      await api('/api/codes', { method: 'POST', body });
      closeModal(); toast('Codes updated');
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
      <div><h2>🎓 Student roster</h2><p>Name · grade · last three digits of the roll number — sorted by grade, then roll.</p></div>
      ${isAdmin ? '<button class="btn btn-primary no-print" id="btn-add">＋ Add student</button>' : ''}
    </div>

    <div class="grid grid-3" style="margin-bottom:18px">
      ${stat('v', 'Students', students.length, 'in the register')}
      ${stat('p', 'Grades', grades.length, 'distinct classes')}
      ${stat('m', 'Added this month', newThisMonth, monthLabel(thisMonth()))}
    </div>

    <div class="card">
      <div class="toolbar no-print">
        <input class="input" id="f-q" placeholder="🔍 Search name or roll…" value="${esc(f.q)}">
        <select class="input" id="f-grade">${gradeOptions(grades, f.grade)}</select>
        <div class="spacer"></div>
        <span class="muted" style="font-size:13px">${students.length} shown</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:90px">Grade</th><th style="width:120px">Roll No.</th><th>Student name</th><th style="width:170px">Added</th><th class="no-print" style="width:170px"></th></tr></thead>
          <tbody id="stu-body">
            ${students.length ? students.map(s => `
              <tr class="clickable" data-id="${s.id}">
                <td><span class="grade-pill">${esc(s.grade)}</span></td>
                <td><span class="roll">${esc(s.grade)}-${esc(s.roll3)}</span></td>
                <td class="name-cell">${esc(s.name)}</td>
                <td class="muted">${esc((s.created_at || '').slice(0, 10))}</td>
                <td class="no-print" style="text-align:right;white-space:nowrap">
                  <button class="btn btn-sm btn-ghost" data-act="view">View</button>
                  ${isAdmin ? `<button class="btn btn-sm btn-danger" data-act="del">Remove</button>` : ''}
                </td>
              </tr>`).join('') : ''}
          </tbody>
        </table>
        ${students.length ? '' : `<div class="empty"><span class="emoji">🎒</span><b>No students yet</b>${isAdmin ? 'Use “Add student” to start the roster.' : 'Ask the admin to add students.'}</div>`}
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
        title: 'Remove student?',
        body: `<p style="margin:0;line-height:1.6">This permanently deletes <b>${esc(name)}</b> together with their attendance and scores.</p>`,
        footer: `<button class="btn btn-ghost" id="m-cancel">Cancel</button><button class="btn btn-danger" id="m-ok">Remove</button>`,
      });
      $('#m-cancel').onclick = closeModal;
      $('#m-ok').onclick = async () => {
        try { await api(`/api/students?id=${id}`, { method: 'DELETE' }); closeModal(); toast('Student removed'); renderStudents(); }
        catch (ex) { warn(ex.message); }
      };
      return;
    }
    openStudent(id);
  });
}

function openAddStudent() {
  openModal({
    title: '＋ Add student',
    body: `
      <div id="add-err"></div>
      <div class="field"><label>Student name</label><input id="s-name" placeholder="e.g. Ayesha Khan" autocomplete="off"></div>
      <div class="row">
        <div class="field"><label>Grade / class</label>
          <input id="s-grade" list="grade-list" placeholder="e.g. 5" autocomplete="off">
          <datalist id="grade-list">${['1','2','3','4','5','6','7','8','9','10','11','12'].map(g => `<option value="${g}">`).join('')}</datalist>
        </div>
        <div class="field"><label>Last 3 digits of roll no.</label>
          <input id="s-roll" inputmode="numeric" maxlength="3" placeholder="042" autocomplete="off">
          <span class="hint">Exactly 3 digits (000–999)</span>
        </div>
      </div>
      <div class="notice" id="roll-preview" style="margin-top:4px">Roll will appear as <b>—</b></div>`,
    footer: `<button class="btn btn-ghost" id="m-cancel">Cancel</button><button class="btn btn-primary" id="m-save">Add student</button>`,
  });

  const roll = $('#s-roll'), grade = $('#s-grade');
  const preview = () => {
    const r = roll.value.replace(/\D/g, '').slice(0, 3);
    roll.value = r;
    $('#roll-preview').innerHTML = `Roll will appear as <b>${esc(grade.value.trim() || '—')}-${esc(r || '•••')}</b>`;
  };
  roll.addEventListener('input', preview);
  grade.addEventListener('input', preview);
  $('#s-name').focus();
  $('#m-cancel').onclick = closeModal;
  $('#m-save').onclick = async () => {
    const body = { name: $('#s-name').value, grade: grade.value, roll3: roll.value };
    $('#add-err').innerHTML = '';
    if (body.roll3.length !== 3) { $('#add-err').innerHTML = '<div class="alert">Enter exactly 3 digits for the roll number.</div>'; roll.focus(); return; }
    try {
      await api('/api/students', { method: 'POST', body });
      closeModal(); toast(`${body.name} added`); renderStudents();
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
      <div><h2>🗓️ Daily attendance</h2><p>Tap a status for each student, then save. ${isAdmin ? '' : 'Read-only for the teacher code.'}</p></div>
    </div>

    <div class="card">
      <div class="card-title">
        <h3>Mark for <span id="day-label">${esc(f.date)}</span></h3>
        <div class="month-nav no-print">
          <input type="date" class="input" id="a-date" value="${esc(f.date)}">
          <select class="input" id="a-grade">${gradeOptions(grades, f.grade)}</select>
        </div>
      </div>
      ${isAdmin ? `
      <div class="toolbar no-print" style="margin-bottom:6px">
        <button class="btn btn-sm btn-mint" data-all="present">✅ All present</button>
        <button class="btn btn-sm btn-danger" data-all="absent">❌ All absent</button>
        <button class="btn btn-sm btn-ghost" data-all="clear">↺ Clear</button>
        <div class="spacer"></div>
        <span class="muted" id="tally" style="font-size:13.2px"></span>
        <button class="btn btn-primary" id="btn-save-att">💾 Save attendance</button>
      </div>` : ''}
      <div id="mark-list">
        ${day.students.length ? day.students.map(s => markRow(s)).join('') : ''}
      </div>
      ${day.students.length ? '' : `<div class="empty"><span class="emoji">🏫</span><b>No students in this filter</b>Add students or change the grade filter.</div>`}
    </div>

    <div class="card">
      <div class="card-title">
        <h3>Monthly summary</h3>
        <div class="month-nav no-print">
          <input type="month" class="input" id="a-month" value="${esc(f.month)}">
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Grade</th><th>Roll No.</th><th>Student</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Late</th><th style="width:170px">Attendance</th></tr></thead>
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
        ${month.rows.length ? '' : `<div class="empty"><span class="emoji">📭</span><b>Nothing here yet</b>Attendance appears once you start marking.</div>`}
      </div>
      <div class="legend">
        <span>🟢 present</span><span>🔴 absent</span><span>🟡 late (counts as attended)</span>
        <span>Attendance % = (present + late) ÷ marked days</span>
      </div>
    </div>`;

  const tally = () => {
    const c = { present: 0, absent: 0, late: 0, null: 0 };
    Object.values(pending).forEach(v => c[v === null ? 'null' : v]++);
    const el = $('#tally');
    if (el) el.textContent = `✅ ${c.present} present · ❌ ${c.absent} absent · 🟡 ${c.late} late · ${c.null} unmarked`;
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
        toast(`Attendance saved for ${f.date}`);
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
          <div class="mark-sub">Grade ${esc(s.grade)} · Roll ${esc(s.roll3)}</div>
        </div>
      </div>
      <div class="seg">${btn('present', 'Present')}${btn('absent', 'Absent')}${btn('late', 'Late')}</div>
    </div>`;
}

function attBar(r) {
  if (!r.marked) return '<span class="chip grey">not marked</span>';
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
      <div><h2>📝 Monthly test scores</h2><p>Create each test, enter the marks — they are allotted to students automatically.</p></div>
      <button class="btn btn-primary no-print" id="btn-new-test">＋ New test</button>
    </div>

    <div class="card">
      <div class="card-title">
        <h3>Tests in ${esc(monthLabel(f.month))}</h3>
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
              <div class="test-meta">${t.test_date ? '📅 ' + esc(t.test_date) + ' · ' : ''}out of <b>${fmt(t.max_score)}</b> · ${esc(monthLabel(t.month))}</div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm ${t.id === f.testId ? 'btn-primary' : 'btn-ghost'}" data-act="open">${t.id === f.testId ? 'Editing ✓' : 'Enter scores'}</button>
              ${App.role === 'admin' ? '<button class="btn btn-sm btn-danger" data-act="del">✕</button>' : ''}
            </div>
          </div>`).join('')}
      </div>
      ${tests.length ? '' : `<div class="empty"><span class="emoji">📄</span><b>No tests for ${esc(monthLabel(f.month))}</b>Click “New test” to create one.</div>`}
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
        title: 'Delete this test?',
        body: '<p style="margin:0;line-height:1.6">The test and every score inside it will be removed from all students.</p>',
        footer: `<button class="btn btn-ghost" id="m-cancel">Cancel</button><button class="btn btn-danger" id="m-ok">Delete test</button>`,
      });
      $('#m-cancel').onclick = closeModal;
      $('#m-ok').onclick = async () => {
        try { await api(`/api/tests?id=${id}`, { method: 'DELETE' }); closeModal(); toast('Test deleted'); f.testId = null; renderScores(); }
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
    title: '＋ New test',
    body: `
      <div id="test-err"></div>
      <div class="field"><label>Test name</label><input id="t-name" placeholder="e.g. Unit Test 1" autocomplete="off"></div>
      <div class="row">
        <div class="field"><label>Month</label><input type="month" id="t-m" value="${esc(f.month)}"></div>
        <div class="field"><label>Test date (optional)</label><input type="date" id="t-d"></div>
        <div class="field"><label>Maximum marks</label><input id="t-max" inputmode="decimal" placeholder="25" value="25"></div>
      </div>`,
    footer: `<button class="btn btn-ghost" id="m-cancel">Cancel</button><button class="btn btn-primary" id="m-save">Create test</button>`,
  });
  $('#t-name').focus();
  $('#m-cancel').onclick = closeModal;
  $('#m-save').onclick = async () => {
    const body = { name: $('#t-name').value, month: $('#t-m').value, test_date: $('#t-d').value, max_score: $('#t-max').value };
    $('#test-err').innerHTML = '';
    try {
      const r = await api('/api/tests', { method: 'POST', body });
      closeModal(); toast('Test created');
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
          <h3>${esc(test.name)} — score sheet</h3>
          <p class="muted" style="margin:5px 0 0;font-size:13.4px">Out of <b>${fmt(test.max_score)}</b> · ${esc(monthLabel(test.month))} · ${students.length} students</p>
        </div>
        <div class="month-nav no-print">
          <span class="muted" id="entry-tally" style="font-size:13.2px"></span>
          <button class="btn btn-primary" id="btn-save-scores">💾 Save scores</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:90px">Grade</th><th style="width:120px">Roll No.</th><th>Student</th>
            <th class="num" style="width:120px">Score</th><th class="num" style="width:110px">%</th><th style="width:90px">Grade</th></tr></thead>
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
        ${students.length ? '' : `<div class="empty"><span class="emoji">🙈</span><b>No students in this filter</b>Change the grade filter to see students.</div>`}
      </div>
      <div class="legend"><span>Leave a box blank if a student was absent for this test — blank scores are not counted.</span></div>
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
        cellPct.innerHTML = '<span class="chip red">invalid</span>';
        cellGrade.innerHTML = '<span class="chip grey">—</span>';
        return;
      }
      input.classList.add('ok');
      filled++; sum += val;
      const p = (100 * val) / ceiling;
      cellPct.textContent = `${Math.round(p)}%`;
      cellGrade.innerHTML = `<span class="chip ${p >= 90 ? 'green' : p >= 60 ? 'violet' : p >= 40 ? 'amber' : 'red'}">${letter(p)}</span>`;
    });
    $('#entry-tally').textContent = filled ? `${filled} scored · class average ${Math.round(sum / filled)}/${fmt(ceiling)}` : 'no scores yet';
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
      toast(`Scores saved for ${test.name}`);
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
      <div><h2>📊 Monthly performance report</h2><p>Scores, totals, grades, ranks and attendance — ${esc(monthLabel(f.month))}.</p></div>
      <div class="hero-actions no-print" style="gap:10px">
        <button class="btn btn-ghost" id="btn-print">🖨 Print</button>
        <button class="btn btn-mint" id="btn-csv">⬇ Export CSV</button>
      </div>
    </div>

    <div class="toolbar no-print">
      <input type="month" class="input" id="r-month" value="${esc(f.month)}">
      <select class="input" id="r-grade">${gradeOptions(grades, f.grade)}</select>
      <span class="muted" style="font-size:13px">Click any row for the full student record</span>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px">
      ${stat('v', 'Students', report.class.students, f.grade ? `grade ${esc(f.grade)}` : 'all grades')}
      ${stat('p', 'Tests', report.class.tests, monthLabel(f.month))}
      ${stat('m', 'Class average', report.class.average === null ? '—' : pctText(report.class.average), `of ${report.class.tested} scored`)}
      ${stat('s', 'Highest', report.class.highest === null || report.class.highest === undefined ? '—' : pctText(report.class.highest), 'top score among scored students')}
    </div>

    <div class="card">
      <div class="card-title"><h3>Score allocation — ${esc(monthLabel(f.month))}</h3></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:80px">Grade</th><th style="width:115px">Roll No.</th><th>Student</th>
              ${report.tests.map(t => `<th class="num">${esc(t.name)}<br><span style="font-weight:400;text-transform:none;letter-spacing:0">/${fmt(t.max_score)}</span></th>`).join('')}
              <th class="num">Total</th><th class="num">%</th><th>Grade</th><th class="num">Rank</th><th style="width:150px">Attendance</th>
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
        ${report.rows.length ? '' : `<div class="empty"><span class="emoji">📉</span><b>No students to report</b>Add students first, then enter scores.</div>`}
      </div>
      <div class="legend">
        <span>Grades: A+ ≥90 · A ≥80 · B+ ≥70 · B ≥60 · C ≥50 · D ≥40 · F &lt;40</span>
        <span>Rank ties share the same position</span>
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
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `report_${month}${grade ? '_' + grade : ''}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('CSV downloaded');
  } catch (ex) { warn(ex.message); }
}

/* ------------------------------ student detail ------------------------------ */
async function openStudent(id) {
  openModal({ title: '🎓 Student record', wide: true, body: '<div class="boot"><div class="boot-logo">⏳</div></div>' });
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
        <div class="muted" style="font-size:13.6px">Grade ${esc(s.grade)} · Roll <span class="roll">${esc(s.grade)}-${esc(s.roll3)}</span></div>
      </div>
      <span class="chip ${attPct === null ? 'grey' : attPct >= 90 ? 'green' : attPct >= 75 ? 'amber' : 'red'}">
        ${attPct === null ? 'attendance —' : pctText(attPct) + ' overall'}
      </span>
    </div>

    <div class="kv">
      <div><div class="k">Days present</div><div class="v">${t.p}</div></div>
      <div><div class="k">Days absent</div><div class="v">${t.ab}</div></div>
      <div><div class="k">Late arrivals</div><div class="v">${t.l}</div></div>
      <div><div class="k">Best month</div><div class="v">${best ? pctText(best.percent) : '—'}</div></div>
    </div>

    <h4 style="margin:20px 0 8px">📅 Monthly attendance</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Month</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Late</th><th style="width:150px">Attendance</th></tr></thead>
        <tbody>
          ${d.attendance_months.length ? d.attendance_months.map(m => `
            <tr><td>${esc(monthLabel(m.month))}</td><td class="num">${m.present}</td><td class="num">${m.absent}</td>
            <td class="num">${m.late}</td><td>${attBar({ percent: m.percent, marked: m.marked })}</td></tr>`).join('')
          : '<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">No attendance recorded yet</td></tr>'}
        </tbody>
      </table>
    </div>

    <h4 style="margin:20px 0 8px">🏆 Monthly performance</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Month</th><th class="num">Tests</th><th class="num">Score</th><th class="num">%</th><th>Grade</th></tr></thead>
        <tbody>
          ${d.performance.length ? d.performance.map(p => `
            <tr><td>${esc(monthLabel(p.month))}</td><td class="num">${p.tests}</td>
            <td class="num"><b>${esc(fmt(p.obtained))}</b><span class="muted">/${esc(fmt(p.maximum))}</span></td>
            <td class="num"><b>${esc(pctText(p.percent))}</b></td>
            <td><span class="chip ${p.grade_letter === 'F' ? 'red' : p.grade_letter.startsWith('A') ? 'green' : 'violet'}">${p.grade_letter}</span></td></tr>`).join('')
          : '<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">No scores entered by the teacher yet</td></tr>'}
        </tbody>
      </table>
    </div>

    <h4 style="margin:20px 0 8px">📝 Every test</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Test</th><th>Month</th><th class="num">Max</th><th class="num">Score</th><th class="num">%</th></tr></thead>
        <tbody>
          ${d.tests.length ? d.tests.map(t => {
            const has = t.score !== null && t.score !== undefined;
            const p = has ? (100 * t.score) / t.max_score : null;
            return `<tr><td class="name-cell">${esc(t.name)}</td><td>${esc(monthLabel(t.month))}</td>
              <td class="num">${esc(fmt(t.max_score))}</td>
              <td class="num">${has ? `<b>${esc(fmt(t.score))}</b>` : '<span class="muted">absent / not entered</span>'}</td>
              <td class="num">${has ? esc(pctText(p)) : '—'}</td></tr>`;
          }).join('') : '<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">No tests created yet</td></tr>'}
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
