// background.js - Service Worker MV3
// Automatización + diccionario + gestión de roles + export/import
// + Detener indefinido + Export robusto + Manejo robusto de pestañas (evita "No tab with id")

const HEADERS = [
  'Candidato',
  'Documento',
  'Telefono',
  'Edad',
  'Genero',
  'Email',
  'Fecha',
  'Estado',
  'Fuente'
];
const SHEETS_TIMEOUT_MS = 15000;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 11;

const DEFAULT_STATE = {
  roles: ['DOMICILIARIOS', 'CONDUCTORES', 'AUXILIARES CARGA Y DESCARGA', 'DELIVERY'],
  currentRole: 'DOMICILIARIOS',
  inferGender: true,
  genderMode: 'auto',               // auto | prompt | hybrid
  genderOverrides: {},              // { firstNameLower: 'M'|'F' }
  userGenderDict: {},               // Diccionario de usuario
  estadoMode: 'auto',
  dataByRole: {},
  customRules: {},
  processing: false,
  paused: false,
  queue: [],
  autoMode: 'off',                  // off | capture-on-open | scan-and-process
  scanIntervalSec: 90,
  holdProcessing: false,            // detener procesamiento indefinidamente
  sheetsWebhookUrl: '',
  sheetsApiKey: ''
};
const SHEETS_TIMEOUT_MS = 15000;

const FIXED_RULES = {
  'DOMICILIARIOS': {
    description: 'Hombres 18–50 → Seleccionados. Mujeres / fuera de rango → Descartados.',
    test(row) {
      const e = parseInt(row.Edad || '0', 10);
      return (e >= 18 && e <= 50 && row.Genero === 'M');
    }
  },
  'CONDUCTORES': {
    description: 'Hombres 30–50 → Seleccionados. Resto → Descartados.',
    test(row) {
      const e = parseInt(row.Edad || '0', 10);
      return (e >= 30 && e <= 50 && row.Genero === 'M');
    }
  },
  'DELIVERY': {
    description: 'Hombres o Mujeres 18–50 → Seleccionados. Fuera de rango → Descartados.',
    test(row) {
      const e = parseInt(row.Edad || '0', 10);
      return (e >= 18 && e <= 50);
    }
  },
  'AUXILIARES CARGA Y DESCARGA': {
    description: 'Hombres 18–40 → Seleccionados. Resto → Descartados.',
    test(row) {
      const e = parseInt(row.Edad || '0', 10);
      return (e >= 18 && e <= 40 && row.Genero === 'M');
    }
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get(null);
  if (!st.roles) await chrome.storage.local.set(DEFAULT_STATE);
  await scheduleAutoAlarm();
});

// Alarma periódica para auto-scan
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name !== 'auto-scan') return;
  const st = await chrome.storage.local.get(['autoMode', 'processing', 'paused', 'holdProcessing']);
  if (st.autoMode !== 'scan-and-process') return;
  if (st.holdProcessing) return; // Respetar "Detenido"
  try {
    await scanAllTabsAndQueue();
    if (!st.processing || st.paused) {
      await chrome.storage.local.set({ processing: true, paused: false });
      notifyStatusUpdated();
      processLoop().catch(e => {
        console.error(e);
        toast('Error en procesamiento automático: ' + (e?.message || e), 'err');
      });
    }
  } catch (e) {
    console.error(e);
    toast('Auto-scan tuvo un error: ' + (e?.message || e), 'err');
  }
});

// Captura al completar carga de una pestaña (auto)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab?.url) return;
  if (!isCtDomain(tab.url)) return;

  const st = await chrome.storage.local.get(['autoMode', 'holdProcessing']);
  if (st.holdProcessing) return; // Respetar "Detenido"

  if (st.autoMode === 'capture-on-open' || st.autoMode === 'scan-and-process') {
    if (isCandidateDetailUrl(tab.url)) {
      try { await captureOnTab(tabId); } catch (e) { console.error(e); }
    } else if (st.autoMode === 'scan-and-process') {
      try {
        const links = await collectLinksFromTab(tabId);
        if (links.length) { await mergeQueue(links); notifyStatusUpdated(); }
      } catch (e) { console.error(e); }
    }
  }
});

// Manejo de peticiones de género (promesas en espera)
const pendingGenderRequests = new Map(); // id -> {resolve, timeout}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'capture-current':
          await captureCurrent(); break;
        case 'start-processing-list':
          await addLinksFromList(); await startProcessing(); break;
        case 'toggle-pause':
          await togglePause(); break;
        case 'cancel-processing':                                // NUEVO
          await cancelProcessing(); break;
        case 'resume-processing':                                // NUEVO
          await resumeProcessing(); break;

        case 'export-csv':
          await exportCsvOfCurrentRole(); break;
        case 'export-xls':
          await exportXlsOfCurrentRole(); break;
        case 'export-all-csv':                                   // NUEVO
          await exportAllCsv(); break;
        case 'export-all-xls':                                   // NUEVO
          await exportAllXls(); break;

        case 'clear-role':
          await clearCurrentRole(); break;

        case 'get-status':
          sendResponse(await getStatus()); return;
        case 'get-rules-descriptions':
          sendResponse(await getRulesDescriptions()); return;

        // Reglas personalizadas
        case 'add-or-update-custom-rule':
          await addOrUpdateCustomRule(msg.payload); sendResponse({ ok: true }); return;
        case 'delete-custom-rule':
          await deleteCustomRule(msg.role); sendResponse({ ok: true }); return;

        // Config género
        case 'get-gender-config':
          sendResponse(await getGenderConfig()); return;
        case 'save-gender-config':
          await saveGenderConfig(msg.payload); sendResponse({ ok: true }); return;

        // Diccionario usuario
        case 'get-gender-dict':
          sendResponse(await getGenderDict()); return;
        case 'save-gender-dict':
          await saveGenderDict(msg.payload); sendResponse({ ok: true }); return;
        case 'clear-gender-dict':
          await chrome.storage.local.set({ userGenderDict: {} }); toast('Diccionario de usuario limpiado.', 'ok'); sendResponse({ ok: true }); return;

        // Automatización
        case 'get-automation-config':
          sendResponse(await getAutomationConfig()); return;
        case 'save-automation-config':
          await saveAutomationConfig(msg.payload); sendResponse({ ok: true }); return;

        // Google Sheets / Webhook
        case 'get-sheets-config':
          sendResponse(await getSheetsConfig()); return;
        case 'save-sheets-config':
          await saveSheetsConfig(msg.payload); sendResponse({ ok: true }); return;
        case 'push-to-sheets':
          sendResponse(await pushToSheets(msg.scope)); return;

        // Roles: eliminar / renombrar
        case 'delete-role':
          await deleteRole(msg.role); sendResponse({ ok: true }); return;
        case 'rename-role':
          await renameRole(msg.oldName, msg.newName); sendResponse({ ok: true }); return;

        // Exportar / Importar diccionario
        case 'export-merged-gender-dict':
          await exportMergedGenderDict(); sendResponse({ ok: true }); return;
        case 'import-gender-dict':
          await importGenderDict(msg.payload); sendResponse({ ok: true }); return;

        // Backup
        case 'export-backup':
          await exportBackup(); sendResponse({ ok: true }); return;
        case 'import-backup':
          await importBackup(msg.payload); sendResponse({ ok: true }); return;

        case 'gender-selected': {
          const { id, gender, firstName } = msg;
          const entry = pendingGenderRequests.get(id);
          if (entry) {
            clearTimeout(entry.timeout);
            pendingGenderRequests.delete(id);
            if (gender === 'M' || gender === 'F') {
              const st = await chrome.storage.local.get(['genderOverrides']);
              const ovs = st.genderOverrides || {};
              if (firstName) ovs[firstName.toLowerCase()] = gender;
              await chrome.storage.local.set({ genderOverrides: ovs });
            }
            entry.resolve(gender || '');
          }
          sendResponse({ ok: true });
          return;
        }
      }
      sendResponse({ ok: true });
    } catch (e) {
      console.error(e);
      toast('Error en background: ' + (e?.message || e), 'err');
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});

