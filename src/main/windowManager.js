const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { BrowserWindow, screen, nativeImage } = require("electron");
const constants = require("../shared/constants");

function createWindowManager(options = {}) {
  const app = options.app;
  const preloadPath = path.join(app.getAppPath(), "preload.js");
  const indexPath = path.join(app.getAppPath(), "index.html");

  let chatWindow = null;
  let floatingButtonWindow = null;
  let isQuitting = false;
  let currentApp = "Unknown application";
  let activeAppInterval = null;
  let activeWinFn = null;
  let isChatExpanded = false;
  let isUpdatingChatBounds = false;
  let floatingButtonPosition = null;

  function createAppImage(size = 100) {
    const logoCandidates = [
      path.join(app.getAppPath(), "public", "blue-logo.png"),
      path.join(app.getAppPath(), "assets", "blue-logo.png"),
      path.join(process.resourcesPath || "", "public", "blue-logo.png"),
      path.join(process.resourcesPath || "", "assets", "blue-logo.png")
    ];

    for (const candidate of logoCandidates) {
      try {
        if (candidate && fs.existsSync(candidate)) {
          const image = nativeImage.createFromPath(candidate);
          if (image && !image.isEmpty()) {
            return image.resize({ width: size, height: size });
          }
        }
      } catch (_error) {}
    }

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#5ad7ff"/>
            <stop offset="100%" stop-color="#2f8dff"/>
          </linearGradient>
        </defs>
        <rect x="4" y="4" width="56" height="56" rx="18" fill="url(#g)"/>
        <circle cx="24" cy="30" r="4" fill="#09203a"/>
        <circle cx="40" cy="30" r="4" fill="#09203a"/>
        <path d="M21 41c3 3 7 5 11 5s8-2 11-5" fill="none" stroke="#09203a" stroke-width="3" stroke-linecap="round"/>
      </svg>
    `;

    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    return nativeImage.createFromDataURL(dataUrl);
  }

  function getBottomRightBounds(width, height) {
    const { x, y, width: areaWidth, height: areaHeight } = screen.getPrimaryDisplay().workArea;
    return {
      x: x + areaWidth - width - constants.WINDOW_MARGIN,
      y: y + areaHeight - height - constants.WINDOW_MARGIN,
      width,
      height
    };
  }

  function clampFloatingButtonPosition(x, y) {
    const size = constants.FLOAT_BUTTON_SIZE;
    const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } =
      screen.getPrimaryDisplay().workArea;
    const minX = areaX;
    const minY = areaY;
    const maxX = areaX + areaWidth - size;
    const maxY = areaY + areaHeight - size;

    const safeX = Math.min(Math.max(Math.round(Number(x) || 0), minX), maxX);
    const safeY = Math.min(Math.max(Math.round(Number(y) || 0), minY), maxY);

    return { x: safeX, y: safeY };
  }

  function getFloatingButtonBounds() {
    const size = constants.FLOAT_BUTTON_SIZE;
    if (floatingButtonPosition) {
      const clamped = clampFloatingButtonPosition(floatingButtonPosition.x, floatingButtonPosition.y);
      floatingButtonPosition = clamped;
      return {
        x: clamped.x,
        y: clamped.y,
        width: size,
        height: size
      };
    }

    return getBottomRightBounds(size, size);
  }

  function getChatWindowSize() {
    return isChatExpanded
      ? {
          width: constants.EXPANDED_CHAT_WIDTH,
          height: constants.EXPANDED_CHAT_HEIGHT
        }
      : {
          width: constants.SMALL_CHAT_WIDTH,
          height: constants.SMALL_CHAT_HEIGHT
        };
  }

  function applyChatWindowBounds(width, height) {
    if (!chatWindow || chatWindow.isDestroyed()) {
      return;
    }

    const safeWidth = Math.max(constants.SMALL_CHAT_WIDTH, Math.round(width));
    const safeHeight = Math.max(constants.SMALL_CHAT_HEIGHT, Math.round(height));
    const nextBounds = getBottomRightBounds(safeWidth, safeHeight);
    const currentBounds = chatWindow.getBounds();

    if (
      currentBounds.x === nextBounds.x &&
      currentBounds.y === nextBounds.y &&
      currentBounds.width === nextBounds.width &&
      currentBounds.height === nextBounds.height
    ) {
      return;
    }

    isUpdatingChatBounds = true;
    try {
      chatWindow.setBounds(nextBounds);
    } finally {
      isUpdatingChatBounds = false;
    }
  }

  function anchorChatWindowToBottomRight() {
    if (!chatWindow || chatWindow.isDestroyed()) {
      return;
    }

    const [width, height] = chatWindow.getSize();
    applyChatWindowBounds(width, height);
  }

  function applyPresetChatWindowSize() {
    const { width, height } = getChatWindowSize();
    applyChatWindowBounds(width, height);
  }

  function positionWindows() {
    anchorChatWindowToBottomRight();

    if (floatingButtonWindow && !floatingButtonWindow.isDestroyed()) {
      floatingButtonWindow.setBounds(getFloatingButtonBounds());
    }
  }

  function setFloatingButtonPosition(x, y) {
    const next = clampFloatingButtonPosition(x, y);
    floatingButtonPosition = next;

    if (floatingButtonWindow && !floatingButtonWindow.isDestroyed()) {
      floatingButtonWindow.setBounds({
        x: next.x,
        y: next.y,
        width: constants.FLOAT_BUTTON_SIZE,
        height: constants.FLOAT_BUTTON_SIZE
      });
    }

    return { ...next };
  }

  function getFloatingButtonPosition() {
    if (floatingButtonWindow && !floatingButtonWindow.isDestroyed()) {
      const bounds = floatingButtonWindow.getBounds();
      return { x: bounds.x, y: bounds.y };
    }

    if (floatingButtonPosition) {
      return { ...floatingButtonPosition };
    }

    const fallback = getFloatingButtonBounds();
    return { x: fallback.x, y: fallback.y };
  }

  function pushCurrentAppToRenderer() {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send("assistant:active-app", currentApp);
    }
  }

  function normalizeActiveApp(activeWindow) {
    const ownerName = String(activeWindow && activeWindow.owner && activeWindow.owner.name ? activeWindow.owner.name : "");
    const title = String(activeWindow && activeWindow.title ? activeWindow.title : "");
    const ownerLower = ownerName.toLowerCase();
    const titleLower = title.toLowerCase();

    if (ownerLower.includes("excel") || titleLower.includes("excel")) {
      return "Microsoft Excel";
    }
    if (ownerLower.includes("winword") || ownerLower.includes("word") || titleLower.includes("word")) {
      return "Microsoft Word";
    }
    if (
      ownerLower.includes("powerpnt") ||
      ownerLower.includes("powerpoint") ||
      titleLower.includes("powerpoint")
    ) {
      return "Microsoft PowerPoint";
    }
    if (
      ownerLower === "code" ||
      ownerLower.includes("visual studio code") ||
      titleLower.includes("visual studio code") ||
      titleLower.endsWith(" - code")
    ) {
      return "VS Code";
    }
    if (ownerLower.includes("chrome") || titleLower.includes("chrome")) {
      return "Google Chrome";
    }

    return ownerName || title || "Unknown application";
  }

  async function detectActiveApplication() {
    if (!activeWinFn) {
      return currentApp;
    }

    try {
      const activeWindow = await activeWinFn();
      const nextApp = normalizeActiveApp(activeWindow);

      if (nextApp && nextApp !== currentApp) {
        currentApp = nextApp;
        pushCurrentAppToRenderer();
      }
    } catch (_error) {}

    return currentApp;
  }

  async function startActiveAppMonitoring() {
    try {
      const activeWinModule = await import("active-win");
      activeWinFn = activeWinModule.default || activeWinModule;
      await detectActiveApplication();
      activeAppInterval = setInterval(detectActiveApplication, constants.ACTIVE_APP_POLL_MS);
    } catch (_error) {
      currentApp = "Unknown application";
    }
  }

  function showFloatingButton() {
    if (floatingButtonWindow && !floatingButtonWindow.isDestroyed()) {
      positionWindows();
      floatingButtonWindow.show();
    }
  }

  function hideFloatingButton() {
    if (floatingButtonWindow && !floatingButtonWindow.isDestroyed()) {
      floatingButtonWindow.hide();
    }
  }

  function emitShortcutOpenEvent() {
    if (!chatWindow || chatWindow.isDestroyed()) {
      return;
    }

    const sendEvent = () => {
      if (!chatWindow || chatWindow.isDestroyed()) {
        return;
      }
      chatWindow.webContents.send("assistant:run-opening-analysis");
    };

    if (chatWindow.webContents.isLoading()) {
      chatWindow.webContents.once("did-finish-load", sendEvent);
    } else {
      sendEvent();
    }
  }

  function showChatWindow(options = {}) {
    if (!chatWindow || chatWindow.isDestroyed()) {
      return;
    }

    const wasVisible = chatWindow.isVisible();
    anchorChatWindowToBottomRight();
    chatWindow.show();
    chatWindow.focus();
    hideFloatingButton();
    pushCurrentAppToRenderer();

    if (options.fromShortcut && !wasVisible) {
      emitShortcutOpenEvent();
    }
  }

  function hideChatWindow() {
    if (!chatWindow || chatWindow.isDestroyed()) {
      return;
    }

    chatWindow.hide();
    showFloatingButton();
  }

  function hideChatWindowForCapture() {
    if (!chatWindow || chatWindow.isDestroyed()) {
      return false;
    }

    const wasVisible = chatWindow.isVisible();
    if (wasVisible) {
      chatWindow.hide();
    }

    return wasVisible;
  }

  function showChatWindowAfterCapture() {
    if (!chatWindow || chatWindow.isDestroyed()) {
      return;
    }

    anchorChatWindowToBottomRight();
    chatWindow.show();
    chatWindow.focus();
    hideFloatingButton();
    pushCurrentAppToRenderer();
  }

  function toggleChatWindow() {
    if (!chatWindow || chatWindow.isDestroyed()) {
      return;
    }

    if (chatWindow.isVisible()) {
      hideChatWindow();
    } else {
      showChatWindow();
    }
  }

  function setupZoomShortcuts(window) {
    function changeZoom(delta) {
      const current = window.webContents.getZoomFactor();
      const next = Math.min(3, Math.max(0.5, current + delta));
      window.webContents.setZoomFactor(next);
    }

    window.webContents.on("before-input-event", (event, input) => {
      if (!input.control && !input.meta) {
        return;
      }

      const key = String(input.key || "").toLowerCase();
      const code = String(input.code || "");

      const isZoomIn = key === "+" || key === "=" || key === "add" || code === "NumpadAdd";
      const isZoomOut =
        key === "-" || key === "_" || key === "subtract" || code === "NumpadSubtract";
      const isZoomReset = key === "0" || code === "Digit0" || code === "Numpad0";

      if (isZoomIn) {
        event.preventDefault();
        changeZoom(0.1);
        return;
      }

      if (isZoomOut) {
        event.preventDefault();
        changeZoom(-0.1);
        return;
      }

      if (isZoomReset) {
        event.preventDefault();
        window.webContents.setZoomFactor(1);
      }
    });
  }

  function createChatWindow() {
    chatWindow = new BrowserWindow({
      ...getBottomRightBounds(constants.SMALL_CHAT_WIDTH, constants.SMALL_CHAT_HEIGHT),
      show: false,
      resizable: true,
      minWidth: constants.SMALL_CHAT_WIDTH,
      minHeight: constants.SMALL_CHAT_HEIGHT,
      minimizable: true,
      maximizable: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      title: "AI Assistant",
      backgroundColor: "#12151d",
      icon: createAppImage(64),
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    chatWindow.loadFile(indexPath);
    setupZoomShortcuts(chatWindow);

    chatWindow.webContents.on("did-finish-load", () => {
      chatWindow.webContents.setZoomFactor(1);
      pushCurrentAppToRenderer();
    });

    chatWindow.on("resize", () => {
      if (isUpdatingChatBounds) {
        return;
      }
      anchorChatWindowToBottomRight();
    });

    chatWindow.on("close", (event) => {
      if (isQuitting) {
        return;
      }
      event.preventDefault();
      hideChatWindow();
    });
  }

  function createFloatingButtonWindow() {
    const floatingButtonFallbackUrl = "assistant://show-chat";
    const floatingButtonSize = Math.max(constants.FLOAT_BUTTON_SIZE, 80);
    let iconUrl = "";

    const getImageMimeType = (filePath) => {
      const ext = path.extname(filePath || "").toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".svg") return "image/svg+xml";
      return "image/gif";
    };

    const gifDirCandidates = [
      path.resolve(app.getAppPath(), "public", "gif"),
      path.resolve(__dirname, "..", "..", "public", "gif"),
      path.resolve(process.resourcesPath || "", "public", "gif")
    ];

    const gifFiles = [];
    gifDirCandidates.forEach((dirPath) => {
      try {
        if (!dirPath || !fs.existsSync(dirPath)) {
          return;
        }
        const files = fs.readdirSync(dirPath);
        files.forEach((file) => {
          if (typeof file !== "string") {
            return;
          }
          const fullPath = path.join(dirPath, file);
          if (path.extname(fullPath).toLowerCase() === ".gif") {
            gifFiles.push(fullPath);
          }
        });
      } catch (_error) {}
    });

    if (gifFiles.length > 0) {
      const preferredGif = gifFiles.find((filePath) => /smile|happy/i.test(path.basename(filePath)));
      const selectedGif = preferredGif || gifFiles[0];
      try {
        iconUrl = pathToFileURL(selectedGif).toString();
      } catch (_error) {}
    } else {
      console.warn("No GIFs found in public/gif for floating button.");
    }

    floatingButtonWindow = new BrowserWindow({
      ...getFloatingButtonBounds(),
      show: true,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      title: "AI Assistant Button",
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: false
      }
    });

    floatingButtonWindow.webContents.on("will-navigate", (event, url) => {
      if (url === floatingButtonFallbackUrl) {
        event.preventDefault();
        showChatWindow();
      }
    });

    const buttonHtml = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            html, body {
              margin: 0;
              width: 100%;
              height: 100%;
              overflow: hidden;
              background: transparent;
              font-family: Segoe UI, sans-serif;
              user-select: none;
            }
            .bot-container {
              position: fixed;
              inset: 0;
              width: 100%;
              height: 100%;
              border: none;
              cursor: grab;
              padding: 0;
              background: transparent;
              box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
              transition: transform 0.2s ease, opacity 0.12s ease;
              z-index: 9999;
              transform: scale(1);
              opacity: 0;
              flex-shrink: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              overflow: hidden;
            }
            .bot-container:hover {
              filter: brightness(1.07);
            }
            .bot-container.dragging {
              cursor: grabbing;
            }
            .bot-container img {
              width: 100%;
              height: 100%;
              border-radius: 50%;
              object-fit: contain;
              display: block;
              pointer-events: none;
              -webkit-user-drag: none;
              user-drag: none;
            }

            .update-mini-btn {
              position: absolute;
              right: -4px;
              top: -4px;
              min-width: 22px;
              height: 22px;
              border-radius: 999px;
              border: 1px solid rgba(29, 78, 216, 0.4);
              background: #eff6ff;
              color: #1d4ed8;
              font-size: 12px;
              font-weight: 700;
              cursor: pointer;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 0 6px;
              box-shadow: 0 6px 14px rgba(2, 6, 23, 0.22);
            }

            .update-mini-btn:disabled {
              opacity: 0.72;
              cursor: not-allowed;
            }

            .update-popup {
              position: fixed;
              right: 10px;
              bottom: 112px;
              z-index: 10000;
            }

            .update-card {
              width: 260px;
              border-radius: 12px;
              padding: 14px;
              color: #e2e8f0;
              background: linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(30, 41, 59, 0.96));
              border: 1px solid rgba(148, 163, 184, 0.28);
              box-shadow: 0 14px 28px rgba(2, 6, 23, 0.45);
            }

            .update-card h3 {
              margin: 0 0 8px;
              font-size: 15px;
              font-weight: 700;
            }

            .update-meta,
            .update-status {
              margin: 0;
              font-size: 12px;
              color: rgba(226, 232, 240, 0.9);
            }

            .update-progress {
              margin: 10px 0 8px;
              width: 100%;
              height: 6px;
              background: rgba(100, 116, 139, 0.35);
              border-radius: 999px;
              overflow: hidden;
            }

            .update-progress-fill {
              width: 0%;
              height: 100%;
              background: linear-gradient(90deg, #22c55e, #4ade80);
              border-radius: inherit;
              transition: width 0.2s ease;
            }

            .update-actions {
              margin-top: 12px;
              display: flex;
              justify-content: flex-end;
              gap: 8px;
            }

            .update-action-btn {
              border-radius: 8px;
              border: 1px solid rgba(148, 163, 184, 0.35);
              background: rgba(15, 23, 42, 0.45);
              color: #e2e8f0;
              font-size: 12px;
              font-weight: 600;
              padding: 6px 10px;
              cursor: pointer;
            }

            .update-action-btn.primary {
              border-color: rgba(34, 197, 94, 0.5);
              background: rgba(34, 197, 94, 0.2);
              color: #bbf7d0;
            }

            .update-action-btn:disabled {
              opacity: 0.65;
              cursor: not-allowed;
            }
          </style>
        </head>
        <body>
          <div class="bot-container" id="bot" title="Open AI Assistant">
            ${iconUrl ? `<img src="${iconUrl}" alt="AI" draggable="false" />` : "AI"}
            <button id="checkUpdateBtn" class="update-mini-btn" type="button" title="Check update">↑</button>
          </div>
          <div id="updatePopup" class="update-popup" hidden></div>
          <script>
            const fallbackUrl = "${floatingButtonFallbackUrl}";
            const dragThreshold = 6;
            let isDragging = false;
            let offsetX = 0;
            let offsetY = 0;
            let dragDistance = 0;
            let suppressClickUntil = 0;
            let latestMove = null;
            let movePending = false;
            const bot = document.getElementById("bot");
            const botImage = bot ? bot.querySelector("img") : null;
            const checkUpdateBtn = document.getElementById("checkUpdateBtn");
            const updatePopup = document.getElementById("updatePopup");
            let windowPos = { x: 0, y: 0 };
            let updateCheckInitiatedByUser = false;

            let updateState = {
              version: "",
              status: "Ready to update",
              progress: 0,
              ready: false
            };

            const clampPercent = (value) => {
              const n = Number(value);
              if (!Number.isFinite(n)) {
                return 0;
              }
              return Math.max(0, Math.min(100, n));
            };

            const escapeHtml = (value) => String(value || "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\"/g, "&quot;")
              .replace(/'/g, "&#039;");

            const closeUpdatePopup = () => {
              if (!updatePopup) {
                return;
              }
              updatePopup.hidden = true;
              updatePopup.innerHTML = "";
            };

            const renderUpdatePopup = (nextState = {}) => {
              if (!updatePopup) {
                return;
              }

              updateState = {
                ...updateState,
                ...nextState
              };

              const safeVersion = String(updateState.version || "Checking...");
              const safeStatus = String(updateState.status || "Ready to update");
              const progress = clampPercent(updateState.progress);
              const canInstall = Boolean(updateState.ready);
              const installAttr = canInstall ? "" : " disabled";

              updatePopup.hidden = false;
              updatePopup.innerHTML = [
                '<div class="update-card">',
                '<h3>🚀 Update Available</h3>',
                '<p class="update-meta">Version: ' + escapeHtml(safeVersion) + '</p>',
                '<div class="update-progress">',
                '<div class="update-progress-fill" id="progressFill" style="width: ' + progress + '%"></div>',
                '</div>',
                '<p class="update-status" id="statusText">' + escapeHtml(safeStatus) + '</p>',
                '<div class="update-actions">',
                '<button id="closeUpdateBtn" class="update-action-btn" type="button">Later</button>',
                '<button id="updateNowBtn" class="update-action-btn primary" type="button"' + installAttr + '>Update Now</button>',
                '</div>',
                '</div>'
              ].join('');

              const closeBtn = document.getElementById("closeUpdateBtn");
              const updateNowBtn = document.getElementById("updateNowBtn");

              if (closeBtn) {
                closeBtn.addEventListener("click", closeUpdatePopup);
              }

              if (updateNowBtn) {
                updateNowBtn.addEventListener("click", async () => {
                  if (!window.updateAPI || typeof window.updateAPI.installUpdate !== "function") {
                    renderUpdatePopup({ status: "Updater unavailable.", ready: false });
                    return;
                  }

                  updateNowBtn.disabled = true;
                  renderUpdatePopup({ status: "Installing update...", ready: true });
                  try {
                    const installResult = await window.updateAPI.installUpdate();
                    if (!installResult || !installResult.ok) {
                      renderUpdatePopup({
                        status: "Update not ready yet. Please wait for download.",
                        ready: false
                      });
                    }
                  } catch (_error) {
                    renderUpdatePopup({ status: "Install failed. Try again.", ready: true });
                  }
                });
              }
            };

            const handleCheckUpdate = async () => {
              if (!checkUpdateBtn) {
                return;
              }

              updateCheckInitiatedByUser = true;

              const originalLabel = checkUpdateBtn.textContent;
              checkUpdateBtn.disabled = true;
              checkUpdateBtn.textContent = "...";
              try {
                if (!window.updateAPI || typeof window.updateAPI.checkUpdate !== "function") {
                  renderUpdatePopup({
                    version: "N/A",
                    status: "Update service unavailable.",
                    progress: 0,
                    ready: false
                  });
                  return;
                }

                const result = await window.updateAPI.checkUpdate();
                if (!result || result.ok === false) {
                  const reason = result && result.reason ? String(result.reason) : "check_failed";
                  if (reason === "development_mode") {
                    renderUpdatePopup({
                      version: "N/A",
                      status: "Development mode me update check disabled hai.",
                      progress: 0,
                      ready: false
                    });
                  } else if (reason === "updater_not_configured") {
                    renderUpdatePopup({
                      version: "N/A",
                      status: "Updater configure nahi hai.",
                      progress: 0,
                      ready: false
                    });
                  } else {
                    renderUpdatePopup({
                      version: "N/A",
                      status: "Update check failed. Please try again.",
                      progress: 0,
                      ready: false
                    });
                  }
                  return;
                }

                if (result.updateAvailable && result.updateInfo && result.updateInfo.version) {
                  renderUpdatePopup({
                    version: String(result.updateInfo.version || "latest"),
                    status: "Update found. Downloading...",
                    progress: 0,
                    ready: false
                  });
                  return;
                }

                renderUpdatePopup({
                  version: String((result && result.currentVersion) || "Current"),
                  status: "You're up to date!",
                  progress: 100,
                  ready: false
                });
              } catch (_error) {
                renderUpdatePopup({
                  version: "N/A",
                  status: "Update check failed.",
                  progress: 0,
                  ready: false
                });
              } finally {
                checkUpdateBtn.disabled = false;
                checkUpdateBtn.textContent = originalLabel;
              }
            };

            if (window.electronAPI && typeof window.electronAPI.onUpdateAvailable === "function") {
              window.electronAPI.onUpdateAvailable((payload) => {
                if (!updateCheckInitiatedByUser) {
                  return;
                }
                const version = payload && payload.version ? String(payload.version) : "latest";
                renderUpdatePopup({
                  version,
                  status: "Update available. Downloading...",
                  progress: 0,
                  ready: false
                });
              });
            }

            if (window.electronAPI && typeof window.electronAPI.onUpdateProgress === "function") {
              window.electronAPI.onUpdateProgress((percent) => {
                if (!updateCheckInitiatedByUser || !updatePopup || updatePopup.hidden) {
                  return;
                }
                const safePercent = clampPercent(percent);
                renderUpdatePopup({
                  status: "Downloading... " + Math.round(safePercent) + "%",
                  progress: safePercent,
                  ready: false
                });
              });
            }

            if (window.electronAPI && typeof window.electronAPI.onUpdateReady === "function") {
              window.electronAPI.onUpdateReady((payload) => {
                if (!updateCheckInitiatedByUser) {
                  return;
                }
                const version = payload && payload.version ? String(payload.version) : updateState.version;
                renderUpdatePopup({
                  version,
                  status: "Ready to install 🚀",
                  progress: 100,
                  ready: true
                });
              });
            }

            if (window.electronAPI && typeof window.electronAPI.onUpdateReadySilent === "function") {
              window.electronAPI.onUpdateReadySilent((payload) => {
                if (!checkUpdateBtn) {
                  return;
                }

                const version = payload && payload.version ? String(payload.version) : "new";
                checkUpdateBtn.textContent = "•";
                checkUpdateBtn.title = "Update ready: " + version + " (restart to apply)";
              });
            }

            if (window.electronAPI && typeof window.electronAPI.onUpdateStatus === "function") {
              window.electronAPI.onUpdateStatus((payload) => {
                const state = payload && payload.state ? String(payload.state) : "";
                if (state === "checking") {
                  renderUpdatePopup({ status: "Checking for updates...", progress: 0, ready: false });
                } else if (state === "up-to-date") {
                  renderUpdatePopup({ status: "You're up to date!", progress: 100, ready: false });
                } else if (state === "error") {
                  renderUpdatePopup({
                    status: payload && payload.message ? String(payload.message) : "Update error.",
                    ready: false
                  });
                }
              });
            }

            const revealBot = () => {
              if (!bot) {
                return;
              }
              bot.style.display = "none";
              void bot.offsetHeight;
              bot.style.display = "flex";
              bot.style.opacity = "1";
            };

            if (botImage) {
              botImage.addEventListener("load", () => {
                revealBot();
                setTimeout(() => {
                  window.dispatchEvent(new Event("resize"));
                }, 50);
              }, { once: true });

              if (botImage.complete) {
                revealBot();
                setTimeout(() => {
                  window.dispatchEvent(new Event("resize"));
                }, 50);
              }
            } else {
              window.addEventListener("load", () => {
                requestAnimationFrame(() => {
                  bot.style.opacity = "1";
                  setTimeout(() => {
                    window.dispatchEvent(new Event("resize"));
                  }, 50);
                });
              });
            }

            const refreshWindowPosition = async () => {
              try {
                if (window.assistantAPI && typeof window.assistantAPI.getFloatingButtonPosition === "function") {
                  const current = await window.assistantAPI.getFloatingButtonPosition();
                  if (current && Number.isFinite(current.x) && Number.isFinite(current.y)) {
                    windowPos = { x: Number(current.x), y: Number(current.y) };
                  }
                }
              } catch (_error) {}
            };

            refreshWindowPosition();

            const requestMove = (x, y) => {
              if (!window.assistantAPI || typeof window.assistantAPI.moveFloatingButton !== "function") {
                return;
              }
              latestMove = { x, y };
              if (movePending) {
                return;
              }
              movePending = true;
              const flush = () => {
                if (!latestMove) {
                  movePending = false;
                  return;
                }
                const next = latestMove;
                latestMove = null;
                Promise.resolve(window.assistantAPI.moveFloatingButton(next))
                  .then((resolved) => {
                    if (resolved && Number.isFinite(resolved.x) && Number.isFinite(resolved.y)) {
                      windowPos = { x: Number(resolved.x), y: Number(resolved.y) };
                    }
                  })
                  .catch(() => {})
                  .finally(() => {
                    if (latestMove) {
                      requestAnimationFrame(flush);
                    } else {
                      movePending = false;
                    }
                  });
              };
              requestAnimationFrame(flush);
            };

            const openAssistant = () => {
              if (Date.now() < suppressClickUntil) {
                return;
              }
              try {
                if (window.assistantAPI && typeof window.assistantAPI.showChat === "function") {
                  window.assistantAPI.showChat();
                }
              } catch (_error) {}

              window.location.href = fallbackUrl;
            };

            bot.addEventListener("dragstart", (event) => {
              event.preventDefault();
            });

            if (checkUpdateBtn) {
              checkUpdateBtn.addEventListener("mousedown", (event) => {
                event.stopPropagation();
              });

              checkUpdateBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                handleCheckUpdate();
              });
            }

            bot.addEventListener("mousedown", (event) => {
              if (event.button !== 0) {
                return;
              }

              isDragging = true;
              dragDistance = 0;
              offsetX = event.screenX;
              offsetY = event.screenY;
              bot.classList.add("dragging");
              bot.style.right = "auto";
              bot.style.bottom = "auto";
            });

            document.addEventListener("mousemove", (event) => {
              if (!isDragging) {
                return;
              }

              const dx = event.screenX - offsetX;
              const dy = event.screenY - offsetY;
              dragDistance += Math.abs(dx) + Math.abs(dy);

              if (dragDistance < dragThreshold) {
                return;
              }

              requestMove(windowPos.x + dx, windowPos.y + dy);

              offsetX = event.screenX;
              offsetY = event.screenY;
            });

            document.addEventListener("mouseup", () => {
              if (!isDragging) {
                return;
              }

              if (dragDistance >= dragThreshold) {
                suppressClickUntil = Date.now() + 250;
              }

              isDragging = false;
              bot.classList.remove("dragging");
            });

            bot.addEventListener("click", openAssistant);
          </script>
        </body>
      </html>
    `;

    floatingButtonWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(buttonHtml)}`);
  }

  async function initialize() {
    createChatWindow();
    createFloatingButtonWindow();
    await startActiveAppMonitoring();
    hideChatWindow();
  }

  function getCurrentApp() {
    return currentApp;
  }

  function getChatWindow() {
    return chatWindow;
  }

  function getFloatingButtonWindow() {
    return floatingButtonWindow;
  }

  function getExpandState() {
    return {
      expanded: isChatExpanded,
      width: getChatWindowSize().width,
      height: getChatWindowSize().height
    };
  }

  function toggleExpandState() {
    isChatExpanded = !isChatExpanded;
    applyPresetChatWindowSize();
    return getExpandState();
  }

  function markQuitting() {
    isQuitting = true;
  }

  function isAppQuitting() {
    return isQuitting;
  }

  function dispose() {
    if (activeAppInterval) {
      clearInterval(activeAppInterval);
      activeAppInterval = null;
    }
  }

  return {
    createAppImage,
    detectActiveApplication,
    dispose,
    getChatWindow,
    getCurrentApp,
    getExpandState,
    getFloatingButtonWindow,
    getFloatingButtonPosition,
    hideChatWindow,
    hideChatWindowForCapture,
    initialize,
    isAppQuitting,
    markQuitting,
    positionWindows,
    setFloatingButtonPosition,
    showChatWindow,
    showChatWindowAfterCapture,
    toggleChatWindow,
    toggleExpandState
  };
}

module.exports = {
  createWindowManager
};
