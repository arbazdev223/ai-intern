const fs = require("fs");
const path = require("path");
const { app, ipcMain, screen } = require("electron");
const { createWindowManager } = require("./windowManager");
const { createTrayManager } = require("./trayManager");
const { createShortcutManager } = require("./shortcutManager");
const { createScreenshotService } = require("./screenshotService");
const { createSearchService } = require("./searchService");
const { createAiClient } = require("./aiClient");
const { createVoiceService } = require("./voiceService");
const { createUpdateService } = require("./updateService");
const { registerIpcHandlers } = require("./ipcHandlers");

function loadEnvFile() {
  const envPath = path.resolve(__dirname, "..", "..", ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) {
      return;
    }

    const key = match[1];
    let value = match[2] || "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GPT_key) {
  console.warn("[startup] No AI API key set. Configure OPENAI_API_KEY or GEMINI_API_KEY to enable AI.");
}

if (process.env.NODE_ENV === "development") {
  try {
    require("electron-reload")(path.resolve(__dirname, "..", ".."), {
      electron: process.execPath,
      hardResetMethod: "exit",
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100
      }
    });
  } catch (error) {
    console.warn("Dev reload disabled:", error);
  }
}

const windowManager = createWindowManager({ app });
const screenshotService = createScreenshotService();
const searchService = createSearchService();
const aiClient = createAiClient({
  getCurrentApp: () => windowManager.getCurrentApp(),
  searchService,
  screenshotService
});
const voiceService = createVoiceService();
const updateService = createUpdateService({
  app,
  getMainWindow: () => windowManager.getChatWindow(),
  getFloatingWindow: () =>
    typeof windowManager.getFloatingButtonWindow === "function"
      ? windowManager.getFloatingButtonWindow()
      : null
});

const trayManager = createTrayManager({
  createIcon: (size) => windowManager.createAppImage(size),
  onHide: () => windowManager.hideChatWindow(),
  onOpen: () => windowManager.showChatWindow(),
  onQuit: () => {
    windowManager.markQuitting();
    app.quit();
  },
  onToggle: () => windowManager.toggleChatWindow()
});

const shortcutManager = createShortcutManager({
  onToggleShortcut: async () => {
    await windowManager.detectActiveApplication();
    windowManager.showChatWindow({ fromShortcut: true });
  }
});

app.whenReady().then(async () => {
  registerIpcHandlers({
    ipcMain,
    aiClient,
    screenshotService,
    voiceService,
    windowManager,
    updateService
  });
  await windowManager.initialize();
  trayManager.create();
  shortcutManager.register();
  if (typeof updateService.initAutoUpdate === "function") {
    updateService.initAutoUpdate();
  } else {
    updateService.initialize();
  }

  screen.on("display-metrics-changed", () => {
    windowManager.positionWindows();
  });

  app.on("activate", () => {
    windowManager.showChatWindow();
  });
});

app.on("before-quit", () => {
  windowManager.markQuitting();
  windowManager.dispose();
});

app.on("will-quit", () => {
  updateService.dispose();
  shortcutManager.unregisterAll();
  trayManager.destroy();
});

app.on("window-all-closed", (event) => {
  if (!windowManager.isAppQuitting()) {
    event.preventDefault();
  }
});
