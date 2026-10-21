'use strict';
const DB = { tareas: [], notas: [], loaded: false };
let LOAD_ERR = '';
let VIEW = 'inicio';
let FILTRO_DIA = 'todas';
let CAL_MONTH = new Date();
let CAL_SEL = null;
let INSTALL_PROMPT = null;
// --- NUEVO: estado del historial (Fase 1) ---
let HIST_ESTADO = 'todas';   // todas | pendientes | en_proceso | atendidas | canceladas | vencidas
let HIST_TIPO = 'todos';
let HIST_BUSCAR = '';

const TIPO_LABEL = { asistencia_tecnica:'Asist. técnica', sesion_educativa:'Sesión educativa', tarea_interna:'Tarea interna', coordinacion:'Coordinación' };
const ESTADO_LABEL = { pendiente:'Pendiente', en_proceso:'En proceso', atendido:'Atendido', cancelado:'Cancelado' };
const REC_LABEL = { unica:'Única', diaria:'Diaria', semanal:'Semanal', mensual:'Mensual', anual:'Anual' };
const PRIO_LABEL = { baja:'Baja', media:'Media', alta:'Alta' };
const ALARM_OPTS = [
  { v: 0, l: 'A la hora' },
  { v: 15, l: '15 min antes' },
  { v: 30, l: '30 min antes' },
  { v: 60, l: '1 hora antes' },
  { v: 1440, l: '1 día antes' }
];
let NOTIF_PERM = (typeof Notification !== 'undefined') ? Notification.permission : 'denied';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const icon = (n,c='') => `<svg class="i ${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

const TZ = APP_CONFIG.zonaHoraria || 'America/Lima';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (ds,n) => { const [y,m,d]=ds.split('-').map(Number); return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10); };
const fmtFecha = d => d ? new Date(d+'T12:00:00').toLocaleDateString(APP_CONFIG.locale,{day:'numeric',month:'short'}) : '—';
const fmtLarga = d => d ? new Date(d+'T12:00:00').toLocaleDateString(APP_CONFIG.locale,{weekday:'long',day:'numeric',month:'long'}) : '';
const byFecha = (a,b) => ((a.fecha||'')+(a.hora||'')).localeCompare((b.fecha||'')+(b.hora||''));
const pendiente = t => t.estado!=='atendido' && t.estado!=='cancelado';
/* =========================================================
   ALARMAS v4
   · Celular (app cerrada / bloqueado): las crea Google Calendar desde el backend.
   · App abierta: pantalla de alarma con sonido + notificación del sistema.
   ========================================================= */
const hasAlarm = o => o && (o.recordatorio === true || o.recordatorio === 'true' || o.recordatorio === 1 || o.recordatorio === '1');
const alarmMin = o => {
  const n = parseInt(o && o.recordatorio_min, 10);
  return isNaN(n) || n < 0 ? 0 : n;
};
const alarmLabel = min => {
  const o = ALARM_OPTS.find(x => x.v === min);
  return o ? o.l : (min ? min + ' min antes' : 'A la hora');
};

// ---- Fechas en hora de Lima (UTC-5, sin horario de verano) ----
const LIMA_OFF = '-05:00';
const DOW_SHORT = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DOW_LETTER = ['', 'L', 'M', 'X', 'J', 'V', 'S', 'D'];
const limaTs = (ds, h) => new Date(ds + 'T' + ((h && /^\d{2}:\d{2}$/.test(h)) ? h : '09:00') + ':00' + LIMA_OFF).getTime();
const isoDow = ds => { const [y, m, d] = ds.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 ? 7 : w; };
const diasArr = o => [...new Set(String((o && o.alarma_dias) == null ? '' : o.alarma_dias).split(',').map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 7))].sort((a, b) => a - b);
function diasLabel(arr) {
  if (!arr.length) return '';
  const k = arr.join(',');
  if (k === '1,2,3,4,5,6,7') return 'Todos los días';
  if (k === '1,2,3,4,5') return 'Lun–Vie';
  if (k === '6,7') return 'Sáb–Dom';
  return arr.map(n => DOW_SHORT[n]).join(', ');
}
const alarmActive = o => !!(hasAlarm(o) && o.fecha && o.estado !== 'atendido' && o.estado !== 'cancelado');
const repite = o => alarmActive(o) && diasArr(o).length > 0;
const ocurreHoy = o => repite(o) && o.fecha <= today() && diasArr(o).includes(isoDow(today()));

// Instantes (ms) en que debe sonar `item` dentro de [fromMs, toMs]
function alarmInstants(item, fromMs, toMs) {
  if (!alarmActive(item)) return [];
  const off = alarmMin(item) * 60000, dias = diasArr(item), out = [];
  if (!dias.length) {
    const ts = limaTs(item.fecha, item.hora) - off;
    if (ts >= fromMs && ts <= toMs) out.push(ts);
    return out;
  }
  const base = today();
  for (let k = -2; k <= 16; k++) {
    const ds = addDays(base, k);
    if (ds < item.fecha || !dias.includes(isoDow(ds))) continue;
    const ts = limaTs(ds, item.hora) - off;
    if (ts >= fromMs && ts <= toMs) out.push(ts);
  }
  return out;
}

function alarmSummary(o) {
  const h = o.hora || '09:00';
  const cuando = o.dias.length
    ? diasLabel(o.dias) + (o.fecha && o.fecha > today() ? ' desde ' + fmtFecha(o.fecha) : '')
    : (o.fecha ? 'Una vez · ' + fmtFecha(o.fecha) : 'Una vez');
  return 'Sonará: ' + cuando + ' · ' + h + (o.hora ? '' : ' (sin hora → 09:00)') + (o.min ? ' · ' + alarmLabel(o.min) : '');
}

// ---- Almacenamiento local ----
const LS_FIRED = 'mi_agenda_fired', LS_SNOOZE = 'mi_agenda_snooze', LS_INAPP = 'mi_agenda_inapp', LS_INIT = 'mi_agenda_v4_init';
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const RING_WINDOW = 3 * 60 * 1000;        // una alarma "vence" a los 3 min
const MISSED_WINDOW = 6 * 60 * 60 * 1000; // se avisa de las perdidas de las últimas 6 h
let FIRED = lsGet(LS_FIRED, {});
let SNOOZE = lsGet(LS_SNOOZE, {});
let MISSED = [];
let RING_QUEUE = [], RING_CUR = null, RING_TIMER = null, RING_STOP = null, WAKE = null, AC = null;
let AFTER_DONE = false;
const inAppOn = () => lsGet(LS_INAPP, true) !== false;
const tagDe = (kind, id) => 'alarm-' + kind + '-' + id;
const findItem = (kind, id) => ((kind === 'nota' ? DB.notas : DB.tareas) || []).find(x => String(x.id) === String(id));
const forEachAlarmItem = fn => {
  (DB.tareas || []).forEach(t => fn(t, 'tarea'));
  (DB.notas || []).forEach(n => fn(n, 'nota'));
};
const tituloDe = (item, kind) => kind === 'nota'
  ? (String(item.texto || '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Recordatorio de nota')
  : (item.titulo || 'Actividad programada');

function guardarFired() {
  const lim = Date.now() - 3 * 864e5;
  Object.keys(FIRED).forEach(k => { if (FIRED[k] < lim) delete FIRED[k]; });
  lsSet(LS_FIRED, FIRED);
}
function actualizarBadge() {
  const b = $('#btn-alarm .badge'); if (b) b.hidden = !MISSED.length;
}

// ---- Permiso de notificaciones ----
async function pedirPermisoNotif() {
  if (typeof Notification === 'undefined') {
    say('Este navegador no soporta notificaciones', 'error');
    return false;
  }
  if (Notification.permission === 'granted') { NOTIF_PERM = 'granted'; return true; }
  if (Notification.permission === 'denied') {
    say('Notificaciones bloqueadas. Actívalas en Ajustes del navegador.', 'error');
    return false;
  }
  try {
    const p = await Notification.requestPermission();
    NOTIF_PERM = p;
    if (p === 'granted') { say('Permiso concedido'); return true; }
    say('Sin permiso no habrá aviso dentro de la app (Calendar seguirá avisando)', 'error');
    return false;
  } catch (e) {
    say('No se pudo pedir permiso', 'error');
    return false;
  }
}

// ---- Notificación del sistema (siempre vía Service Worker: único método válido en Android) ----
async function mostrarNotifSistema(item, kind) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const opts = {
    body: kind === 'nota' ? 'Recordatorio de nota' : 'Alarma',
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    tag: tagDe(kind, item.id),
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 120, 300, 120, 300, 120, 500],
    data: { id: item.id, kind },
    actions: kind === 'tarea'
      ? [{ action: 'done', title: '✓ Hecha' }, { action: 'snooze', title: '⏱ +10 min' }]
      : [{ action: 'snooze', title: '⏱ +10 min' }]
  };
  const title = (kind === 'nota' ? '📝 ' : '🔔 ') + tituloDe(item, kind);
  try {
    if ('serviceWorker' in navigator) {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(rej, 3000))]);
      await reg.showNotification(title, opts);
      return;
    }
  } catch (_) {}
  try { new Notification(title, { body: opts.body, tag: opts.tag, icon: opts.icon }); } catch (_) {}
}
async function cerrarNotifSistema(c) {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    (await reg.getNotifications({ tag: tagDe(c.kind, c.item.id) })).forEach(n => n.close());
  } catch (_) {}
}

// ---- Sonido (Web Audio) ----
function unlockAudio() {
  try {
    if (!AC) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return; AC = new C(); }
    if (AC.state === 'suspended') AC.resume();
  } catch (_) {}
}
function beep() {
  const warn = $('#ring-warn');
  if (!AC || AC.state !== 'running') { if (warn) warn.hidden = false; return; }
  if (warn) warn.hidden = true;
  const t = AC.currentTime;
  for (let i = 0; i < 4; i++) {
    const o = AC.createOscillator(), g = AC.createGain(), t0 = t + i * 0.2;
    o.type = 'square';
    o.frequency.value = i % 2 ? 880 : 1175;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.17);
    o.connect(g); g.connect(AC.destination);
    o.start(t0); o.stop(t0 + 0.18);
  }
}
const vibrar = () => { try { if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([300, 120, 300, 120, 500]); } catch (_) {} };
async function pedirWake() {
  try {
    if (navigator.wakeLock && !WAKE) {
      WAKE = await navigator.wakeLock.request('screen');
      WAKE.addEventListener('release', () => { WAKE = null; });
    }
  } catch (_) {}
}
function detenerSonido() {
  clearInterval(RING_TIMER); clearTimeout(RING_STOP); RING_TIMER = RING_STOP = null;
  try { if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate(0); } catch (_) {}
  try { if (WAKE) WAKE.release(); } catch (_) {}
  WAKE = null;
}
function iniciarSonido() {
  detenerSonido();
  unlockAudio(); beep(); vibrar();
  RING_TIMER = setInterval(() => { beep(); vibrar(); }, 1600);
  RING_STOP = setTimeout(detenerSonido, 3 * 60 * 1000); // deja de sonar a los 3 min; la notificación queda
  pedirWake();
}

// ---- Pantalla de alarma ----
function overlayEl() {
  let el = $('#alarm-ring');
  if (!el) {
    el = document.createElement('div');
    el.id = 'alarm-ring'; el.hidden = true;
    el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-modal', 'true');
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-ring]');
      if (b) resolverRing(b.dataset.ring);
    });
  }
  return el;
}
function ringAlarm(item, kind, ts) {
  mostrarNotifSistema(item, kind);
  RING_QUEUE.push({ item, kind, ts: ts || Date.now() });
  if (!RING_CUR) mostrarSiguiente();
}
function mostrarSiguiente() {
  RING_CUR = RING_QUEUE.shift() || null;
  const el = overlayEl();
  if (!RING_CUR) { el.hidden = true; el.innerHTML = ''; return; }
  const { item, kind, ts } = RING_CUR;
  const esTest = String(item.id) === 'test';
  const hh = new Date(ts).toLocaleTimeString(APP_CONFIG.locale, { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  el.innerHTML = `<div class="ring-card">
    <div class="ring-bell">${icon('bell')}</div>
    <small>${kind === 'nota' ? 'Recordatorio de nota' : 'Alarma'} · ${esc(hh)}</small>
    <h2>${esc(tituloDe(item, kind))}</h2>
    ${kind === 'tarea' && item.notas ? `<p>${esc(String(item.notas).slice(0, 160))}</p>` : ''}
    <div id="ring-warn" hidden>🔇 Toca la pantalla para activar el sonido</div>
    <div class="ring-actions">
      ${kind === 'tarea' && !esTest ? '<button type="button" class="btn primary" data-ring="done">✓ Hecha</button>' : ''}
      <button type="button" class="btn ghost" data-ring="snooze">⏱ +10 min</button>
      <button type="button" class="btn ghost" data-ring="stop">Detener</button>
    </div>
    ${RING_QUEUE.length ? `<small>+${RING_QUEUE.length} alarma(s) más en cola</small>` : ''}
  </div>`;
  el.hidden = false;
  iniciarSonido();
}
function resolverRing(accion) {
  const cur = RING_CUR; if (!cur) return;
  detenerSonido();
  cerrarNotifSistema(cur);
  if (accion === 'snooze') {
    SNOOZE[cur.kind + ':' + cur.item.id] = Date.now() + 10 * 60000;
    lsSet(LS_SNOOZE, SNOOZE);
    say('Pospuesta 10 min');
  }
  if (accion === 'done') marcarHecha(cur.item, cur.kind);
  RING_CUR = null;
  mostrarSiguiente();
}
const pasoLaHora = p => p.fecha && limaTs(p.fecha, p.hora) - alarmMin(p) * 60000 < Date.now() - 60000;
function marcarHecha(item, kind) {
  if (kind !== 'tarea') return;
  const t = (DB.tareas || []).find(x => String(x.id) === String(item.id));
  if (t && pendiente(t)) act('setEstadoTarea', { id: t.id, estado: 'atendido' }, 'Atendida · alarma detenida', () => { t.estado = 'atendido'; });
}

// ---- Motor: revisa cada 10 s mientras la app esté abierta ----
function tick() {
  if (!DB.loaded || !inAppOn()) return;
  const now = Date.now();
  let cambio = false;
  forEachAlarmItem((item, kind) => {
    alarmInstants(item, now - RING_WINDOW, now).forEach(ts => {
      const key = kind + ':' + item.id + ':' + ts;
      if (FIRED[key]) return;
      FIRED[key] = now; cambio = true;
      ringAlarm(item, kind, ts);
    });
  });
  Object.keys(SNOOZE).forEach(k => {
    if (SNOOZE[k] > now) return;
    const i = k.indexOf(':'), kind = k.slice(0, i), id = k.slice(i + 1);
    delete SNOOZE[k]; lsSet(LS_SNOOZE, SNOOZE);
    const item = findItem(kind, id);
    if (item && alarmActive(item)) ringAlarm(item, kind, now);
  });
  if (cambio) guardarFired();
}

// Alarmas que vencieron mientras la app estaba cerrada (Calendar ya avisó en el celular)
function catchUp() {
  if (!lsGet(LS_INIT, false)) { lsSet(LS_INIT, true); return; } // primera vez en v4: no listar el pasado
  const now = Date.now(); let n = 0;
  forEachAlarmItem((item, kind) => {
    alarmInstants(item, now - MISSED_WINDOW, now - RING_WINDOW - 1).forEach(ts => {
      const key = kind + ':' + item.id + ':' + ts;
      if (FIRED[key]) return;
      FIRED[key] = now; n++;
      MISSED.push({ kind, id: item.id, ts, title: tituloDe(item, kind) });
    });
  });
  if (n) { guardarFired(); actualizarBadge(); say(n + ' alarma(s) sonaron mientras no estabas aquí · toca 🔔'); }
}

function proximasAlarmas(max) {
  const now = Date.now(), res = [];
  forEachAlarmItem((item, kind) => {
    const l = alarmInstants(item, now, now + 15 * 864e5).sort((a, b) => a - b);
    if (l.length) res.push({ kind, ts: l[0], title: tituloDe(item, kind), rep: diasLabel(diasArr(item)) });
  });
  return res.sort((a, b) => a.ts - b.ts).slice(0, max);
}
const fmtTs = ts => new Date(ts).toLocaleString(APP_CONFIG.locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });

function handleSWMessage(e) {
  if (!e.data) return;
  const id = e.data.id, kind = e.data.kind || 'tarea';
  if (e.data.type === 'SNOOZE_ALARM') {
    SNOOZE[kind + ':' + id] = Date.now() + 10 * 60000;
    lsSet(LS_SNOOZE, SNOOZE);
    say('Alarma pospuesta 10 min');
  }
  if (e.data.type === 'DONE_ALARM') {
    const item = findItem(kind, id);
    if (item) marcarHecha(item, kind);
  }
}

function procesarQuery() {
  const qp = new URLSearchParams(location.search), kind = qp.get('kind') || 'tarea';
  const d = qp.get('done'), s = qp.get('snooze');
  if (d) { const it = findItem(kind, d); if (it) marcarHecha(it, kind); }
  if (s) { SNOOZE[kind + ':' + s] = Date.now() + 10 * 60000; lsSet(LS_SNOOZE, SNOOZE); say('Alarma pospuesta 10 min'); }
  if (d || s) { try { history.replaceState(null, '', '/'); } catch (_) {} }
}
function afterLoad() {
  if (!AFTER_DONE) { AFTER_DONE = true; catchUp(); procesarQuery(); }
  tick();
}

// ---- Centro de alarmas ----
function abrirPanelAlarmas() {
  const perm = typeof Notification === 'undefined' ? 'no soportado' : Notification.permission;
  const permTxt = perm === 'granted' ? 'Activadas' : perm === 'denied' ? 'Bloqueadas (actívalas en Ajustes del navegador)' : perm === 'default' ? 'Sin permitir' : 'No soportadas';
  const prox = proximasAlarmas(5);
  const d = abrirModal(`<div class="form-header"><div><p style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase">Alarmas</p><h2>Centro de alarmas</h2></div><button type="button" class="icon-btn" data-cerrar>${icon('x')}</button></div>
  <div class="form-body panel">
    <p class="panel-note" id="p-ver">Servidor: comprobando…</p>
    <p class="panel-note"><b>Cómo suena en tu celular:</b> cada alarma se crea en Google Calendar y la app Calendar del teléfono la dispara aunque esta app esté cerrada. Usa la misma cuenta de Google en Calendar.</p>
    <button type="button" class="btn primary block" id="p-test-cal">${icon('bell','sm')} Probar alarma del celular (en 2 min)</button>
    <button type="button" class="btn ghost block" id="p-sync">Sincronizar todas mis alarmas con Calendar</button>
    <hr class="sep">
    <div class="panel-row"><div><strong>Avisos dentro de la app</strong><span>Notificaciones: ${esc(permTxt)}</span></div>${perm === 'default' ? '<button type="button" class="chip-btn" id="p-perm">Permitir</button>' : ''}</div>
    <label class="check-line"><input type="checkbox" id="p-inapp" ${inAppOn() ? 'checked' : ''}/><span>Pantalla y sonido de alarma cuando la app esté abierta</span></label>
    <button type="button" class="btn ghost block" id="p-test-app">Probar alarma en la app (10 s)</button>
    ${MISSED.length ? `<div class="panel-list"><h3>Sonaron sin ti <button type="button" class="link-btn" id="p-clear">Limpiar</button></h3>${MISSED.slice(-8).reverse().map(m => `<div><span>${esc(m.title)}</span><small>${esc(fmtTs(m.ts))}</small></div>`).join('')}</div>` : ''}
    <div class="panel-list"><h3>Próximas alarmas</h3>${prox.length ? prox.map(p => `<div><span>${p.kind === 'nota' ? '📝' : '🔔'} ${esc(p.title)}${p.rep ? ` <em>${esc(p.rep)}</em>` : ''}</span><small>${esc(fmtTs(p.ts))}</small></div>`).join('') : '<div><span>No tienes alarmas activas</span></div>'}</div>
    <details class="tips"><summary>Cómo hacer que suene más fuerte (Android)</summary>
      <ol>
        <li>Ajustes del teléfono → Aplicaciones → <b>Calendar</b> → Notificaciones → categoría de <b>alertas/recordatorios de eventos</b>: Importancia <b>Urgente</b>, elige un <b>sonido</b> largo (puede ser un tono de alarma) y activa <b>mostrar en pantalla de bloqueo</b>.</li>
        <li>Calendar → Batería → <b>Sin restricciones</b>.</li>
        <li>Android 12+: Calendar → Permisos → <b>Alarmas y recordatorios</b>: permitir.</li>
        <li>Revisa que <b>No molestar</b> permita Calendar y que el volumen de <b>notificaciones</b> esté alto.</li>
      </ol>
      <p>Los nombres exactos cambian según la marca del teléfono.</p>
    </details>
  </div>
  <div class="form-footer"><button type="button" class="btn primary" data-cerrar>Cerrar</button></div>`);
  d.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', cerrarModal));
  const q = s => d.querySelector(s);
  api('ping').then(r => { const e = q('#p-ver'); if (e) e.innerHTML = r && r.version ? '✅ Servidor v' + esc(r.version) + ' actualizado' : '❌ <b>El servidor sigue con el Code.gs ANTIGUO</b>: pega el nuevo, ejecuta setup e implementa una Nueva versión.'; }).catch(() => { const e = q('#p-ver'); if (e) e.textContent = '⚠ No se pudo consultar el servidor'; });
  q('#p-test-cal').addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await api('testCalendar');
      say('Evento de prueba para las ' + r.cuando + '. Bloquea el celular y espera.');
    } catch (err) { say(err.message, 'error'); }
    b.disabled = false;
  });
  q('#p-sync').addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Sincronizando…';
    try {
      const r = await api('syncCalendar', { force: true });
      say(r.errores ? `${r.sincronizadas} ok, ${r.errores} con error: ${r.detalle}` : `${r.sincronizadas} alarma(s) sincronizada(s)`, r.errores ? 'error' : 'ok');
      await refrescar();
    } catch (err) { say(err.message, 'error'); }
    b.disabled = false; b.textContent = 'Sincronizar todas mis alarmas con Calendar';
  });
  const bp = q('#p-perm');
  if (bp) bp.addEventListener('click', async () => { await pedirPermisoNotif(); abrirPanelAlarmas(); });
  q('#p-inapp').addEventListener('change', e => lsSet(LS_INAPP, e.target.checked));
  q('#p-test-app').addEventListener('click', () => {
    unlockAudio();
    cerrarModal();
    say('Sonará en 10 segundos…');
    setTimeout(() => ringAlarm({ id: 'test', titulo: 'Alarma de prueba', notas: 'Si ves esto y oyes el tono, la alarma dentro de la app funciona.' }, 'tarea', Date.now()), 10000);
  });
  const bc = q('#p-clear');
  if (bc) bc.addEventListener('click', () => { MISSED = []; actualizarBadge(); abrirPanelAlarmas(); });
}

function semaforo(t) {
  if (t.estado==='atendido') return 'v-atendido';
  if (t.estado==='cancelado') return 'v-cancelado';
  if (repite(t)) return 'v-proximo'; // alarma repetitiva: nunca "vencida"
  const h = today();
  if (t.fecha<h) return 'v-vencido';
  if (t.fecha<=addDays(h,1)) return 'v-hoy';
  if (t.fecha<=addDays(h,7)) return 'v-proximo';
  return '';
}

async function api(action, params={}) {
  if (!SCRIPT_URL || !SCRIPT_URL.startsWith('https://script.google.com/')) throw new Error('SCRIPT_URL inválida en config.js');
  if (!navigator.onLine) throw new Error('Sin conexión a internet');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const body = { action, ...params };
    if (API_TOKEN) body.token = API_TOKEN;
    let res;
    try {
      res = await fetch(SCRIPT_URL, { method:'POST', redirect:'follow', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify(body), signal: ctrl.signal });
    } catch(e) {
      if (e.name==='AbortError') throw e;
      throw new Error('No se pudo contactar al servidor. Revisa que el Web App esté publicado para "Cualquier persona".');
    }
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); } catch { throw new Error('Respuesta inválida: el Web App no es público o la URL es incorrecta.'); }
    if (!json.ok) throw new Error(json.error || 'Error servidor');
    return json.data;
  } catch(e) {
    if (e.name==='AbortError') throw new Error('Tiempo agotado. Reintenta.');
    throw e;
  } finally { clearTimeout(timer); }
}

function guardarCache() { try{localStorage.setItem('mi_agenda_db',JSON.stringify(DB))}catch{} }
function cargarCache() { try{return JSON.parse(localStorage.getItem('mi_agenda_db'))}catch{return null} }

function say(msg,tipo='ok') {
  const t=$('#toast'); t.textContent=msg;
  t.classList.toggle('error',tipo==='error'); t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2600);
}

async function load() {
  const cached = cargarCache();
  if (cached?.tareas) { Object.assign(DB,cached); DB.loaded=true; render(); }
  try {
    const data = await api('getAll');
    Object.assign(DB,data); DB.loaded=true; LOAD_ERR=''; guardarCache(); render(); afterLoad();
    try {
      const r = await api('generarRecurrentes');
      if (r?.creadas>0) {
        say(`${r.creadas} recurrente(s) generada(s)`);
        const fresh = await api('getAll');
        Object.assign(DB,fresh); guardarCache(); render(); tick();
      }
    } catch(_){}
  } catch(e) {
    say(e.message,'error');
    if (!DB.loaded) { LOAD_ERR=e.message; render(); }
  }
}

async function refrescar() {
  try { const d=await api('getAll'); Object.assign(DB,d); DB.loaded=true; LOAD_ERR=''; guardarCache(); render(); tick(); }
  catch(e) { say(e.message,'error'); }
}

async function act(action,params,msg,cambioLocal) {
  if (cambioLocal) { cambioLocal(); render(); guardarCache(); }
  try {
    const r = await api(action,params);
    if (r && r.cal_error) say("Guardado, pero Google Calendar falló: "+r.cal_error,"error");
    else if (params && params.recordatorio && /^(add|update)/.test(action) && r && !r.cal_id && !params.alarma_dias && !pasoLaHora(params)) say('⚠ Se guardó, pero NO se creó la alarma en Calendar. Revisa que Code.gs esté actualizado e implementado como Nueva versión (🔔 → estado del servidor).','error');
    else if (msg) say(msg);
  } catch(e) { say(e.message,"error"); }
  await refrescar();
}

function render() {
  const el=$('#today-label'); if(el) el.textContent=fmtLarga(today());
  const vistas={inicio:vistaInicio,dia:vistaDia,agenda:vistaAgenda,notas:vistaNotas,reportes:vistaReportes,historial:vistaHistorial};
  $('#main').innerHTML = DB.loaded ? (vistas[VIEW]||vistaInicio)()
    : LOAD_ERR ? `<div class="empty">${icon('alert','lg')}<strong>No se pudo cargar</strong><span>${esc(LOAD_ERR)}</span><button class="btn primary" data-retry>Reintentar</button></div>`
    : `<div class="empty"><strong>Cargando…</strong></div>`;
  $$('#bottom-nav button').forEach(b=>{ b.setAttribute('aria-current',b.dataset.view===VIEW?'page':'false'); });
  const fab=$('#fab'); if(fab) fab.setAttribute('aria-label',VIEW==='notas'?'Agregar nota':'Agregar tarea');
  wireMainEvents();
}

// --- Refactor: wiring de acciones de tarjeta reutilizable (main + modal) ---
function wireCardActions(root) {
  root.querySelectorAll('[data-check]').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation();
    const t=DB.tareas.find(x=>String(x.id)===String(btn.dataset.check));
    if(!t)return;
    const n=t.estado==='atendido'?'pendiente':'atendido';
    cerrarModal(); // no-op si no hay modal abierto
    act('setEstadoTarea',{id:t.id,estado:n},ESTADO_LABEL[n],()=>{t.estado=n});
  }));
  root.querySelectorAll('[data-edit]').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation(); cerrarModal(); formTarea(btn.dataset.edit);
  }));
  root.querySelectorAll('[data-proc]').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation(); cerrarModal();
    act('setEstadoTarea',{id:btn.dataset.proc,estado:'en_proceso'},'En proceso',()=>{
      const t=DB.tareas.find(x=>String(x.id)===String(btn.dataset.proc)); if(t)t.estado='en_proceso';
    });
  }));
  root.querySelectorAll('[data-cancel]').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation(); cerrarModal();
    act('setEstadoTarea',{id:btn.dataset.cancel,estado:'cancelado'},'Cancelada',()=>{
      const t=DB.tareas.find(x=>String(x.id)===String(btn.dataset.cancel)); if(t)t.estado='cancelado';
    });
  }));
}

function wireMainEvents() {
  wireCardActions($('#main'));
  $$('#main [data-retry]').forEach(b=>b.addEventListener('click',()=>{LOAD_ERR='';render();load()}));
  $$('#main [data-chip]').forEach(c=>c.addEventListener('click',()=>{FILTRO_DIA=c.dataset.chip;render()}));
  $$('#main [data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
  $$('#main [data-cal-mes]').forEach(b=>b.addEventListener('click',()=>{
    CAL_MONTH=new Date(CAL_MONTH.getFullYear(),CAL_MONTH.getMonth()+Number(b.dataset.calMes),1); render();
  }));
  $$('#main [data-cal-dia]').forEach(b=>b.addEventListener('click',()=>{CAL_SEL=b.dataset.calDia;render()}));
  $$('#main [data-edit-nota]').forEach(b=>b.addEventListener('click',()=>formNota(b.dataset.editNota)));

  // --- Historial: filtros, tipo y buscador ---
  $$('#main [data-hist-estado]').forEach(c=>c.addEventListener('click',()=>{
    HIST_ESTADO=c.dataset.histEstado; render();
  }));
  const histTipo=$('#hist-tipo');
  if(histTipo) histTipo.addEventListener('change',()=>{ HIST_TIPO=histTipo.value; render(); });
  const histQ=$('#hist-q');
  if(histQ){
    let tId=null;
    histQ.addEventListener('input',()=>{
      HIST_BUSCAR=histQ.value;
      clearTimeout(tId);
      tId=setTimeout(()=>{
        const list=filtrarHistorial();
        const box=$('#hist-list'); if(!box) return;
        box.innerHTML=list.length
          ? list.map(cardTarea).join('')
          : `<div class="empty">${icon('alert','lg')}<strong>Sin resultados</strong><span>Ajusta los filtros</span></div>`;
        const sub=$('#hist-sub');
        if(sub) sub.textContent=`${list.length} de ${(DB.tareas||[]).length} actividades`;
        wireCardActions(box);
      },120);
    });
  }

  // --- Reportes: drill-down ---
  $$('#main [data-rep-estado]').forEach(b=>b.addEventListener('click',()=>{
    const e=b.dataset.repEstado;
    verTareasEnModal(t=>t.estado===e, ESTADO_LABEL[e]||e);
  }));
  $$('#main [data-rep-tipo]').forEach(b=>b.addEventListener('click',()=>{
    const tp=b.dataset.repTipo;
    verTareasEnModal(t=>t.tipo===tp, TIPO_LABEL[tp]||tp);
  }));
}

function cardTarea(t) {
  const v=semaforo(t), done=t.estado==='atendido', id=esc(t.id);
  const meta=[`<span class="tipo">${esc(TIPO_LABEL[t.tipo]||t.tipo)}</span>`];
  if(t.recurrencia && t.recurrencia!=='unica') meta.push(`<span>${esc(REC_LABEL[t.recurrencia])}</span>`);
  meta.push(`<span>${fmtFecha(t.fecha)}${t.hora?' · '+esc(t.hora):''}</span>`);
  if(t.prioridad==='alta') meta.push('<span class="prio-alta">Alta</span>');
  if(hasAlarm(t)) meta.push(`<span class="alarm">${icon('bell','sm')} ${esc(alarmLabel(alarmMin(t)))}${diasArr(t).length?' · '+esc(diasLabel(diasArr(t))):''}</span>`);
  if(t.estado==='en_proceso') meta.push('<span class="proc">En proceso</span>');
  if(t.estado==='cancelado') meta.push('<span class="vencido">Cancelada</span>');
  if(v==='v-vencido'&&!repite(t)) meta.push('<span class="vencido">Vencida</span>');
  if(done) meta.push('<span class="done">Atendida</span>');

  return `<div class="task ${v} ${done?'done':''}">
    <button class="task-chk ${done?'done':''}" data-check="${id}" aria-label="${done?'Pendiente':'Atendida'}">${icon('check','sm')}</button>
    <div class="task-body">
      <div class="task-title">${hasAlarm(t)?`<span class="alarm-badge" title="Alarma activa">${icon('bell')}</span>`:''}${esc(t.titulo)}</div>
      <div class="task-meta">${meta.join('')}</div>
      ${t.notas?`<div class="task-notes">${esc(t.notas)}</div>`:''}
      <div class="task-actions">
        <button class="mini-btn" data-edit="${id}" title="Editar">${icon('edit','sm')}</button>
        <button class="mini-btn" data-proc="${id}" title="En proceso">${icon('clock','sm')}</button>
        <button class="mini-btn danger" data-cancel="${id}" title="Cancelar">${icon('x','sm')}</button>
      </div>
    </div>
  </div>`;
}

function vistaInicio() {
  const hoy=today(), tareas=DB.tareas||[];
  const activas=tareas.filter(t=>t.estado!=='cancelado');
  const vencidas=activas.filter(t=>pendiente(t)&&t.fecha<hoy&&!repite(t));
  const deHoy=activas.filter(t=>t.fecha===hoy);
  const doneHoy=deHoy.filter(t=>t.estado==='atendido').length;
  const atendidas=tareas.filter(t=>t.estado==='atendido').length;
  const semana=activas.filter(t=>pendiente(t)&&t.fecha>=hoy&&t.fecha<=addDays(hoy,7));
  const proximas=activas.filter(pendiente).sort(byFecha).slice(0,5);
  const pct=deHoy.length?Math.round((doneHoy/deHoy.length)*100):0;

  return `<div class="hero"><small>Avance de hoy</small><div class="metric">${pct}%</div><p>${doneHoy} de ${deHoy.length} atendidas</p></div>
  <div class="grid-stats">
    <div class="stat-mini danger"><small>Vencidas</small><div class="n">${vencidas.length}</div></div>
    <div class="stat-mini warn"><small>Hoy</small><div class="n">${deHoy.length-doneHoy}</div></div>
    <div class="stat-mini ok"><small>Atendidas</small><div class="n">${atendidas}</div></div>
    <div class="stat-mini info"><small>Próx. 7 días</small><div class="n">${semana.length}</div></div>
  </div>
  <div class="section-head"><h2>Próximas</h2><button class="link-btn" data-go="agenda">Ver agenda →</button></div>
  ${proximas.length?proximas.map(cardTarea).join(''):`<div class="empty">${icon('check','lg')}<strong>Sin pendientes</strong><span>Todo al día 🎉</span></div>`}`;
}

function vistaDia() {
  const hoy=today();
  const filtros=['todas',...Object.keys(TIPO_LABEL)];
  const tareas=(DB.tareas||[]).filter(t=>t.estado!=='cancelado'&&(t.fecha===hoy||(t.fecha<hoy&&pendiente(t)&&!repite(t))||ocurreHoy(t)))
    .filter(t=>FILTRO_DIA==='todas'||t.tipo===FILTRO_DIA).sort(byFecha);

  return `<div class="view-head"><div><h1>Mi día</h1><p>${tareas.length} actividad${tareas.length===1?'':'es'} hoy</p></div></div>
  <div class="chips">${filtros.map(f=>`<button class="chip" data-chip="${f}" aria-pressed="${FILTRO_DIA===f}">${f==='todas'?'Todas':esc(TIPO_LABEL[f])}</button>`).join('')}</div>
  ${tareas.length?tareas.map(cardTarea).join(''):`<div class="empty">${icon('calendar','lg')}<strong>Sin actividades hoy</strong><span>Toca + para agregar</span></div>`}`;
}

function vistaAgenda() {
  const y=CAL_MONTH.getFullYear(), m=CAL_MONTH.getMonth();
  const primerDia = new Date(y,m,1).getDay();
  const inicio = primerDia === 0 ? 6 : primerDia - 1;

  const dias=new Date(y,m+1,0).getDate();
  const hoy=today();
  const tareas=(DB.tareas||[]).filter(t=>t.estado!=='cancelado');
  if(!CAL_SEL) CAL_SEL=hoy;

  let celdas='<div class="cal-cell hidden"></div>'.repeat(inicio);
  for(let d=1;d<=dias;d++){
    const ds=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const delDia=tareas.filter(t=>t.fecha===ds);
    const todasDone=delDia.length>0&&delDia.every(t=>t.estado==='atendido');
    celdas+=`<button class="cal-cell ${ds===hoy?'today':''} ${ds===CAL_SEL?'sel':''}" data-cal-dia="${ds}">
      <span>${d}</span>${delDia.length?`<i class="dot ${todasDone?'ok':''}"></i>`:''}</button>`;
  }

  const delSel=tareas.filter(t=>t.fecha===CAL_SEL).sort(byFecha);
  const mesLabel=CAL_MONTH.toLocaleDateString(APP_CONFIG.locale,{month:'long',year:'numeric'});

  return `<div class="view-head"><div><h1>Agenda</h1><p>Calendario</p></div></div>
  <div class="card">
    <div class="cal-head">
      <button class="cal-nav" data-cal-mes="-1">${icon('chevron-left','sm')}</button>
      <strong>${esc(mesLabel)}</strong>
      <button class="cal-nav" data-cal-mes="1">${icon('chevron-right','sm')}</button>
    </div>
    <div class="cal-grid">
      ${['L','M','X','J','V','S','D'].map(d=>`<div class="cal-dow">${d}</div>`).join('')}
      ${celdas}
    </div>
  </div>
  <div class="section-head"><h2>${esc(fmtLarga(CAL_SEL))}</h2></div>
  ${delSel.length?delSel.map(cardTarea).join(''):`<div class="empty">${icon('calendar','lg')}<strong>Sin actividades</strong><span>Día libre</span></div>`}`;
}

function vistaNotas() {
  const notas=(DB.notas||[]).slice().sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||''));
  return `<div class="view-head"><div><h1>Notas</h1><p>${notas.length} nota${notas.length===1?'':'s'}</p></div></div>
  ${notas.length?notas.map(n=>`<div class="card" style="padding:14px;margin-bottom:10px;display:flex;gap:12px">
    <div style="flex:1;min-width:0">
      <div style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${fmtFecha(n.fecha)}${n.hora?' · '+esc(n.hora):''}
        ${hasAlarm(n)?`<span class="task-meta" style="margin:0"><span class="alarm">${icon('bell','sm')} ${esc(alarmLabel(alarmMin(n)))}${diasArr(n).length?' · '+esc(diasLabel(diasArr(n))):''}</span></span>`:''}
      </div>
      <div style="white-space:pre-wrap;font-size:14px">${esc(n.texto)}</div>
    </div>
    <button class="mini-btn" data-edit-nota="${esc(n.id)}">${icon('edit','sm')}</button>
  </div>`).join(''):`<div class="empty">${icon('note','lg')}<strong>Sin notas</strong><span>Toca + para crear</span></div>`}`;
}

function vistaReportes() {
  const tareas=DB.tareas||[];
  const total=tareas.length, atendidas=tareas.filter(t=>t.estado==='atendido').length;
  const cumplimiento=total>0?Math.round((atendidas/total)*100):0;
  const porTipo={};
  tareas.forEach(t=>{
    const k=t.tipo||'otro';
    if(!porTipo[k]) porTipo[k]={tipo:k,total:0,atendidas:0};
    porTipo[k].total++;
    if(t.estado==='atendido') porTipo[k].atendidas++;
  });
  const tiposArr=Object.values(porTipo).sort((a,b)=>b.total-a.total);
  const maxTipo=Math.max(...tiposArr.map(x=>x.total),1);
  const porEstado={pendiente:0,en_proceso:0,atendido:0,cancelado:0};
  tareas.forEach(t=>{if(porEstado[t.estado]!==undefined)porEstado[t.estado]++});

  return `<div class="view-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
    <div><h1>Reportes</h1><p>Resumen</p></div>
    <button class="link-btn" data-go="historial">Ver historial →</button>
  </div>
  <div class="hero" style="background:linear-gradient(135deg,var(--orange),#E05300)">
    <small>Cumplimiento</small><div class="metric">${cumplimiento}%</div><p>${atendidas} de ${total} atendidas</p>
  </div>
  <div class="grid-stats">
    <button class="stat-mini danger" data-rep-estado="pendiente" title="Ver pendientes"><small>Pendientes</small><div class="n">${porEstado.pendiente}</div></button>
    <button class="stat-mini warn" data-rep-estado="en_proceso" title="Ver en proceso"><small>En proceso</small><div class="n">${porEstado.en_proceso}</div></button>
    <button class="stat-mini ok" data-rep-estado="atendido" title="Ver atendidas"><small>Atendidas</small><div class="n">${porEstado.atendido}</div></button>
    <button class="stat-mini info" data-rep-estado="cancelado" title="Ver canceladas"><small>Canceladas</small><div class="n">${porEstado.cancelado}</div></button>
  </div>
  <div class="card rep-card"><h3>Por tipo (toca para ver)</h3>
    ${tiposArr.length?tiposArr.map(x=>`<button class="rep-bar" data-rep-tipo="${esc(x.tipo)}" title="Ver ${esc(TIPO_LABEL[x.tipo]||x.tipo)}">
      <span class="rep-bar-label">${esc(TIPO_LABEL[x.tipo]||x.tipo)}</span>
      <span class="rep-bar-track"><span class="rep-bar-fill" style="width:${Math.max(6,(x.total/maxTipo)*100)}%"></span></span>
      <span class="rep-bar-value">${x.total}</span>
    </button>`).join(''):'<p style="color:var(--muted)">Sin datos.</p>'}
  </div>`;
}

// ============ NUEVO: Vista Historial (Fase 1) ============
function filtrarHistorial() {
  const hoy=today();
  let list=(DB.tareas||[]).slice();
  if(HIST_ESTADO==='vencidas'){
    list=list.filter(t=>pendiente(t)&&t.fecha&&t.fecha<hoy&&!repite(t));
  } else if(HIST_ESTADO!=='todas'){
    list=list.filter(t=>t.estado===HIST_ESTADO);
  }
  if(HIST_TIPO!=='todos') list=list.filter(t=>t.tipo===HIST_TIPO);
  if(HIST_BUSCAR){
    const q=HIST_BUSCAR.trim().toLowerCase();
    if(q) list=list.filter(t=>(t.titulo||'').toLowerCase().includes(q)||(t.notas||'').toLowerCase().includes(q));
  }
  return list.sort((a,b)=>byFecha(b,a)); // más recientes primero
}

function vistaHistorial() {
  const list=filtrarHistorial();
  const total=(DB.tareas||[]).length;
  const chips=[
    ['todas','Todas'],
    ['pendientes','Pendientes'],
    ['en_proceso','En proceso'],
    ['atendidas','Atendidas'],
    ['canceladas','Canceladas'],
    ['vencidas','Vencidas']
  ];
  return `<div class="view-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
    <div><h1>Historial</h1><p id="hist-sub">${list.length} de ${total} actividades</p></div>
    <button class="link-btn" data-go="reportes">← Reportes</button>
  </div>
  <div class="field" style="margin-bottom:10px">
    <input type="search" id="hist-q" placeholder="Buscar en título o notas…" value="${esc(HIST_BUSCAR)}" autocomplete="off" spellcheck="false"/>
  </div>
  <div class="chips">${chips.map(([k,l])=>`<button class="chip" data-hist-estado="${k}" aria-pressed="${HIST_ESTADO===k}">${l}</button>`).join('')}</div>
  <div class="field" style="margin:8px 0 14px">
    <select id="hist-tipo">
      <option value="todos"${HIST_TIPO==='todos'?' selected':''}>Todos los tipos</option>
      ${Object.entries(TIPO_LABEL).map(([k,v])=>`<option value="${k}"${HIST_TIPO===k?' selected':''}>${esc(v)}</option>`).join('')}
    </select>
  </div>
  <div id="hist-list">${list.length
    ? list.map(cardTarea).join('')
    : `<div class="empty">${icon('alert','lg')}<strong>Sin resultados</strong><span>Ajusta los filtros</span></div>`}</div>`;
}

// ============ NUEVO: Modal drill-down (Reportes → detalle) ============
function verTareasEnModal(filtro, titulo) {
  const list=(DB.tareas||[]).filter(filtro).sort((a,b)=>byFecha(b,a));
  abrirModal(`<div class="form-header">
    <div><p style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase">${list.length} actividad${list.length===1?'':'es'}</p><h2>${esc(titulo)}</h2></div>
    <button type="button" class="icon-btn" data-cerrar>${icon('x')}</button></div>
    <div class="form-body" style="max-height:60vh;overflow:auto;padding-top:4px">
      ${list.length
        ? list.map(cardTarea).join('')
        : `<div class="empty">${icon('alert','lg')}<strong>Sin actividades</strong><span>No hay registros en este grupo</span></div>`}
    </div>
    <div class="form-footer"><button type="button" class="btn ghost" data-cerrar>Cerrar</button></div>`);
  const d=$('#modal');
  d.querySelectorAll('[data-cerrar]').forEach(b=>b.addEventListener('click',cerrarModal));
  wireCardActions(d);
}

function go(v) { VIEW=v; window.scrollTo({top:0,behavior:'smooth'}); render(); }
function abrirModal(html) { const d=$('#modal'); d.innerHTML=html; if(!d.open)d.showModal(); return d; }
function cerrarModal() { const d=$('#modal'); if(d&&d.open)d.close(); }
const opciones=(obj,sel)=>Object.entries(obj).map(([k,v])=>`<option value="${k}"${k===sel?' selected':''}>${v}</option>`).join('');

// ---- Campo de alarma compartido (tareas y notas), estilo Notion ----
function alarmFieldHTML(t) {
  const on = hasAlarm(t), min = alarmMin(t);
  const conocido = ALARM_OPTS.some(o => o.v === min);
  const radios = ALARM_OPTS.map(o =>
    `<label><input type="radio" name="rec_min" value="${o.v}" ${(min === o.v || (o.v === 0 && !conocido)) ? 'checked' : ''}/>${o.l}</label>`
  ).join('');
  const dow = [1, 2, 3, 4, 5, 6, 7].map(n =>
    `<button type="button" class="dow-btn" data-dow="${n}" aria-pressed="false" aria-label="${DOW_SHORT[n]}">${DOW_LETTER[n]}</button>`
  ).join('');
  return `<div class="alarm-field">
    <label class="main-lab"><input type="checkbox" name="recordatorio" id="chk-alarm" ${on ? 'checked' : ''}/> ${icon('bell', 'sm')} Alarma en el celular</label>
    <div id="af-body" ${on ? '' : 'hidden'}>
      <div class="af-sub">Avisar</div>
      <div class="alarm-opts">${radios}</div>
      <div class="af-sub">Repetir</div>
      <div class="seg" id="af-seg">
        <button type="button" data-preset="once">Una vez</button>
        <button type="button" data-preset="all">Todos los días</button>
        <button type="button" data-preset="wk">Lun–Vie</button>
        <button type="button" data-preset="we">Sáb–Dom</button>
        <button type="button" data-preset="custom">Personalizado</button>
      </div>
      <div class="dow" id="af-dow" hidden>${dow}</div>
      <p class="af-sum" id="af-sum"></p>
    </div>
    ${NOTIF_PERM !== 'granted' && NOTIF_PERM !== 'denied' ? `<div class="perm-banner" id="perm-banner">${icon('bell')}<div>La alarma del celular la envía Google Calendar. Permite notificaciones para que además suene aquí dentro.</div><button type="button" id="btn-perm">Permitir</button></div>` : ''}
  </div>`;
}

function wireAlarmField(form, dias0) {
  const chk = form.querySelector('#chk-alarm'), body = form.querySelector('#af-body');
  const dowBox = form.querySelector('#af-dow'), sum = form.querySelector('#af-sum');
  const rec = form.elements.recurrencia, hint = form.querySelector('#rec-hint');
  const sel = new Set(dias0);
  let custom = false;
  const key = () => [...sel].sort((a, b) => a - b).join(',');
  const preset = () => {
    if (!sel.size) return custom ? 'custom' : 'once';
    const k = key();
    return k === '1,2,3,4,5,6,7' ? 'all' : k === '1,2,3,4,5' ? 'wk' : k === '6,7' ? 'we' : 'custom';
  };
  const minSel = () => parseInt((form.querySelector('input[name=rec_min]:checked') || {}).value, 10) || 0;

  function refresh() {
    const p = preset(), on = chk.checked;
    body.hidden = !on;
    form.querySelectorAll('#af-seg [data-preset]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === p)));
    dowBox.hidden = !(sel.size || custom);
    form.querySelectorAll('[data-dow]').forEach(b => b.setAttribute('aria-pressed', String(sel.has(+b.dataset.dow))));
    if (rec) {
      const lock = on && sel.size > 0;
      if (lock) rec.value = 'unica';
      rec.disabled = lock;
      if (hint) hint.hidden = !lock;
    }
    sum.textContent = alarmSummary({
      fecha: form.elements.fecha ? form.elements.fecha.value : '',
      hora: form.elements.hora ? form.elements.hora.value : '',
      min: minSel(),
      dias: [...sel].sort((a, b) => a - b)
    });
  }
  const setSel = arr => { sel.clear(); arr.forEach(n => sel.add(n)); };
  form.querySelectorAll('#af-seg [data-preset]').forEach(b => b.addEventListener('click', () => {
    const p = b.dataset.preset;
    if (p === 'once') { setSel([]); custom = false; }
    else if (p === 'all') { setSel([1, 2, 3, 4, 5, 6, 7]); custom = false; }
    else if (p === 'wk') { setSel([1, 2, 3, 4, 5]); custom = false; }
    else if (p === 'we') { setSel([6, 7]); custom = false; }
    else custom = true;
    refresh();
  }));
  form.querySelectorAll('[data-dow]').forEach(b => b.addEventListener('click', () => {
    const n = +b.dataset.dow;
    if (sel.has(n)) sel.delete(n); else sel.add(n);
    refresh();
  }));
  chk.addEventListener('change', refresh);
  ['fecha', 'hora'].forEach(n => { if (form.elements[n]) form.elements[n].addEventListener('input', refresh); });
  form.querySelectorAll('input[name=rec_min]').forEach(r => r.addEventListener('change', refresh));
  const btnPerm = form.querySelector('#btn-perm');
  if (btnPerm) btnPerm.addEventListener('click', async () => {
    if (await pedirPermisoNotif()) { const b = form.querySelector('#perm-banner'); if (b) b.remove(); }
  });
  refresh();
  return {
    read() {
      const on = chk.checked;
      return {
        recordatorio: on,
        recordatorio_min: on ? minSel() : 0,
        alarma_dias: on ? key() : ''
      };
    }
  };
}

function formTarea(id) {
  const ex = id ? DB.tareas.find(x => String(x.id) === String(id)) : null;
  const t = ex || { titulo: '', tipo: 'tarea_interna', prioridad: 'media', fecha: today(), hora: '', recurrencia: 'unica', programada: true, notas: '', recordatorio: false, recordatorio_min: 0, alarma_dias: '' };
  abrirModal(`<form id="form-tarea">
    <div class="form-header"><div><p style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase">${ex ? 'Editar' : 'Nueva'}</p><h2>${ex ? 'Editar' : 'Nueva'} actividad</h2></div><button type="button" class="icon-btn" data-cerrar>${icon('x')}</button></div>
    <div class="form-body">
      <div class="field"><label>Título</label><input name="titulo" required maxlength="200" value="${esc(t.titulo)}" placeholder="Ej: Asistencia técnica..." autofocus/></div>
      <div class="row-2">
        <div class="field"><label>Tipo</label><select name="tipo">${opciones(TIPO_LABEL, t.tipo)}</select></div>
        <div class="field"><label>Prioridad</label><select name="prioridad">${opciones(PRIO_LABEL, t.prioridad)}</select></div>
      </div>
      <div class="row-2">
        <div class="field"><label>Fecha</label><input name="fecha" type="date" required value="${esc(t.fecha)}"/></div>
        <div class="field"><label>Hora</label><input name="hora" type="time" value="${esc(t.hora)}"/></div>
      </div>
      <div class="field"><label>Recurrencia</label><select name="recurrencia">${opciones(REC_LABEL, t.recurrencia)}</select>
        <small class="hint" id="rec-hint" hidden>La repetición la define la alarma (días elegidos abajo).</small></div>
      <label class="check-line"><input type="checkbox" name="programada" ${t.programada ? 'checked' : ''}/><span>Programada</span></label>
      ${alarmFieldHTML(t)}
      <div class="field"><label>Notas</label><textarea name="notas" maxlength="1000">${esc(t.notas)}</textarea></div>
    </div>
    <div class="form-footer">
      ${ex ? `<button type="button" class="btn danger" data-eliminar>${icon('trash', 'sm')}Eliminar</button>` : ''}
      <button type="button" class="btn ghost" data-cerrar>Cancelar</button>
      <button type="submit" class="btn primary">${ex ? 'Guardar' : 'Crear'}</button>
    </div>
  </form>`);
  const form = $('#form-tarea');
  form.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', cerrarModal));
  const af = wireAlarmField(form, diasArr(t));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.programada = form.elements.programada.checked;
    Object.assign(data, af.read());
    delete data.rec_min;
    if (data.alarma_dias) data.recurrencia = 'unica';
    else if (!data.recurrencia) data.recurrencia = (ex && ex.recurrencia) || 'unica';
    if (data.recordatorio && NOTIF_PERM === 'default') await pedirPermisoNotif();
    cerrarModal();
    act(ex ? 'updateTarea' : 'addTarea', ex ? { ...data, id: ex.id } : data, data.recordatorio ? 'Guardado · Alarma programada en Calendar' : (ex ? 'Guardada' : 'Creada'),
      ex ? () => Object.assign(ex, data) : () => DB.tareas.push({ id: 'tmp_' + Date.now(), estado: 'pendiente', ...data }));
  });
  const del = form.querySelector('[data-eliminar]');
  if (del) del.addEventListener('click', () => { if (confirm('¿Eliminar?')) { cerrarModal(); act('deleteTarea', { id: ex.id }, 'Eliminada', () => { DB.tareas = DB.tareas.filter(x => x !== ex); }); } });
}

function formNota(id) {
  const ex = id ? DB.notas.find(x => String(x.id) === String(id)) : null;
  const n = ex || { texto: '', fecha: today(), hora: '', recordatorio: false, recordatorio_min: 0, alarma_dias: '' };
  abrirModal(`<form id="form-nota">
    <div class="form-header"><div><p style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase">${ex ? 'Editar' : 'Nueva'}</p><h2>${ex ? 'Editar' : 'Nueva'} nota</h2></div><button type="button" class="icon-btn" data-cerrar>${icon('x')}</button></div>
    <div class="form-body">
      <div class="row-2">
        <div class="field"><label>Fecha</label><input name="fecha" type="date" required value="${esc(n.fecha)}"/></div>
        <div class="field"><label>Hora (opc.)</label><input name="hora" type="time" value="${esc(n.hora || '')}"/></div>
      </div>
      <div class="field"><label>Nota</label><textarea name="texto" required maxlength="2000" autofocus>${esc(n.texto)}</textarea></div>
      ${alarmFieldHTML(n)}
    </div>
    <div class="form-footer">
      ${ex ? `<button type="button" class="btn danger" data-eliminar>${icon('trash', 'sm')}Eliminar</button>` : ''}
      <button type="button" class="btn ghost" data-cerrar>Cancelar</button>
      <button type="submit" class="btn primary">${ex ? 'Guardar' : 'Crear'}</button>
    </div>
  </form>`);
  const form = $('#form-nota');
  form.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', cerrarModal));
  const af = wireAlarmField(form, diasArr(n));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    Object.assign(data, af.read());
    delete data.rec_min;
    if (data.recordatorio && NOTIF_PERM === 'default') await pedirPermisoNotif();
    cerrarModal();
    act(ex ? 'updateNota' : 'addNota', ex ? { ...data, id: ex.id } : data, data.recordatorio ? 'Guardado · Alarma programada en Calendar' : (ex ? 'Guardada' : 'Creada'),
      ex ? () => Object.assign(ex, data) : () => DB.notas.push({ id: 'tmp_' + Date.now(), ...data }));
  });
  const del = form.querySelector('[data-eliminar]');
  if (del) del.addEventListener('click', () => { if (confirm('¿Eliminar?')) { cerrarModal(); act('deleteNota', { id: ex.id }, 'Eliminada', () => { DB.notas = DB.notas.filter(x => x !== ex); }); } });
}

function aplicarTema() {
  const g=localStorage.getItem('mi_agenda_theme')||'auto';
  if(g==='auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme',g);
  actualizarIconoTema(g);
}
function actualizarIconoTema(modo) {
  const btn=$('#btn-theme'); if(!btn)return;
  const use=btn.querySelector('use'); if(!use)return;
  const oscuro=modo==='dark'||(modo==='auto'&&window.matchMedia('(prefers-color-scheme:dark)').matches);
  use.setAttribute('href',oscuro?'#i-sun':'#i-moon');
}
function toggleTema() {
  const a=localStorage.getItem('mi_agenda_theme')||'auto';
  const s=a==='light'?'dark':a==='dark'?'auto':'light';
  localStorage.setItem('mi_agenda_theme',s); aplicarTema();
  say(s==='light'?'Modo claro':s==='dark'?'Modo oscuro':'Automático');
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);

function ayudaInstalar() {
  const pasos = isIOS()
    ? '<li>Abre esta página en <b>Safari</b>.</li><li>Toca el botón <b>Compartir</b> (cuadro con flecha ↑).</li><li>Elige <b>Agregar a pantalla de inicio</b> y confirma.</li>'
    : '<li>Abre el menú <b>⋮</b> de Chrome.</li><li>Elige <b>Instalar aplicación</b> (o <b>Agregar a pantalla principal</b>).</li><li>Confirma.</li>';
  abrirModal(`<div class="form-header"><h2>Instalar Mi Agenda</h2><button type="button" class="icon-btn" data-cerrar>${icon('x')}</button></div>
    <ol class="howto" style="padding-top:12px">${pasos}</ol>
    <div class="form-footer"><button type="button" class="btn primary" data-cerrar>Entendido</button></div>`)
    .querySelectorAll('[data-cerrar]').forEach(b=>b.addEventListener('click',cerrarModal));
}

function wireInstall() {
  const btn=$('#btn-install');
  if (!btn) return;
  if (isStandalone()) { btn.hidden=true; return; }
  // Mostrar siempre el botón si no está instalada (Chrome a veces no dispara beforeinstallprompt)
  btn.hidden=false;
  btn.textContent='Instalar';
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    INSTALL_PROMPT = e;
    btn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    INSTALL_PROMPT = null;
    btn.hidden = true;
    say('App instalada');
  });
  btn.addEventListener('click', async () => {
    if (INSTALL_PROMPT) {
      INSTALL_PROMPT.prompt();
      const { outcome } = await INSTALL_PROMPT.userChoice;
      INSTALL_PROMPT = null;
      if (outcome === 'accepted') btn.hidden = true;
      return;
    }
    // Fallback: instrucciones manuales (menú ⋮ de Chrome)
    ayudaInstalar();
  });
}

function wireGlobal() {
  $$('#bottom-nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
  $('#fab').addEventListener('click', () => VIEW === 'notas' ? formNota() : formTarea());
  $('#btn-theme').addEventListener('click', toggleTema);
  const ba = $('#btn-alarm'); if (ba) ba.addEventListener('click', abrirPanelAlarmas);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarModal(); });
  // Desbloquea el audio con el primer toque (los navegadores lo exigen)
  ['pointerdown', 'touchstart', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, unlockAudio, { passive: true }));
  const setOff = () => { const o = $('#offline'); if (o) o.hidden = navigator.onLine; };
  window.addEventListener('online', () => { setOff(); refrescar(); }); window.addEventListener('offline', setOff); setOff();
  if ('serviceWorker' in navigator) {
    const habia = !!navigator.serviceWorker.controller; let recargado = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (habia && !recargado && !RING_CUR) { recargado = true; location.reload(); } });
    navigator.serviceWorker.addEventListener('message', handleSWMessage);
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(reg => { reg.update().catch(() => {}); })
        .catch(err => { console.warn('[SW] error', err); });
    });
  }
  // Al volver a la app: revisar alarmas y avisar de las que sonaron mientras estaba cerrada
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { tick(); if (DB.loaded) catchUp(); }
  });
  window.addEventListener('focus', () => tick());
  setInterval(tick, 10000);
}

function init() {
  aplicarTema(); wireGlobal(); wireInstall(); render(); load();
  if (typeof Notification !== 'undefined') NOTIF_PERM = Notification.permission;
  window.matchMedia('(prefers-color-scheme:dark)').addEventListener?.('change', () => {
    if ((localStorage.getItem('mi_agenda_theme') || 'auto') === 'auto') actualizarIconoTema('auto');
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
