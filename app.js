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
const ALARM_TIMERS = new Map();
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
const hasAlarm = o => o && (o.recordatorio === true || o.recordatorio === 'true' || o.recordatorio === 1 || o.recordatorio === '1');
const alarmMin = o => {
  const n = parseInt(o && o.recordatorio_min, 10);
  return isNaN(n) || n < 0 ? 0 : n;
};
const alarmLabel = min => {
  const o = ALARM_OPTS.find(x => x.v === min);
  return o ? o.l : (min ? min + ' min antes' : 'A la hora');
};

function parseFechaHora(fecha, hora) {
  if (!fecha) return null;
  const h = (hora && /^\d{2}:\d{2}$/.test(hora)) ? hora : '09:00';
  // Interpretar en zona America/Lima
  const iso = fecha + 'T' + h + ':00';
  // Crear Date en local y ajustar si el navegador no está en Lima (aproximación robusta)
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

function calcAlarmTime(item) {
  if (!hasAlarm(item) || !item.fecha) return null;
  if (item.estado === 'atendido' || item.estado === 'cancelado') return null;
  const base = parseFechaHora(item.fecha, item.hora);
  if (!base) return null;
  const ms = base.getTime() - (alarmMin(item) * 60 * 1000);
  return new Date(ms);
}

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
    if (p === 'granted') { say('Permiso de alarmas concedido'); return true; }
    say('Sin permiso no se pueden programar alarmas', 'error');
    return false;
  } catch (e) {
    say('No se pudo pedir permiso', 'error');
    return false;
  }
}

function clearAllAlarmTimers() {
  ALARM_TIMERS.forEach(id => clearTimeout(id));
  ALARM_TIMERS.clear();
}

function scheduleOneAlarm(item, kind) {
  const when = calcAlarmTime(item);
  if (!when) return;
  const now = Date.now();
  const delay = when.getTime() - now;
  if (delay < -60000) return; // ya pasó hace más de 1 min
  const key = kind + ':' + item.id;
  if (ALARM_TIMERS.has(key)) {
    clearTimeout(ALARM_TIMERS.get(key));
    ALARM_TIMERS.delete(key);
  }
  // Si ya debería sonar (hasta 1 min de retraso), disparar ya
  const fire = () => dispararAlarma(item, kind);
  if (delay <= 0) {
    setTimeout(fire, 400);
    return;
  }
  // setTimeout max ~24.8 días; para alarmas lejanas solo programamos si < 12h
  if (delay > 12 * 60 * 60 * 1000) return;
  const tid = setTimeout(fire, delay);
  ALARM_TIMERS.set(key, tid);
}

function scheduleAllAlarms() {
  clearAllAlarmTimers();
  if (NOTIF_PERM !== 'granted') return;
  (DB.tareas || []).forEach(t => scheduleOneAlarm(t, 'tarea'));
  (DB.notas || []).forEach(n => scheduleOneAlarm(n, 'nota'));
}

async function dispararAlarma(item, kind) {
  if (NOTIF_PERM !== 'granted') return;
  const title = kind === 'nota' ? '📝 Nota' : '🔔 Alarma';
  const body = kind === 'nota'
    ? (String(item.texto || '').slice(0, 120) || 'Recordatorio de nota')
    : (item.titulo || 'Actividad programada');
  const tag = 'alarm-' + kind + '-' + item.id;

  // Preferir Service Worker (más fiable en Android)
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SHOW_ALARM',
      id: item.id,
      kind,
      title,
      body,
      tag
    });
  } else if (typeof Notification !== 'undefined') {
    try {
      new Notification(title, {
        body,
        icon: './icons/icon-192.png',
        tag,
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 120, 300, 120, 300],
        data: { id: item.id, kind }
      });
    } catch (_) {}
  }
  // Feedback in-app
  say(kind === 'nota' ? 'Recordatorio de nota' : '¡Alarma: ' + (item.titulo || '') );
}

function handleSWMessage(e) {
  if (!e.data) return;
  if (e.data.type === 'SNOOZE_ALARM') {
    const id = e.data.id, kind = e.data.kind || 'tarea';
    const list = kind === 'nota' ? DB.notas : DB.tareas;
    const item = (list || []).find(x => String(x.id) === String(id));
    if (!item) return;
    // Reprogramar +10 min desde ahora
    const key = kind + ':' + id;
    if (ALARM_TIMERS.has(key)) clearTimeout(ALARM_TIMERS.get(key));
    const tid = setTimeout(() => dispararAlarma(item, kind), 10 * 60 * 1000);
    ALARM_TIMERS.set(key, tid);
    say('Alarma pospuesta 10 min');
  }
  if (e.data.type === 'DONE_ALARM') {
    const id = e.data.id, kind = e.data.kind || 'tarea';
    if (kind === 'tarea') {
      const t = (DB.tareas || []).find(x => String(x.id) === String(id));
      if (t && pendiente(t)) {
        act('setEstadoTarea', { id: t.id, estado: 'atendido' }, 'Atendida', () => { t.estado = 'atendido'; });
      }
    }
  }
}