/* ==========================
   Detener / Reanudar (indefinido)
   ========================== */

async function cancelProcessing() {
  await chrome.storage.local.set({ processing: false, paused: false, holdProcessing: true });
  notifyStatusUpdated();
  toast('Procesamiento detenido. No se reanudará automáticamente.', 'ok');
}

async function resumeProcessing() {
  await chrome.storage.local.set({ holdProcessing: false });
  notifyStatusUpdated();
  toast('Listo para reanudar. Usa "Procesar lista" o "Pausar/Continuar".', 'ok');
}

/* ==========================
   Reglas dinámicas
   ========================== */

async function addOrUpdateCustomRule({ role, ageMin, ageMax, genders }) {
  if (!role) throw new Error('Rol requerido');
  ageMin = parseInt(ageMin, 10);
  ageMax = parseInt(ageMax, 10);
  if (isNaN(ageMin) || isNaN(ageMax) || ageMin > ageMax) {
    throw new Error('Rango de edad inválido');
  }
  if (!Array.isArray(genders) || !genders.length) {
    throw new Error('Debe seleccionar al menos un género');
  }
  const st = await chrome.storage.local.get(['customRules', 'roles']);
  const customRules = st.customRules || {};
  const upper = role.toUpperCase().trim();
  customRules[upper] = {
    ageMin,
    ageMax,
    genders: genders.map(g => g.toUpperCase()),
    description: buildCustomDescription(ageMin, ageMax, genders)
  };

  const roles = st.roles || [];
  if (!roles.includes(upper)) roles.push(upper);

  await chrome.storage.local.set({ customRules, roles });
  toast(`Regla guardada para ${upper}`, 'ok');
}

async function deleteCustomRule(role) {
  const upper = (role || '').toUpperCase();
  const st = await chrome.storage.local.get(['customRules']);
  const customRules = st.customRules || {};
  if (customRules[upper]) {
    delete customRules[upper];
    await chrome.storage.local.set({ customRules });
    toast(`Regla personalizada eliminada para ${upper}`, 'ok');
  }
}

function buildCustomDescription(min, max, genders) {
  const mapped = genders.map(g => g === 'M' ? 'Hombres' : (g === 'F' ? 'Mujeres' : g));
  const gs = mapped.length === 2 ? 'Hombres y Mujeres' : mapped.join(', ');
  return `${gs} ${min}–${max} → Seleccionados; fuera de rango o género distinto → Descartados.`;
}

async function getRulesDescriptions() {
  const st = await chrome.storage.local.get(['customRules', 'roles']);
  const out = {};
  const customs = st.customRules || {};
  for (const r of (st.roles || [])) {
    if (customs[r]) out[r] = customs[r].description;
    else if (FIXED_RULES[r]) out[r] = FIXED_RULES[r].description;
    else out[r] = '(sin reglas: en modo auto todo será Seleccionados)';
  }
  return out;
}

/* ==========================
   Config de género y diccionario
   ========================== */

async function getGenderConfig() {
  const st = await chrome.storage.local.get(['genderMode','genderOverrides','inferGender','userGenderDict']);
  return {
    genderMode: st.genderMode || 'auto',
    genderOverrides: st.genderOverrides || {},
    inferGender: st.inferGender !== false,
    genderDict: st.userGenderDict || {}
  };
}

async function saveGenderConfig({ genderMode, overridesText, inferGender, dictText }) {
  const ovs = {};
  if (overridesText) {
    overridesText.split(/\r?\n/).forEach(line => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return;
      const m = l.match(/^([a-zA-ZÁÉÍÓÚÜÑáéíóúüñ]+)\s*=\s*([MFmf])$/);
      if (m) {
        const name = normalizeFirstName(m[1]);
        if (name) ovs[name.toLowerCase()] = m[2].toUpperCase();
      }
    });
  }

  const dict = {};
  if (dictText) {
    dictText.split(/\r?\n/).forEach(line => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return;
      const m = l.match(/^([a-zA-ZÁÉÍÓÚÜÑáéíóúüñ]+)\s*=\s*([MFmf])$/);
      if (m) {
        const name = normalizeFirstName(m[1]);
        if (name) dict[name.toLowerCase()] = m[2].toUpperCase();
      }
    });
  }

  await chrome.storage.local.set({
    genderMode: genderMode || 'auto',
    genderOverrides: ovs,
    userGenderDict: dict,
    inferGender: !!inferGender
  });
  toast('Configuración de género guardada.', 'ok');
}

async function getGenderDict() {
  const st = await chrome.storage.local.get(['userGenderDict']);
  return st.userGenderDict || {};
}

async function saveGenderDict({ dictText }) {
  const dict = {};
  if (dictText) {
    dictText.split(/\r?\n/).forEach(line => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return;
      const m = l.match(/^([a-zA-ZÁÉÍÓÚÜÑáéíóúüñ]+)\s*=\s*([MFmf])$/);
      if (m) {
        const name = normalizeFirstName(m[1]);
        if (name) dict[name.toLowerCase()] = m[2].toUpperCase();
      }
    });
  }
  await chrome.storage.local.set({ userGenderDict: dict });
  toast('Diccionario de género guardado.', 'ok');
}

/* ==========================
   Automatización
   ========================== */

async function getAutomationConfig() {
  const st = await chrome.storage.local.get(['autoMode','scanIntervalSec']);
  return {
    autoMode: st.autoMode || 'off',
    scanIntervalSec: st.scanIntervalSec || 90
  };
}

