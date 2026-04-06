const { autoUpdater } = require("electron-updater");

const DEFAULT_UPDATE_OWNER = "arbazdev223";
const DEFAULT_UPDATE_REPO = "ai-intern";
const DEFAULT_AUTO_INSTALL_DELAY_MS = 5000;

function resolveAutoInstallOnDownload() {
  const value = String(process.env.IFDA_AUTO_INSTALL_ON_DOWNLOAD || "true").trim().toLowerCase();
  if (!value) {
    return true;
  }
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}

function resolveAutoInstallDelayMs() {
  const raw = Number(process.env.IFDA_AUTO_INSTALL_DELAY_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_AUTO_INSTALL_DELAY_MS;
  }
  return Math.min(raw, 60_000);
}

function getGithubFeedConfig() {
  const owner = String(process.env.IFDA_UPDATE_OWNER || DEFAULT_UPDATE_OWNER).trim();
  const repo = String(process.env.IFDA_UPDATE_REPO || DEFAULT_UPDATE_REPO).trim();
  const token = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();

  if (!owner || !repo) {
    return null;
  }

  return {
    provider: "github",
    owner,
    repo,
    private: Boolean(token),
    token: token || undefined
  };
}

function createUpdateService(options = {}) {
  const app = options.app;
  let initialized = false;
  let periodicTimer = null;
  let lastUpdateInfo = null;
  let isUpdateDownloaded = false;
  let installRequested = false;
  let autoInstallTimer = null;
  const autoInstallOnDownload = resolveAutoInstallOnDownload();
  const autoInstallDelayMs = resolveAutoInstallDelayMs();

  function log(message, payload) {
    if (typeof payload === "undefined") {
      console.info(`[updater] ${message}`);
      return;
    }

    console.info(`[updater] ${message}`, payload);
  }

  function emitToRenderer(channel, payload) {
    const windows = [];
    if (typeof options.getMainWindow === "function") {
      windows.push(options.getMainWindow());
    }
    if (typeof options.getFloatingWindow === "function") {
      windows.push(options.getFloatingWindow());
    }

    windows.forEach((win) => {
      try {
        if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      } catch (_error) {}
    });
  }

  async function safeCheckForUpdates() {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      log("check failed", error && error.message ? error.message : error);
    }
  }

  function isUpdaterEnabled() {
    if (!app || !app.isPackaged) {
      return false;
    }

    return Boolean(getGithubFeedConfig());
  }

  async function checkForUpdatesManual() {
    if (!app || !app.isPackaged) {
      return {
        ok: false,
        updateAvailable: false,
        reason: "development_mode"
      };
    }

    if (!getGithubFeedConfig()) {
      return {
        ok: false,
        updateAvailable: false,
        reason: "updater_not_configured"
      };
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      const info = result && result.updateInfo ? result.updateInfo : null;
      if (info) {
        lastUpdateInfo = info;
      }

      const currentVersion = app && typeof app.getVersion === "function" ? app.getVersion() : "";
      const nextVersion = info && info.version ? String(info.version) : "";
      const updateAvailable = Boolean(nextVersion && currentVersion && nextVersion !== currentVersion);

      return {
        ok: true,
        updateAvailable,
        updateInfo: info,
        currentVersion
      };
    } catch (error) {
      return {
        ok: false,
        updateAvailable: false,
        reason: "check_failed",
        message: error && error.message ? error.message : String(error || "Unknown error")
      };
    }
  }

  function installUpdateNow() {
    if (!isUpdateDownloaded) {
      return {
        ok: false,
        reason: "update_not_downloaded"
      };
    }

    installRequested = true;
    autoUpdater.quitAndInstall();
    return {
      ok: true,
      installing: true
    };
  }

  function scheduleAutoInstall(version) {
    if (!autoInstallOnDownload || installRequested) {
      return;
    }

    installRequested = true;
    emitToRenderer("update-status", {
      state: "installing",
      message: `Update ${version || "new"} downloaded. Closing app to install...`,
      version: version || undefined
    });

    const runInstall = () => {
      try {
        autoUpdater.quitAndInstall();
      } catch (error) {
        installRequested = false;
        log("install trigger failed", error && error.message ? error.message : error);
        emitToRenderer("update-status", {
          state: "error",
          message: "Automatic install failed. Please restart the app manually."
        });
      }
    };

    if (autoInstallDelayMs <= 0) {
      runInstall();
      return;
    }

    autoInstallTimer = setTimeout(() => {
      autoInstallTimer = null;
      runInstall();
    }, autoInstallDelayMs);
  }

  function registerEvents() {
    autoUpdater.on("checking-for-update", () => {
      log("checking for update");
      emitToRenderer("update-status", { state: "checking" });
    });

    autoUpdater.on("update-available", (info) => {
      const version = info && info.version ? info.version : "unknown";
      lastUpdateInfo = info || null;
      log(`update available: ${version}`);
      emitToRenderer("update-status", {
        state: "downloading",
        message: "Update found. Downloading silently...",
        version
      });
      emitToRenderer("update-available", {
        version,
        info: info || null
      });
    });

    autoUpdater.on("update-not-available", () => {
      log("no update available");
      emitToRenderer("update-status", { state: "up-to-date" });
    });

    autoUpdater.on("error", (error) => {
      log("error", error && error.message ? error.message : error);
      emitToRenderer("update-status", {
        state: "error",
        message: error && error.message ? error.message : String(error || "Unknown error")
      });
    });

    autoUpdater.on("download-progress", (progress) => {
      const percent = Number(progress && progress.percent ? progress.percent : 0).toFixed(1);
      log(`download progress: ${percent}%`);
      emitToRenderer("update-progress", Number(percent));
    });

    autoUpdater.on("update-downloaded", (info) => {
      const version = info && info.version ? info.version : "new";
      lastUpdateInfo = info || null;
      isUpdateDownloaded = true;
      log(`update downloaded: ${version}`);
      emitToRenderer("update-status", {
        state: "ready",
        message: "Update ready. Will install on restart.",
        version
      });
      emitToRenderer("update-ready", { version });
      emitToRenderer("update-ready-silent", { version });
      scheduleAutoInstall(version);
    });
  }

  function initAutoUpdate() {
    if (initialized) {
      return;
    }
    initialized = true;

    if (!app || !app.isPackaged) {
      log("skipping auto-update in development mode");
      return;
    }

    const feedConfig = getGithubFeedConfig();
    if (!feedConfig) {
      log("IFDA_UPDATE_OWNER/IFDA_UPDATE_REPO missing; auto-update disabled");
      return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.setFeedURL(feedConfig);
    registerEvents();

    // Quiet background check shortly after startup.
    setTimeout(() => {
      safeCheckForUpdates();
    }, 2000);

    periodicTimer = setInterval(() => {
      safeCheckForUpdates();
    }, 1000 * 60 * 60 * 6);
  }

  function initialize() {
    initAutoUpdate();
  }

  function dispose() {
    if (autoInstallTimer) {
      clearTimeout(autoInstallTimer);
      autoInstallTimer = null;
    }
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  return {
    checkForUpdatesManual,
    initAutoUpdate,
    initialize,
    installUpdateNow,
    isUpdaterEnabled,
    dispose
  };
}

module.exports = {
  createUpdateService
};