function semaforo(t) {
  if (t.estado==='atendido') return 'v-atendido';
  if (t.estado==='cancelado') return 'v-cancelado';
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
    Object.assign(DB,data); DB.loaded=true; LOAD_ERR=''; guardarCache(); render(); scheduleAllAlarms();
    try {
      const r = await api('generarRecurrentes');
      if (r?.creadas>0) {
        say(`${r.creadas} recurrente(s) generada(s)`);
        const fresh = await api('getAll');
        Object.assign(DB,fresh); guardarCache(); render(); scheduleAllAlarms();
      }
    } catch(_){}
  } catch(e) {
    say(e.message,'error');
    if (!DB.loaded) { LOAD_ERR=e.message; render(); }
  }
}

async function refrescar() {
  try { const d=await api('getAll'); Object.assign(DB,d); DB.loaded=true; LOAD_ERR=''; guardarCache(); render(); scheduleAllAlarms(); }
  catch(e) { say(e.message,'error'); }
}

async function act(action,params,msg,cambioLocal) {
  if (cambioLocal) { cambioLocal(); render(); guardarCache(); scheduleAllAlarms(); }
  try { await api(action,params); if(msg) say(msg); }
  catch(e) { say(e.message,'error'); }
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
  if(hasAlarm(t)) meta.push(`<span class="alarm">${icon('bell','sm')} ${esc(alarmLabel(alarmMin(t)))}</span>`);
  if(t.estado==='en_proceso') meta.push('<span class="proc">En proceso</span>');
  if(t.estado==='cancelado') meta.push('<span class="vencido">Cancelada</span>');
  if(v==='v-vencido') meta.push('<span class="vencido">Vencida</span>');
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
  const vencidas=activas.filter(t=>pendiente(t)&&t.fecha<hoy);
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
  const tareas=(DB.tareas||[]).filter(t=>t.estado!=='cancelado'&&(t.fecha===hoy||(t.fecha<hoy&&pendiente(t))))
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
        ${hasAlarm(n)?`<span class="task-meta" style="margin:0"><span class="alarm">${icon('bell','sm')} ${esc(alarmLabel(alarmMin(n)))}</span></span>`:''}
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
    list=list.filter(t=>pendiente(t)&&t.fecha&&t.fecha<hoy);
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

function formTarea(id) {
  const ex=id?DB.tareas.find(x=>String(x.id)===String(id)):null;
  const t=ex||{titulo:'',tipo:'tarea_interna',prioridad:'media',fecha:today(),hora:'',recurrencia:'unica',programada:true,notas:'',recordatorio:false,recordatorio_min:0};
  const recOn = hasAlarm(t);
  const recMin = alarmMin(t);
  const alarmRadios = ALARM_OPTS.map(o =>
    `<label><input type="radio" name="rec_min" value="${o.v}" ${recOn && recMin===o.v?'checked':''}/>${o.l}</label>`
  ).join('');
  abrirModal(`<form id="form-tarea">
    <div class="form-header"><div><p style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase">${ex?'Editar':'Nueva'}</p><h2>${ex?'Editar':'Nueva'} actividad</h2></div><button type="button" class="icon-btn" data-cerrar>${icon('x')}</button></div>
    <div class="form-body">
      <div class="field"><label>Título</label><input name="titulo" required maxlength="200" value="${esc(t.titulo)}" placeholder="Ej: Asistencia técnica..." autofocus/></div>
      <div class="row-2">
        <div class="field"><label>Tipo</label><select name="tipo">${opciones(TIPO_LABEL,t.tipo)}</select></div>
        <div class="field"><label>Prioridad</label><select name="prioridad">${opciones(PRIO_LABEL,t.prioridad)}</select></div>
      </div>
      <div class="row-2">
        <div class="field"><label>Fecha</label><input name="fecha" type="date" required value="${esc(t.fecha)}"/></div>
        <div class="field"><label>Hora</label><input name="hora" type="time" value="${esc(t.hora)}"/></div>
      </div>
      <div class="field"><label>Recurrencia</label><select name="recurrencia">${opciones(REC_LABEL,t.recurrencia)}</select></div>
      <label class="check-line"><input type="checkbox" name="programada" ${t.programada?'checked':''}/><span>Programada</span></label>

      <div class="alarm-field">
        <label class="main-lab"><input type="checkbox" name="recordatorio" id="chk-alarm" ${recOn?'checked':''}/> ${icon('bell','sm')} Alarma / recordatorio</label>
        <div class="alarm-opts" id="alarm-opts" ${recOn?'':'hidden'}>${alarmRadios}</div>
        ${NOTIF_PERM!=='granted'?`<div class="perm-banner" id="perm-banner">${icon('bell')}<div>Para que suene la alarma necesitas permitir notificaciones.</div><button type="button" id="btn-perm">Permitir</button></div>`:''}
      </div>

      <div class="field"><label>Notas</label><textarea name="notas" maxlength="1000">${esc(t.notas)}</textarea></div>
    </div>
    <div class="form-footer">
      ${ex?`<button type="button" class="btn danger" data-eliminar>${icon('trash','sm')}Eliminar</button>`:''}
      <button type="button" class="btn ghost" data-cerrar>Cancelar</button>
      <button type="submit" class="btn primary">${ex?'Guardar':'Crear'}</button>
    </div>
  </form>`);
  const form=$('#form-tarea');
  form.querySelectorAll('[data-cerrar]').forEach(b=>b.addEventListener('click',cerrarModal));
  const chk=$('#chk-alarm'), opts=$('#alarm-opts');
  if(chk) chk.addEventListener('change',()=>{ if(opts) opts.hidden=!chk.checked; });
  const btnPerm=$('#btn-perm');
  if(btnPerm) btnPerm.addEventListener('click',async()=>{
    const ok=await pedirPermisoNotif();
    if(ok){ const b=$('#perm-banner'); if(b) b.remove(); }
  });
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const data=Object.fromEntries(new FormData(form));
    data.programada=form.elements.programada.checked;
    data.recordatorio=!!(form.elements.recordatorio && form.elements.recordatorio.checked);
    data.recordatorio_min = data.recordatorio ? (parseInt(data.rec_min,10)||0) : 0;
    delete data.rec_min;
    if(data.recordatorio && NOTIF_PERM!=='granted'){
      const ok=await pedirPermisoNotif();
      if(!ok) data.recordatorio=false;
    }
    cerrarModal();
    act(ex?'updateTarea':'addTarea', ex?{...data,id:ex.id}:data, data.recordatorio?'Guardado · Alarma programada':'Creada',
      ex?()=>Object.assign(ex,data):()=>DB.tareas.push({id:'tmp_'+Date.now(),estado:'pendiente',...data}));
  });
  const del=form.querySelector('[data-eliminar]');
  if(del) del.addEventListener('click',()=>{if(confirm('¿Eliminar?')){cerrarModal();act('deleteTarea',{id:ex.id},'Eliminada',()=>{DB.tareas=DB.tareas.filter(x=>x!==ex); scheduleAllAlarms()})}});
}