async function saveAutomationConfig({ autoMode, scanIntervalSec }) {
  const sec = Math.max(30, parseInt(scanIntervalSec || 90, 10) || 90);
  await chrome.storage.local.set({
    autoMode: autoMode || 'off',
    scanIntervalSec: sec
  });
  await scheduleAutoAlarm();
  toast('Automatización guardada.', 'ok');
}

async function scheduleAutoAlarm() {
  const st = await chrome.storage.local.get(['autoMode','scanIntervalSec']);
  await chrome.alarms.clear('auto-scan');
  if (st.autoMode !== 'scan-and-process') return;
  const minutes = Math.max(1, Math.round((st.scanIntervalSec || 90) / 60));
  chrome.alarms.create('auto-scan', { periodInMinutes: minutes });
}

/* ==========================
   Google Sheets / Webhook
   ========================== */

async function getSheetsConfig() {
  const st = await chrome.storage.local.get(['sheetsWebhookUrl', 'sheetsApiKey']);
  return {
    url: st.sheetsWebhookUrl || '',
    apiKey: st.sheetsApiKey || ''
  };
}

async function saveSheetsConfig({ url, apiKey }) {
  const cleanUrl = (url || '').trim();
  if (cleanUrl) {
    let parsed;
    try { parsed = new URL(cleanUrl); }
    catch (e) { if (e instanceof TypeError) throw new Error('Invalid webhook URL.'); else throw e; }
    if (parsed.protocol !== 'https:') throw new Error('Use HTTPS for the webhook.');
  }
  await chrome.storage.local.set({
    sheetsWebhookUrl: cleanUrl,
    sheetsApiKey: (apiKey || '').trim()
  });
  toast('Configuración de Google Sheets guardada.', 'ok');
}

async function pushToSheets(scope = 'current') {
  const cfg = await getSheetsConfig();
  if (!cfg.url) throw new Error('Configura la URL/Webhook de Google Sheets.');

  const payload = await buildSheetsPayload(scope);
  if (!payload.rows.length) {
    toast('No hay datos válidos para enviar a Sheets.', 'warn');
    return { ok: false, sent: 0 };
  }

  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  if (cfg.apiKey) headers['X-Api-Key'] = cfg.apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEETS_TIMEOUT_MS);
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    mode: 'cors',
    credentials: 'omit',
    signal: controller.signal
  });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Sheets respondió ${res.status}`);
  let json = null;
  try { json = await res.json(); } catch (e) { console.warn('Sheets response was not valid JSON', e); }
  if (json && json.ok === false) {
    throw new Error(json.message || 'Sheets rechazó la solicitud.');
  }
  toast(`Enviadas ${payload.rows.length} filas a Sheets (${scope}).`, 'ok');
  return { ok: true, sent: payload.rows.length };
}

async function buildSheetsPayload(scope = 'current') {
  const st = await chrome.storage.local.get(['dataByRole', 'currentRole', 'roles']);
  const map = st.dataByRole || {};
  const roles = st.roles || [];
  const payloadRows = [];

  if (scope === 'all') {
    for (const r of roles) {
      const rows = (map[r] || []).map(ensureRowShape).filter(isRowValid).map(x => ({ Rol: r, ...x }));
      payloadRows.push(...rows);
    }
  } else {
    const role = st.currentRole;
    const rows = (map[role] || []).map(ensureRowShape).filter(isRowValid).map(x => ({ Rol: role, ...x }));
    payloadRows.push(...rows);
  }

  const snap = await getPendingSnapshotForCurrentTab();
  if (snap && isRowValid(snap)) payloadRows.push({ Rol: st.currentRole, ...snap });

  const merged = dedupeByDocEmail(payloadRows);
  return {
    scope,
    role: st.currentRole,
    exportedAt: new Date().toISOString(),
    rows: merged
  };
}

/* ==========================
   Roles: eliminar / renombrar
   ========================== */

async function deleteRole(role) {
  const upper = (role || '').toUpperCase().trim();
  if (!upper) throw new Error('Rol inválido.');

  const st = await chrome.storage.local.get(['roles','dataByRole','customRules','currentRole']);
  let roles = st.roles || [];
  if (!roles.includes(upper)) { toast('El rol no existe.', 'warn'); return; }

  roles = roles.filter(r => r !== upper);
  const dataByRole = st.dataByRole || {};
  const customRules = st.customRules || {};

  delete dataByRole[upper];
  delete customRules[upper];

  let currentRole = st.currentRole;
  if (currentRole === upper) {
    currentRole = roles[0] || 'DOMICILIARIOS';
  }

  await chrome.storage.local.set({ roles, dataByRole, customRules, currentRole });
  notifyRowsUpdated();
  notifyStatusUpdated();
  toast(`Rol "${upper}" eliminado.`, 'ok');
}

async function renameRole(oldName, newName) {
  const from = (oldName || '').toUpperCase().trim();
  const to = (newName || '').toUpperCase().trim();
  if (!from || !to) throw new Error('Nombres inválidos.');
  if (from === to) { toast('El nombre es el mismo.', 'warn'); return; }

  const st = await chrome.storage.local.get(['roles','dataByRole','customRules','currentRole']);
  const roles = st.roles || [];
  if (!roles.includes(from)) throw new Error('El rol origen no existe.');
  if (roles.includes(to)) throw new Error('El rol destino ya existe.');

  const newRoles = roles.map(r => (r === from ? to : r));
  const dataByRole = st.dataByRole || {};
  const customRules = st.customRules || {};

  if (dataByRole[from]) { dataByRole[to] = dataByRole[from]; delete dataByRole[from]; }
  if (customRules[from]) { customRules[to] = customRules[from]; delete customRules[from]; }

  const currentRole = (st.currentRole === from) ? to : st.currentRole;

  await chrome.storage.local.set({ roles: newRoles, dataByRole, customRules, currentRole });
  notifyRowsUpdated();
  notifyStatusUpdated();
  toast(`Rol renombrado: "${from}" → "${to}".`, 'ok');
}

/* ==========================
   Export / Import Diccionario
   ========================== */

function getMergedGenderDictObject() {
  const base = seedDict();
  return (async () => {
    const st = await chrome.storage.local.get(['userGenderDict','genderOverrides']);
    const usr = st.userGenderDict || {};
    const ovs = st.genderOverrides || {};
    // prioridad: overrides > user > base
    const merged = {};
    // base
    for (const [k, v] of Object.entries(base)) merged[k] = v.g;
    // user
    for (const [k, v] of Object.entries(usr)) merged[k.toLowerCase()] = (v || '').toUpperCase();
    // overrides
    for (const [k, v] of Object.entries(ovs)) merged[k.toLowerCase()] = (v || '').toUpperCase();
    return merged;
  })();
}

async function exportMergedGenderDict() {
  const merged = await getMergedGenderDictObject();
  const keys = Object.keys(merged).sort((a,b) => a.localeCompare(b));
  const total = keys.length;
  const lines = [
    '# Diccionario de género exportado',
    `# Total entradas: ${total}`,
    '# Formato: nombre=G',
    '# Prioridad original: Overrides > Usuario > Base',
    ''
  ];
  for (const k of keys) {
    const g = merged[k];
    if (g === 'M' || g === 'F') lines.push(`${k}=${g}`);
  }
  const txt = lines.join('\n');
  const fname = `diccionario_genero_${formatDateFile(new Date())}.txt`;
  const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(txt);
  await chrome.downloads.download({ url, filename: fname, saveAs: true });
  toast(`Diccionario exportado (${total} nombres).`, 'ok');
}

