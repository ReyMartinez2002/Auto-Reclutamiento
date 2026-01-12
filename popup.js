const DEFAULT_ROLES = [
  'DOMICILIARIOS',
  'CONDUCTORES',
  'AUXILIARES CARGA Y DESCARGA',
  'DELIVERY'
];

const roleSelect = document.getElementById('roleSelect');
const roleCustom = document.getElementById('roleCustom');
const btnAddRole = document.getElementById('btnAddRole');
const newRoleName = document.getElementById('newRoleName');
const btnRenameRole = document.getElementById('btnRenameRole');
const btnDeleteRole = document.getElementById('btnDeleteRole');

const inferGender = document.getElementById('inferGender');
const estadoMode = document.getElementById('estadoMode');
const genderMode = document.getElementById('genderMode');
const overridesText = document.getElementById('overridesText');
const btnSaveGender = document.getElementById('btnSaveGender');
const btnClearOverrides = document.getElementById('btnClearOverrides');

// Diccionario usuario
const dictText = document.getElementById('dictText');
const btnSaveDict = document.getElementById('btnSaveDict');
const btnClearDict = document.getElementById('btnClearDict');
const btnExportDict = document.getElementById('btnExportDict');
const btnImportDict = document.getElementById('btnImportDict');
const fileImportDict = document.getElementById('fileImportDict');
const chkMergeDict = document.getElementById('chkMergeDict');

// Automatización
const autoMode = document.getElementById('autoMode');
const scanInterval = document.getElementById('scanInterval');
const btnSaveAuto = document.getElementById('btnSaveAuto');

// Google Sheets / Webhook
const sheetsUrl = document.getElementById('sheetsUrl');
const sheetsApiKey = document.getElementById('sheetsApiKey');
const btnSaveSheets = document.getElementById('btnSaveSheets');
const btnSendSheets = document.getElementById('btnSendSheets');
const btnSendSheetsAll = document.getElementById('btnSendSheetsAll');

const btnCapture = document.getElementById('btnCapture');
const btnProcessList = document.getElementById('btnProcessList');
const btnTogglePause = document.getElementById('btnTogglePause');
const btnCancelProcessing = document.getElementById('btnCancelProcessing'); // NUEVO
const btnExport = document.getElementById('btnExport');
const btnExportXls = document.getElementById('btnExportXls');
const btnExportAllCsv = document.getElementById('btnExportAllCsv'); // NUEVO
const btnExportAllXls = document.getElementById('btnExportAllXls'); // NUEVO
const btnClear = document.getElementById('btnClear');
const btnRefreshRules = document.getElementById('btnRefreshRules');

const statusInfo = document.getElementById('statusInfo');
const statusBadge = document.getElementById('statusBadge');
const rulesInfo = document.getElementById('rulesInfo');

const btnSaveRule = document.getElementById('btnSaveRule');
const btnDeleteRule = document.getElementById('btnDeleteRule');
const ageMin = document.getElementById('ageMin');
const ageMax = document.getElementById('ageMax');

const btnExportBackup = document.getElementById('btnExportBackup');
const btnImportBackup = document.getElementById('btnImportBackup');
const fileImportBackup = document.getElementById('fileImportBackup');

let lastStatus = null;

init().catch(console.error);

