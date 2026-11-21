/**
 * HyperDrive 1000X Google Drive v3 Engine + Persistent IndexedDB Sandbox Store
 * - Server-side pointer copy (files.copy) for 1000X instant cloning
 * - Automatic Google Docs/Sheets/Slides export + re-upload fallback
 * - Real byte-level progress Resumable Upload (supports large files 5GB+)
 * - Adaptive Exponential Backoff for 429/403/5xx rate limits
 * - Persistent IndexedDB Sandbox Store for zero-config full testing
 */
const DriveEngine = (() => {
  function getSiteApiKey() {
    return (
      localStorage.getItem("nexusdrive_api_key_v1") ||
      (window.NEXUSDRIVE_CONFIG && window.NEXUSDRIVE_CONFIG.GOOGLE_API_KEY) ||
      ""
    ).trim();
  }

  function extractDriveId(input) {
    if (!input) return null;
    const t = input.trim();
    if (
      /\/drive\/(?:u\/\d+\/)?my-drive/i.test(t) ||
      /^https?:\/\/drive\.google\.com\/?(?:drive\/?)?$/i.test(t) ||
      t.toLowerCase() === "root" ||
      t.toLowerCase() === "my-drive"
    ) {
      return "root";
    }
    const f = t.match(/\/folders\/([a-zA-Z0-9_-]{6,})/);
    if (f && f[1]) return f[1];
    const file = t.match(/\/file\/d\/([a-zA-Z0-9_-]{6,})/);
    if (file && file[1]) return file[1];
    const doc = t.match(/\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]{6,})/);
    if (doc && doc[1]) return doc[1];
    const q = t.match(/[?&]id=([a-zA-Z0-9_-]{6,})/);
    if (q && q[1]) return q[1];
    if (Security.isValidDriveId(t)) return t;
    return null;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0 || isNaN(bytes)) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + " " + units[i];
  }

  function normalizeText(str) {
    return String(str || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "");
  }

  function shouldFilterOut(name, kind, filters) {
    if (!filters) return false;
    const lower = String(name || "").toLowerCase().trim();
    if (filters.skipKeywords && filters.skipKeywords.length) {
      for (const kw of filters.skipKeywords) {
        const clean = kw.toLowerCase().trim();
        if (clean && lower.includes(clean)) return true;
      }
    }
    if (kind === "file" && filters.skipExtensions && filters.skipExtensions.length) {
      for (const ext of filters.skipExtensions) {
        const cleanExt = ext.toLowerCase().trim().replace(/^\./, "");
        if (cleanExt && lower.endsWith("." + cleanExt)) return true;
      }
    }
    return false;
  }

  function transformName(originalName, kind, rules) {
    if (!rules) return Security.sanitizeName(originalName);
    let name = originalName;
    if (rules.removeWords && rules.removeWords.length) {
      for (const w of rules.removeWords) {
        const cw = w.trim();
        if (cw) {
          const esc = cw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          name = name.replace(new RegExp(esc, "gi"), "");
        }
      }
    }
    name = name.replace(/\s{2,}/g, " ").trim() || originalName;
    const prefix = rules.prefix ? rules.prefix.trim() + " " : "";
    const suffix = rules.suffix ? " " + rules.suffix.trim() : "";

    if (kind === "file") {
      const dot = name.lastIndexOf(".");
      if (dot > 0 && dot < name.length - 1) {
        return Security.sanitizeName(
          prefix + name.slice(0, dot).trim() + suffix + name.slice(dot)
        );
      }
    }
    return Security.sanitizeName(prefix + name + suffix);
  }

  function createConcurrencyPool(concurrency) {
    const max = Math.max(1, Math.min(35, concurrency || 20));
    let active = 0;
    const queue = [];
    const next = () => {
      active -= 1;
      const fn = queue.shift();
      if (fn) fn();
    };
    return (task) =>
      new Promise((resolve, reject) => {
        const run = () => {
          active += 1;
          task().then(resolve).catch(reject).finally(next);
        };
        if (active < max) run();
        else queue.push(run);
      });
  }

  async function withBackoff(op, maxRetries = 6) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await op();
      } catch (err) {
        lastErr = err;
        const msg = err && err.message ? err.message : String(err);
        const retryable =
          msg.includes("[429]") ||
          msg.includes("[500]") ||
          msg.includes("[502]") ||
          msg.includes("[503]") ||
          (msg.includes("[403]") &&
            /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|usageLimits/i.test(msg));
        if (!retryable || i === maxRetries - 1) throw err;
        const wait = 150 * Math.pow(2, i) + Math.random() * 120;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  // ===========================================================================
  // 2. LIVE GOOGLE DRIVE API v3 CLIENT
  // ===========================================================================
  async function liveVerifyToken(accessToken) {
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink),storageQuota",
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    if (!res.ok) {
      throw new Error("Invalid or expired Google Drive OAuth token.");
    }
    return await res.json();
  }

  async function liveGetMeta(fileId, accessToken) {
    if (fileId === "root") {
      return {
        id: "root",
        name: "My Google Drive",
        mimeType: "application/vnd.google-apps.folder",
      };
    }
    const apiKey = getSiteApiKey();
    const sp = new URLSearchParams({
      fields: "id,name,mimeType,size,modifiedTime,webViewLink,shortcutDetails(targetId,targetMimeType)",
      supportsAllDrives: "true",
    });
    if (apiKey && !accessToken) sp.set("key", apiKey);

    const headers = accessToken ? { Authorization: "Bearer " + accessToken } : {};
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${sp.toString()}`,
      { headers }
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Drive Metadata Error [${res.status}]: ${txt}`);
    }
    return await res.json();
  }

  async function liveListChildren(folderId, accessToken) {
    const apiKey = getSiteApiKey();
    const files = [];
    let pageToken = null;
    do {
      const sp = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,shortcutDetails(targetId,targetMimeType))",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) sp.set("pageToken", pageToken);
      if (apiKey && !accessToken) sp.set("key", apiKey);

      const headers = accessToken ? { Authorization: "Bearer " + accessToken } : {};
      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${sp.toString()}`, {
        headers,
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`List Folder Error [${res.status}]: ${txt}`);
      }
      const data = await res.json();
      if (Array.isArray(data.files)) files.push(...data.files);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return files;
  }

  async function liveCreateFolder(name, parentId, accessToken) {
    const body = {
      name: Security.sanitizeName(name),
      mimeType: "application/vnd.google-apps.folder",
    };
    if (parentId && parentId !== "root") body.parents = [parentId];
    const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Create Folder [${res.status}]: ${JSON.stringify(data)}`);
    return data;
  }

  function getExportDescriptor(mimeType) {
    if (mimeType === "application/vnd.google-apps.document") {
      return { exportMime: "application/pdf", ext: ".pdf" };
    }
    if (mimeType === "application/vnd.google-apps.spreadsheet") {
      return { exportMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" };
    }
    if (mimeType === "application/vnd.google-apps.presentation") {
      return { exportMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" };
    }
    return null;
  }

  async function liveCopyFileWithFallback(sourceFileId, name, parentId, mimeType, accessToken) {
    const body = { name: Security.sanitizeName(name) };
    if (parentId && parentId !== "root") body.parents = [parentId];

    // Primary 1000X path: Direct Google internal server-side copy
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}/copy?supportsAllDrives=true`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    if (res.ok) {
      return await res.json();
    }

    const errText = await res.text();
    // If rate limit or auth error, throw so exponential backoff handles it
    if (res.status === 429 || res.status === 401 || res.status >= 500) {
      throw new Error(`Copy Failed [${res.status}]: ${errText}`);
    }

    // Fallback for restricted/Google Docs files: Export/Download + Re-Upload
    const exp = getExportDescriptor(mimeType);
    const dlUrl = exp
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}/export?mimeType=${encodeURIComponent(exp.exportMime)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}?alt=media&acknowledgeAbuse=true`;

    const dlRes = await fetch(dlUrl, {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!dlRes.ok) {
      throw new Error(`Copy Failed [${res.status}]: ${errText}`);
    }

    const blob = await dlRes.blob();
    const finalName = exp && !name.toLowerCase().endsWith(exp.ext) ? name + exp.ext : name;
    const upFile = new File([blob], finalName, {
      type: exp ? exp.exportMime : blob.type || "application/octet-stream",
    });
    return await liveUploadFileWithProgress(upFile, parentId, accessToken);
  }

  /**
   * Real Resumable + Multipart Uploader with Live Byte Percentage Progress!
   * - Small files (< 4 MB): instant multipart upload
   * - Large files (>= 4 MB): official Google Drive Resumable Upload session via XHR with live %
   */
  async function liveUploadFileWithProgress(file, parentId, accessToken, onProgress) {
    const meta = { name: Security.sanitizeName(file.name) };
    if (parentId && parentId !== "root") meta.parents = [parentId];

    // Multipart fast path for small files under 4 MB
    if (file.size < 4 * 1024 * 1024) {
      if (onProgress) onProgress(30);
      const fd = new FormData();
      fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
      fd.append("file", file, file.name);
      const res = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,mimeType,webViewLink",
        {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken },
          body: fd,
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(`Upload Failed [${res.status}]: ${JSON.stringify(data)}`);
      if (onProgress) onProgress(100);
      return data;
    }

    // Resumable Upload session for large files (handles GB-sized videos & archives cleanly!)
    const initRes = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,mimeType,webViewLink",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": file.type || "application/octet-stream",
          "X-Upload-Content-Length": String(file.size),
        },
        body: JSON.stringify(meta),
      }
    );
    if (!initRes.ok) {
      const txt = await initRes.text();
      throw new Error(`Resumable Init Failed [${initRes.status}]: ${txt}`);
    }
    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) throw new Error("Google Drive did not return a Resumable Upload URL.");

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl, true);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onProgress) {
          onProgress(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (onProgress) onProgress(100);
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve({ id: "uploaded", name: file.name });
          }
        } else {
          reject(new Error(`Resumable Upload Failed [${xhr.status}]: ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error("Network error during Resumable Upload."));
      xhr.send(file);
    });
  }

  async function liveDeleteFiles(fileIds, accessToken) {
    await Promise.all(
      fileIds.map((id) =>
        fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ trashed: true }),
        })
      )
    );
  }

  async function liveScanTree(rootId, accessToken, filters, onProgress) {
    const pool = createConcurrencyPool(20);
    const stats = { totalFiles: 0, totalFolders: 0, totalBytes: 0, filteredOut: 0 };
    const meta = await withBackoff(() => liveGetMeta(rootId, accessToken));

    const effMime =
      meta.mimeType === "application/vnd.google-apps.shortcut" && meta.shortcutDetails
        ? meta.shortcutDetails.targetMimeType
        : meta.mimeType;
    const effId =
      meta.mimeType === "application/vnd.google-apps.shortcut" && meta.shortcutDetails
        ? meta.shortcutDetails.targetId
        : meta.id;

    if (effMime !== "application/vnd.google-apps.folder") {
      stats.totalFiles = 1;
      stats.totalBytes = Number(meta.size || 0);
      return {
        root: {
          id: effId,
          name: meta.name,
          mimeType: effMime,
          kind: "file",
          size: Number(meta.size || 0),
        },
        stats,
      };
    }

    async function walk(folderId, folderName) {
      stats.totalFolders += 1;
      if (onProgress) onProgress(`Scanning: ${stats.totalFiles} files found...`);
      const children = await withBackoff(() => pool(() => liveListChildren(folderId, accessToken)));
      const subFolders = [];
      const files = [];

      for (const item of children) {
        const isShortcut = item.mimeType === "application/vnd.google-apps.shortcut";
        const tMime = isShortcut && item.shortcutDetails ? item.shortcutDetails.targetMimeType : item.mimeType;
        const tId = isShortcut && item.shortcutDetails ? item.shortcutDetails.targetId : item.id;
        const isFolder = tMime === "application/vnd.google-apps.folder";

        if (shouldFilterOut(item.name, isFolder ? "folder" : "file", filters)) {
          stats.filteredOut += 1;
          continue;
        }

        if (isFolder) {
          subFolders.push({ id: tId, name: item.name });
        } else {
          const sz = Number(item.size || 0);
          stats.totalFiles += 1;
          stats.totalBytes += sz;
          files.push({
            id: item.id,
            name: item.name,
            mimeType: tMime,
            kind: "file",
            size: sz,
            shortcutTargetId: isShortcut ? tId : null,
          });
        }
      }

      const resolved = await Promise.all(subFolders.map((sf) => walk(sf.id, sf.name)));
      resolved.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));

      return {
        id: folderId,
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        kind: "folder",
        children: [...resolved, ...files],
      };
    }

    const root = await walk(effId, meta.name);
    return { root, stats };
  }

  // ===========================================================================
  // 3. PERSISTENT INDEXEDDB SANDBOX DRIVE STORE
  // ===========================================================================
  const DB_NAME = "HyperDriveSandboxDB";
  const DB_VERSION = 1;
  const STORE_ITEMS = "drive_items";
  const STORE_BLOBS = "file_blobs";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_ITEMS)) {
          db.createObjectStore(STORE_ITEMS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function seedSandboxIfEmpty() {
    const db = await openDB();
    const tx = db.transaction(STORE_ITEMS, "readonly");
    const count = await new Promise((res) => {
      const r = tx.objectStore(STORE_ITEMS).count();
      r.onsuccess = () => res(r.result);
    });
    if (count > 0) return;

    const now = new Date().toISOString();
    const initial = [
      { id: "sb_folder_1", name: "01 - Cloud Architecture & FYP Bundle", mimeType: "application/vnd.google-apps.folder", kind: "folder", parentId: "root", size: 0, modifiedTime: now },
      { id: "sb_vid_1", name: "01. 1000X Server-Side Pointer Cloning.mp4", mimeType: "video/mp4", kind: "file", parentId: "sb_folder_1", size: 1845493760, modifiedTime: now, previewText: "1000X Pointer Copy Architecture Video Stream" },
      { id: "sb_pdf_1", name: "02. Zero-Trust AES-GCM Security Guide.pdf", mimeType: "application/pdf", kind: "file", parentId: "sb_folder_1", size: 48234496, modifiedTime: now, previewText: "System Security & OAuth 2.0 Architecture Blueprint" },
      { id: "sb_promo_1", name: "PROMO - Join Telegram Ads & Bonus.txt", mimeType: "text/plain", kind: "file", parentId: "sb_folder_1", size: 4096, modifiedTime: now, previewText: "Promotional junk file (auto-filtered by Smart Cleaner)" },
      { id: "sb_bonus_1", name: "500$ bonus.pdf", mimeType: "application/pdf", kind: "file", parentId: "sb_folder_1", size: 120400, modifiedTime: now, previewText: "Exact promo file replaceable by your injected file" },
      { id: "sb_zip_root", name: "Production_Starter_Kit_v2.zip", mimeType: "application/zip", kind: "file", parentId: "root", size: 854589440, modifiedTime: now, previewText: "Archive Package (815 MB)" },
    ];
    const wtx = db.transaction(STORE_ITEMS, "readwrite");
    const store = wtx.objectStore(STORE_ITEMS);
    initial.forEach((it) => store.put(it));
    await new Promise((res) => { wtx.oncomplete = res; });
  }

  async function sbGetAllItems() {
    await seedSandboxIfEmpty();
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_ITEMS, "readonly");
      const req = tx.objectStore(STORE_ITEMS).getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  }

  async function sbListFolder(parentId = "root", search = "") {
    const all = await sbGetAllItems();
    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      return all.filter((i) => i.name.toLowerCase().includes(q));
    }
    return all
      .filter((i) => i.parentId === parentId)
      .sort((a, b) => {
        if (a.kind === "folder" && b.kind !== "folder") return -1;
        if (a.kind !== "folder" && b.kind === "folder") return 1;
        return a.name.localeCompare(b.name);
      });
  }

  async function sbCreateFolder(name, parentId = "root") {
    const db = await openDB();
    const folder = {
      id: "sb_f_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      name: Security.sanitizeName(name),
      mimeType: "application/vnd.google-apps.folder",
      kind: "folder",
      parentId: parentId || "root",
      size: 0,
      modifiedTime: new Date().toISOString(),
    };
    const tx = db.transaction(STORE_ITEMS, "readwrite");
    tx.objectStore(STORE_ITEMS).put(folder);
    await new Promise((res) => { tx.oncomplete = res; });
    return folder;
  }

  async function sbCopyFile(sourceId, name, parentId = "root") {
    const all = await sbGetAllItems();
    const src = all.find((x) => x.id === sourceId);
    const db = await openDB();
    const newId = "sb_c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const copy = {
      id: newId,
      name: Security.sanitizeName(name || (src ? src.name : "Cloned_File")),
      mimeType: src ? src.mimeType : "application/octet-stream",
      kind: "file",
      parentId: parentId || "root",
      size: src ? src.size : 52428800,
      modifiedTime: new Date().toISOString(),
      previewText: src && src.previewText ? src.previewText : `Cloned at 1000X speed from source (${sourceId})`,
    };
    const tx = db.transaction(STORE_ITEMS, "readwrite");
    tx.objectStore(STORE_ITEMS).put(copy);
    await new Promise((res) => { tx.oncomplete = res; });
    return copy;
  }

  async function sbUploadFile(file, parentId = "root", onProgress) {
    if (onProgress) onProgress(35);
    const db = await openDB();
    const id = "sb_u_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    let previewText = null;
    if (file.type.startsWith("text/") || /\.(txt|md|json|csv|js|html|css|log)$/i.test(file.name)) {
      previewText = (await file.text()).slice(0, 6000);
    }
    const item = {
      id,
      name: Security.sanitizeName(file.name),
      mimeType: file.type || "application/octet-stream",
      kind: "file",
      parentId: parentId || "root",
      size: file.size,
      modifiedTime: new Date().toISOString(),
      previewText,
    };
    const tx = db.transaction([STORE_ITEMS, STORE_BLOBS], "readwrite");
    tx.objectStore(STORE_ITEMS).put(item);
    tx.objectStore(STORE_BLOBS).put({ id, blob: file });
    await new Promise((res) => { tx.oncomplete = res; });
    if (onProgress) onProgress(100);
    return item;
  }

  async function sbGetBlob(id) {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_BLOBS, "readonly");
      const req = tx.objectStore(STORE_BLOBS).get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => resolve(null);
    });
  }

  async function sbDeleteItems(ids) {
    const all = await sbGetAllItems();
    const idSet = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const it of all) {
        if (!idSet.has(it.id) && idSet.has(it.parentId)) {
          idSet.add(it.id);
          changed = true;
        }
      }
    }
    const db = await openDB();
    const tx = db.transaction([STORE_ITEMS, STORE_BLOBS], "readwrite");
    const iStore = tx.objectStore(STORE_ITEMS);
    const bStore = tx.objectStore(STORE_BLOBS);
    idSet.forEach((id) => {
      iStore.delete(id);
      bStore.delete(id);
    });
    await new Promise((res) => { tx.oncomplete = res; });
    return idSet.size;
  }

  async function sbGetQuota() {
    const all = await sbGetAllItems();
    const used = all.reduce((acc, it) => acc + Number(it.size || 0), 0);
    return { limit: 16106127360, usage: used };
  }

  async function sbScanSourceLink(link, filters) {
    const all = await sbGetAllItems();
    const stats = { totalFiles: 0, totalFolders: 0, totalBytes: 0, filteredOut: 0 };
    const id = extractDriveId(link) || "root";

    const matched = all.find((x) => x.id === id);
    if (matched && matched.kind === "file") {
      stats.totalFiles = 1;
      stats.totalBytes = matched.size;
      return { root: matched, stats };
    }

    if (id !== "root" && !matched) {
      const rawExternal = {
        id: "ext_root_" + id.slice(0, 8),
        name: `External Shared Folder (${id.slice(0, 10)})`,
        mimeType: "application/vnd.google-apps.folder",
        kind: "folder",
        children: [
          {
            id: "ext_sub_1",
            name: "Module 01 - Shared Source Videos",
            mimeType: "application/vnd.google-apps.folder",
            kind: "folder",
            children: [
              { id: "ext_f1", name: "01. Cloud_Architecture_Masterclass.mp4", mimeType: "video/mp4", kind: "file", size: 1420000000 },
              { id: "ext_f2", name: "02. API_Optimization_Slides.pdf", mimeType: "application/pdf", kind: "file", size: 32500000 },
              { id: "ext_promo", name: "PROMO_Telegram_Ads_Link.txt", mimeType: "text/plain", kind: "file", size: 2048 },
            ],
          },
          { id: "ext_f3", name: "Complete_Source_Package.zip", mimeType: "application/zip", kind: "file", size: 640000000 },
        ],
      };

      function filterExt(node) {
        stats.totalFolders += 1;
        const kids = [];
        for (const c of node.children || []) {
          if (shouldFilterOut(c.name, c.kind, filters)) {
            stats.filteredOut += 1;
            continue;
          }
          if (c.kind === "folder") kids.push(filterExt(c));
          else {
            stats.totalFiles += 1;
            stats.totalBytes += c.size || 0;
            kids.push(c);
          }
        }
        return { ...node, children: kids };
      }
      return { root: filterExt(rawExternal), stats };
    }

    const startId = matched ? matched.id : "root";
    const startName = matched ? matched.name : "My Google Drive (Source)";

    function buildTree(parentId, folderName, depth = 0) {
      stats.totalFolders += 1;
      if (depth > 12) return { id: parentId, name: folderName, kind: "folder", children: [] };
      const children = all.filter((x) => x.parentId === parentId);
      const subFolders = [];
      const files = [];

      for (const ch of children) {
        if (shouldFilterOut(ch.name, ch.kind, filters)) {
          stats.filteredOut += 1;
          continue;
        }
        if (ch.kind === "folder") subFolders.push(buildTree(ch.id, ch.name, depth + 1));
        else {
          stats.totalFiles += 1;
          stats.totalBytes += Number(ch.size || 0);
          files.push({ ...ch });
        }
      }
      return {
        id: parentId,
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        kind: "folder",
        children: [...subFolders, ...files],
      };
    }

    return { root: buildTree(startId, startName), stats };
  }

  return {
    extractDriveId,
    formatBytes,
    normalizeText,
    transformName,
    createConcurrencyPool,
    withBackoff,
    liveVerifyToken,
    liveScanTree,
    liveCreateFolder,
    liveCopyFileWithFallback,
    liveUploadFileWithProgress,
    liveListChildren,
    liveDeleteFiles,
    sbListFolder,
    sbCreateFolder,
    sbCopyFile,
    sbUploadFile,
    sbGetBlob,
    sbDeleteItems,
    sbGetQuota,
    sbScanSourceLink,
  };
})();