async function importGenderDict({ text, mode }) {
  const st = await chrome.storage.local.get(['userGenderDict']);
  const current = st.userGenderDict || {};
  const parsed = {};
  (text || '').split(/\r?\n/).forEach(line => {
    const l = line.trim();
    if (!l || l.startsWith('#')) return;
    const m = l.match(/^([a-zA-ZÁÉÍÓÚÜÑáéíóúüñ]+)\s*=\s*([MFmf])$/);
    if (m) {
      const name = normalizeFirstName(m[1]);
      if (name) parsed[name.toLowerCase()] = m[2].toUpperCase();
    }
  });

  let next = {};
  if (mode === 'replace') next = parsed;
  else next = { ...current, ...parsed }; // merge por defecto

  await chrome.storage.local.set({ userGenderDict: next });
  toast(`Diccionario importado (${Object.keys(parsed).length} entradas, modo: ${mode || 'merge'}).`, 'ok');
}

/* ==========================
   Backup (config completa)
   ========================== */

async function exportBackup() {
  const keys = ['roles','customRules','genderMode','genderOverrides','userGenderDict','estadoMode','autoMode','scanIntervalSec','currentRole'];
  const st = await chrome.storage.local.get(keys);
  const payload = {
    meta: { app: 'AutoReclutamiento', version: '0.5.0', createdAt: new Date().toISOString() },
    data: st
  };
  const txt = JSON.stringify(payload, null, 2);
  const fname = `backup_autoreclutamiento_${formatDateFile(new Date())}.json`;
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(txt);
  await chrome.downloads.download({ url, filename: fname, saveAs: true });
  toast('Backup exportado.', 'ok');
}

async function importBackup({ text }) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('JSON inválido'); }
  if (!obj?.data || typeof obj.data !== 'object') throw new Error('Estructura de backup inválida.');
  const allowed = ['roles','customRules','genderMode','genderOverrides','userGenderDict','estadoMode','autoMode','scanIntervalSec','currentRole'];
  const set = {};
  for (const k of allowed) if (k in obj.data) set[k] = obj.data[k];
  await chrome.storage.local.set(set);
  notifyRowsUpdated();
  notifyStatusUpdated();
  toast('Backup importado.', 'ok');
}

/* ==========================
   Captura y procesamiento
   ========================== */

async function captureOnTab(tabId) {
  if (!(await tabExists(tabId))) { toast('La pestaña se cerró antes de capturar.', 'warn'); return; }
  const stEstado = await chrome.storage.local.get(['estadoMode']);
  const estadoMode = stEstado.estadoMode || 'auto';

  const row = await safeExecuteScript(tabId, extractOnPage);
  if (!row || !row.Candidato) {
    toast('No se detectó ficha de candidato (auto).', 'warn');
    return;
  }
  if (/^\s*oferta\b/i.test(row.Candidato || '')) {
    toast('Es una oferta, no ficha (auto).', 'warn');
    return;
  }

  const completed = await ensureGender(row, tabId);
  const decided = await decideAndOptionallyClick(tabId, completed, estadoMode);
  await saveRow(decided);
  notifyRowsUpdated();
  toast(`Guardado (auto): ${decided.Candidato} (${decided.Estado})`, 'ok');
}

async function captureCurrent() {
  const tab = await getActiveTab();
  if (!tab) { toast('No hay pestaña activa.', 'err'); return; }
  await captureOnTab(tab.id);
}

async function addLinksFromList() {
  const tab = await getActiveTab();
  if (!tab) { toast('No hay pestaña activa.', 'err'); return; }

  const links = await collectLinksFromTab(tab.id);
  if (!links.length) {
    toast('No se encontraron enlaces.', 'warn');
    return;
  }
  await mergeQueue(links);
  notifyStatusUpdated();
  toast(`Añadidos ${links.length}.`, 'ok');
}

async function collectLinksFromTab(tabId) {
  const res = await safeExecuteScript(tabId, collectListLinksOnPage);
  return Array.isArray(res) ? res : [];
}

async function mergeQueue(links) {
  const st = await chrome.storage.local.get(['queue']);
  const q = st.queue || [];
  const set = new Set(q);
  let added = 0;
  for (const l of links) {
    if (!set.has(l)) { q.push(l); set.add(l); added++; }
  }
  await chrome.storage.local.set({ queue: q });
  return added;
}

async function scanAllTabsAndQueue() {
  const tabs = await chrome.tabs.query({ url: ['https://*.computrabajo.com/*', 'https://empresa.co.computrabajo.com/*'] });
  let totalAdded = 0;
  for (const t of tabs) {
    try {
      const links = await collectLinksFromTab(t.id);
      totalAdded += await mergeQueue(links);
    } catch {}
  }
  if (totalAdded) toast(`Auto-scan: +${totalAdded} enlaces agregados a la cola.`, 'ok');
}

async function startProcessing() {
  const st = await chrome.storage.local.get(['processing', 'paused', 'holdProcessing']);
  if (st.holdProcessing) {
    toast('Está detenido. Usa "Reanudar" para permitir procesar de nuevo.', 'warn');
    return;
  }
  if (st.processing && !st.paused) {
    toast('Ya procesando.', 'warn');
    return;
  }
  await chrome.storage.local.set({ processing: true, paused: false });
  notifyStatusUpdated();
  processLoop().catch(e => {
    console.error(e);
    toast('Error en procesamiento: ' + (e?.message || e), 'err');
  });
}

async function togglePause() {
  const st = await chrome.storage.local.get(['processing', 'paused', 'holdProcessing']);
  if (st.holdProcessing) {
    toast('Está detenido. Usa "Reanudar" para permitir procesar.', 'warn');
    return;
  }
  if (!st.processing) {
    await chrome.storage.local.set({ processing: true, paused: false });
    notifyStatusUpdated();
    processLoop().catch(e => {
      console.error(e);
      toast('Error al iniciar: ' + (e?.message || e), 'err');
    });
  } else {
    await chrome.storage.local.set({ paused: !st.paused });
    notifyStatusUpdated();
  }
}