async function init() {
  const st = await chrome.storage.local.get({
    roles: DEFAULT_ROLES,
    currentRole: DEFAULT_ROLES[0],
    inferGender: true,
    estadoMode: 'auto',
    customRules: {}
  });

  fillRoles(st.roles, st.currentRole);
  inferGender.checked = !!st.inferGender;
  estadoMode.value = st.estadoMode || 'auto';

  await loadGenderConfig();
  await loadGenderDict();
  await loadAutomation();
  await loadSheetsConfig();
  await refreshStatus();
  await refreshRulesDescription();

  roleSelect.addEventListener('change', async () => {
    await chrome.storage.local.set({ currentRole: roleSelect.value });
    await refreshRulesDescription();
    await refreshStatus();
    loadCustomRuleFields();
  });

  btnAddRole.addEventListener('click', addRole);
  btnRenameRole.addEventListener('click', renameRole);
  btnDeleteRole.addEventListener('click', deleteRole);

  inferGender.addEventListener('change', () => chrome.storage.local.set({ inferGender: inferGender.checked }));
  estadoMode.addEventListener('change', () => chrome.storage.local.set({ estadoMode: estadoMode.value }));

  btnCapture.addEventListener('click', () => sendBg({ type: 'capture-current' }));
  btnProcessList.addEventListener('click', () => sendBg({ type: 'start-processing-list' }));

  btnTogglePause.addEventListener('click', async () => {
    const st = await chrome.runtime.sendMessage({ type: 'get-status' });
    lastStatus = st;
    if (st.holdProcessing) {
      await sendBg({ type: 'resume-processing' });
    } else {
      await sendBg({ type: 'toggle-pause' });
    }
    await refreshStatus();
  });

  btnCancelProcessing.addEventListener('click', async () => {
    await sendBg({ type: 'cancel-processing' });
    await refreshStatus();
  });

  btnExport.addEventListener('click', () => sendBg({ type: 'export-csv' }));
  btnExportXls.addEventListener('click', () => sendBg({ type: 'export-xls' }));
  btnExportAllCsv.addEventListener('click', () => sendBg({ type: 'export-all-csv' }));
  btnExportAllXls.addEventListener('click', () => sendBg({ type: 'export-all-xls' }));

  btnClear.addEventListener('click', async () => {
    if (!confirm('¿Vaciar datos del rol actual?')) return;
    await sendBg({ type: 'clear-role' });
    await refreshStatus();
  });

  btnSaveRule.addEventListener('click', saveCustomRule);
  btnDeleteRule.addEventListener('click', deleteCustomRuleRule);
  btnRefreshRules.addEventListener('click', refreshRulesDescription);

  btnSaveGender.addEventListener('click', saveGenderConfig);
  btnClearOverrides.addEventListener('click', () => {
    if (!confirm('¿Limpiar overrides de nombres?')) return;
    overridesText.value = '';
    saveGenderConfig();
  });

  btnSaveDict.addEventListener('click', saveGenderDict);
  btnClearDict.addEventListener('click', async () => {
    if (!confirm('¿Limpiar diccionario de usuario?')) return;
    dictText.value = '';
    await chrome.runtime.sendMessage({ type: 'clear-gender-dict' });
  });
  btnExportDict.addEventListener('click', () => sendBg({ type: 'export-merged-gender-dict' }));
  btnImportDict.addEventListener('click', () => fileImportDict.click());
  fileImportDict.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const mode = chkMergeDict.checked ? 'merge' : 'replace';
    await chrome.runtime.sendMessage({ type: 'import-gender-dict', payload: { text, mode } });
    await loadGenderDict();
    e.target.value = '';
  });

  genderMode.addEventListener('change', saveGenderConfig);
  btnSaveAuto.addEventListener('click', saveAutomation);
  btnSaveSheets.addEventListener('click', saveSheetsConfig);
  btnSendSheets.addEventListener('click', () => sendSheets('current'));
  btnSendSheetsAll.addEventListener('click', () => sendSheets('all'));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'rows-updated' || msg?.type === 'status-updated') {
      refreshStatus();
    }
  });

  btnExportBackup.addEventListener('click', () => sendBg({ type: 'export-backup' }));
  btnImportBackup.addEventListener('click', () => fileImportBackup.click());
  fileImportBackup.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    await chrome.runtime.sendMessage({ type: 'import-backup', payload: { text } });
    await init(); // recargar todo
  });

  loadCustomRuleFields();
}

/* ===== Config género + diccionario ===== */

