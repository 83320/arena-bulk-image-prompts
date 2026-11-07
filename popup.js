const $ = id => document.getElementById(id);

// ---- prompt split logic ----
const HEADING_RE = /^[\s*_#>]*(?:prompt|image|scene|page|idea)?\s*#?\s*\d+\s*\\?\s*[:.)\-\u2013\u2014][*_]*(?:\s+(.*))?\s*$/i;

function clean(lines) {
  return lines.map(s => s.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function parsePrompts(text, mode) {
  const lines = text.replace(/\r/g, '').split('\n');
  const headingCount = lines.filter(l => HEADING_RE.test(l)).length;
  const hasBlank = /\n\s*\n/.test(text.trim());

  if (mode === 'auto') {
    if (headingCount >= 2) mode = 'heading';
    else if (hasBlank) mode = 'blank';
    else mode = 'line';
  }

  if (mode === 'line') {
    return lines.map(s => s.trim()).filter(Boolean);
  }
  if (mode === 'blank') {
    return text.replace(/\r/g, '').split(/\n\s*\n/).map(b => clean(b.split('\n'))).filter(Boolean);
  }
  // heading mode: "Prompt 12:" ba "12." theke shuru kore porer heading porjonto ek prompt
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (cur) blocks.push(cur);
      cur = [m[1] || ''];
    } else if (line.trim()) {
      if (!cur) cur = [];
      cur.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return blocks.map(clean).filter(Boolean);
}

function refreshCount() {
  const p = parsePrompts($('prompts').value, $('mode').value);
  $('count').textContent = `${p.length} ta prompt paoa gelo`;
  $('preview').textContent = p.length ? 'Prothom prompt: ' + p[0].slice(0, 140) + (p[0].length > 140 ? '...' : '') : '';
}

const KEYS = ['prompts', 'prefix', 'delay', 'autozip', 'newchat', 'mode', 'vote', 'which', 'promptScroll', 'promptCaret'];

chrome.storage.local.get(KEYS, d => {
  if (d.prompts) $('prompts').value = d.prompts;
  if (d.prefix !== undefined) $('prefix').value = d.prefix;
  if (d.delay !== undefined) $('delay').value = d.delay;
  if (d.mode) $('mode').value = d.mode;
  if (d.vote) $('vote').value = d.vote;
  if (d.which) $('which').value = d.which;
  $('autozip').checked = !!d.autozip;
  $('newchat').checked = !!d.newchat;
  refreshCount();

  // popup khulle textbox ager jaygay (na thakle shesh prompt e) thakbe
  setTimeout(() => {
    const ta = $('prompts');
    ta.focus();
    if (typeof d.promptScroll === 'number' && d.prompts) {
      const pos = Math.min(d.promptCaret || 0, ta.value.length);
      ta.setSelectionRange(pos, pos);
      ta.scrollTop = d.promptScroll;
    } else {
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.scrollTop = ta.scrollHeight;
    }
  }, 50);
});

// shob setting likhar sathe sathei save hoy
let saveTimer = null;
function saveFields() {
  chrome.storage.local.set({
    prompts: $('prompts').value,
    prefix: $('prefix').value,
    delay: Number($('delay').value) || 0,
    mode: $('mode').value,
    vote: $('vote').value,
    which: $('which').value,
    autozip: $('autozip').checked,
    newchat: $('newchat').checked,
    promptScroll: $('prompts').scrollTop,
    promptCaret: $('prompts').selectionStart
  });
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveFields, 200);
}
$('prompts').addEventListener('input', () => { refreshCount(); saveSoon(); });
$('prompts').addEventListener('scroll', saveSoon);
$('prompts').addEventListener('keyup', saveSoon);
$('prompts').addEventListener('click', saveSoon);
['prefix', 'delay'].forEach(id => $(id).addEventListener('input', saveSoon));
['mode', 'vote', 'which', 'autozip', 'newchat'].forEach(id => $(id).addEventListener('change', () => { if (id === 'mode') refreshCount(); saveSoon(); }));
window.addEventListener('pagehide', saveFields);

async function send(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/arena\.ai|lmarena\.ai/i.test(tab.url || '')) {
    $('status').textContent = 'Age arena.ai tab open koro (image generate er page), tarpor ekhane eso.';
    return false;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, msg);
    return true;
  } catch (e) {
    $('status').textContent = 'Error: ' + (e && e.message ? e.message : e);
    return false;
  }
}

