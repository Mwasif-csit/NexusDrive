/**
 * NexusDrive by ByteNexus — Production Controller (Zero Demo/Temporary Logins)
 * Exact NitroDrive-Grade Flow:
 *   1. Real Account Sign-Up / Sign-In OR Official Google Sign-In ("Continue with Google")
 *   2. Official Google OAuth 2.0 Drive Connection ("Connect Google Drive")
 *   3. 1000X Direct Google Drive API v3 Cloning, Resumable Upload & File Manager
 */
const App = (() => {
  const ACCOUNTS_KEY = "nexusdrive_accounts_v1";
  const CURRENT_USER_KEY = "nexusdrive_user_v1";

  const state = {
    view: "landing",
    authMode: "login",
    user: null,
    driveConnected: false,
    driveEmail: "",
    accessToken: null,
    scannedRoot: null,
    scannedSourceId: null,
    scannedFilterKey: "",
    scanStats: null,
    selectedMap: {},
    injectedFiles: [],
    isCloning: false,
    uploadQueue: [],
    isUploading: false,
    lastUploadRenderTs: 0,
    manageCurrentFolder: { id: "root", name: "My Drive" },
    manageHistory: [],
    manageItems: [],
    manageSelected: {},
  };

  function getGoogleClientId() {
    return (
      (window.NEXUSDRIVE_CONFIG && window.NEXUSDRIVE_CONFIG.GOOGLE_CLIENT_ID) ||
      ""
    ).trim();
  }

  async function init() {
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

    // Restore authenticated user & encrypted Google Drive token session
    const savedUser = localStorage.getItem(CURRENT_USER_KEY);
    if (savedUser) {
      try {
        state.user = JSON.parse(savedUser);
        const vault = await Security.loadEncryptedTokenSession();
        if (vault && vault.accessToken) {
          state.driveConnected = true;
          state.accessToken = vault.accessToken;
          state.driveEmail = vault.email || "Google Drive";
        }
        enterDashboard();
      } catch {
        localStorage.removeItem(CURRENT_USER_KEY);
        navigate("landing");
      }
    } else if (location.hash === "#auth") {
      openAuth("login");
    } else if (location.hash === "#about") {
      navigate("about");
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
    setTimeout(() => el.remove(), 4500);
  }

  // ===========================================================================
  // PRODUCTION AUTHENTICATION (NO DEMO / NO TEMPORARY LOGINS)
  // ===========================================================================
  function setAuthInlineError(msg) {
    const el = document.getElementById("auth-inline-alert");
    if (!el) return;
    if (!msg) {
      el.classList.add("hidden");
      el.textContent = "";
    } else {
      el.classList.remove("hidden");
      el.textContent = msg;
    }
  }

  function openAuth(mode) {
    state.authMode = mode || "login";
    setAuthInlineError("");
    updateAuthUI();
    navigate("auth");
  }

  function toggleAuthMode() {
    state.authMode = state.authMode === "login" ? "signup" : "login";
    setAuthInlineError("");
    updateAuthUI();
  }

  function togglePasswordVisibility() {
    const input = document.getElementById("auth-password");
    input.type = input.type === "password" ? "text" : "password";
  }

  function updateAuthUI() {
    const isLogin = state.authMode === "login";
    document.getElementById("auth-heading").textContent = isLogin ? "Welcome back" : "Create your account";
    document.getElementById("auth-subtitle").textContent = isLogin
      ? "Sign in to continue to NexusDrive"
      : "Start uploading files at lightning speed";
    document.getElementById("auth-name-group").classList.toggle("hidden", isLogin);
    document.getElementById("auth-name").required = !isLogin;
    document.getElementById("auth-submit-btn").textContent = isLogin ? "Sign In" : "Create Account";
    document.getElementById("auth-switch-prompt").textContent = isLogin ? "Don't have an account?" : "Already have an account?";
    document.getElementById("auth-switch-btn").textContent = isLogin ? "Sign up" : "Sign in";
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    setAuthInlineError("");
    const email = document.getElementById("auth-email").value.trim().toLowerCase();
    const password = document.getElementById("auth-password").value;
    const nameInput = document.getElementById("auth-name").value.trim();

    if (!email || !email.includes("@")) {
      setAuthInlineError("Please enter a valid email address.");
      showToast("Invalid Email", "Please enter a valid email address.", "error");
      return;
    }
    if (password.length < 6) {
      setAuthInlineError("Password must be at least 6 characters.");
      showToast("Password Too Short", "Password must be at least 6 characters.", "error");
      return;
    }

    const accounts = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "{}");
    const passHash = await Security.hashPassword(password);

    if (state.authMode === "signup") {
      if (accounts[email]) {
        setAuthInlineError("This email is already registered. Please sign in instead.");
        showToast(
          "Account already exists",
          "This email address is already registered. Please sign in instead.",
          "error"
        );
        state.authMode = "login";
        updateAuthUI();
        return;
      }
      if (!nameInput) {
        setAuthInlineError("Please enter your full name.");
        showToast("Name Required", "Please enter your full name.", "error");
        return;
      }
      const userObj = {
        name: Security.sanitizeName(nameInput),
        email,
        passHash,
        provider: "email",
      };
      accounts[email] = userObj;
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
      state.user = { name: userObj.name, email: userObj.email };
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(state.user));
      enterDashboard();
      showToast("Account created!", "Now connect your Google Drive to get started.", "success");
    } else {
      const existing = accounts[email];
      if (!existing || existing.passHash !== passHash) {
        const msg = "Invalid email or password. If you signed up with Google, please click 'Continue with Google'.";
        setAuthInlineError(msg);
        showToast("Login failed", msg, "error");
        return;
      }
      state.user = { name: existing.name, email: existing.email };
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(state.user));
      enterDashboard();
      showToast("Welcome back!", `Signed in as ${existing.email}`, "success");
    }
  }

  /**
   * Real Google OAuth Sign-In ("Continue with Google")
   */
  function loginWithGoogle() {
    const clientId = getGoogleClientId();
    if (!clientId) {
      showToast("Configuration Missing", "Google Client ID is not set in js/config.js.", "error");
      return;
    }
    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      showToast("Google Auth Loading", "Google Sign-In SDK is loading. Please try again in a second.", "error");
      return;
    }

    const btn = document.getElementById("btn-google-login");
    btn.disabled = true;

    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "openid email profile",
        callback: async (resp) => {
          btn.disabled = false;
          if (resp.error || !resp.access_token) {
            handleOAuthError(resp.error || "Google sign-in was cancelled.");
            return;
          }
          try {
            const profile = await DriveEngine.fetchGoogleUserProfile(resp.access_token);
            state.user = {
              name: Security.sanitizeName(profile.name || profile.email.split("@")[0]),
              email: profile.email,
            };
            localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(state.user));
            enterDashboard();
            showToast("Welcome!", `Signed in with Google as ${profile.email}`, "success");
          } catch (err) {
            showToast("Profile Error", err.message || "Could not load Google profile.", "error");
          }
        },
      });
      client.requestAccessToken({ prompt: "select_account" });
    } catch (err) {
      btn.disabled = false;
      showToast("Google Login Failed", err.message || "OAuth initialization failed.", "error");
    }
  }

  function logout() {
    if (state.accessToken) {
      fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(state.accessToken), {
        method: "POST",
      }).catch(() => {});
    }
    localStorage.removeItem(CURRENT_USER_KEY);
    Security.clearTokenSession();
    state.user = null;
    state.driveConnected = false;
    state.accessToken = null;
    state.driveEmail = "";
    state.scannedRoot = null;
    navigate("landing");
    showToast("Logged Out", "You have been signed out safely.");
  }

  // ===========================================================================
  // DASHBOARD & REAL GOOGLE DRIVE OAUTH CONNECTION
  // ===========================================================================
  function enterDashboard() {
    navigate("dashboard");
    document.getElementById("dash-user-name").textContent = state.user.name;
    updateConnectionUI();
  }

  function updateConnectionUI() {
    const btnConn = document.getElementById("btn-connect-drive");
    const btnDisc = document.getElementById("btn-disconnect-drive");
    const quotaPill = document.getElementById("quota-pill");
    const upPill = document.getElementById("upload-conn-pill");
    const emailLbl = document.getElementById("conn-email-label");

    if (state.driveConnected && state.accessToken) {
      btnConn.classList.add("hidden");
      btnDisc.classList.remove("hidden");
      emailLbl.textContent = `Drive Connected (${state.driveEmail})`;
      quotaPill.classList.remove("hidden");
      if (upPill) {
        upPill.textContent = "✓ Drive Connected";
        upPill.style.color = "#4ade80";
        upPill.style.borderColor = "rgba(34,197,94,0.4)";
      }
      refreshQuotaUI();
    } else {
      btnConn.classList.remove("hidden");
      btnDisc.classList.add("hidden");
      quotaPill.classList.add("hidden");
      if (upPill) {
        upPill.textContent = "Connect Drive first";
        upPill.style.color = "";
        upPill.style.borderColor = "";
      }
    }
  }

  async function refreshQuotaUI() {
    if (!state.accessToken) return;
    try {
      const about = await DriveEngine.liveVerifyToken(state.accessToken);
      if (about.storageQuota && Number(about.storageQuota.limit) > 0) {
        document.getElementById("quota-text").textContent = `${DriveEngine.formatBytes(
          Number(about.storageQuota.usage || 0)
        )} / ${DriveEngine.formatBytes(Number(about.storageQuota.limit))}`;
      }
    } catch (err) {
      if (String(err.message).includes("401")) {
        handleSessionExpired();
      }
    }
  }

  function connectGoogleDrive() {
    const clientId = getGoogleClientId();
    if (!clientId) {
      showToast("Client ID Missing", "Google Client ID must be set in js/config.js.", "error");
      return;
    }
    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      showToast("Google OAuth Loading", "Please wait a moment and click Connect Google Drive again.", "error");
      return;
    }

    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "https://www.googleapis.com/auth/drive",
        callback: async (resp) => {
          if (resp.error || !resp.access_token) {
            handleOAuthError(resp.error || "No access token returned by Google.");
            return;
          }
          try {
            const about = await DriveEngine.liveVerifyToken(resp.access_token);
            const email = (about.user && about.user.emailAddress) || state.user.email || "Google Drive";
            const expiresSec = Number(resp.expires_in) || 3599;
            await Security.saveEncryptedTokenSession({
              accessToken: resp.access_token,
              email,
              expiresAt: Date.now() + expiresSec * 1000,
            });
            state.driveConnected = true;
            state.accessToken = resp.access_token;
            state.driveEmail = email;
            updateConnectionUI();
            showToast("Google Drive Connected!", `Connected to ${email}`, "success");
          } catch (err) {
            showToast("Verification Failed", err.message || "Could not verify Drive access.", "error");
          }
        },
      });
      client.requestAccessToken({
        prompt: "consent",
        ...(state.user && state.user.email ? { hint: state.user.email } : {}),
      });
    } catch (err) {
      showToast("Connection Failed", err.message || "Could not open Google Drive popup.", "error");
    }
  }

  function handleOAuthError(errCode) {
    const msg = String(errCode);
    if (msg.toLowerCase().includes("redirect_uri_mismatch")) {
      showToast(
        "Domain Not Authorized",
        "Add this website URL to Authorized JavaScript origins in Google Cloud Console.",
        "error"
      );
    } else if (msg.toLowerCase().includes("access_denied")) {
      showToast("Access Denied", "Authorization was cancelled or account is not added in Google Test Users.", "error");
    } else {
      showToast("Google Auth Error", msg, "error");
    }
  }

  function handleSessionExpired() {
    Security.clearTokenSession();
    state.driveConnected = false;
    state.accessToken = null;
    state.driveEmail = "";
    updateConnectionUI();
    showToast(
      "Session Expired",
      "Your Google Drive session has expired. Please click 'Connect Google Drive' to authorize again.",
      "error"
    );
  }

  function disconnectDrive() {
    if (state.accessToken) {
      fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(state.accessToken), {
        method: "POST",
      }).catch(() => {});
    }
    Security.clearTokenSession();
    state.driveConnected = false;
    state.accessToken = null;
    state.driveEmail = "";
    updateConnectionUI();
    showToast("Drive Disconnected", "Google Drive connection removed.");
  }

  function switchTab(tabName, resetRoot = false) {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-content").forEach((p) => p.classList.remove("active"));
    const panel = document.getElementById("tab-" + tabName);
    if (panel) panel.classList.add("active");

    if (tabName === "manage" && state.driveConnected && state.accessToken) {
      if (resetRoot) {
        state.manageCurrentFolder = { id: "root", name: "My Drive" };
        state.manageHistory = [];
      }
      refreshManager();
    }
  }

  // ===========================================================================
  // TAB 1: SMART CLONE (100% REAL GOOGLE DRIVE API)
  // ===========================================================================
  function getFiltersFromUI() {
    const exactEl = document.getElementById("filter-exact-replace");
    return {
      skipKeywords: document.getElementById("filter-keywords").value.split(",").map((s) => s.trim()).filter(Boolean),
      skipExtensions: [],
      exactReplaceNames: exactEl
        ? exactEl.value.split(",").map((s) => DriveEngine.normalizeText(s)).filter(Boolean)
        : [],
    };
  }

  async function scanSourceLink() {
    if (!state.driveConnected || !state.accessToken) {
      connectGoogleDrive();
      return;
    }

    const rawLink = document.getElementById("clone-source-link").value.trim();
    const rootId = DriveEngine.extractDriveId(rawLink);
    if (!rootId) {
      showToast("Invalid Link", "Please paste a valid Google Drive folder or file link.", "error");
      return;
    }

    const btn = document.getElementById("btn-scan-link");
    const txt = document.getElementById("scan-btn-text");
    const radarDesc = document.getElementById("radar-idle-desc");
    btn.disabled = true;
    txt.textContent = "Scanning...";
    if (radarDesc) radarDesc.textContent = "Scanning source Drive structure...";

    try {
      const filters = getFiltersFromUI();
      const filterKey = filters.skipKeywords.join(",") + "|" + filters.exactReplaceNames.join(",");
      const result = await DriveEngine.liveScanTree(rootId, state.accessToken, filters, (msg) => {
        if (radarDesc) radarDesc.textContent = msg;
      });

      state.scannedRoot = result.root;
      state.scannedSourceId = rootId;
      state.scannedFilterKey = filterKey;
      state.scanStats = result.stats;
      state.selectedMap = {};
      const exactList = filters.exactReplaceNames || [];

      const mark = (n) => {
        const norm = DriveEngine.normalizeText(n.name);
        const isExact = n.kind === "file" && exactList.some((ex) => norm.includes(ex));
        state.selectedMap[n.id] = !isExact;
        if (n.children) n.children.forEach(mark);
      };
      mark(result.root);

      document.getElementById("tree-section").classList.remove("hidden");
      document.getElementById("radar-idle-desc").textContent =
        "Content is filtered and ready for high-speed injection.";
      renderTree();
      showToast(
        "Nexus Scan Ready",
        `Found ${result.stats.totalFiles} files (${DriveEngine.formatBytes(result.stats.totalBytes)}).`,
        "success"
      );
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes("401") || msg.includes("Invalid Credentials")) handleSessionExpired();
      else showToast("Scan Failed", msg, "error");
    } finally {
      btn.disabled = false;
      txt.textContent = "Scan";
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
      html += `<div class="tree-row" style="padding-left:${Math.min(depth * 14 + 6, 84)}px">
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
    document.getElementById("tree-summary-badge").textContent = `Selected Content (${cnt} • ${DriveEngine.formatBytes(bytes)})`;
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

  function addInjectFiles(fileList) {
    if (!fileList || !fileList.length) return;
    state.injectedFiles.push(...Array.from(fileList));
    renderInjectTags();
  }

  function renderInjectTags() {
    const wrap = document.getElementById("inject-file-tags");
    wrap.innerHTML = state.injectedFiles
      .map(
        (f, i) =>
          `<span class="file-tag">${Security.escapeHtml(f.name)} <button type="button" onclick="App.removeInjectFile(${i})">✕</button></span>`
      )
      .join("");
  }

  function removeInjectFile(idx) {
    state.injectedFiles.splice(idx, 1);
    renderInjectTags();
  }

  function setRadarView(mode, stageText = "") {
    document.getElementById("radar-idle-view").classList.toggle("hidden", mode !== "idle");
    document.getElementById("radar-running-view").classList.toggle("hidden", mode !== "running");
    document.getElementById("radar-done-view").classList.toggle("hidden", mode !== "done");
    if (mode === "running" && stageText) {
      document.getElementById("radar-stage-pill").textContent = `PROCESSING STAGE: ${stageText.toUpperCase()}`;
    }
  }

  async function startCloneTransfer() {
    if (!state.driveConnected || !state.accessToken) {
      connectGoogleDrive();
      return;
    }

    const rawLink = document.getElementById("clone-source-link").value.trim();
    const currentId = DriveEngine.extractDriveId(rawLink);
    const preFilters = getFiltersFromUI();
    const currentFilterKey = preFilters.skipKeywords.join(",") + "|" + preFilters.exactReplaceNames.join(",");

    if (!rawLink && !state.scannedRoot) {
      showToast("Paste Link", "Enter a Google Drive folder or file link.", "error");
      return;
    }

    const needsRescan =
      !state.scannedRoot ||
      (currentId && currentId !== state.scannedSourceId) ||
      currentFilterKey !== state.scannedFilterKey;

    if (needsRescan) {
      state.scannedRoot = null;
      await scanSourceLink();
      if (!state.scannedRoot) return;
    }

    const btn = document.getElementById("btn-start-clone");
    const statusBox = document.getElementById("clone-status-box");
    const errBox = document.getElementById("clone-error-log");
    btn.disabled = true;
    statusBox.classList.remove("hidden");
    errBox.classList.add("hidden");
    setRadarView("running", "creating_folders");
    updateCloneProgress("Nexus Initializing...", 0, 1);

    const filters = getFiltersFromUI();
    const exactList = filters.exactReplaceNames || [];
    const errors = [];

    try {
      const root = state.scannedRoot;
      if (root.kind === "file") {
        setRadarView("running", "copying");
        await DriveEngine.withBackoff(() =>
          DriveEngine.liveCopyFileWithFallback(
            root.shortcutTargetId || root.id,
            root.name,
            "root",
            root.mimeType,
            state.accessToken
          )
        );
        updateCloneProgress("Nexus Transfer Complete!", 1, 1);
        setRadarView("done");
        document.getElementById("radar-done-desc").textContent = `Cloned "${root.name}" directly into your Google Drive.`;
        refreshQuotaUI();
        showToast("Nexus Transfer Complete! 🚀", `"${root.name}" saved to your Google Drive.`, "success");
        return;
      }

      const hasAnySelected = Object.values(state.selectedMap).some(Boolean) || state.injectedFiles.length > 0;
      if (!hasAnySelected) {
        setRadarView("idle");
        statusBox.classList.add("hidden");
        showToast("Nothing Selected", "Select at least one file or folder before starting transfer.", "error");
        return;
      }

      const customName = document.getElementById("clone-dest-name").value.trim();
      const rootFolderName = customName || root.name;

      const createdRoot = await DriveEngine.withBackoff(() =>
        DriveEngine.liveCreateFolder(rootFolderName, "root", state.accessToken)
      );

      const copyTasks = [];
      const exactMatchedParentIds = new Set();
      const folderPool = DriveEngine.createConcurrencyPool(10);

      async function buildTree(node, parentId) {
        const subFolders = [];
        for (const ch of node.children || []) {
          const norm = DriveEngine.normalizeText(ch.name);
          const isExactReplaced = ch.kind === "file" && exactList.some((ex) => norm.includes(ex));
          if (isExactReplaced) {
            exactMatchedParentIds.add(parentId);
            continue;
          }
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
              const created = await DriveEngine.withBackoff(() =>
                DriveEngine.liveCreateFolder(sf.name, parentId, state.accessToken)
              );
              await buildTree(sf, created.id);
            })
          )
        );
      }

      await buildTree(root, createdRoot.id);

      const injectTargets = exactMatchedParentIds.size > 0 ? Array.from(exactMatchedParentIds) : [createdRoot.id];
      const injectTasks = [];
      if (state.injectedFiles.length > 0) {
        for (const pid of injectTargets) {
          for (const f of state.injectedFiles) {
            injectTasks.push({ file: f, parentId: pid });
          }
        }
      }

      setRadarView("running", "copying");
      const total = copyTasks.length + injectTasks.length;
      let done = 0;
      const copyPool = DriveEngine.createConcurrencyPool(15);

      await Promise.all(
        copyTasks.map((t) =>
          copyPool(async () => {
            try {
              await DriveEngine.withBackoff(() =>
                DriveEngine.liveCopyFileWithFallback(
                  t.sourceId,
                  t.name,
                  t.parentId,
                  t.mimeType,
                  state.accessToken
                )
              );
            } catch (err) {
              errors.push(`${t.name}: ${err.message || err}`);
            } finally {
              done++;
              updateCloneProgress(`Nexus Cloning: ${done}/${total}`, done, Math.max(1, total));
            }
          })
        )
      );

      for (const inj of injectTasks) {
        try {
          await DriveEngine.liveUploadFileWithProgress(inj.file, inj.parentId, state.accessToken);
        } catch (err) {
          errors.push(`${inj.file.name}: ${err.message || err}`);
        } finally {
          done++;
          updateCloneProgress(`Injecting Files: ${done}/${total}`, done, Math.max(1, total));
        }
      }

      updateCloneProgress("Nexus Transfer Complete!", total, Math.max(1, total));
      setRadarView("done");
      document.getElementById("radar-done-desc").textContent = `Cloned "${rootFolderName}" (${total} items) into your Drive.`;
      if (errors.length) {
        errBox.classList.remove("hidden");
        errBox.innerHTML = errors.map((e) => `<div>• ${Security.escapeHtml(e)}</div>`).join("");
      }
      state.injectedFiles = [];
      renderInjectTags();
      refreshQuotaUI();
      showToast("Nexus Transfer Complete! 🚀", `${total} items saved to your Google Drive.`, "success");
    } catch (err) {
      setRadarView("idle");
      const msg = err.message || String(err);
      if (msg.includes("401") || msg.includes("Invalid Credentials")) handleSessionExpired();
      else showToast("Transfer Failed", msg, "error");
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
  // TAB 2: UPLOAD FILES (100% REAL GOOGLE DRIVE UPLOAD)
  // ===========================================================================
  async function handleBatchUpload(fileList) {
    if (!state.driveConnected || !state.accessToken) {
      connectGoogleDrive();
      showToast("Drive not connected", "Please click 'Connect Google Drive' first.", "error");
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
    renderUploadQueue(true);

    for (const item of items) {
      item.status = "uploading";
      renderUploadQueue(true);
      try {
        await DriveEngine.liveUploadFileWithProgress(item.file, "root", state.accessToken, (p) => {
          item.pct = p;
          renderUploadQueue(false);
        });
        item.status = "done";
        item.pct = 100;
      } catch (err) {
        item.status = "error";
        item.err = err.message || "Upload failed";
        if (String(item.err).includes("401")) handleSessionExpired();
      }
      renderUploadQueue(true);
    }

    state.isUploading = false;
    refreshQuotaUI();
    showToast("Upload complete", "Files uploaded directly to your Google Drive.", "success");
  }

  function renderUploadQueue(force = true) {
    const now = Date.now();
    if (!force && now - state.lastUploadRenderTs < 120) return;
    state.lastUploadRenderTs = now;
    const list = document.getElementById("upload-queue-list");
    const wrap = document.getElementById("upload-progress-wrap");
    const resTitle = document.getElementById("upload-result-title");
    const resDesc = document.getElementById("upload-result-desc");
    const mgrBtn = document.getElementById("btn-upload-view-mgr");

    if (!state.uploadQueue.length) {
      wrap.classList.add("hidden");
      list.innerHTML = "";
      resTitle.textContent = "Ready to go!";
      resDesc.textContent = "Upload files to see results here.";
      mgrBtn.classList.add("hidden");
      return;
    }
    wrap.classList.remove("hidden");
    const done = state.uploadQueue.filter((i) => i.status === "done").length;
    const pct = Math.round((done / state.uploadQueue.length) * 100);
    document.getElementById("upload-count-text").textContent = `${done}/${state.uploadQueue.length}`;
    document.getElementById("upload-progress-bar").style.width = pct + "%";

    if (done > 0) {
      resTitle.textContent = `${done} File(s) Uploaded!`;
      resDesc.textContent = "Your files are safely stored in your Google Drive.";
      mgrBtn.classList.remove("hidden");
    }

    list.innerHTML = state.uploadQueue
      .map((i) => {
        const st =
          i.status === "done"
            ? `<span class="text-primary font-bold">✓ Done</span>`
            : i.status === "uploading"
            ? `<span class="text-cyan font-bold">Uploading ${i.pct || 0}%</span>`
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
  // TAB 3: MANAGE FILES & PREVIEW (100% REAL GOOGLE DRIVE API)
  // ===========================================================================
  async function refreshManager() {
    if (!state.driveConnected || !state.accessToken) {
      connectGoogleDrive();
      return;
    }
    const listEl = document.getElementById("manage-file-list");
    listEl.innerHTML = `<div class="empty-msg">Loading files...</div>`;
    state.manageSelected = {};
    updateManageSelectedCount();

    const search = document.getElementById("manage-search-input").value.trim();
    const folderId = state.manageCurrentFolder.id;

    try {
      let items = await DriveEngine.liveListChildren(folderId, state.accessToken);
      if (search) {
        const q = search.toLowerCase();
        items = items.filter((i) => i.name.toLowerCase().includes(q));
      }
      items.sort((a, b) => {
        const af = a.mimeType === "application/vnd.google-apps.folder";
        const bf = b.mimeType === "application/vnd.google-apps.folder";
        if (af && !bf) return -1;
        if (!af && bf) return 1;
        return a.name.localeCompare(b.name);
      });

      state.manageItems = items;
      const selectAllEl = document.getElementById("manage-select-all");
      if (selectAllEl) selectAllEl.checked = false;
      document.getElementById("manage-current-folder-name").textContent = state.manageCurrentFolder.name;
      document.getElementById("btn-manage-back").classList.toggle("hidden", state.manageHistory.length === 0);
      const rootBtn = document.getElementById("btn-manage-root");
      if (rootBtn) rootBtn.classList.toggle("hidden", state.manageCurrentFolder.id === "root");

      if (!items.length) {
        listEl.innerHTML = `<div class="empty-msg">This folder is empty.</div>`;
        return;
      }

      listEl.innerHTML = items
        .map((it) => {
          const isFolder = it.mimeType === "application/vnd.google-apps.folder";
          return `<div class="manage-row">
            <input type="checkbox" class="manage-item-cb" data-id="${Security.escapeHtml(it.id)}" onchange="App.toggleManageItem('${Security.escapeHtml(it.id)}', this.checked)" />
            <div class="manage-item-main" onclick="App.onManageItemClick('${Security.escapeHtml(it.id)}')">
              <span>${isFolder ? "📁" : "📄"}</span>
              <div style="min-width:0;flex:1">
                <div class="manage-item-title">${Security.escapeHtml(it.name)}</div>
                <div class="manage-item-meta">${isFolder ? "Folder" : DriveEngine.formatBytes(Number(it.size || 0))}</div>
              </div>
            </div>
            ${!isFolder ? `<button type="button" class="btn btn-outline btn-xs" onclick="App.onManageItemClick('${Security.escapeHtml(it.id)}')">👁️</button>` : ""}
          </div>`;
        })
        .join("");
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes("401")) handleSessionExpired();
      listEl.innerHTML = `<div class="empty-msg" style="color:#fca5a5">${Security.escapeHtml(msg)}</div>`;
    }
  }

  function toggleManageItem(id, checked) {
    state.manageSelected[id] = checked;
    updateManageSelectedCount();
  }

  function manageSelectAll(checked) {
    state.manageItems.forEach((it) => {
      state.manageSelected[it.id] = checked;
    });
    document.querySelectorAll(".manage-item-cb").forEach((cb) => {
      cb.checked = checked;
    });
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
    const openBtn = document.getElementById("btn-open-drive");
    if (openBtn) {
      openBtn.href = item.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(item.id)}/view`;
      openBtn.classList.remove("hidden");
    }

    const embedUrl = `https://drive.google.com/file/d/${encodeURIComponent(item.id)}/preview`;
    previewBox.innerHTML = `<iframe src="${Security.escapeHtml(embedUrl)}" allow="autoplay" allowfullscreen></iframe>`;
  }

  function closePreview() {
    document.getElementById("btn-close-preview").classList.add("hidden");
    const openBtn = document.getElementById("btn-open-drive");
    if (openBtn) openBtn.classList.add("hidden");
    document.getElementById("manage-preview-area").innerHTML = `<div class="empty-preview">
      <div class="preview-eye">👁️</div>
      <h4>Preview Area</h4>
      <p>Click a file to see its preview and play videos here.</p>
    </div>`;
  }

  function manageGoRoot() {
    state.manageHistory = [];
    state.manageCurrentFolder = { id: "root", name: "My Drive" };
    refreshManager();
  }

  function manageGoBack() {
    if (!state.manageHistory.length) return;
    state.manageCurrentFolder = state.manageHistory.pop();
    refreshManager();
  }

  async function createManagerFolder() {
    if (!state.driveConnected || !state.accessToken) {
      connectGoogleDrive();
      return;
    }
    const input = document.getElementById("manage-new-folder-input");
    const name = input.value.trim();
    if (!name) return;
    try {
      await DriveEngine.liveCreateFolder(name, state.manageCurrentFolder.id, state.accessToken);
      input.value = "";
      refreshManager();
      showToast("Folder Created", `Created "${name}"`, "success");
    } catch (err) {
      showToast("Error", err.message, "error");
    }
  }

  async function deleteSelectedManaged() {
    const ids = Object.keys(state.manageSelected).filter((k) => state.manageSelected[k]);
    if (!ids.length || !state.accessToken) return;
    try {
      await DriveEngine.liveDeleteFiles(ids, state.accessToken);
      showToast("Deleted", `${ids.length} item(s) moved to Trash.`, "success");
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
    togglePasswordVisibility,
    loginWithGoogle,
    logout,
    connectGoogleDrive,
    disconnectDrive,
    switchTab,
    scanSourceLink,
    toggleTreeNode,
    selectAllTree,
    addInjectFiles,
    removeInjectFile,
    startCloneTransfer,
    handleBatchUpload,
    clearUploadQueue,
    refreshManager,
    toggleManageItem,
    manageSelectAll,
    onManageItemClick,
    closePreview,
    manageGoRoot,
    manageGoBack,
    createManagerFolder,
    deleteSelectedManaged,
  };
})();