function formNota(id) {
  const ex=id?DB.notas.find(x=>String(x.id)===String(id)):null;
  const n=ex||{texto:'',fecha:today(),hora:'',recordatorio:false,recordatorio_min:0};
  const recOn = hasAlarm(n);
  const recMin = alarmMin(n);
  const alarmRadios = ALARM_OPTS.map(o =>
    `<label><input type="radio" name="rec_min" value="${o.v}" ${recOn && recMin===o.v?'checked':''}/>${o.l}</label>`
  ).join('');
  abrirModal(`<form id="form-nota">
    <div class="form-header"><div><p style="font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase">${ex?'Editar':'Nueva'}</p><h2>${ex?'Editar':'Nueva'} nota</h2></div><button type="button" class="icon-btn" data-cerrar>${icon('x')}</button></div>
    <div class="form-body">
      <div class="row-2">
        <div class="field"><label>Fecha</label><input name="fecha" type="date" required value="${esc(n.fecha)}"/></div>
        <div class="field"><label>Hora (opc.)</label><input name="hora" type="time" value="${esc(n.hora||'')}"/></div>
      </div>
      <div class="field"><label>Nota</label><textarea name="texto" required maxlength="2000" autofocus>${esc(n.texto)}</textarea></div>

      <div class="alarm-field">
        <label class="main-lab"><input type="checkbox" name="recordatorio" id="chk-alarm-n" ${recOn?'checked':''}/> ${icon('bell','sm')} Recordatorio (opcional)</label>
        <div class="alarm-opts" id="alarm-opts-n" ${recOn?'':'hidden'}>${alarmRadios}</div>
        ${NOTIF_PERM!=='granted'?`<div class="perm-banner" id="perm-banner-n">${icon('bell')}<div>Para que suene el recordatorio permite notificaciones.</div><button type="button" id="btn-perm-n">Permitir</button></div>`:''}
      </div>
    </div>
    <div class="form-footer">
      ${ex?`<button type="button" class="btn danger" data-eliminar>${icon('trash','sm')}Eliminar</button>`:''}
      <button type="button" class="btn ghost" data-cerrar>Cancelar</button>
      <button type="submit" class="btn primary">${ex?'Guardar':'Crear'}</button>
    </div>
  </form>`);
  const form=$('#form-nota');
  form.querySelectorAll('[data-cerrar]').forEach(b=>b.addEventListener('click',cerrarModal));
  const chk=$('#chk-alarm-n'), opts=$('#alarm-opts-n');
  if(chk) chk.addEventListener('change',()=>{ if(opts) opts.hidden=!chk.checked; });
  const btnPerm=$('#btn-perm-n');
  if(btnPerm) btnPerm.addEventListener('click',async()=>{
    const ok=await pedirPermisoNotif();
    if(ok){ const b=$('#perm-banner-n'); if(b) b.remove(); }
  });
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const data=Object.fromEntries(new FormData(form));
    data.recordatorio=!!(form.elements.recordatorio && form.elements.recordatorio.checked);
    data.recordatorio_min = data.recordatorio ? (parseInt(data.rec_min,10)||0) : 0;
    delete data.rec_min;
    if(data.recordatorio && NOTIF_PERM!=='granted'){
      const ok=await pedirPermisoNotif();
      if(!ok) data.recordatorio=false;
    }
    cerrarModal();
    act(ex?'updateNota':'addNota', ex?{...data,id:ex.id}:data, data.recordatorio?'Guardado · Recordatorio':'Creada',
      ex?()=>Object.assign(ex,data):()=>DB.notas.push({id:'tmp_'+Date.now(),...data}));
  });
  const del=form.querySelector('[data-eliminar]');
  if(del) del.addEventListener('click',()=>{if(confirm('¿Eliminar?')){cerrarModal();act('deleteNota',{id:ex.id},'Eliminada',()=>{DB.notas=DB.notas.filter(x=>x!==ex); scheduleAllAlarms()})}});
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
  if (isStandalone()) return;
  btn.hidden=false;
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();INSTALL_PROMPT=e;btn.hidden=false});
  window.addEventListener('appinstalled',()=>{INSTALL_PROMPT=null;btn.hidden=true;say('App instalada')});
  btn.addEventListener('click',async()=>{
    if(!INSTALL_PROMPT){ayudaInstalar();return}
    INSTALL_PROMPT.prompt();
    const {outcome}=await INSTALL_PROMPT.userChoice;
    INSTALL_PROMPT=null;
    if(outcome==='accepted'){btn.hidden=true}
  });
}