async function loadGenderConfig() {
  const cfg = await chrome.runtime.sendMessage({ type: 'get-gender-config' }).catch(()=>null);
  if (!cfg) return;
  genderMode.value = cfg.genderMode || 'auto';
  inferGender.checked = !!cfg.inferGender;
  overridesText.value = Object.entries(cfg.genderOverrides || {})
    .map(([name,g]) => `${name}=${g}`).join('\n');
}

async function saveGenderConfig() {
  await chrome.runtime.sendMessage({
    type: 'save-gender-config',
    payload: {
      genderMode: genderMode.value,
      overridesText: overridesText.value,
      inferGender: inferGender.checked,
      dictText: dictText.value
    }
  });
}

async function loadGenderDict() {
  const dict = await chrome.runtime.sendMessage({ type: 'get-gender-dict' }).catch(()=>null);
  if (!dict) return;
  dictText.value = Object.entries(dict || {})
    .map(([name,g]) => `${name}=${g}`).join('\n');
}

async function saveGenderDict() {
  await chrome.runtime.sendMessage({
    type: 'save-gender-dict',
    payload: { dictText: dictText.value }
  });
}

/* ===== Automatización ===== */

async function loadAutomation() {
  const cfg = await chrome.runtime.sendMessage({ type: 'get-automation-config' }).catch(()=>null);
  if (!cfg) return;
  autoMode.value = cfg.autoMode || 'off';
  scanInterval.value = cfg.scanIntervalSec || 90;
}

async function saveAutomation() {
  await chrome.runtime.sendMessage({
    type: 'save-automation-config',
    payload: {
      autoMode: autoMode.value,
      scanIntervalSec: parseInt(scanInterval.value, 10) || 90
    }
  });
}

/* ===== Google Sheets / Webhook ===== */

async function loadSheetsConfig() {
  const cfg = await chrome.runtime.sendMessage({ type: 'get-sheets-config' }).catch(()=>null);
  if (!cfg) return;
  sheetsUrl.value = cfg.url || '';
  sheetsApiKey.value = cfg.apiKey || '';
}

async function saveSheetsConfig() {
  try {
    await chrome.runtime.sendMessage({
      type: 'save-sheets-config',
      payload: { url: sheetsUrl.value, apiKey: sheetsApiKey.value }
    });
  } catch (e) {
    const msg = 'No se pudo guardar: ' + (e?.message || e);
    console.error(msg);
    statusInfo.textContent = msg;
  }
}

async function sendSheets(scope) {
  try {
    await chrome.runtime.sendMessage({ type: 'push-to-sheets', scope });
    await refreshStatus();
  } catch (e) {
    const msg = 'No se pudo enviar a Sheets: ' + (e?.message || e);
    console.error(msg);
    statusInfo.textContent = msg;
  }
}

/* ===== Roles y reglas ===== */

function fillRoles(roles, current) {
  roleSelect.innerHTML = '';
  roles.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === current) opt.selected = true;
    roleSelect.appendChild(opt);
  });
}

async function addRole() {
  const v = roleCustom.value.trim();
  if (!v) return;
  const upper = v.toUpperCase();
  const st = await chrome.storage.local.get(['roles']);
  const roles = st.roles || [];
  if (!roles.includes(upper)) roles.push(upper);
  await chrome.storage.local.set({ roles, currentRole: upper });
  fillRoles(roles, upper);
  roleCustom.value = '';
  await refreshRulesDescription();
  await refreshStatus();
  loadCustomRuleFields();
}

async function renameRole() {
  const oldName = roleSelect.value;
  const newName = newRoleName.value.trim();
  if (!newName) { alert('Ingresa el nuevo nombre del rol.'); return; }
  try {
    await chrome.runtime.sendMessage({ type: 'rename-role', oldName, newName });
    const st = await chrome.storage.local.get(['roles','currentRole']);
    fillRoles(st.roles || [], st.currentRole);
    newRoleName.value = '';
    await refreshRulesDescription();
    await refreshStatus();
    loadCustomRuleFields();
  } catch (e) {
    alert('No se pudo renombrar: ' + (e?.message || e));
  }
}

