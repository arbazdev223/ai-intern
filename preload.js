console.log("Preload script loaded successfully");
const { clipboard, contextBridge, ipcRenderer, shell } = require("electron");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isSafeExternalUrl(url) {
  return /^(https?:\/\/|mailto:)/i.test(String(url || "").trim());
}

function highlightCode(code, language) {
  const safeCode = String(code || "");
  const safeLanguage = String(language || "").trim().toLowerCase();

  return {
    html: escapeHtml(safeCode),
    language: safeLanguage
  };
}

function writeClipboardTextSafe(text) {
  const safeText = String(text || "");
  if (clipboard && typeof clipboard.writeText === "function") {
    clipboard.writeText(safeText);
    return true;
  }

  return ipcRenderer.invoke("assistant:write-clipboard-text", { text: safeText });
}

contextBridge.exposeInMainWorld("assistantAPI", {
  captureScreenshot: () => ipcRenderer.invoke("capture-screen"),
  extractOcrText: (base64Screenshot) =>
    ipcRenderer.invoke("assistant:extract-ocr", {
      base64Screenshot
    }),
  getAppVersion: () => ipcRenderer.invoke("assistant:get-app-version"),
  getCurrentApp: () => ipcRenderer.invoke("assistant:get-current-app"),
  getFloatingButtonPosition: () => ipcRenderer.invoke("assistant:get-floating-button-position"),
  getExpandState: () => ipcRenderer.invoke("assistant:get-expand-state"),
  hideForCapture: () => ipcRenderer.invoke("assistant:hide-for-capture"),
  highlightCode,
  onActiveApp: (callback) => {
    if (typeof callback !== "function") {
      return;
    }

    ipcRenderer.on("assistant:active-app", (_event, appName) => {
      callback(appName);
    });
  },
  onOpeningAnalysis: (callback) => {
    if (typeof callback !== "function") {
      return;
    }

    ipcRenderer.on("assistant:run-opening-analysis", () => {
      callback();
    });
  },
  openExternal: async (url) => {
    const safeUrl = String(url || "").trim();
    if (!isSafeExternalUrl(safeUrl)) {
      return false;
    }

    await shell.openExternal(safeUrl);
    return true;
  },
  openPath: async (filePath) => {
    const safePath = String(filePath || "").trim();
    if (!safePath) {
      return "";
    }
    return shell.openPath(safePath);
  },
  openImage: (payload) => ipcRenderer.invoke("assistant:open-image", payload),
  readClipboardImage: () => {
    if (!clipboard || typeof clipboard.readImage !== "function") {
      return "";
    }

    const image = clipboard.readImage();
    if (!image || image.isEmpty()) {
      return "";
    }
    return image.toPNG().toString("base64");
  },
  synthesizeSpeech: (payload) => ipcRenderer.invoke("assistant:tts", payload),
  transcribeSpeech: (payload) => ipcRenderer.invoke("assistant:stt", payload),
  sendPrompt: (payload) => ipcRenderer.invoke("ai:generate", payload),
  moveFloatingButton: (payload) => ipcRenderer.invoke("assistant:move-floating-button", payload),
  classifyInputType: (payload) => ipcRenderer.invoke("assistant:classify-input", payload),
  downloadImage: (payload) => ipcRenderer.invoke("assistant:download-image", payload),
  showAfterCapture: () => ipcRenderer.invoke("assistant:show-after-capture"),
  showChat: () => ipcRenderer.send("assistant:show-chat"),
  showItemInFolder: (filePath) => {
    const safePath = String(filePath || "").trim();
    if (!safePath) {
      return false;
    }
    return shell.showItemInFolder(safePath);
  },
  storeScreenshot: (payload) => ipcRenderer.invoke("assistant:store-screenshot", payload),
  toggleExpand: () => ipcRenderer.invoke("assistant:toggle-expand"),
  writeClipboardText: (text) => writeClipboardTextSafe(text)
});

contextBridge.exposeInMainWorld("electronAPI", {
  copyText: (text) => writeClipboardTextSafe(text),
  onUpdateAvailable: (callback) => {
    if (typeof callback !== "function") {
      return;
    }
    ipcRenderer.on("update-available", (_event, payload) => {
      callback(payload || {});
    });
  },
  onUpdateProgress: (callback) => {
    if (typeof callback !== "function") {
      return;
    }
    ipcRenderer.on("update-progress", (_event, percent) => {
      callback(percent);
    });
  },
  onUpdateReady: (callback) => {
    if (typeof callback !== "function") {
      return;
    }
    ipcRenderer.on("update-ready", (_event, payload) => {
      callback(payload || {});
    });
  },
  onUpdateReadySilent: (callback) => {
    if (typeof callback !== "function") {
      return;
    }
    ipcRenderer.on("update-ready-silent", (_event, payload) => {
      callback(payload || {});
    });
  },
  onUpdateStatus: (callback) => {
    if (typeof callback !== "function") {
      return;
    }
    ipcRenderer.on("update-status", (_event, payload) => {
      callback(payload || {});
    });
  }
});

contextBridge.exposeInMainWorld("updateAPI", {
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update")
});

console.log("electronAPI exposed");