async function processLoop() {
  while (true) {
    const st = await chrome.storage.local.get(['processing', 'paused', 'queue', 'estadoMode', 'holdProcessing']);
    if (!st.processing) break;
    if (st.holdProcessing) {
      await chrome.storage.local.set({ processing: false, paused: false });
      notifyStatusUpdated();
      toast('Procesamiento detenido.', 'ok');
      break;
    }
    if (st.paused) { await sleep(400); continue; }
    if (!st.queue?.length) {
      await chrome.storage.local.set({ processing: false, paused: false });
      notifyStatusUpdated();
      toast('Cola vacía. Terminado.', 'ok');
      break;
    }

    const url = st.queue.shift();
    await chrome.storage.local.set({ queue: st.queue });
    notifyStatusUpdated();

    try {
      // Navegación y extracción robustas: crea pestaña si no existe la activa
      const row = await navigateAndExtract(url);
      if (!row || !row.Candidato) { toast('No válido, salto.', 'warn'); continue; }
      if (/^\s*oferta\b/i.test(row.Candidato)) { toast('Era una oferta.', 'warn'); continue; }

      const tab = await getActiveTab();
      const tabId = tab?.id ?? 0;

      const completed = await ensureGender(row, tabId);
      const decided = await decideAndOptionallyClick(tabId, completed, st.estadoMode);
      await saveRow(decided);
      notifyRowsUpdated();
      toast(`OK: ${decided.Candidato} (${decided.Estado})`, 'ok');
      await sleep(250);
    } catch (e) {
      console.error(e);
      toast('Error en un enlace. Continúo.', 'err');
    }
  }
}

/* ==========================
   Género (robusto)
   ========================== */

async function ensureGender(row, tabId) {
  if (row.Genero) return row;
  const st = await chrome.storage.local.get(['genderMode','genderOverrides','inferGender','userGenderDict']);
  const mode = st.genderMode || 'auto';
  const overrides = st.genderOverrides || {};
  const userDict = st.userGenderDict || {};
  const allowInfer = st.inferGender !== false;

  const first = normalizeFirstName(row.Candidato || '');
  if (first && overrides[first.toLowerCase()]) {
    return { ...row, Genero: overrides[first.toLowerCase()] };
  }

  let inferred = '';
  if ((mode === 'auto' || mode === 'hybrid') && allowInfer) {
    inferred = inferGenderByName(row.Candidato || '', userDict).gender || '';
  }

  if (mode === 'auto') return { ...row, Genero: inferred };
  if (mode === 'hybrid' && inferred) return { ...row, Genero: inferred };

  // Si no hay tabId válido, no mostramos prompt (mantener flujo)
  if (!(await tabExists(tabId))) return { ...row, Genero: inferred || '' };

  const chosen = await promptGenderOnPage(tabId, first, inferred);
  return { ...row, Genero: chosen || inferred || '' };
}

function promptGenderOnPage(tabId, firstName, guess) {
  return new Promise((resolve) => {
    const id = 'gender_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => {
      const entry = pendingGenderRequests.get(id);
      if (entry) {
        pendingGenderRequests.delete(id);
        resolve('');
      }
    }, 20000);

    pendingGenderRequests.set(id, { resolve, timeout });

    chrome.tabs.sendMessage(tabId, {
      type: 'ask-gender',
      id,
      firstName,
      guess
    }).catch(() => {
      clearTimeout(timeout);
      pendingGenderRequests.delete(id);
      resolve('');
    });
  });
}

/* ==========================
   Decisión
   ========================== */

async function decideAndOptionallyClick(tabId, row, estadoMode) {
  const st = await chrome.storage.local.get(['currentRole', 'customRules']);
  const role = (st.currentRole || '').toUpperCase();
  let target = 'Seleccionados';

  if (estadoMode === 'manual-seleccionados') target = 'Seleccionados';
  else if (estadoMode === 'manual-descartados') target = 'Descartados';
  else target = decideByRules(role, row, st.customRules || {});

  // Intentar click solo si hay pestaña válida
  if (await tabExists(tabId)) {
    try {
      const ok = await safeExecuteScript(tabId, (t) => {
        const norm = s => (s||'').replace(/\s+/g,' ').trim().toLowerCase();
        const isSel = t.toLowerCase().startsWith('sele');
        const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const btn = all.find(b => {
          const txt = norm(b.innerText);
          return /mover a/i.test(txt) && (isSel ? /seleccionad/.test(txt) : /descartad/.test(txt));
        });
        if (btn) {
          btn.click();
          setTimeout(() => {
            const conf = Array.from(document.querySelectorAll('button, a, [role="button"]'))
              .find(b => /aceptar|confirmar|si|sí/i.test(norm(b.innerText)));
            conf?.click();
          }, 250);
          return true;
        }
        const alt = all.find(b => {
          const txt = norm(b.innerText);
          return isSel ? /seleccionad/.test(txt) : /descartad/.test(txt);
        });
        if (alt) { alt.click(); return true; }
        return false;
      }, [target]);
      if (!ok) toast(`No se pudo hacer clic en ${target}`, 'warn');
    } catch (e) {
      console.error(e);
      toast(`Error al pulsar ${target}`, 'err');
    }
  }

  return { ...row, Estado: target };
}

function decideByRules(role, row, customRules) {
  const custom = customRules[role];
  if (custom) {
    const age = parseInt(row.Edad || '0', 10);
    const gender = (row.Genero || '').toUpperCase();
    if (!isNaN(age) && age >= custom.ageMin && age <= custom.ageMax && custom.genders.includes(gender)) {
      return 'Seleccionados';
    }
    return 'Descartados';
  }
  const fixed = FIXED_RULES[role];
  if (fixed) {
    try { return fixed.test(row) ? 'Seleccionados' : 'Descartados'; }
    catch { return 'Seleccionados'; }
  }
  return 'Seleccionados';
}

/* ==========================
   Storage / export
   ========================== */

async function saveRow(row) {
  const shaped = ensureRowShape(row);
  if (!isRowValid(shaped)) {
    toast('Fila descartada: falta contacto o nombre.', 'warn');
    return;
  }
  if (/^\s*oferta\b/i.test(shaped.Candidato || '')) return;

  const st = await chrome.storage.local.get(['dataByRole', 'currentRole']);
  const role = st.currentRole;
  const map = st.dataByRole || {};
  const rows = map[role] || [];
  const doc = (shaped.Documento || '').toString().trim();
  const email = (shaped.Email || '').toLowerCase().trim();

  let exists = false;
  if (doc) exists = rows.some(r => (r.Documento || '').toString().trim() === doc);
  else if (email) exists = rows.some(r => (r.Email || '').toLowerCase().trim() === email);

  if (!exists) {
    map[role] = [...rows, shaped];
    await chrome.storage.local.set({ dataByRole: map });
  }
}

