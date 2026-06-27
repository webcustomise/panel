/**
 * DingDong One-Click Folder Export v5
 *
 * What it does:
 *   - Shows a floating "📁 Pick Folder & Start" button.
 *   - Admin clicks ONCE → picks a local folder (File System Access API).
 *   - Script walks every user → every folder → grabs every file URL → downloads
 *     and writes each file DIRECTLY into the chosen folder on disk.
 *   - Structure on disk:
 *        <chosen-folder>/<UID - label>/<original/path/file.ext>
 *   - A _manifest.json is written per-user with url/size/path.
 *   - No ZIP step. No "Save As" prompts. No 100 downloads in tray.
 *
 * Drop in:  <script src="./script_v5.js"></script>   (AFTER script.js)
 *
 * Requires Chrome/Edge/Opera (Chromium 86+). Firefox/Safari fall back to
 * per-file browser downloads (with a one-time consent warning).
 */
(function () {
  "use strict";

  const CFG = {
    CLICK_SETTLE: 1500,
    FOLDER_WAIT: 2200,
    PREVIEW_TRIES: 12,
    PREVIEW_STEP: 250,
    MAX_DEPTH: 8,
    MAX_PARALLEL_DL: 4,
    BETWEEN_FILES: 250,
  };

  /* ---------- utils ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log("%c[DD]", "color:#0ff;font-weight:bold", ...a);
  const warn = (...a) => console.warn("%c[DD]", "color:#f90;font-weight:bold", ...a);
  const fmt = b => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB";
  const safe = s => (s || "_").replace(/[<>:"|?*\\]/g, "_").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  const hasFSA = () => typeof window.showDirectoryPicker === "function";

  /* ---------- state ---------- */
  const S = {
    rootDir: null,        // FileSystemDirectoryHandle
    running: false,
    users: [],
    stats: { totalFiles: 0, done: 0, failed: 0, bytes: 0 },
  };

  /* ---------- UI ---------- */
  function panel() {
    if (document.getElementById("dd-panel")) return;
    const p = document.createElement("div");
    p.id = "dd-panel";
    p.innerHTML = `
      <style>
        #dd-panel{position:fixed;bottom:12px;right:12px;width:360px;max-height:60vh;
          background:#0b0f15f0;border:1px solid #0ff7;border-radius:12px;color:#ddd;
          font:12px/1.4 ui-monospace,monospace;z-index:2147483647;overflow:hidden;
          display:flex;flex-direction:column;box-shadow:0 8px 30px #000a;}
        #dd-panel header{padding:10px 12px;background:#0ff1;color:#0ff;font-weight:bold;
          display:flex;justify-content:space-between;align-items:center;}
        #dd-panel header button{background:#0ff;color:#000;border:0;border-radius:6px;
          padding:6px 10px;cursor:pointer;font-weight:bold;font-size:12px;}
        #dd-panel header button.busy{background:#666;color:#aaa;cursor:wait;}
        #dd-list{padding:8px 10px;overflow:auto;flex:1;}
        #dd-panel .u{margin:5px 0;padding:6px 8px;background:#fff1;border-radius:6px;}
        #dd-panel .u b{color:#fff;font-size:11px;display:block;}
        #dd-panel .u span{color:#aaa;font-size:10.5px;}
        #dd-panel .bar{height:4px;background:#222;border-radius:2px;margin-top:4px;overflow:hidden;}
        #dd-panel .fill{height:100%;background:linear-gradient(90deg,#0ff,#0f9);transition:width .3s;}
        #dd-sum{padding:8px 12px;background:#0001;color:#0f9;font-size:11px;border-top:1px solid #fff1;}
        #dd-pick{padding:14px;text-align:center;}
        #dd-pick button{background:#0ff;color:#000;border:0;border-radius:8px;
          padding:12px 18px;cursor:pointer;font-weight:bold;font-size:13px;}
        #dd-pick small{display:block;color:#888;margin-top:8px;font-size:10.5px;}
      </style>
      <header>
        <span>🛰 DingDong Export v5</span>
        <button id="dd-stop" style="display:none;background:#f55;color:#fff">Stop</button>
      </header>
      <div id="dd-pick">
        <button id="dd-start">📁 Pick Folder &amp; Start</button>
        <small>Chooses ONE local folder. All files save directly there.<br>
        Chrome / Edge / Opera required.</small>
      </div>
      <div id="dd-list" style="display:none"></div>
      <div id="dd-sum" style="display:none">Idle.</div>`;
    document.body.appendChild(p);

    document.getElementById("dd-start").onclick = startFlow;
    document.getElementById("dd-stop").onclick = () => { S.running = false; sum("⏹ Stopping…"); };
  }
  function upd(uid, label, status, pct) {
    let el = document.getElementById("dd-u-" + uid);
    if (!el) {
      el = document.createElement("div"); el.className = "u"; el.id = "dd-u-" + uid;
      el.innerHTML = `<b></b><span></span><div class="bar"><div class="fill"></div></div>`;
      document.getElementById("dd-list").appendChild(el);
    }
    el.querySelector("b").textContent = label || uid;
    el.querySelector("span").textContent = status || "";
    el.querySelector(".fill").style.width = (pct || 0) + "%";
  }
  const sum = t => { const s = document.getElementById("dd-sum"); if (s) s.textContent = t; };

  /* ---------- discover users ---------- */
  function discover() {
    const out = [];
    document.querySelectorAll(".usr").forEach(div => {
      const btn = div.querySelector("button[onclick*='setdev']");
      if (!btn) return;
      const m = (btn.getAttribute("onclick") || "").match(/setdev\(['"]([^'"]+)['"]\)/);
      if (!m) return;
      const label = div.textContent.replace(/\s+/g, " ").trim().substring(0, 60);
      out.push({ uid: m[1], label, btn });
    });
    return out;
  }

  /* ---------- DOM helpers ---------- */
  const $resp = () => document.getElementById("resp");
  const $fprev = () => document.getElementById("fprev");
  const fprevOpen = () => { const f = $fprev(); return f && getComputedStyle(f).display !== "none"; };
  const getEntries = () => {
    const r = $resp(); if (!r) return [];
    return Array.from(r.querySelectorAll("li"));
  };
  const entryName = li => {
    const c = li.cloneNode(true);
    c.querySelectorAll("b").forEach(b => b.remove());
    return c.textContent.replace(/\s+/g, " ").trim();
  };
  const isFolder = li => li.classList.contains("fo");
  const isBack = li => entryName(li).startsWith("..");
  function closeFprev() {
    const f = $fprev(); if (!f) return;
    const x = f.querySelector("span.span");
    if (x) try { x.click(); } catch (_) {}
    f.style.display = "none";
  }

  /* ---------- FS helpers ---------- */
  async function ensureDir(parent, segments) {
    let d = parent;
    for (const seg of segments) {
      const name = safe(seg) || "_";
      if (!name) continue;
      d = await d.getDirectoryHandle(name, { create: true });
    }
    return d;
  }
  async function writeFile(dirHandle, fileName, blob) {
    const fh = await dirHandle.getFileHandle(safe(fileName) || "file", { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  /* ---------- walk + collect per user ---------- */
  async function collectUser(u) {
    upd(u.uid, u.label, "selecting…", 4);
    u.btn.click();
    await sleep(CFG.CLICK_SETTLE);

    const fm = document.querySelector('[onclick="filesmanager()"]');
    if (!fm) { upd(u.uid, u.label, "⚠ no FM", 0); return []; }
    fm.click();
    await sleep(CFG.FOLDER_WAIT);
    for (let i = 0; i < 12 && getEntries().length === 0; i++) await sleep(800);

    const files = [];
    await walk(u, "/", 0, files);
    upd(u.uid, u.label, `${files.length} files queued`, files.length ? 30 : 0);
    return files;
  }

  async function walk(u, path, depth, out) {
    if (!S.running || depth > CFG.MAX_DEPTH) return;
    const snap = getEntries()
      .map(li => ({ name: entryName(li), folder: isFolder(li), back: isBack(li) }))
      .filter(e => e.name && !e.back);

    for (const meta of snap) {
      if (!S.running) return;
      const li = getEntries().find(x => entryName(x) === meta.name && isFolder(x) === meta.folder);
      if (!li) continue;

      if (meta.folder) {
        upd(u.uid, u.label, `→ ${meta.name}`, 10 + depth * 4);
        li.click();
        await sleep(CFG.FOLDER_WAIT);
        await walk(u, path + meta.name + "/", depth + 1, out);
        await goUp();
      } else {
        li.click();
        let href = null;
        for (let i = 0; i < CFG.PREVIEW_TRIES; i++) {
          await sleep(CFG.PREVIEW_STEP);
          const a = document.getElementById("btdwn");
          const h = a && (a.href || a.getAttribute("href"));
          if (fprevOpen() && h && h !== "hh" && h !== "#" && !h.startsWith("javascript")) { href = h; break; }
        }
        if (href) {
          out.push({ url: href, path: path + meta.name });
          S.stats.totalFiles++;
        } else warn(`[${u.uid}] no URL for ${meta.name}`);
        closeFprev();
        await sleep(CFG.BETWEEN_FILES);
      }
    }
  }

  async function goUp() {
    const back = getEntries().find(li => isBack(li));
    if (back) { back.click(); await sleep(CFG.FOLDER_WAIT); return; }
    try {
      if (typeof window.setdatcmd === "function" && typeof window.var32 === "string") {
        const parent = window.var32.substr(0, window.var32.lastIndexOf("/")) || "/";
        window.setdatcmd("cd", parent, "", window.respov);
        await sleep(CFG.FOLDER_WAIT);
      }
    } catch (e) { warn("goUp failed", e); }
  }

  /* ---------- download + write to disk ---------- */
  async function downloadUser(u, files, userDir) {
    if (!files.length) { upd(u.uid, u.label, "no files", 100); return; }
    const manifest = [];
    let done = 0;

    const queue = files.slice();
    async function worker() {
      while (queue.length && S.running) {
        const f = queue.shift(); if (!f) break;
        try {
          const r = await fetch(f.url);
          if (!r.ok) throw new Error("HTTP " + r.status);
          const blob = await r.blob();
          const parts = f.path.split("/").filter(Boolean);
          const fname = parts.pop();
          const sub = parts.length ? await ensureDir(userDir, parts) : userDir;
          await writeFile(sub, fname, blob);
          S.stats.bytes += blob.size;
          S.stats.done++;
          manifest.push({ path: f.path, url: f.url, size: blob.size });
        } catch (e) {
          S.stats.failed++;
          manifest.push({ path: f.path, url: f.url, error: String(e.message || e) });
          warn(`[${u.uid}] DL fail`, f.path, e.message);
        }
        done++;
        const pct = 30 + (done / files.length) * 65;
        upd(u.uid, u.label, `${done}/${files.length} · ${fmt(S.stats.bytes)}`, pct);
        sum(`💾 ${S.stats.done}/${S.stats.totalFiles} · ${fmt(S.stats.bytes)} · ${S.stats.failed} failed`);
      }
    }
    await Promise.all(Array.from({ length: CFG.MAX_PARALLEL_DL }, worker));
    try {
      await writeFile(userDir, "_manifest.json",
        new Blob([JSON.stringify({ uid: u.uid, label: u.label, files: manifest }, null, 2)],
          { type: "application/json" }));
    } catch (_) {}
    upd(u.uid, u.label, `✅ ${done}/${files.length}`, 100);
  }

  /* ---------- main flow ---------- */
  async function startFlow() {
    if (S.running) return;
    if (!hasFSA()) {
      alert("Your browser doesn't support direct folder writes.\nUse Chrome / Edge / Opera.");
      return;
    }
    try {
      S.rootDir = await window.showDirectoryPicker({ id: "dingdong-export", mode: "readwrite" });
    } catch (_) { return; }

    const btn = document.getElementById("dd-start");
    btn.disabled = true; btn.classList.add("busy"); btn.textContent = "Running…";
    document.getElementById("dd-list").style.display = "";
    document.getElementById("dd-sum").style.display = "";
    document.getElementById("dd-stop").style.display = "";

    S.running = true;
    sum("Discovering users…");
    let users = discover();
    for (let i = 0; i < 6 && users.length === 0; i++) { await sleep(1500); users = discover(); }
    if (!users.length) { sum("❌ No users found"); S.running = false; return; }
    S.users = users;
    sum(`Found ${users.length} users — exporting…`);

    const sessionDir = await S.rootDir.getDirectoryHandle(
      "DingDong_" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
      { create: true });

    for (const u of users) {
      if (!S.running) break;
      try {
        const files = await collectUser(u);
        if (!S.running) break;
        const dirName = safe(`${u.uid} - ${u.label}`);
        const userDir = await sessionDir.getDirectoryHandle(dirName, { create: true });
        await downloadUser(u, files, userDir);
      } catch (e) {
        warn("user err", u.uid, e);
        upd(u.uid, u.label, "⚠ " + (e.message || e), 0);
      }
    }

    sum(`🏁 ${S.stats.done}/${S.stats.totalFiles} saved · ${fmt(S.stats.bytes)} · ${S.stats.failed} failed`);
    btn.disabled = false; btn.classList.remove("busy"); btn.textContent = "📁 Pick Folder & Start (again)";
    document.getElementById("dd-stop").style.display = "none";
    S.running = false;
  }

  /* ---------- expose ---------- */
  window.DingDong = {
    start: startFlow,
    state: S,
    discover,
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", panel);
  else panel();
})();
