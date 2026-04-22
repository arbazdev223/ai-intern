const { app, ipcMain, screen } = require("electron");
const { getEnv } = require("./config/env");
const { createWindowManager } = require("./windowManager");
const { createTrayManager } = require("./trayManager");
const { createShortcutManager } = require("./shortcutManager");
const { createScreenshotService } = require("./screenshotService");
const { createSearchService } = require("./searchService");
const { createAiClient } = require("./aiClient");
const { createVoiceService } = require("./voiceService");
const { createUpdateService } = require("./updateService");
const { registerIpcHandlers } = require("./ipcHandlers");
const { createPromptLibraryService } = require("./services/promptLibraryService");

const startupEnv = getEnv();

if (!startupEnv.OPENAI_API_KEY && !startupEnv.GEMINI_API_KEY) {
  console.warn("[startup] No AI API key set. Configure OPENAI_API_KEY or GEMINI_API_KEY to enable AI.");
}

if (process.env.NODE_ENV === "development") {
  try {
    require("electron-reload")(require("path").resolve(__dirname, "..", ".."), {
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
const promptLibraryService = createPromptLibraryService();
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

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) {
      windowManager.showChatWindow({ fromShortcut: true });
      return;
    }

    app.once("ready", () => {
      windowManager.showChatWindow({ fromShortcut: true });
    });
  });

  app.whenReady().then(async () => {
    registerIpcHandlers({
      ipcMain,
      aiClient,
      screenshotService,
      voiceService,
      promptLibraryService,
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
}