async function clearCurrentRole() {
  const st = await chrome.storage.local.get(['dataByRole', 'currentRole']);
  const map = st.dataByRole || {};
  map[st.currentRole] = [];
  await chrome.storage.local.set({ dataByRole: map });
  notifyRowsUpdated();
  toast('Datos del rol eliminados.', 'ok');
}

// Dedupe por Documento o Email
function dedupeByDocEmail(rows) {
  const seenDoc = new Set();
  const seenEmail = new Set();
  const out = [];
  for (const r of rows) {
    const doc = (r.Documento || '').toString().trim();
    const email = (r.Email || '').toLowerCase().trim();
    let keep = true;
    if (doc) {
      if (seenDoc.has(doc)) keep = false;
      else seenDoc.add(doc);
    } else if (email) {
      if (seenEmail.has(email)) keep = false;
      else seenEmail.add(email);
    }
    if (keep) out.push(r);
  }
  return out;
}

function isRowValid(r) {
  const nameOk = (r.Candidato || '').trim().length >= 2;
  const phoneDigits = (r.Telefono || '').replace(/\D/g, '');
  const phoneOk = !!phoneDigits && phoneDigits.length >= PHONE_MIN_DIGITS && phoneDigits.length <= PHONE_MAX_DIGITS;
  const email = (r.Email || '').trim();
  const emailOk = email ? /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email) : false;
  return nameOk && (phoneOk || emailOk);
}

// Snapshot de la ficha en curso (se intenta siempre; dedupe evitará duplicados)
async function getPendingSnapshotForCurrentTab() {
  const tab = await getActiveTab();
  if (!tab) return null;
  try {
    const row = await safeExecuteScript(tab.id, extractOnPage);
    if (!row || !row.Candidato) return null;
    if (/^\s*oferta\b/i.test(row.Candidato || '')) return null;
    return ensureRowShape(row);
  } catch {
    return null;
  }
}

async function exportCsvOfCurrentRole() {
  const st = await chrome.storage.local.get(['dataByRole', 'currentRole']);
  const role = st.currentRole;
  const rows = (st.dataByRole || {})[role] || [];

  const outRows = rows.map(ensureRowShape).filter(isRowValid);
  const snap = await getPendingSnapshotForCurrentTab();
  if (snap && isRowValid(snap)) outRows.push(snap);

  const merged = dedupeByDocEmail(outRows);
  if (!merged.length) { toast('No hay datos.', 'warn'); return; }

  const csv = '\ufeff' + toCsv(HEADERS, merged, ';');
  const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  await chrome.downloads.download({
    url,
    filename: `${sanitizeSheetName(role)}.csv`,
    saveAs: true
  });
  toast(`Exportadas ${merged.length} filas CSV.`, 'ok');
}

async function exportXlsOfCurrentRole() {
  const st = await chrome.storage.local.get(['dataByRole', 'currentRole']);
  const role = st.currentRole || 'Hoja';
  const rows = (st.dataByRole || {})[role] || [];

  const outRows = rows.map(ensureRowShape).filter(isRowValid);
  const snap = await getPendingSnapshotForCurrentTab();
  if (snap && isRowValid(snap)) outRows.push(snap);

  const merged = dedupeByDocEmail(outRows);
  if (!merged.length) { toast('No hay datos.', 'warn'); return; }

  const sheetName = sanitizeSheetName(role);
  const xml = buildExcelXml(sheetName, HEADERS, merged, { autoFilter: true });

  const base64 = toBase64(xml);
  const url = 'data:application/vnd.ms-excel;base64,' + base64;
  await chrome.downloads.download({
    url,
    filename: `${sheetName}.xls`,
    saveAs: true
  });
  toast(`Exportadas ${merged.length} filas Excel.`, 'ok');
}

// Exportar TODOS los roles (CSV)
async function exportAllCsv() {
  const st = await chrome.storage.local.get(['dataByRole', 'roles', 'currentRole']);
  const map = st.dataByRole || {};
  const roles = st.roles || [];
  const headersAll = ['Rol', ...HEADERS];

  const all = [];
  for (const r of roles) {
    const shaped = (map[r] || []).map(ensureRowShape).filter(isRowValid).map(x => ({ Rol: r, ...x }));
    all.push(...shaped);
  }
  const snap = await getPendingSnapshotForCurrentTab();
  if (snap && isRowValid(snap)) all.push({ Rol: st.currentRole, ...snap });

  const merged = dedupeByDocEmail(all);
  if (!merged.length) { toast('No hay datos.', 'warn'); return; }

  const csv = '\ufeff' + toCsv(headersAll, merged, ';');
  const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  await chrome.downloads.download({
    url,
    filename: `Todos_los_roles.csv`,
    saveAs: true
  });
  toast(`Exportadas ${merged.length} filas (todos los roles) CSV.`, 'ok');
}

// Exportar TODOS los roles (XLS)
async function exportAllXls() {
  const st = await chrome.storage.local.get(['dataByRole', 'roles', 'currentRole']);
  const map = st.dataByRole || {};
  const roles = st.roles || [];
  const headersAll = ['Rol', ...HEADERS];

  const all = [];
  for (const r of roles) {
    const shaped = (map[r] || []).map(ensureRowShape).filter(isRowValid).map(x => ({ Rol: r, ...x }));
    all.push(...shaped);
  }
  const snap = await getPendingSnapshotForCurrentTab();
  if (snap && isRowValid(snap)) all.push({ Rol: st.currentRole, ...snap });

  const merged = dedupeByDocEmail(all);
  if (!merged.length) { toast('No hay datos.', 'warn'); return; }

  const sheetName = 'Todos';
  const xml = buildExcelXml(sheetName, headersAll, merged, { autoFilter: true });

  const base64 = toBase64(xml);
  const url = 'data:application/vnd.ms-excel;base64,' + base64;
  await chrome.downloads.download({
    url,
    filename: `Todos_los_roles.xls`,
    saveAs: true
  });
  toast(`Exportadas ${merged.length} filas (todos los roles) Excel.`, 'ok');
}

function ensureRowShape(r) {
  let tel = (r.Telefono || '').toString();
  const digitsList = tel.split(/[\/|,]/).map(s => s.replace(/\D/g, '')).filter(Boolean);
  let telOut = '';
  const cells = digitsList.filter(d => d.length === 10 && d.startsWith('3'));
  if (cells.length) telOut = cells[0];
  else if (digitsList.length) telOut = digitsList[0];

  let fecha = r.Fecha;
  if (!fecha) fecha = formatDateShort(new Date());
  if (/^\d{4}-\d{2}-\d{2}/.test(fecha)) {
    const d = new Date(fecha.replace(' ', 'T'));
    fecha = formatDateShort(d);
  }

  return {
    Candidato: r.Candidato || '',
    Documento: (r.Documento || '').toString(),
    Telefono: telOut,
    Edad: (r.Edad || '').toString(),
    Genero: (r.Genero || '').toString(),
    Email: r.Email || '',
    Fecha: fecha,
    Estado: r.Estado || '',
    Fuente: r.Fuente || ''
  };
}

