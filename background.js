// Image download er fallback: kichu image onno domain e thake, content script CORS e atke jay.
// Service worker e host permission thakay ekhane theke fetch kora jay.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'fetchImage') {
    fetch(msg.url, { credentials: 'include' })
      .then(async r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        }
        sendResponse({ ok: true, b64: btoa(bin), type: r.headers.get('content-type') || '' });
      })
      .catch(e => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
});
