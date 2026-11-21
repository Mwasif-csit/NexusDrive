/**
 * NexusDrive by ByteNexus — Main Application Controller (Pure Vanilla JS)
 * Clean, To-The-Point 3-Step Flow:
 *   1. Account Sign-In / Sign-Up
 *   2. Connect Destination Google Drive
 *   3. Paste Source Link -> 1000X Transfer into Connected Drive
 */
const App = (() => {
  const ACCOUNTS_KEY = "nexusdrive_accounts_v1";
  const CURRENT_USER_KEY = "nexusdrive_user_v1";
  const CLIENT_ID_KEY = "nexusdrive_client_id_v1";

  const state = {
    view: "landing",
    authMode: "login",
    user: null,
    driveConnected: false,
    driveMode: null, // "live" | "sandbox"
    driveEmail: "",
    accessToken: null,
    clientId: "",
    scannedRoot: null,
    scanStats: null,
    selectedMap: {},
    isCloning: false,
    uploadQueue: [],
    isUploading: false,
    manageCurrentFolder: { id: "root", name: "My Drive" },
    manageHistory: [],
    manageItems: [],
    manageSelected: {},
  };

  async function init() {
    const cfgClient = (window.NEXUSDRIVE_CONFIG && window.NEXUSDRIVE_CONFIG.GOOGLE_CLIENT_ID) || "";
    state.clientId = localStorage.getItem(CLIENT_ID_KEY) || cfgClient;
    const clientEl = document.getElementById("oauth-client-id");
    if (clientEl && state.clientId) clientEl.value = state.clientId;

    const form = document.getElementById("auth-form");
    if (form) form.addEventListener("submit", handleAuthSubmit);

    const dz = document.getElementById("upload-dropzone");
    if (dz) {
      dz.addEventListener("dragover", (e) => {
        e.preventDefault();
        dz.classList.add("dragover");
      });
      dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
      dz.addEventListener("drop", (e) => {
        e.preventDefault();
        dz.classList.remove("dragover");
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          handleBatchUpload(e.dataTransfer.files);
        }
      });
    }

    const savedUser = localStorage.getItem(CURRENT_USER_KEY);
    if (savedUser) {
      try {
        state.user = JSON.parse(savedUser);
        const vault = await Security.loadEncryptedTokenSession();
        if (vault && vault.accessToken) {
          state.driveConnected = true;
          state.driveMode = "live";
          state.accessToken = vault.accessToken;
          state.driveEmail = vault.email || "Google Drive";
        } else if (sessionStorage.getItem("nexusdrive_sandbox") === "true") {
          state.driveConnected = true;
          state.driveMode = "sandbox";
          state.driveEmail = "Sandbox Drive (Test Mode)";
        }
        enterDashboard();
      } catch {
        navigate("landing");
      }
    }
  }

  function navigate(viewName) {
    state.view = viewName;
    document.querySelectorAll(".view-section").forEach((el) => el.classList.remove("active"));
    const target = document.getElementById("view-" + viewName);
    if (target) target.classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goHomeOrDashboard() {
    navigate(state.user ? "dashboard" : "landing");
  }

  function openDashboardOrAuth() {
    if (state.user) enterDashboard();
    else openAuth("signup");
  }

  function showToast(title, desc = "", type = "info") {
    const box = document.getElementById("toast-container");
    if (!box) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<div class="toast-title">${Security.escapeHtml(title)}</div>${
      desc ? `<div class="toast-desc">${Security.escapeHtml(desc)}</div>` : ""
    }`;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  // ===========================================================================
  // AUTHENTICATION
  // ===========================================================================
  function openAuth(mode) {
    state.authMode = mode || "login";
    updateAuthUI();
    navigate("auth");
  }

  function toggleAuthMode() {
    state.authMode = state.authMode === "login" ? "signup" : "login";
    updateAuthUI();
  }

  function updateAuthUI() {
    const isLogin = state.authMode === "login";
    document.getElementById("auth-heading").textContent = isLogin ? "Sign in to NexusDrive" : "Create your NexusDrive account";
    document.getElementById("auth-subtitle").textContent = isLogin
      ? "Access your Drive transfer workspace"
      : "Step 1: Create your account, then connect Google Drive";
    document.getElementById("auth-name-group").classList.toggle("hidden", isLogin);
    document.getElementById("auth-name").required = !isLogin;
    document.getElementById("auth-submit-btn").textContent = isLogin ? "Sign In" : "Create Account";
    document.getElementById("auth-switch-prompt").textContent = isLogin ? "New to NexusDrive?" : "Already have an account?";
    document.getElementById("auth-switch-btn").textContent = isLogin ? "Create account" : "Sign in";
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = document.getElementById("auth-email").value.trim().toLowerCase();
    const password = document.getElementById("auth-password").value;
    const nameInput = document.getElementById("auth-name").value.trim();

    if (password.length < 4) {
      showToast("Password Too Short", "Use at least 4 characters.", "error");
      return;
    }

    const accounts = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "{}");
    const passHash = await Security.hashPassword(password);

    if (state.authMode === "signup") {
      if (accounts[email]) {
        showToast("Account Exists", "Please sign in with this email.", "error");
        openAuth("login");
        return;
      }
      const userObj = {
        name: Security.sanitizeName(nameInput || email.split("@")[0]),
        email,
        passHash,
      };
      accounts[email] = userObj;
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
      state.user = { name: userObj.name, email: userObj.email };
    } else {
      const existing = accounts[email];
      if (existing && existing.passHash !== passHash) {
        showToast("Incorrect Password", "Please check your password.", "error");
        return;
      }
      const resolvedName = existing ? existing.name : email.split("@")[0];
      if (!existing) {
        accounts[email] = { name: resolvedName, email, passHash };
        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
      }
      state.user = { name: resolvedName, email };
    }

    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(state.user));
    enterDashboard();
    showToast("Welcome to NexusDrive!", "Now connect your destination Google Drive.", "success");
  }

  function quickDemoAccountLogin() {
    state.user = { name: "ByteNexus User", email: "user@bytenexus.site" };
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(state.user));
    enterDashboard();
    showToast("Signed In", "Next step: Connect your Google Drive.", "success");
  }

  function logout() {
    localStorage.removeItem(CURRENT_USER_KEY);
    Security.clearTokenSession();
    sessionStorage.removeItem("nexusdrive_sandbox");
    state.user = null;
    state.driveConnected = false;
    state.driveMode = null;
    state.accessToken = null;
    state.driveEmail = "";
    navigate("landing");
    showToast("Signed Out", "Your session has been cleared.");
  }

  // ===========================================================================
  // DASHBOARD & DRIVE CONNECTION
  // ===========================================================================
  function enterDashboard() {
    navigate("dashboard");
    document.getElementById("dash-user-name").textContent = state.user.name;
    updateConnectionUI();
  }

  function updateConnectionUI() {
    const dot = document.getElementById("conn-status-dot");
    const emailLbl = document.getElementById("conn-email-label");
    const subLbl = document.getElementById("conn-sub-label");
    const btnConn = document.getElementById("btn-connect-drive");
    const btnDisc = document.getElementById("btn-disconnect-drive");
    const quotaPill = document.getElementById("quota-pill");

    if (state.driveConnected) {
      dot.className = "conn-dot online";
      emailLbl.textContent = state.driveEmail;
      emailLbl.style.color = "var(--emerald)";
      subLbl.textContent = "Ready to receive cloned & uploaded files directly.";
      btnConn.classList.add("hidden");
      btnDisc.classList.remove("hidden");
      quotaPill.classList.remove("hidden");
      refreshQuotaUI();
    } else {
      dot.className = "conn-dot offline";
      emailLbl.textContent = "Not Connected";
      emailLbl.style.color = "#f59e0b";
      subLbl.textContent = "Connect the Google Drive account where you want files saved.";
      btnConn.classList.remove("hidden");
      btnDisc.classList.add("hidden");
      quotaPill.classList.add("hidden");
    }
  }

  async function refreshQuotaUI() {
    try {
      let quota = null;
      if (state.driveMode === "live" && state.accessToken) {
        const about = await DriveEngine.liveVerifyToken(state.accessToken);
        if (about.storageQuota) {
          quota = {
            limit: Number(about.storageQuota.limit || 0),
            usage: Number(about.storageQuota.usage || 0),
          };
        }
      } else if (state.driveMode === "sandbox") {
        quota = await DriveEngine.sbGetQuota();
      }
      if (quota && quota.limit > 0) {
        document.getElementById("quota-text").textContent = `${DriveEngine.formatBytes(
          quota.usage
        )} / ${DriveEngine.formatBytes(quota.limit)}`;
      }
    } catch {
      // ignore
    }
  }

  function openConnectModal() {
    const preId = (window.NEXUSDRIVE_CONFIG && window.NEXUSDRIVE_CONFIG.GOOGLE_CLIENT_ID) || "";
    if (preId && window.google && window.google.accounts && window.google.accounts.oauth2) {
      state.clientId = preId;
      document.getElementById("oauth-client-id").value = preId;
      connectWithGoogleOAuth();
      return;
    }
    document.getElementById("modal-error-box").classList.add("hidden");
    document.getElementById("connect-modal").classList.remove("hidden");
  }

  function closeConnectModal() {
    document.getElementById("connect-modal").classList.add("hidden");
  }

  function toggleOwnerConfig() {
    document.getElementById("owner-config-panel").classList.toggle("hidden");
  }

  function showModalError(msg) {
    const box = document.getElementById("modal-error-box");
    box.textContent = msg;
    box.classList.remove("hidden");
  }

  function connectWithGoogleOAuth() {
    const inputId = document.getElementById("oauth-client-id").value.trim() || state.clientId;
    if (!inputId) {
      showModalError("Paste a Google OAuth Client ID, or click 'Connect Sandbox Drive' above.");
      return;
    }
    state.clientId = inputId;
    localStorage.setItem(CLIENT_ID_KEY, inputId);

    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      showModalError("Google Sign-In script is loading or blocked. Check your internet connection.");
      return;
    }

    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: inputId,
        scope: "https://www.googleapis.com/auth/drive",
        prompt: "consent",
        callback: async (resp) => {
          if (resp.error || !resp.access_token) {
            showModalError(resp.error || "Google authorization cancelled.");
            return;
          }
          await finalizeLiveDriveConnection(resp.access_token, resp.expires_in || 3599);
          closeConnectModal();
        },
      });
      client.requestAccessToken({ prompt: "consent" });
    } catch (err) {
      showModalError(err.message || "Google OAuth failed.");
    }
  }

  async function connectWithManualToken() {
    const token = document.getElementById("manual-access-token").value.trim();
    if (!token) {
      showModalError("Paste a valid Google Access Token.");
      return;
    }
    try {
      await finalizeLiveDriveConnection(token, 3599);
      document.getElementById("manual-access-token").value = "";
      closeConnectModal();
    } catch (err) {
      showModalError(err.message || "Token verification failed.");
    }
  }

  async function finalizeLiveDriveConnection(accessToken, expiresInSec) {
    const about = await DriveEngine.liveVerifyToken(accessToken);
    const email = (about.user && about.user.emailAddress) || "Google Drive Connected";
    await Security.saveEncryptedTokenSession({
      accessToken,
      email,
      expiresAt: Date.now() + expiresInSec * 1000,
    });
    sessionStorage.removeItem("nexusdrive_sandbox");
    state.driveConnected = true;
    state.driveMode = "live";
    state.accessToken = accessToken;
    state.driveEmail = email;
    updateConnectionUI();
    showToast("Google Drive Connected!", `Connected as ${email}`, "success");
  }

  function connectSandboxDrive() {
    Security.clearTokenSession();
    sessionStorage.setItem("nexusdrive_sandbox", "true");
    state.driveConnected = true;
    state.driveMode = "sandbox";
    state.accessToken = null;
    state.driveEmail = "Sandbox Drive (Test Mode)";
    updateConnectionUI();
    closeConnectModal();
    showToast("Sandbox Drive Connected!", "You can now scan, upload, clone & preview.", "success");
  }

  function disconnectDrive() {
    if (state.accessToken) {
      fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(state.accessToken), {
        method: "POST",
      }).catch(() => {});
    }
    Security.clearTokenSession();
    sessionStorage.removeItem("nexusdrive_sandbox");
    state.driveConnected = false;
    state.driveMode = null;
    state.accessToken = null;
    state.driveEmail = "";
    updateConnectionUI();
    showToast("Disconnected", "Google Drive unlinked cleanly.");
  }

  function switchTab(tabName) {
    document.querySelectorAll(".pill-tab, .m-pill").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabName);
    });
    document.querySelectorAll(".dash-panel").forEach((p) => p.classList.remove("active"));
    const panel = document.getElementById("tab-" + tabName);
    if (panel) panel.classList.add("active");

    if (tabName === "manage" && state.driveConnected) {
      refreshManager();
    }
  }

  // ===========================================================================
  // TAB 1: CLONE LINK (SIMPLE & TO THE POINT)
  // ===========================================================================
  function fillSampleLink() {
    document.getElementById("clone-source-link").value = "https://drive.google.com/drive/my-drive";
  }

  function getActiveFilters() {
    const autoClean = document.getElementById("opt-auto-clean").checked;
    if (!autoClean) return { skipKeywords: [], skipExtensions: [] };
    return {
      skipKeywords: ["promo", "ads", "link", "telegram", "bonus"],
      skipExtensions: ["url", "html"],
    };
  }

  async function scanSourceLink() {
    if (!state.driveConnected) {
      openConnectModal();
      showToast("Connect Drive First", "Connect your destination Google Drive first.", "error");
      return;
    }

    const rawLink = document.getElementById("clone-source-link").value.trim();
    if (!rawLink) {
      showToast("Paste Link", "Enter a Google Drive folder or file link.", "error");
      return;
    }

    const btn = document.getElementById("btn-scan-link");
    const txt = document.getElementById("scan-btn-text");
    btn.disabled = true;
    txt.textContent = "Scanning...";

    try {
      const filters = getActiveFilters();
      let result;
      if (state.driveMode === "live" && state.accessToken) {
        const rootId = DriveEngine.extractDriveId(rawLink);
        if (!rootId) throw new Error("Invalid Google Drive link.");
        result = await DriveEngine.liveScanTree(rootId, state.accessToken, filters);
      } else {
        result = await DriveEngine.sbScanSourceLink(rawLink, filters);
      }

      state.scannedRoot = result.root;
      state.scanStats = result.stats;
      state.selectedMap = {};
      const mark = (n) => {
        state.selectedMap[n.id] = true;
        if (n.children) n.children.forEach(mark);
      };
      mark(result.root);

      document.getElementById("tree-section").classList.remove("hidden");
      renderTree();
      showToast("Scan Complete", `Found ${result.stats.totalFiles} files (${DriveEngine.formatBytes(result.stats.totalBytes)}).`, "success");
    } catch (err) {
      showToast("Scan Failed", err.message || "Could not scan link.", "error");
    } finally {
      btn.disabled = false;
      txt.textContent = "Scan Files";
    }
  }

  function renderTree() {
    const container = document.getElementById("tree-container");
    if (!state.scannedRoot || !container) return;
    let html = "";

    function draw(node, depth = 0) {
      const checked = state.selectedMap[node.id] ? "checked" : "";
      const isFolder = node.kind === "folder";
      const sizeStr = !isFolder && node.size ? DriveEngine.formatBytes(node.size) : "";
      html += `<div class="tree-row" style="padding-left:${Math.min(depth * 16 + 8, 96)}px">
        <input type="checkbox" ${checked} onchange="App.toggleTreeNode('${Security.escapeHtml(node.id)}', this.checked)" />
        <span>${isFolder ? "📁" : "📄"}</span>
        <span class="tree-name">${Security.escapeHtml(node.name)}</span>
        ${sizeStr ? `<span class="tree-size">${sizeStr}</span>` : ""}
      </div>`;
      if (isFolder && node.children) node.children.forEach((c) => draw(c, depth + 1));
    }

    draw(state.scannedRoot);
    container.innerHTML = html;

    let cnt = 0;
    let bytes = 0;
    const calc = (n) => {
      if (n.kind === "file" && state.selectedMap[n.id]) {
        cnt++;
        bytes += Number(n.size || 0);
      }
      if (n.children) n.children.forEach(calc);
    };
    calc(state.scannedRoot);
    document.getElementById("tree-summary-badge").textContent = `${cnt} files selected (${DriveEngine.formatBytes(bytes)})`;
  }

  function toggleTreeNode(nodeId, checked) {
    function walk(n) {
      if (n.id === nodeId) {
        const mark = (sub) => {
          state.selectedMap[sub.id] = checked;
          if (sub.children) sub.children.forEach(mark);
        };
        mark(n);
        return true;
      }
      if (n.children) {
        for (const ch of n.children) {
          if (walk(ch)) return true;
        }
      }
      return false;
    }
    if (state.scannedRoot) {
      walk(state.scannedRoot);
      renderTree();
    }
  }

  function selectAllTree(checked) {
    if (!state.scannedRoot) return;
    const walk = (n) => {
      state.selectedMap[n.id] = checked;
      if (n.children) n.children.forEach(walk);
    };
    walk(state.scannedRoot);
    renderTree();
  }

  async function startCloneTransfer() {
    if (!state.driveConnected) {
      openConnectModal();
      showToast("Connect Drive First", "Connect your Google Drive before starting transfer.", "error");
      return;
    }

    const rawLink = document.getElementById("clone-source-link").value.trim();
    if (!rawLink && !state.scannedRoot) {
      showToast("Paste Link", "Enter a Google Drive folder or file link.", "error");
      return;
    }

    if (!state.scannedRoot) {
      await scanSourceLink();
      if (!state.scannedRoot) return;
    }

    const btn = document.getElementById("btn-start-clone");
    const statusBox = document.getElementById("clone-status-box");
    const doneRow = document.getElementById("clone-done-row");
    const errBox = document.getElementById("clone-error-log");
    btn.disabled = true;
    statusBox.classList.remove("hidden");
    doneRow.classList.add("hidden");
    errBox.classList.add("hidden");
    updateCloneProgress("Creating destination folder...", 0, 1);

    const isLive = state.driveMode === "live" && state.accessToken;
    const errors = [];

    try {
      const root = state.scannedRoot;
      if (root.kind === "file") {
        if (isLive) {
          await DriveEngine.withBackoff(() =>
            DriveEngine.liveCopyFileWithFallback(root.shortcutTargetId || root.id, root.name, "root", root.mimeType, state.accessToken)
          );
        } else {
          await DriveEngine.sbCopyFile(root.id, root.name, "root");
        }
        updateCloneProgress("Transfer complete!", 1, 1);
        doneRow.classList.remove("hidden");
        refreshQuotaUI();
        return;
      }

      const customName = document.getElementById("clone-dest-name").value.trim();
      const rootFolderName = customName || root.name;

      const createdRoot = isLive
        ? await DriveEngine.withBackoff(() => DriveEngine.liveCreateFolder(rootFolderName, "root", state.accessToken))
        : await DriveEngine.sbCreateFolder(rootFolderName, "root");

      const copyTasks = [];
      const folderPool = DriveEngine.createConcurrencyPool(10);

      async function buildTree(node, parentId) {
        const subFolders = [];
        for (const ch of node.children || []) {
          if (!state.selectedMap[ch.id]) continue;
          if (ch.kind === "file") {
            copyTasks.push({
              sourceId: ch.shortcutTargetId || ch.id,
              name: ch.name,
              mimeType: ch.mimeType,
              parentId,
            });
          } else {
            subFolders.push(ch);
          }
        }
        await Promise.all(
          subFolders.map((sf) =>
            folderPool(async () => {
              const created = isLive
                ? await DriveEngine.withBackoff(() => DriveEngine.liveCreateFolder(sf.name, parentId, state.accessToken))
                : await DriveEngine.sbCreateFolder(sf.name, parentId);
              await buildTree(sf, created.id);
            })
          )
        );
      }

      await buildTree(root, createdRoot.id);

      const total = copyTasks.length;
      let done = 0;
      const copyPool = DriveEngine.createConcurrencyPool(20);

      await Promise.all(
        copyTasks.map((t) =>
          copyPool(async () => {
            try {
              if (isLive) {
                await DriveEngine.withBackoff(() =>
                  DriveEngine.liveCopyFileWithFallback(t.sourceId, t.name, t.parentId, t.mimeType, state.accessToken)
                );
              } else {
                await DriveEngine.sbCopyFile(t.sourceId, t.name, t.parentId);
              }
            } catch (err) {
              errors.push(`${t.name}: ${err.message || err}`);
            } finally {
              done++;
              updateCloneProgress(`Copying files (${done}/${total})...`, done, Math.max(1, total));
            }
          })
        )
      );

      updateCloneProgress(`Completed ${total} files!`, total, Math.max(1, total));
      doneRow.classList.remove("hidden");
      if (errors.length) {
        errBox.classList.remove("hidden");
        errBox.innerHTML = errors.map((e) => `<div>• ${Security.escapeHtml(e)}</div>`).join("");
      }
      refreshQuotaUI();
      showToast("Transfer Complete!", `${total} files saved to your Google Drive.`, "success");
    } catch (err) {
      showToast("Transfer Failed", err.message || "Error occurred.", "error");
    } finally {
      btn.disabled = false;
    }
  }

  function updateCloneProgress(msg, done, total) {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    document.getElementById("clone-progress-msg").textContent = msg;
    document.getElementById("clone-progress-pct").textContent = pct + "%";
    document.getElementById("clone-progress-bar").style.width = pct + "%";
  }

  // ===========================================================================
  // TAB 2: UPLOAD FILES
  // ===========================================================================
  async function handleBatchUpload(fileList) {
    if (!state.driveConnected) {
      openConnectModal();
      showToast("Connect Drive First", "Connect your Google Drive before uploading.", "error");
      return;
    }
    if (!fileList || !fileList.length) return;

    const items = Array.from(fileList).map((f) => ({
      id: "up_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      file: f,
      status: "queued",
      pct: 0,
    }));
    state.uploadQueue.push(...items);
    state.isUploading = true;
    renderUploadQueue();

    const isLive = state.driveMode === "live" && state.accessToken;
    for (const item of items) {
      item.status = "uploading";
      renderUploadQueue();
      try {
        const onProg = (p) => {
          item.pct = p;
          renderUploadQueue();
        };
        if (isLive) await DriveEngine.liveUploadFileWithProgress(item.file, "root", state.accessToken, onProg);
        else await DriveEngine.sbUploadFile(item.file, "root", onProg);
        item.status = "done";
        item.pct = 100;
      } catch (err) {
        item.status = "error";
        item.err = err.message || "Upload failed";
      }
      renderUploadQueue();
    }

    state.isUploading = false;
    refreshQuotaUI();
    showToast("Upload Complete!", "Files saved to your Drive.", "success");
  }

  function renderUploadQueue() {
    const list = document.getElementById("upload-queue-list");
    const wrap = document.getElementById("upload-progress-wrap");
    if (!state.uploadQueue.length) {
      wrap.classList.add("hidden");
      list.innerHTML = "";
      return;
    }
    wrap.classList.remove("hidden");
    const done = state.uploadQueue.filter((i) => i.status === "done").length;
    const pct = Math.round((done / state.uploadQueue.length) * 100);
    document.getElementById("upload-count-text").textContent = `${done}/${state.uploadQueue.length}`;
    document.getElementById("upload-progress-bar").style.width = pct + "%";

    list.innerHTML = state.uploadQueue
      .map((i) => {
        const st =
          i.status === "done"
            ? `<span style="color:var(--emerald);font-weight:700">✓ Done</span>`
            : i.status === "uploading"
            ? `<span style="color:var(--blue);font-weight:700">Uploading ${i.pct || 0}%</span>`
            : i.status === "error"
            ? `<span style="color:var(--danger)">${Security.escapeHtml(i.err || "Error")}</span>`
            : `<span style="color:var(--muted)">Queued</span>`;
        return `<div class="list-row">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Security.escapeHtml(i.file.name)} (${DriveEngine.formatBytes(i.file.size)})</span>
          ${st}
        </div>`;
      })
      .join("");
  }

  function clearUploadQueue() {
    if (state.isUploading) return;
    state.uploadQueue = [];
    renderUploadQueue();
  }

  // ===========================================================================
  // TAB 3: MY DRIVE FILES (EXPLORER & PREVIEW)
  // ===========================================================================
  async function refreshManager() {
    if (!state.driveConnected) {
      openConnectModal();
      return;
    }
    const listEl = document.getElementById("manage-file-list");
    listEl.innerHTML = `<div class="empty-msg">Loading files...</div>`;
    state.manageSelected = {};
    updateManageSelectedCount();

    const search = document.getElementById("manage-search-input").value.trim();
    const folderId = state.manageCurrentFolder.id;

    try {
      let items;
      if (state.driveMode === "live" && state.accessToken) {
        items = await DriveEngine.liveListChildren(folderId, state.accessToken);
        if (search) {
          const q = search.toLowerCase();
          items = items.filter((i) => i.name.toLowerCase().includes(q));
        }
      } else {
        items = await DriveEngine.sbListFolder(folderId, search);
      }

      state.manageItems = items;
      document.getElementById("manage-current-folder-name").textContent = state.manageCurrentFolder.name;
      document.getElementById("btn-manage-back").classList.toggle("hidden", state.manageHistory.length === 0);

      if (!items.length) {
        listEl.innerHTML = `<div class="empty-msg">This folder is empty.</div>`;
        return;
      }

      listEl.innerHTML = items
        .map((it) => {
          const isFolder = it.mimeType === "application/vnd.google-apps.folder";
          return `<div class="manage-row">
            <input type="checkbox" onchange="App.toggleManageItem('${Security.escapeHtml(it.id)}', this.checked)" />
            <div class="manage-item-main" onclick="App.onManageItemClick('${Security.escapeHtml(it.id)}')">
              <span>${isFolder ? "📁" : "📄"}</span>
              <div style="min-width:0;flex:1">
                <div class="manage-item-title">${Security.escapeHtml(it.name)}</div>
                <div class="manage-item-meta">${isFolder ? "Folder" : DriveEngine.formatBytes(Number(it.size || 0))}</div>
              </div>
            </div>
            ${!isFolder ? `<button type="button" class="btn btn-outline btn-xs" onclick="App.onManageItemClick('${Security.escapeHtml(it.id)}')">Preview</button>` : ""}
          </div>`;
        })
        .join("");
    } catch (err) {
      listEl.innerHTML = `<div class="empty-msg" style="color:#fca5a5">${Security.escapeHtml(err.message)}</div>`;
    }
  }

  function toggleManageItem(id, checked) {
    state.manageSelected[id] = checked;
    updateManageSelectedCount();
  }

  function updateManageSelectedCount() {
    const cnt = Object.values(state.manageSelected).filter(Boolean).length;
    document.getElementById("manage-selected-count").textContent = cnt;
    document.getElementById("btn-delete-selected").disabled = cnt === 0;
  }

  async function onManageItemClick(id) {
    const item = state.manageItems.find((i) => i.id === id);
    if (!item) return;

    if (item.mimeType === "application/vnd.google-apps.folder") {
      state.manageHistory.push({ ...state.manageCurrentFolder });
      state.manageCurrentFolder = { id: item.id, name: item.name };
      refreshManager();
      return;
    }

    const previewBox = document.getElementById("manage-preview-area");
    document.getElementById("btn-close-preview").classList.remove("hidden");

    if (state.driveMode === "live" && item.webViewLink) {
      const embedUrl = item.webViewLink.replace(/\/view.*$/, "/preview");
      previewBox.innerHTML = `<iframe src="${Security.escapeHtml(embedUrl)}" allow="autoplay" allowfullscreen></iframe>`;
      return;
    }

    const blob = await DriveEngine.sbGetBlob(item.id);
    if (blob) {
      const objUrl = URL.createObjectURL(blob);
      if (item.mimeType.startsWith("image/")) {
        previewBox.innerHTML = `<img src="${objUrl}" alt="${Security.escapeHtml(item.name)}" />
          <a href="${objUrl}" download="${Security.escapeHtml(item.name)}" class="btn btn-blue btn-sm" style="margin-top:12px">Download</a>`;
        return;
      }
      if (item.mimeType.startsWith("video/")) {
        previewBox.innerHTML = `<video src="${objUrl}" controls style="max-width:100%;max-height:340px;border-radius:8px"></video>`;
        return;
      }
    }

    const text = item.previewText || `Cloud File: ${item.name} (${DriveEngine.formatBytes(Number(item.size || 0))})`;
    previewBox.innerHTML = `<pre>${Security.escapeHtml(text)}</pre>`;
  }

  function closePreview() {
    document.getElementById("btn-close-preview").classList.add("hidden");
    document.getElementById("manage-preview-area").innerHTML =
      `<div class="empty-msg">Click any file on the left to preview it here.</div>`;
  }

  function manageGoBack() {
    if (!state.manageHistory.length) return;
    state.manageCurrentFolder = state.manageHistory.pop();
    refreshManager();
  }

  async function createManagerFolder() {
    const input = document.getElementById("manage-new-folder-input");
    const name = input.value.trim();
    if (!name) return;
    try {
      if (state.driveMode === "live" && state.accessToken) {
        await DriveEngine.liveCreateFolder(name, state.manageCurrentFolder.id, state.accessToken);
      } else {
        await DriveEngine.sbCreateFolder(name, state.manageCurrentFolder.id);
      }
      input.value = "";
      refreshManager();
      showToast("Folder Created", `Created "${name}"`, "success");
    } catch (err) {
      showToast("Error", err.message, "error");
    }
  }

  async function deleteSelectedManaged() {
    const ids = Object.keys(state.manageSelected).filter((k) => state.manageSelected[k]);
    if (!ids.length) return;
    try {
      if (state.driveMode === "live" && state.accessToken) {
        await DriveEngine.liveDeleteFiles(ids, state.accessToken);
      } else {
        await DriveEngine.sbDeleteItems(ids);
      }
      showToast("Deleted", `${ids.length} item(s) removed.`, "success");
      refreshManager();
      refreshQuotaUI();
    } catch (err) {
      showToast("Delete Error", err.message, "error");
    }
  }

  window.addEventListener("DOMContentLoaded", init);

  return {
    navigate,
    goHomeOrDashboard,
    openDashboardOrAuth,
    openAuth,
    toggleAuthMode,
    quickDemoAccountLogin,
    logout,
    openConnectModal,
    closeConnectModal,
    toggleOwnerConfig,
    connectWithGoogleOAuth,
    connectWithManualToken,
    connectSandboxDrive,
    disconnectDrive,
    switchTab,
    fillSampleLink,
    scanSourceLink,
    toggleTreeNode,
    selectAllTree,
    startCloneTransfer,
    handleBatchUpload,
    clearUploadQueue,
    refreshManager,
    toggleManageItem,
    onManageItemClick,
    closePreview,
    manageGoBack,
    createManagerFolder,
    deleteSelectedManaged,
  };
})();
