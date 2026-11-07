(() => {
  const VERSION = 'arena-v1.3';
  if (window.__arenaBulkVersion === VERSION) return;
  window.__arenaBulkVersion = VERSION;

  let running = false;
  let zipping = false;
  let pauseRequested = false;
  let runFiles = []; // { n, label: 'A'|'B', ext, data: Uint8Array }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log('[ArenaBulk]', ...a);

  // ---------- status badge ----------
  document.querySelectorAll('.__arenabulk_badge').forEach(e => e.remove());
  const badge = document.createElement('div');
  badge.className = '__arenabulk_badge';
  badge.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#2563eb;color:#fff;padding:8px 12px;border-radius:8px;font:13px Arial;display:none;max-width:320px;box-shadow:0 2px 8px rgba(0,0,0,.25)';
  document.documentElement.appendChild(badge);

  function status(text) {
    log(text);
    badge.textContent = text;
    badge.style.display = text ? 'block' : 'none';
    try { chrome.runtime.sendMessage({ type: 'progress', text }); } catch (e) {}
  }
  const hideBadgeLater = ms => setTimeout(() => { if (!running && !zipping) badge.style.display = 'none'; }, ms);

  async function waitFor(fn, timeout = 30000, step = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (!running) return null;
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };

  // ---------- prompt box + send ----------
  function getBox() {
    const cands = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
    const byHint = cands.find(e => /describe|prompt|ask|message|generate/i.test(
      e.getAttribute('placeholder') || e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || ''));
    return byHint || cands[cands.length - 1] || null;
  }

  const boxText = box => (box.tagName === 'TEXTAREA' ? box.value : box.innerText || '').trim();

  async function typePrompt(box, text) {
    box.focus();
    await sleep(200);
    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
      if (!boxText(box)) {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    }
    await sleep(500);
    return boxText(box).length > 0;
  }

  function composerScope(box) {
    const form = box.closest('form');
    if (form) return form;
    let e = box;
    for (let i = 0; i < 6 && e.parentElement; i++) {
      e = e.parentElement;
      if (e.querySelectorAll('button').length >= 2) return e;
    }
    return box.parentElement || document.body;
  }

  function findSendButton(box) {
    const scope = composerScope(box);
    const btns = [...scope.querySelectorAll('button')].filter(visible);
    return (
      btns.find(b => /send|submit|generate/i.test(b.getAttribute('aria-label') || '') ) ||
      btns.find(b => b.type === 'submit') ||
      [...btns].reverse().find(b => !(b.textContent || '').trim()) ||
      null
    );
  }

  async function submit(box) {
    const btn = await waitFor(() => {
      const b = findSendButton(box);
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 6000);
    if (btn) { btn.click(); return true; }
    box.focus();
    ['keydown', 'keypress', 'keyup'].forEach(t =>
      box.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
    );
    return true;
  }

  // ---------- vote buttons ----------
  const VOTE_RE = {
    A: /\bA\s+is\s+better/i,
    B: /\bB\s+is\s+better/i,
    both_good: /both\s+are\s+good/i,
    both_bad: /both\s+are\s+bad/i
  };

  function findVote(kind) {
    return [...document.querySelectorAll('button, [role="button"], a')].find(b =>
      VOTE_RE[kind].test((b.textContent || '').replace(/\s+/g, ' ')) && visible(b));
  }

  const votesReady = () =>
    Object.keys(VOTE_RE).some(k => {
      const b = findVote(k);
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    });

  function pickVote(choice) {
    if (choice === 'random') return Math.random() < 0.5 ? 'A' : 'B';
    return VOTE_RE[choice] ? choice : 'both_good';
  }

  // ---------- find the two result images ----------
  const imgOK = img => {
    const r = img.getBoundingClientRect();
    return Math.max(img.naturalWidth || 0, r.width || 0) >= 150 && visible(img);
  };

  function panelImage(label) {
    const re = new RegExp('^\\s*(?:assistant|model)\\s*' + label + '\\s*$', 'i');
    const labels = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && re.test(e.textContent || ''));
    const el = labels[labels.length - 1];
    if (el) {
      let p = el;
      for (let i = 0; i < 10 && p.parentElement; i++) {
        p = p.parentElement;
        const img = [...p.querySelectorAll('img')].find(imgOK);
        if (img) return img;
      }
    }
    return null;
  }

  // label paoa na gele: main part er sheshe 2 ta boro image dhore nibo (A, B)
  function fallbackImages() {
    const imgs = [...document.querySelectorAll('img')].filter(i =>
      imgOK(i) && !i.closest('nav, aside, header, form, [role="dialog"]'));
    const last2 = imgs.slice(-2);
    return last2.length === 2 ? { A: last2[0], B: last2[1] } : (last2.length === 1 ? { A: last2[0], B: null } : { A: null, B: null });
  }

  function resultImages() {
    const a = panelImage('A');
    const b = panelImage('B');
    if (a && b && a !== b) return { A: a, B: b };
    return fallbackImages();
  }

  const srcOf = img => (img ? (img.currentSrc || img.src || '') : '');
  const loaded = img => img && img.complete && img.naturalWidth > 0;

  // ---------- image bytes ----------
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const extOf = type => ((type || 'image/png').split('/')[1] || 'png').split('+')[0].replace('jpeg', 'jpg') || 'png';

  async function imageBytes(img) {
    const src = srcOf(img);
    let firstErr = null;
    try {
      const r = await fetch(src, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      return { data: new Uint8Array(await blob.arrayBuffer()), ext: extOf(blob.type) };
    } catch (e) { firstErr = e; }

    if (/^https?:/i.test(src)) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'fetchImage', url: src });
        if (r && r.ok) return { data: b64ToBytes(r.b64), ext: extOf(r.type) };
      } catch (e) {}
    }

    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise(res => c.toBlob(res, 'image/png'));
      if (blob) return { data: new Uint8Array(await blob.arrayBuffer()), ext: 'png' };
    } catch (e) {}

    throw firstErr || new Error('image namano jayni');
  }

  async function captureImages(n, prevSrc) {
    // notun image ashar jonno wait (ager round er image hole abar wait)
    await waitFor(() => {
      const { A } = resultImages();
      return loaded(A) && srcOf(A) !== prevSrc.A;
    }, 25000, 400);
    await sleep(600);
    const { A, B } = resultImages();
    let got = 0;
    for (const [label, img] of [['A', A], ['B', B]]) {
      if (!img) continue;
      if (!loaded(img)) await waitFor(() => loaded(img), 8000, 300);
      try {
        const { data, ext } = await imageBytes(img);
        runFiles.push({ n, label, ext, data });
        got++;
      } catch (e) {
        log('capture fail', label, e);
      }
    }
    prevSrc.A = srcOf(A);
    prevSrc.B = srcOf(B);
    try {
      await chrome.storage.local.set({
        runCount: runFiles.length,
        runCountA: runFiles.filter(f => f.label === 'A').length,
        runCountB: runFiles.filter(f => f.label === 'B').length
      });
    } catch (e) {}
    return got;
  }

  // ---------- zip ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);

      offset += 30 + name.length + size;
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.byteLength !== undefined ? c.byteLength : c.length;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  async function downloadZip(which) {
    if (zipping) { status('ZIP age theke toiri hocche...'); return; }
    zipping = true;
    try {
      const chosen = runFiles.filter(f => which === 'A' ? f.label === 'A' : which === 'B' ? f.label === 'B' : true);
      if (!chosen.length) {
        status('Recent run e kono image nai. Age prompt Start kore chalao.');
        return;
      }
      status('ZIP file toiri hocche...');
      const files = chosen.map(f => ({
        name: `prompt-${String(f.n).padStart(3, '0')}-${f.label}.${f.ext}`,
        data: f.data
      }));
      const zip = makeZip(files);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = URL.createObjectURL(zip);
      a.download = `arena-images-${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      status(`ZIP ready: ${files.length} ta image`);
    } catch (e) {
      status('ZIP error: ' + (e && e.message ? e.message : e));
    } finally {
      zipping = false;
      hideBadgeLater(10000);
    }
  }

  // ---------- new chat ----------
  async function clickNewChat() {
    const el = [...document.querySelectorAll('a, button, [role="button"]')].find(e =>
      /^\s*new\s*chat\s*$/i.test(e.textContent || '') && visible(e));
    if (!el) return false;
    el.click();
    await sleep(2000);
    return true;
  }

  // ---------- pause / state ----------
  const setState = s => { try { chrome.storage.local.set({ runState: s }); } catch (e) {} };

  async function pausePoint(where) {
    if (!pauseRequested) return;
    setState('paused');
    status(`PAUSED: ${where}. Popup e Resume chapo.`);
    while (pauseRequested && running) await sleep(300);
    if (running) { setState('running'); status('Resume kora hocche...'); }
  }

  // ---------- main run ----------
  async function run(prompts, o) {
    const startIdx = Math.max(0, (parseInt(o.startFrom, 10) || 1) - 1);
    if (startIdx >= prompts.length) {
      status(`ERROR: Start number (${startIdx + 1}) prompt sonkha (${prompts.length}) er cheye boro.`);
      return;
    }
    running = true;
    pauseRequested = false;
    if (startIdx === 0) {
      runFiles = [];
      try { await chrome.storage.local.set({ runCount: 0, runCountA: 0, runCountB: 0 }); } catch (e) {}
    }
    try { await chrome.storage.local.set({ lastDone: startIdx }); } catch (e) {}
    setState('running');
    const prevSrc = { A: null, B: null };
    let voted = 0;

    for (let i = startIdx; i < prompts.length && running; i++) {
      const n = `${i + 1}/${prompts.length}`;
      await pausePoint(`Prompt ${n} er age`);
      if (!running) break;

      status(`Prompt ${n}: prompt box khujchi...`);
      const box = await waitFor(getBox, 20000);
      if (!box) { status('ERROR: prompt box paoa jachchhe na (Describe the image... box).'); running = false; break; }

      status(`Prompt ${n}: type kora hocche...`);
      const typed = await typePrompt(box, (o.prefix || '') + prompts[i]);
      if (!typed) { status('ERROR: prompt box e likhte pari ni. Page refresh (F5) kore abar try koro.'); running = false; break; }

      status(`Prompt ${n}: send kora hocche...`);
      await submit(box);

      status(`Prompt ${n}: image generate hocche (A ar B)...`);
      await waitFor(() => !votesReady(), 20000);           // ager vote button gele jabe
      const ready = await waitFor(votesReady, 300000, 500); // notun vote button ashbe
      if (!ready) {
        if (running) { status(`ERROR: Prompt ${n}: vote button ashe ni (timeout). Stop kora holo.`); running = false; }
        break;
      }
      await sleep(1200);

      status(`Prompt ${n}: image save korchi...`);
      const got = await captureImages(i + 1, prevSrc);
      if (!got) log('kono image capture hoyni, prompt', i + 1);

      const kind = pickVote(o.vote);
      const btn = findVote(kind);
      if (!btn) { status('ERROR: vote button paoa jayni: ' + kind); running = false; break; }
      status(`Prompt ${n}: vote deya hocche (${btn.textContent.trim()})...`);
      btn.click();
      voted++;
      try { await chrome.storage.local.set({ lastDone: i + 1 }); } catch (e) {}

      await sleep(800);
      await waitFor(() => !votesReady(), 10000);
      if (!running) break;
      await sleep((o.delay || 0) * 1000);

      if (o.newChat && i < prompts.length - 1) {
        status(`Prompt ${n}: New Chat khulchi...`);
        const ok = await clickNewChat();
        if (!ok) log('New Chat button paoa jayni');
      }
    }

    const finished = running;
    running = false;
    pauseRequested = false;
    setState('idle');
    if (finished) {
      status(`Sesh! ${prompts.length} ta prompt complete, ${runFiles.length} ta image save hoyeche.`);
      if (o.autozip) {
        await sleep(1500);
        await downloadZip(o.which || 'both');
      }
    }
    hideBadgeLater(10000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'start') {
      if (running) { status(pauseRequested ? 'Pause kora ache, popup e Resume chapo.' : 'Age theke cholche.'); return; }
      status('Start message peyechi, shuru korchi...');
      run(msg.prompts, msg);
    }
    if (msg.type === 'stop') { running = false; pauseRequested = false; setState('idle'); status('Stop kora hoyeche.'); }
    if (msg.type === 'pause') {
      if (!running) { status('Kono run cholche na, tai pause kora gelo na.'); return; }
      pauseRequested = true;
      status('Pause request peyechi. Cholte thaka prompt sesh hole thambe...');
    }
    if (msg.type === 'resume') { pauseRequested = false; }
    if (msg.type === 'zip') downloadZip(msg.which || 'both');
    if (msg.type === 'clearRun') { runFiles = []; }
    if (msg.type === 'ping') { sendResponse({ running, paused: pauseRequested }); }
  });

  setState('idle');
  status('Extension ready.');
  hideBadgeLater(3000);
})();