$('start').onclick = async () => {
  const prompts = parsePrompts($('prompts').value, $('mode').value);
  if (!prompts.length) { $('status').textContent = 'Kono prompt nai.'; return; }
  saveFields();
  const ok = await send({
    type: 'start',
    prompts,
    prefix: $('prefix').value,
    vote: $('vote').value,
    delay: Number($('delay').value) || 0,
    newChat: $('newchat').checked,
    autozip: $('autozip').checked,
    which: $('which').value,
    startFrom: Number($('startfrom').value) || 1
  });
  if (ok) $('status').textContent = 'Message pathano hoyeche, page er nichey dekho.';
};

$('stop').onclick = () => send({ type: 'stop' });

$('pause').onclick = () => {
  chrome.storage.local.get(['runState'], d => {
    send({ type: d.runState === 'paused' ? 'resume' : 'pause' });
  });
};

function refreshRunState() {
  chrome.storage.local.get(['runState', 'lastDone'], d => {
    const paused = d.runState === 'paused';
    $('pause').textContent = paused ? 'Resume' : 'Pause';
    $('pause').className = paused ? 'resume' : '';
    const done = d.lastDone || 0;
    if (paused) $('lastdone').textContent = `Pause kora ache. Prompt ${done} porjonto complete. Resume chapo.`;
    else if (d.runState === 'running') $('lastdone').textContent = `Cholche... Prompt ${done} porjonto complete.`;
    else if (done > 0) $('lastdone').textContent = `Shesh complete: prompt ${done}. Continue korte upore ${done + 1} likhe Start chapo.`;
    else $('lastdone').textContent = '';
  });
}
refreshRunState();
chrome.storage.onChanged.addListener(ch => { if (ch.runState || ch.lastDone) refreshRunState(); });

// popup khulle dekhi content script e sotti run cholche ki na (page reload hole state purano thakte pare)
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    if (!r || !r.running) chrome.storage.local.set({ runState: 'idle' });
  } catch (e) {
    chrome.storage.local.set({ runState: 'idle' });
  }
})();

$('clear').onclick = async () => {
  $('prompts').value = '';
  chrome.storage.local.remove(['prompts', 'runCount', 'runCountA', 'runCountB', 'lastDone', 'promptScroll', 'promptCaret']);
  refreshCount();
  refreshRecent();
  $('status').textContent = 'Prompt ar recent run er record clear kora hoyeche.';
  $('prompts').focus();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'clearRun' });
  } catch (e) {}
};

$('zipA').onclick = () => send({ type: 'zip', which: 'A' });
$('zipB').onclick = () => send({ type: 'zip', which: 'B' });
$('zipBoth').onclick = () => send({ type: 'zip', which: 'both' });

function refreshRecent() {
  chrome.storage.local.get(['runCount', 'runCountA', 'runCountB'], d => {
    $('zipA').textContent = `A (${d.runCountA || 0})`;
    $('zipB').textContent = `B (${d.runCountB || 0})`;
    $('zipBoth').textContent = `Both (${d.runCount || 0})`;
  });
}
refreshRecent();
chrome.storage.onChanged.addListener(ch => { if (ch.runCount || ch.runCountA || ch.runCountB) refreshRecent(); });

chrome.runtime.onMessage.addListener(m => {
  if (m.type === 'progress') $('status').textContent = m.text;
});
