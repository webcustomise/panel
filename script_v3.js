/**
 * DingDong One-Click Folder Export v5 — WhatsApp only
 *
 * What it does:
 *   - Shows a floating "📁 Pick Folder & Start" button.
 *   - Admin clicks ONCE → picks a local folder (File System Access API).
 *   - Script walks every user → looks for Android/media/com.whatsapp →
 *     grabs every file URL → downloads and writes each file DIRECTLY into the
 *     chosen folder on disk.
 *   - Keeps the original folder structure: <out>/DingDong_WA_<ts>/<userLabel>/Android/media/com.whatsapp/...
 *
 * How to use:
 *   1. Serve this file alongside testin.html (or paste it in a <script> block).
 *   2. Open testin.html in a modern Chromium/Edge browser.
 *   3. Click the button, pick a destination folder, allow downloads.
 *   4. Wait for "Done."  No further clicks.
 */

(function () {
  "use strict";

  const S = {
    running: false,
    abort: false,
    stats: { users: 0, files: 0, bytes: 0, failed: 0, skipped: 0 },
    startedAt: 0,
    log: [],
    handles: new Map(), // userLabel -> root directory handle
  };

  const fmt = (n) =>
    n > 1e9
      ? (n / 1e9).toFixed(2) + " GB"
      : n > 1e6
      ? (n / 1e6).toFixed(2) + " MB"
      : n > 1e3
      ? (n / 1e3).toFixed(2) + " KB"
      : n + " B";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- UI ---------- */
  function panel() {
    if (document.getElementById("dd-panel")) return;
    const d = document.createElement("div");
    d.id = "dd-panel";
    d.innerHTML = `
      <div id="dd-panel" style="position:fixed;bottom:18px;right:18px;z-index:999999;font-family:system-ui,sans-serif;">
        <button id="dd-btn" style="padding:12px 16px;border-radius:999px;border:none;background:#10b981;color:#fff;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25);">
          📁 Pick Folder & Start
        </button>
        <button id="dd-stop" style="display:none;margin-left:8px;padding:12px 16px;border-radius:999px;border:none;background:#ef4444;color:#fff;font-weight:700;cursor:pointer;">
          Stop
        </button>
        <div id="dd-status" style="margin-top:8px;padding:10px 14px;background:#111827;color:#e5e7eb;border-radius:8px;max-width:320px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.25);">
          Ready. Click the button.
        </div>
        <div id="dd-log" style="margin-top:8px;max-height:260px;overflow:auto;padding:10px 14px;background:#111827;color:#9ca3af;border-radius:8px;max-width:320px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,.25);"></div>
      </div>
    `;
    document.body.appendChild(d);
    document.getElementById("dd-btn").addEventListener("click", startFlow);
    document.getElementById("dd-stop").addEventListener("click", () => {
      S.abort = true;
      status("Stopping after current file...");
    });
  }

  function status(t) {
    const el = document.getElementById("dd-status");
    if (el) el.textContent = t;
  }

  function log(t) {
    S.log.push(t);
    const el = document.getElementById("dd-log");
    if (el) {
      const line = document.createElement("div");
      line.textContent = new Date().toLocaleTimeString() + "  " + t;
      el.prepend(line);
    }
  }

  /* ---------- File System Access helpers ---------- */
  async function pickFolder() {
    return await window.showDirectoryPicker({ mode: "readwrite" });
  }

  async function getFolder(parent, name, create = true) {
    try {
      return await parent.getDirectoryHandle(name, { create });
    } catch (e) {
      return null;
    }
  }

  async function writeFile(parent, name, blob) {
    try {
      const fh = await parent.getFileHandle(name, { create: true });
      const ws = await fh.createWritable();
      await ws.write(blob);
      await ws.close();
      return true;
    } catch (e) {
      console.error("writeFile failed", name, e);
      return false;
    }
  }

  async function pathExists(parent, ...parts) {
    let cur = parent;
    for (const p of parts) {
      try {
        cur = await cur.getDirectoryHandle(p);
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  /* ---------- Discovery helpers ---------- */

  /**
   * In your testin.html, the "users" are typically the rows under the
   * file-manager container. Each row has a user label, and the rows expose
   * a file tree. This script tries to find the list of user rows, then for each
   * opens File Manager, then drills into `Android/media/com.whatsapp`.
   */
  function discover() {
    // Try to find user rows. The original script used `[data-user-id]` or similar.
    // We'll support multiple selectors.
    const rows =
      document.querySelectorAll("[data-user-id]")?.length > 0
        ? document.querySelectorAll("[data-user-id]")
        : document.querySelectorAll(".user-row, .device-row, .row-user");

    const users = [];
    rows.forEach((row) => {
      const label =
        row.querySelector(".user-label, .row-label, .label")?.textContent?.trim() ||
        row.getAttribute("data-user-label") ||
        row.getAttribute("data-user-id") ||
        "User";
      const btn = row.querySelector("button, .open-files, .file-manager, .files");
      users.push({ element: row, label, btn });
    });

    return users;
  }

  async function clickOpenFileManager(user) {
    if (!user.btn) return false;
    user.btn.click();
    await sleep(300);
    return true;
  }

  /* ---------- Main traversal ---------- */
  async function downloadFolder(userRoot, relPath, fileUrls) {
    for (const url of fileUrls) {
      if (S.abort) return;
      const fileName = url.split("/").pop().split("?")[0] || "file";
      const parts = [...relPath, fileName];
      let cur = userRoot;
      for (let i = 0; i < parts.length - 1; i++) {
        cur = await getFolder(cur, parts[i], true);
        if (!cur) {
          S.stats.failed++;
          log("✗ could not create folder " + parts[i]);
          return;
        }
      }
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const blob = await resp.blob();
        const ok = await writeFile(cur, parts[parts.length - 1], blob);
        if (!ok) throw new Error("write failed");
        S.stats.files++;
        S.stats.bytes += blob.size;
        log(`✓ ${parts.join("/")} (${fmt(blob.size)})`);
        status(`Downloaded ${S.stats.files} files · ${fmt(S.stats.bytes)}`);
        await sleep(20); // tiny throttle
      } catch (e) {
        S.stats.failed++;
        log("✗ " + parts.join("/") + " — " + e.message);
      }
    }
  }

  async function getFileUrlsFromTree(rootNode) {
    const urls = [];
    // Try several common selectors used in the file manager UI.
    const links = rootNode.querySelectorAll("a[href]");
    const buttons = rootNode.querySelectorAll("button[data-url], [data-src]");
    const anyUrl = rootNode.querySelectorAll("[data-url], [data-src]");

    const add = (u) => {
      if (u && u.startsWith("http") && !urls.includes(u)) urls.push(u);
    };

    links.forEach((a) => add(a.href));
    buttons.forEach((b) => add(b.dataset.url || b.dataset.src));
    anyUrl.forEach((el) => add(el.dataset.url || el.dataset.src));

    return urls;
  }

  async function recurseDomTree(rootNode, userRoot, currentRel) {
    if (S.abort) return;

    // 1. Collect file URLs at this level.
    const urls = await getFileUrlsFromTree(rootNode);
    if (urls.length) {
      await downloadFolder(userRoot, currentRel, urls);
    }

    // 2. Find child folders at this level.
    //    Common patterns: details/summary, nested ul/li, or div with children.
    const folders = rootNode.querySelectorAll("details, [data-folder], .folder");
    for (const f of folders) {
      if (S.abort) return;
      const name =
        f.querySelector("summary, .folder-name, .name")?.textContent?.trim() ||
        f.getAttribute("data-folder") ||
        "unnamed";
      await recurseDomTree(f, userRoot, [...currentRel, name]);
    }
  }

  async function processUser(user, baseDir, ts) {
    if (S.abort) return;
    const userLabel = (user.label || "user").replace(/[^a-z0-9\-_]/gi, "_");
    const userRoot = await getFolder(baseDir, userLabel, true);
    S.handles.set(userLabel, userRoot);
    S.stats.users++;
    log(`User ${S.stats.users}: ${user.label}`);

    // Open the file manager for this user.
    await clickOpenFileManager(user);

    // Find the file manager tree DOM for this user.
    // testin.html usually shows a modal or a container. We wait a moment then pick the most recent active tree.
    await sleep(500);
    const tree =
      document.querySelector(".file-manager-tree.active, .tree.active, [data-tree-active]") ||
      document.querySelector(".file-manager-tree, .tree, .file-tree") ||
      document.querySelector("dialog[open] .file-manager, dialog[open] .tree");

    if (!tree) {
      log("✗ file manager tree not found for " + user.label);
      S.stats.failed++;
      return;
    }

    // Try to find Android/media/com.whatsapp within the tree.
    const path = ["Android", "media", "com.whatsapp"];
    let cur = tree;
    for (const part of path) {
      const child = Array.from(cur.querySelectorAll("details, [data-folder], .folder")).find(
        (el) =>
          (el.querySelector("summary, .folder-name, .name")?.textContent?.trim() ||
            el.getAttribute("data-folder")) === part
      );
      if (!child) {
        log(`⚠ com.whatsapp not found for ${user.label} (missing ${part})`);
        S.stats.skipped++;
        return;
      }
      // Expand if needed.
      if (child.tagName === "DETAILS" && !child.open) {
        child.open = true;
        await sleep(200);
      }
      cur = child;
    }

    log(`→ Android/media/com.whatsapp found for ${user.label}, recursing...`);
    await recurseDomTree(cur, userRoot, ["Android", "media", "com.whatsapp"]);
  }

  /* ---------- Flow ---------- */
  async function startFlow() {
    if (S.running) return;
    S.running = true;
    S.abort = false;
    S.stats = { users: 0, files: 0, bytes: 0, failed: 0, skipped: 0 };
    S.log = [];
    S.startedAt = Date.now();

    const btn = document.getElementById("dd-btn");
    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = "Running...";
    document.getElementById("dd-stop").style.display = "inline-block";

    try {
      const root = await pickFolder();
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const baseDir = await getFolder(root, "DingDong_WA_" + ts, true);
      log(`Output: ${root.name}/DingDong_WA_${ts}`);

      const users = discover();
      if (!users.length) {
        status("No users found.");
        log("No users found — check the page layout.");
        return;
      }
      log(`Found ${users.length} user(s).`);

      for (const user of users) {
        if (S.abort) break;
        await processUser(user, baseDir, ts);
      }
    } catch (e) {
      console.error(e);
      log("✗ Error: " + e.message);
      status("Error: " + e.message);
    }

    const elapsed = ((Date.now() - S.startedAt) / 1000).toFixed(1);
    status(`Done in ${elapsed}s · ${S.stats.files} files · ${fmt(S.stats.bytes)} · ${S.stats.failed} failed · ${S.stats.skipped} skipped`);
    log(`Done in ${elapsed}s · ${S.stats.files} files · ${fmt(S.stats.bytes)} · ${S.stats.failed} failed · ${S.stats.skipped} skipped`);

    btn.disabled = false;
    btn.classList.remove("busy");
    btn.textContent = "📁 Pick Folder & Start (again)";
    document.getElementById("dd-stop").style.display = "none";
    S.running = false;
  }

  /* ---------- expose ---------- */
  window.DingDong = {
    start: startFlow,
    state: S,
    discover,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", panel);
  } else {
    panel();
  }
})();