/* ==========================
   Inferencia + diccionarios
   ========================== */

function inferGenderByName(fullName, userDict = {}) {
  const first = normalizeFirstName(fullName);
  if (!first) return { gender: '' };

  const base = seedDict();
  const merged = { ...base, ...(Object.fromEntries(Object.entries(userDict).map(([k,v]) => [k.toLowerCase(), { g: (v || '').toUpperCase() }])) ) };

  if (merged[first]) return { gender: merged[first].g };

  if (first.startsWith('juan')) return { gender: 'M' };
  if (first.startsWith('maria')) return { gender: 'F' };
  if (first.endsWith('o')) return { gender: 'M' };
  if (first.endsWith('a')) {
    const maleExceptions = new Set(['josua','joshua','sasha','andrea']);
    if (!maleExceptions.has(first)) return { gender: 'F' };
  }
  return { gender: '' };
}

function normalizeFirstName(fullName) {
  const s = (fullName || '').toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z\s-]/g, ' ')
    .trim();
  if (!s) return '';
  const tokens = s.split(/\s+/).filter(t => !['de','del','la','las','los','y','e'].includes(t));
  return tokens[0] || '';
}

function seedDict() {
  return {
    'juan': { g:'M' }, 'jhon': { g:'M' }, 'jose': { g:'M' },
    'carlos': { g:'M' }, 'andres': { g:'M' }, 'luis': { g:'M' },
    'maria': { g:'F' }, 'laura': { g:'F' }, 'natalia': { g:'F' },
    'andrea': { g:'F' }, 'paula': { g:'F' }, 'camila': { g:'F' },
    'diana': { g:'F' }, 'daniel': { g:'M' }, 'sebastian': { g:'M' },
    'valentina': { g:'F' }, 'sandra': { g:'F' }, 'oscar': { g:'M' },
    'yessica': { g:'F' }, 'jessica': { g:'F' }, 'yeison': { g:'M' },
    'brayan': { g:'M' }
  };
}

/* ==========================
   Helpers
   ========================== */

function isCtDomain(url) {
  return /https:\/\/(?:.*\.)?computrabajo\.com\/?/i.test(url) || /https:\/\/empresa\.co\.computrabajo\.com\/?/i.test(url);
}
function isCandidateDetailUrl(url) {
  return /MatchCvDetail|CvDetail|Curriculum|Candidate/i.test(url);
}

function formatDateShort(d) {
  const pad = n => String(n).padStart(2,'0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
}
function formatDateFile(d) {
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
}

function toCsv(headers, rows, sep=';') {
  const esc = v => {
    let s = (v ?? '').toString().replace(/\r?\n/g,' ');
    if (s.includes('"') || s.includes(sep)) s = `"${s.replace(/"/g,'""')}"`;
    return s;
  };
  const lines = [];
  lines.push(`sep=${sep}`);
  lines.push(headers.map(esc).join(sep));
  for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(sep));
  return lines.join('\r\n');
}

function buildExcelXml(sheetName, headers, rows, opts={}) {
  const escXml = s => (s ?? '').toString()
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;');

  const maxLen = {};
  headers.forEach(h => maxLen[h] = escXml(h).length);
  rows.forEach(r => headers.forEach(h => {
    const L = escXml(r[h]).length;
    if (L > maxLen[h]) maxLen[h] = L;
  }));
  const charToPts = n => Math.min(120, Math.max(40, n * 6.2));

  const colsXml = headers.map(h =>
    `<Column ss:AutoFitWidth="1" ss:Width="${charToPts(maxLen[h] + 2).toFixed(1)}"/>`
  ).join('');

  const headerRow = `<Row ss:AutoFitHeight="1">` + headers.map(h =>
    `<Cell ss:StyleID="sHeader"><Data ss:Type="String">${escXml(h)}</Data></Cell>`
  ).join('') + `</Row>`;

  const dataRows = rows.map(r =>
    `<Row ss:AutoFitHeight="1">` + headers.map(h =>
      `<Cell><Data ss:Type="String">${escXml(r[h])}</Data></Cell>`
    ).join('') + `</Row>`
  ).join('');

  const autoFilter = opts.autoFilter ? `
    <AutoFilter x:Range="R1C1:R${rows.length+1}C${headers.length}" xmlns="urn:schemas-microsoft-com:office:excel"/>` : '';

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Author>Auto Reclutamiento</Author>
  <Created>${new Date().toISOString()}</Created>
 </DocumentProperties>
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11"/>
  </Style>
  <Style ss:ID="sHeader">
   <Font ss:Bold="1" ss:FontName="Calibri" ss:Size="11" ss:Color="#1F4E79"/>
   <Interior ss:Color="#E2ECF8" ss:Pattern="Solid"/>
   <Borders>
     <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#9CC2E5"/>
   </Borders>
  </Style>
 </Styles>
 <Worksheet ss:Name="${escXml(sanitizeSheetName(sheetName))}">
  <Table ss:FullColumns="1" ss:FullRows="1">
   ${colsXml}
   ${headerRow}
   ${dataRows}
  </Table>
  ${autoFilter}
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <Selected/>
   <FreezePanes/>
   <FrozenNoSplit/>
   <SplitHorizontal>1</SplitHorizontal>
   <TopRowBottomPane>1</TopRowBottomPane>
   <ActivePane>2</ActivePane>
   <ProtectObjects>False</ProtectObjects>
   <ProtectScenarios>False</ProtectScenarios>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;
}

function sanitizeSheetName(name) {
  return (name || 'Hoja').replace(/[\\/?*\[\]:]/g,' ').trim().slice(0,31) || 'Hoja';
}

function toBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
  return tab || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Espera robusta: aborta si la pestaña ya no existe
async function waitTabLoaded(tabId) {
  await sleep(200);
  for (let i=0;i<60;i++){
    if (!(await tabExists(tabId))) throw new Error('tab-closed');
    try {
      const state = await safeExecuteScript(tabId, () => document.readyState);
      if (state === 'interactive' || state === 'complete') return;
    } catch {}
    await sleep(250);
  }
}

function notifyRowsUpdated() { chrome.runtime.sendMessage({ type:'rows-updated' }).catch(()=>{}); }
function notifyStatusUpdated() { chrome.runtime.sendMessage({ type:'status-updated' }).catch(()=>{}); }

async function getStatus() {
  const st = await chrome.storage.local.get(['processing','paused','queue','dataByRole','currentRole','holdProcessing']);
  const rows = (st.dataByRole || {})[st.currentRole || ''] || [];
  return {
    processing: !!st.processing,
    paused: !!st.paused,
    queueLength: st.queue?.length || 0,
    rowsCount: rows.length,
    holdProcessing: !!st.holdProcessing
  };
}

