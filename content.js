/* content.js
   Versión robusta con soporte de prompt de género. Sin cambios mayores funcionales,
   ya que la automatización se gestiona desde el background (MV3).
*/

(() => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ask-gender') {
      buildGenderOverlay(msg.id, msg.firstName, msg.guess);
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'force-extract') {
      const data = extractOnPage();
      sendResponse?.({ ok: true, data });
    }
    return true;
  });

  function extractOnPage() {
    const getText = (el) => (el?.textContent || '').trim();
    // Nombre
    let nombre = '';
    const titleSelectors = [
      'h1.fwB.mrAuto.w100_m',
      'h1[data-testid="cv-title"]',
      'h1'
    ];
    for (const sel of titleSelectors) {
      const h = document.querySelector(sel);
      if (h) {
        nombre = getText(h)
          .replace(/^Hoja de vida de\s+/i, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (nombre) break;
      }
    }

    // Panel
    const panel = document.querySelector('ul.mtB.table.small') ||
                  document.querySelector('ul[data-testid="cv-summary"]');
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
        email = mailto
          ? (mailto.getAttribute('href') || '').replace(/^mailto:/i, '').trim()
          : getText(liEmail.querySelector('.w100')) || findEmailInText(liEmail.textContent);
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

    const telefono = pickBestPhone(phones, documento);

    if (!nombre && !email && !telefono) return null;

    return {
      Candidato: nombre || '',
      Documento: documento || '',
      Telefono: telefono || '',
      Edad: edad || '',
      Genero: '',
      Estado: '',
      Email: email || '',
      Fuente: location.href,
      Fecha: ''
    };
  }

  function findEmailInText(txt) {
    const m = (txt || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0] : '';
  }

  function pickBestPhone(phones, documento) {
    const digits = Array.from(
      new Set(
        phones
          .map(s => s.replace(/\D/g, ''))
          .filter(Boolean)
      )
    );
    const normalized = digits.map(d => d.replace(/^57/, ''));
    const cells = normalized.filter(d => d.length === 10 && d.startsWith('3'));
    const others = normalized.filter(d => !(d.length === 10 && d.startsWith('3')) && d.length >= 7 && d.length <= 10);
    let telefono = '';
    if (cells.length) telefono = cells[0];
    else if (others.length) telefono = others[0];

    if (documento && telefono && telefono === documento) {
      if (cells.length > 1) telefono = cells[1];
      else if (others.length > 1) telefono = others[1];
      else telefono = '';
    }
    return telefono;
  }

  function buildGenderOverlay(id, firstName, guess) {
    if (document.getElementById('__gender_overlay_ct')) return;

    const root = document.createElement('div');
    root.id = '__gender_overlay_ct';
    root.innerHTML = `
      <div style="
        position:fixed;inset:0;z-index:999999;
        display:flex;align-items:center;justify-content:center;
        background:rgba(15,20,26,0.55);backdrop-filter:blur(3px);
        font-family:system-ui,Arial,sans-serif;">
        <div style="background:#1e252d;border:1px solid #2d3945;min-width:300px;max-width:340px;
          padding:18px 18px 16px;border-radius:12px;box-shadow:0 10px 32px -10px rgba(0,0,0,0.65),
          0 0 0 1px rgba(255,255,255,0.05);color:#e8eef5;position:relative;">
          <h3 style="margin:0 0 8px;font-size:15px;letter-spacing:.3px;">Confirmar género</h3>
          <p style="margin:0 0 10px;font-size:12.5px;line-height:1.35;color:#b9c4d0;">
            Nombre: <strong>${escapeHtml(firstName || '(sin nombre)')}</strong><br>
            Selecciona el género del candidato.
            ${guess ? `<br><em style="color:#82b2ff">Sugerencia: ${guess==='M'?'Hombre':'Mujer'}</em>` : ''}
          </p>
          <div style="display:flex;gap:8px;margin-bottom:10px;">
            <button data-g="M" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid #2e3d4c;
              background:${guess==='M'?'linear-gradient(135deg,#1e7bff,#1552c8)':'#25313b'};
              color:${guess==='M'?'#fff':'#dbe4ec'};cursor:pointer;font-weight:500;">Hombre (M)</button>
            <button data-g="F" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid #2e3d4c;
              background:${guess==='F'?'linear-gradient(135deg,#d94eb0,#ab2e82)':'#25313b'};
              color:${guess==='F'?'#fff':'#dbe4ec'};cursor:pointer;font-weight:500;">Mujer (F)</button>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <button id="__btn_skip_gender" style="background:#394653;
              border:1px solid #465665;color:#cdd7e1;
              padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;">Sin definir</button>
            <button id="__btn_cancel_gender" style="background:#2a333c;border:1px solid #3a4854;
              color:#96a6b4;padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;">Cancelar</button>
          </div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    const send = (gender) => {
      chrome.runtime.sendMessage({ type: 'gender-selected', id, gender, firstName })
        .catch(()=>{});
      root.remove();
    };

    root.querySelectorAll('button[data-g]').forEach(btn =>
      btn.addEventListener('click', () => send(btn.getAttribute('data-g')))
    );
    root.querySelector('#__btn_skip_gender').addEventListener('click', () => send(''));
    root.querySelector('#__btn_cancel_gender').addEventListener('click', () => send(''));
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'
    }[c]));
  }

  // Exponer utilidades para depuración
  window.__AutoRecruitExtractor = {
    extractOnPage,
    _testPhones: pickBestPhone
  };
})();