async function deleteRole() {
  const role = roleSelect.value;
  if (!role) return;
  if (!confirm(`¿Eliminar el rol "${role}" y sus datos/reglas?`)) return;
  await chrome.runtime.sendMessage({ type: 'delete-role', role });
  const st = await chrome.storage.local.get(['roles','currentRole']);
  fillRoles(st.roles || [], st.currentRole);
  await refreshRulesDescription();
  await refreshStatus();
  loadCustomRuleFields();
}

async function refreshRulesDescription() {
  try {
    const desc = await chrome.runtime.sendMessage({ type: 'get-rules-descriptions' });
    const role = roleSelect.value.toUpperCase();
    rulesInfo.textContent = desc?.[role] || '(sin reglas definidas)';
  } catch {
    rulesInfo.textContent = '(no se pudo obtener reglas)';
  }
}

async function refreshStatus() {
  const st = await chrome.runtime.sendMessage({ type: 'get-status' });
  lastStatus = st;

  const estadoTxt = st.holdProcessing
    ? 'Detenido'
    : (st.processing ? (st.paused ? 'En pausa' : 'Procesando') : 'Inactivo');

  statusInfo.textContent = `Estado: ${estadoTxt} · Cola: ${st.queueLength} · Filas rol: ${st.rowsCount}`;
  statusBadge.textContent = estadoTxt;
  statusBadge.className = 'badge ' + (st.holdProcessing ? 'warn' : (st.processing ? (st.paused ? 'warn' : 'ok') : ''));

  // Botón Pausar/Continuar/Reanudar
  if (st.holdProcessing) btnTogglePause.textContent = 'Reanudar';
  else btnTogglePause.textContent = st.paused ? 'Continuar' : 'Pausar';
}

function sendBg(payload) {
  return chrome.runtime.sendMessage(payload);
}

/* ===== Reglas personalizadas ===== */

async function loadCustomRuleFields() {
  const st = await chrome.storage.local.get(['customRules']);
  const role = (roleSelect.value || '').toUpperCase();
  const cr = st.customRules?.[role];
  if (cr) {
    ageMin.value = cr.ageMin;
    ageMax.value = cr.ageMax;
    document.querySelectorAll('.gchk').forEach(chk => {
      chk.checked = cr.genders.includes(chk.value);
    });
  } else {
    switch (role) {
      case 'DOMICILIARIOS': ageMin.value = 18; ageMax.value = 50; break;
      case 'CONDUCTORES': ageMin.value = 30; ageMax.value = 50; break;
      case 'DELIVERY': ageMin.value = 18; ageMax.value = 50; break;
      case 'AUXILIARES CARGA Y DESCARGA': ageMin.value = 18; ageMax.value = 40; break;
      default: ageMin.value = 18; ageMax.value = 50;
    }
    document.querySelectorAll('.gchk').forEach(chk => {
      chk.checked = true;
      if (['DOMICILIARIOS','CONDUCTORES','AUXILIARES CARGA Y DESCARGA'].includes(role)) {
        chk.checked = (chk.value === 'M');
      }
    });
  }
}

async function saveCustomRule() {
  const role = roleSelect.value;
  const genders = Array.from(document.querySelectorAll('.gchk'))
    .filter(c => c.checked)
    .map(c => c.value);
  if (!genders.length) { alert('Selecciona al menos un género.'); return; }
  try {
    await sendBg({
      type: 'add-or-update-custom-rule',
      payload: { role, ageMin: ageMin.value, ageMax: ageMax.value, genders }
    });
    await refreshRulesDescription();
  } catch (e) {
    alert('Error guardando: ' + (e?.message || e));
  }
}

async function deleteCustomRuleRule() {
  if (!confirm('¿Eliminar regla personalizada de este rol?')) return;
  await sendBg({ type: 'delete-custom-rule', role: roleSelect.value });
  await refreshRulesDescription();
  loadCustomRuleFields();
}