function wireGlobal() {
  $$('#bottom-nav button').forEach(b=>b.addEventListener('click',()=>go(b.dataset.view)));
  $('#fab').addEventListener('click',()=>VIEW==='notas'?formNota():formTarea());
  $('#btn-theme').addEventListener('click',toggleTema);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')cerrarModal()});
  const setOff=()=>{const o=$('#offline'); if(o) o.hidden=navigator.onLine};
  window.addEventListener('online',()=>{setOff();refrescar()}); window.addEventListener('offline',setOff); setOff();
  if('serviceWorker'in navigator){
    const habia=!!navigator.serviceWorker.controller; let recargado=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{ if(habia&&!recargado){recargado=true;location.reload()} });
    navigator.serviceWorker.addEventListener('message', handleSWMessage);
    window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
  }
  // Reprogramar alarmas al volver a la app (Android)
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible') scheduleAllAlarms();
  });
  window.addEventListener('focus',()=>scheduleAllAlarms());
}

function init() {
  aplicarTema(); wireGlobal(); wireInstall(); render(); load();
  if(typeof Notification!=='undefined') NOTIF_PERM=Notification.permission;
  window.matchMedia('(prefers-color-scheme:dark)').addEventListener?.('change',()=>{
    if((localStorage.getItem('mi_agenda_theme')||'auto')==='auto') actualizarIconoTema('auto');
  });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();