/**
 * NexusDrive 1000X Pure Google Drive API v3 Engine
 * - Direct server-side pointer copy (files.copy) inside Google's datacenters
 * - Google Docs/Sheets/Slides export & re-upload fallback
 * - Resumable chunked upload with live byte progress for large files
 * - Adaptive Exponential Backoff for 429/403/5xx rate limits
 */
const DriveEngine = (() => {
  function getSiteApiKey() {
    return (
      (window.NEXUSDRIVE_CONFIG && window.NEXUSDRIVE_CONFIG.GOOGLE_API_KEY) ||
      ""
    ).trim();
  }

  function parseApiError(rawText, status) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && parsed.error && parsed.error.message) {
        return `[${status}] ${parsed.error.message}`;
      }
    } catch {}
    return `[${status}] ${String(rawText || "Unknown Google Drive API error").slice(0, 220)}`;
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

  function createConcurrencyPool(concurrency) {
    const max = Math.max(1, Math.min(60, concurrency || 25));
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

  async function withBackoff(op, maxRetries = 8) {
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
          msg.includes("[504]") ||
          (msg.includes("[403]") &&
            /rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded|quotaExceeded|usageLimits|backendError/i.test(msg));
        if (!retryable || i === maxRetries - 1) throw err;
        const wait = 120 * Math.pow(2, i) + Math.random() * 120;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  async function fetchGoogleUserProfile(accessToken) {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!res.ok) throw new Error("Unable to load Google profile.");
    return await res.json();
  }

  async function liveVerifyToken(accessToken) {
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink),storageQuota",
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    if (!res.ok) {
      const txt = await res.text();
      const parsed = parseApiError(txt, res.status);
      if (res.status === 403 && /has not been used in project|is disabled|accessNotConfigured/i.test(txt)) {
        throw new Error(
          `Drive API Disabled [403]: Enable "Google Drive API" in Google Cloud Console (APIs & Services -> Library).`
        );
      }
      if (res.status === 403 && /insufficient/i.test(txt)) {
        throw new Error(
          `Permission Missing [403]: Tick the Google Drive access checkbox on Google's consent screen and try again.`
        );
      }
      throw new Error(`Drive authorization invalid ${parsed}`);
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
      if (res.status === 404) {
        throw new Error(`Drive Metadata Error [404]: Folder or file not found. Make sure the link is shared as "Anyone with the link".`);
      }
      throw new Error(`Drive Metadata Error ${parseApiError(txt, res.status)}`);
    }
    return await res.json();
  }

  async function liveListChildren(folderId, accessToken, compact = false) {
    const apiKey = getSiteApiKey();
    const files = [];
    let pageToken = null;
    const fields = compact
      ? "nextPageToken,files(id,name,mimeType,size,shortcutDetails(targetId,targetMimeType))"
      : "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,shortcutDetails(targetId,targetMimeType))";
    do {
      const sp = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields,
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
        throw new Error(`List Folder Error ${parseApiError(txt, res.status)}`);
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
    const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
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

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}/copy?supportsAllDrives=true&fields=id`,
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
    const isRateOrServerError =
      res.status === 429 ||
      res.status === 401 ||
      res.status >= 500 ||
      (res.status === 403 &&
        /rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded|quotaExceeded|usageLimits|backendError/i.test(errText));

    if (isRateOrServerError) {
      throw new Error(`Copy Failed [${res.status}]: ${errText}`);
    }

    const exp = getExportDescriptor(mimeType);
    const isCopyBlocked = /cannotCopyFile|copyRequiresWriterPermission/i.test(errText);
    if (!exp && !isCopyBlocked) {
      throw new Error(`Copy Failed ${parseApiError(errText, res.status)}`);
    }
    const dlUrl = exp
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}/export?mimeType=${encodeURIComponent(exp.exportMime)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}?alt=media&acknowledgeAbuse=true`;

    const dlRes = await fetch(dlUrl, {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!dlRes.ok) {
      throw new Error(`Copy Failed ${parseApiError(errText, res.status)}`);
    }

    const blob = await dlRes.blob();
    const finalName = exp && !name.toLowerCase().endsWith(exp.ext) ? name + exp.ext : name;
    const upFile = new File([blob], finalName, {
      type: exp ? exp.exportMime : blob.type || "application/octet-stream",
    });
    return await liveUploadFileWithProgress(upFile, parentId, accessToken);
  }

  async function liveUploadFileWithProgress(file, parentId, accessToken, onProgress) {
    const meta = { name: Security.sanitizeName(file.name) };
    if (parentId && parentId !== "root") meta.parents = [parentId];

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
      fileIds.map(async (id) => {
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
          {
            method: "PATCH",
            headers: {
              Authorization: "Bearer " + accessToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ trashed: true }),
          }
        );
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Delete failed [${res.status}]: ${txt}`);
        }
      })
    );
  }

  async function liveScanTree(rootId, accessToken, filters, onProgress) {
    const pool = createConcurrencyPool(35);
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
      if (onProgress) {
        onProgress(`Scanning: ${stats.totalFiles} files • ${stats.totalFolders} folders...`);
      }
      const children = await withBackoff(() => pool(() => liveListChildren(folderId, accessToken, true)));
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

  return {
    extractDriveId,
    formatBytes,
    normalizeText,
    createConcurrencyPool,
    withBackoff,
    fetchGoogleUserProfile,
    liveVerifyToken,
    liveScanTree,
    liveCreateFolder,
    liveCopyFileWithFallback,
    liveUploadFileWithProgress,
    liveListChildren,
    liveDeleteFiles,
  };
})();