function toast(msg, level='ok') {
  const tag = level === 'err' ? 'error' : (level === 'warn' ? 'warn' : 'log');
  console[tag](`[${level}] ${msg}`);
  chrome.runtime.sendMessage({ type:'toast', level, msg }).catch(()=>{});
}

/* ==========================
   Funciones inyectadas (no modificar id)
   ========================== */

function extractOnPage() {
  const getText = el => (el?.textContent || '').trim();
  const h1 = document.querySelector('h1.fwB.mrAuto.w100_m') || document.querySelector('h1[data-testid="cv-title"]') || document.querySelector('h1');
  let nombre = getText(h1).replace(/^Hoja de vida de\s+/i,'').replace(/\s+/g,' ').trim();

  const panel = document.querySelector('ul.mtB.table.small') || document.querySelector('ul[data-testid="cv-summary"]');
  let email = '';
  let documento = '';
  let edad = '';
  const phones = [];

  if (panel) {
    const lis = Array.from(panel.querySelectorAll('li'));
    const liEmail = lis.find(li =>
      li.querySelector('.i_email') ||
      /e-?mail/i.test(li.querySelector('.icon')?.getAttribute('title') || '') ||
      /\b@[\w.-]+\.[a-z]{2,}\b/i.test(li.textContent)
    );
    if (liEmail) {
      const mailto = liEmail.querySelector('a[href^="mailto:"]');
      email = mailto ? (mailto.getAttribute('href') || '').replace(/^mailto:/i,'').trim()
                     : getText(liEmail.querySelector('.w100')) || (liEmail.textContent.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '');
    }
    const liDoc = lis.find(li =>
      /identific|cedula|c[ée]dula|dni|document/i.test(li.querySelector('.icon')?.getAttribute('title') || '') ||
      /identific|c[ée]dula|document/i.test(li.textContent)
    );
    if (liDoc) {
      const docTxt = getText(liDoc.querySelector('.w100')) || liDoc.textContent;
      const m = docTxt.match(/\b\d{6,12}\b/);
      documento = m ? m[0] : '';
    }
    const liEdad = lis.find(li =>
      /edad/i.test(li.querySelector('.icon')?.getAttribute('title') || '') ||
      /\b\d{1,2}\s*años?/i.test(li.textContent)
    );
    if (liEdad) {
      const eTxt = getText(liEdad.querySelector('.w100')) || liEdad.textContent;
      const m = eTxt.match(/(\d{1,2})\s*años?/i);
      edad = m ? m[1] : '';
    }
    lis.forEach(li => {
      if (
        li.querySelector('.i_mobile') ||
        li.querySelector('.i_whatsapp') ||
        /whatsapp|m(ó|o)vil|celular|tel(é|e)fono/i.test(li.textContent)
      ) {
        const raw =
          getText(li.querySelector('.w100')) ||
          getText(li.querySelector('a[href*="whatsapp"]')) ||
          li.textContent;
        if (!raw) return;
        const found = raw.match(/(?:\+?57[\s-]?)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}|\b\d{7,10}\b/g) || [];
        for (let s of found) phones.push(s);
      }
    });
  }

  const digits = Array.from(new Set(phones.map(s => s.replace(/\D/g,'')).filter(Boolean)));
  const normalized = digits.map(d => d.replace(/^57/,''));
  const cells = normalized.filter(d => d.length === 10 && d.startsWith('3'));
  const others = normalized.filter(d => !(d.length === 10 && d.startsWith('3')) && d.length >= 7 && d.length <= 10);
  let telefono = cells[0] || others[0] || '';
  if (documento && telefono && telefono === documento) {
    if (cells.length > 1) telefono = cells[1];
    else if (others.length > 1) telefono = others[1];
    else telefono = '';
  }

  if (!nombre && !email && !telefono) return null;

  return {
    Candidato: nombre || '',
    Documento: documento || '',
    Telefono: telefono || '',
    Edad: (edad || '').toString(),
    Genero: '',
    Estado: '',
    Email: email || '',
    Fuente: location.href,
    Fecha: ''
  };
}

function collectListLinksOnPage() {
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const links = anchors.map(a => a.href).filter(h => /MatchCvDetail|CvDetail|Curriculum|Candidate/i.test(h));
  return Array.from(new Set(links));
}

function clickMoveButtonOnPage(target) {
  const norm = s => (s||'').replace(/\s+/g,' ').trim().toLowerCase();
  const isSel = target.toLowerCase().startsWith('sele');
  const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const btn = all.find(b => {
    const t = norm(b.innerText);
    return /mover a/i.test(t) && (isSel ? /seleccionad/.test(t) : /descartad/.test(t));
  });
  if (btn) {
    btn.click();
    setTimeout(() => {
      const conf = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .find(b => /aceptar|confirmar|si|sí/i.test(norm(b.innerText)));
      conf?.click();
    }, 250);
    return true;
  }
  const alt = all.find(b => {
    const t = norm(b.innerText);
    return isSel ? /seleccionad/.test(t) : /descartad/.test(t);
  });
  if (alt) { alt.click(); return true; }
  return false;
}

/* ==========================
   Robustez de pestañas
   ========================== */

// ¿Existe la pestaña?
async function tabExists(tabId) {
  if (tabId === undefined || tabId === null) return false;
  try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}

// Ejecuta script y devuelve result, devolviendo null si la pestaña no existe.
// Permite pasar argumentos opcionales.
async function safeExecuteScript(tabId, func, args = []) {
  try {
    await chrome.tabs.get(tabId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args
    });
    return result;
  } catch (e) {
    if (e && /No tab with id/i.test(String(e.message || e))) {
      console.warn('safeExecuteScript: pestaña no existe, se omite.');
      return null;
    }
    throw e;
  }
}

// Navega al URL en una pestaña existente (si hay), o crea una nueva si falla.
// Devuelve la fila extraída o null.
async function navigateAndExtract(url) {
  // 1) intenta en pestaña activa
  let tab = await getActiveTab();
  if (tab && await tabExists(tab.id)) {
    try {
      await chrome.tabs.update(tab.id, { url });
      await waitTabLoaded(tab.id);
      const row = await safeExecuteScript(tab.id, extractOnPage);
      if (row) return row;
    } catch (e) {
      if (!/tab-closed|No tab with id/i.test(String(e?.message || e))) {
        console.warn('navigateAndExtract (active) error:', e);
      }
    }
  }
  // 2) crea nueva pestaña y extrae
  try {
    const created = await chrome.tabs.create({ url, active: true });
    await waitTabLoaded(created.id);
    const row = await safeExecuteScript(created.id, extractOnPage);
    return row;
  } catch (e) {
    console.error('navigateAndExtract (create) error:', e);
    return null;
  }
}
