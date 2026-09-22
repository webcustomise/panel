/**
 * DingDong One-Click Folder Export v6 — WhatsApp only, robust walker
 *
 * Per user: opens file manager → cd Android/media/com.whatsapp →
 * recursively walks EVERY subfolder and downloads EVERY file.
 *
 * Robustness fixes over v5:
 *  - Tracks the absolute path of each folder (window.var32) and re-navigates
 *    to it after every file preview + after every recursive return, because
 *    the panel re-renders #resp <li> nodes and stale references silently
 *    no-op.
 *  - Re-snapshots entries by NAME every loop iteration.
 *  - Uses setdatcmd("cd", absPath, "", respov) for reliable navigation
 *    instead of clicking ".." (which sometimes lands in the wrong place).
 *  - Waits for listing to actually change after each navigation.
 *
 * Output: <picked>/DingDong_WA_<ts>/<UID - label>/com.whatsapp/...
 */

(function () {
  "use strict";

  const CFG = {
    CLICK_SETTLE: 1500,
    NAV_WAIT_MAX: 6000,     // max ms to wait for listing to refresh
    NAV_POLL: 150,
    PREVIEW_TRIES: 20,
    PREVIEW_STEP: 250,
    MAX_DEPTH: 12,
    BETWEEN_FILES: 200,
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log("%c[DD]", "color:#0ff;font-weight:bold", ...a);
  const warn = (...a) => console.warn("%c[DD]", "color:#f90;font-weight:bold", ...a);
  const fmt = b => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB";
  const safe = s => (s || "_").replace(/[<>:"|?*\\]/g, "_").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  const hasFSA = () => typeof window.showDirectoryPicker === "function";

  const S = {
    rootDir: null,
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
        <span>🛰 DingDong WA Export v6</span>
        <button id="dd-stop" style="display:none;background:#f55;color:#fff">Stop</button>
      </header>
      <div id="dd-pick">
        <button id="dd-start">📁 Pick Folder &amp; Start</button>
        <small>Only downloads Android/media/com.whatsapp per user.<br>
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
  const curPath = () => (typeof window.var32 === "string" ? window.var32 : "");

  function closeFprev() {
    const f = $fprev(); if (!f) return;
    const x = f.querySelector("span.span");
    if (x) try { x.click(); } catch (_) {}
    f.style.display = "none";
  }

  /* ---------- absolute-path navigation ---------- */
  async function cdAbs(absPath) {
    if (typeof window.setdatcmd !== "function") {
      warn("setdatcmd missing — cannot cd to", absPath);
      return false;
    }
    const before = curPath();
    const beforeSig = entriesSig();
    try { window.setdatcmd("cd", absPath, "", window.respov); }
    catch (e) { warn("cd threw", absPath, e); return false; }
    // wait for var32 to update OR listing to change
    const t0 = Date.now();
    while (Date.now() - t0 < CFG.NAV_WAIT_MAX) {
      await sleep(CFG.NAV_POLL);
      if (curPath() === absPath || entriesSig() !== beforeSig) break;
    }
    await sleep(250); // tiny settle
    if (curPath() && curPath() !== absPath) {
      // some panels strip trailing slash; accept close matches
      const a = absPath.replace(/\/+$/, ""), b = curPath().replace(/\/+$/, "");
      if (a !== b) warn(`cd target ${absPath} but var32=${curPath()}`);
    }
    return true;
  }

  function entriesSig() {
    return getEntries().map(li => (isFolder(li) ? "D:" : "F:") + entryName(li)).join("|");
  }

  async function clickFolderByName(name) {
    const li = getEntries().find(x => isFolder(x) && entryName(x) === name);
    if (!li) return false;
    const beforeSig = entriesSig();
    li.click();
    const t0 = Date.now();
    while (Date.now() - t0 < CFG.NAV_WAIT_MAX) {
      await sleep(CFG.NAV_POLL);
      if (entriesSig() !== beforeSig) break;
    }
    await sleep(250);
    return true;
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

  /* ---------- collect files for one user ---------- */
  async function collectUser(u, userDir) {
    upd(u.uid, u.label, "selecting…", 4);
    u.btn.click();
    await sleep(CFG.CLICK_SETTLE);

    const fm = document.querySelector('[onclick="filesmanager()"]');
    if (!fm) { upd(u.uid, u.label, "⚠ no FM", 0); return []; }
    fm.click();
    await sleep(CFG.CLICK_SETTLE);

    // wait for first listing
    const t0 = Date.now();
    while (Date.now() - t0 < CFG.NAV_WAIT_MAX && getEntries().length === 0) await sleep(CFG.NAV_POLL);

    // Navigate Android → media → com.whatsapp via folder clicks
    for (const folder of ["Android", "media", "com.whatsapp"]) {
      upd(u.uid, u.label, `→ ${folder}`, 8);
      const ok = await clickFolderByName(folder);
      if (!ok) {
        upd(u.uid, u.label, `⚠ ${folder} not found`, 0);
        warn(`[${u.uid}] missing folder ${folder}`);
        return [];
      }
    }

    const waRoot = curPath();
    log(`[${u.uid}] com.whatsapp root =`, waRoot);
    if (!waRoot) { upd(u.uid, u.label, "⚠ no abs path", 0); return []; }

    const manifest = [];
    await walk(u, waRoot, "com.whatsapp/", 0, manifest, userDir);

    try {
      await writeFile(userDir, "_manifest.json",
        new Blob([JSON.stringify({ uid: u.uid, label: u.label, files: manifest }, null, 2)],
          { type: "application/json" }));
    } catch (_) {}

    upd(u.uid, u.label, `✅ ${manifest.filter(x => !x.error).length}/${manifest.length} saved`, 100);
    return manifest;
  }

  /**
   * Walk a folder by its ABSOLUTE path. We re-cd into it before every
   * operation that could mutate the listing (file preview, or returning
   * from a child walk), so stale <li> references never bite us.
   */
  async function saveNow(u, userDir, path, url, manifest) {
    S.stats.totalFiles++;
    upd(u.uid, u.label, `⬇ ${path}`, 35);
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      const parts = path.split("/").filter(Boolean);
      const fname = parts.pop() || "file";
      const sub = parts.length ? await ensureDir(userDir, parts) : userDir;
      await writeFile(sub, fname, blob);
      S.stats.bytes += blob.size;
      S.stats.done++;
      manifest.push({ path, url, size: blob.size });
      upd(u.uid, u.label, `✅ ${path} · ${fmt(blob.size)}`, 45);
      sum(`💾 ${S.stats.done}/${S.stats.totalFiles} saved now · ${fmt(S.stats.bytes)} · ${S.stats.failed} failed`);
      log(`[${u.uid}] saved`, path, fmt(blob.size));
      return true;
    } catch (e) {
      S.stats.failed++;
      manifest.push({ path, url, error: String(e.message || e) });
      upd(u.uid, u.label, `⚠ save failed: ${path}`, 35);
      sum(`💾 ${S.stats.done}/${S.stats.totalFiles} saved now · ${fmt(S.stats.bytes)} · ${S.stats.failed} failed`);
      warn(`[${u.uid}] save fail`, path, e.message || e);
      return false;
    }
  }

  async function walk(u, absPath, relPath, depth, manifest, userDir) {
    if (!S.running || depth > CFG.MAX_DEPTH) return;

    // Ensure we are in absPath and snapshot names
    if (curPath().replace(/\/+$/, "") !== absPath.replace(/\/+$/, "")) {
      await cdAbs(absPath);
    }

    const snap = getEntries()
      .map(li => ({ name: entryName(li), folder: isFolder(li), back: isBack(li) }))
      .filter(e => e.name && !e.back);

    log(`[${u.uid}] walk ${relPath} (${snap.length} entries, depth ${depth})`);
    upd(u.uid, u.label, `📂 ${relPath} (${snap.length})`, Math.min(28, 10 + depth * 3));

    for (const meta of snap) {
      if (!S.running) return;

      if (meta.folder) {
        // Build absolute path of the child
        const childAbs = absPath.replace(/\/+$/, "") + "/" + meta.name;
        // Navigate to it explicitly (don't rely on click-then-stale-list)
        const okCd = await cdAbs(childAbs);
        if (!okCd) {
          // fallback: click by name from current snapshot
          if (curPath().replace(/\/+$/, "") !== absPath.replace(/\/+$/, "")) await cdAbs(absPath);
          await clickFolderByName(meta.name);
        }
        await walk(u, childAbs, relPath + meta.name + "/", depth + 1, manifest, userDir);
        // Return to parent before next sibling
        await cdAbs(absPath);
      } else {
        // FILE: re-enter parent (preview/close can desync), then click fresh li
        if (curPath().replace(/\/+$/, "") !== absPath.replace(/\/+$/, "")) {
          await cdAbs(absPath);
        }
        const li = getEntries().find(x => !isFolder(x) && entryName(x) === meta.name);
        if (!li) { warn(`[${u.uid}] file vanished: ${meta.name}`); continue; }
        li.click();

        let href = null;
        for (let i = 0; i < CFG.PREVIEW_TRIES; i++) {
          await sleep(CFG.PREVIEW_STEP);
          const a = document.getElementById("btdwn");
          const h = a && (a.href || a.getAttribute("href"));
          if (fprevOpen() && h && h !== "hh" && h !== "#" && !h.startsWith("javascript")) { href = h; break; }
        }
        if (href) {
          await saveNow(u, userDir, relPath + meta.name, href, manifest);
        } else warn(`[${u.uid}] no URL for ${relPath}${meta.name}`);

        closeFprev();
        await sleep(CFG.BETWEEN_FILES);
        // After preview, the listing may have been re-rendered or path reset.
        // Force back to absPath so the next iteration is clean.
        await cdAbs(absPath);
      }
    }
  }

  /* ---------- main flow ---------- */
  async function startFlow() {
    if (S.running) return;
    if (!hasFSA()) {
      alert("Your browser doesn't support direct folder writes.\nUse Chrome / Edge / Opera.");
      return;
    }
    try {
      S.rootDir = await window.showDirectoryPicker({ id: "dingdong-wa", mode: "readwrite" });
    } catch (_) { return; }

    const btn = document.getElementById("dd-start");
    btn.disabled = true; btn.classList.add("busy"); btn.textContent = "Running…";
    document.getElementById("dd-list").style.display = "";
    document.getElementById("dd-sum").style.display = "";
    document.getElementById("dd-stop").style.display = "";
    S.running = true;
    S.stats = { totalFiles: 0, done: 0, failed: 0, bytes: 0 };

    sum("Discovering users…");
    let users = discover();
    for (let i = 0; i < 6 && users.length === 0; i++) { await sleep(1500); users = discover(); }

    if (!users.length) {
      sum("❌ No users found.");
      S.running = false;
      btn.disabled = false; btn.classList.remove("busy"); btn.textContent = "📁 Pick Folder & Start (again)";
      return;
    }

    S.users = users.filter(u => /samsung/i.test(u.label));
    if (!S.users.length) {
      sum("❌ No Samsung users found in list.");
      S.running = false;
      btn.disabled = false; btn.classList.remove("busy"); btn.textContent = "📁 Pick Folder & Start (again)";
      return;
    }
    sum(`Found ${S.users.length} Samsung user(s) — exporting WhatsApp…`);

    const sessionDir = await S.rootDir.getDirectoryHandle(
      "DingDong_WA_" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
      { create: true });

    for (const u of S.users) {
      if (!S.running) break;
      try {
        const dirName = safe(`${u.uid} - ${u.label}`);
        const userDir = await sessionDir.getDirectoryHandle(dirName, { create: true });
        await collectUser(u, userDir);
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

  window.DingDong = { start: startFlow, state: S, discover };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", panel);
  else panel();
})();
