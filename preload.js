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

function writeClipboardRichSafe(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const safeText = String(data.text || "");
  const safeHtml = String(data.html || "");

  if (clipboard) {
    // Prefer writeHTML when available: it sets the correct CF_HTML payload that browsers (Google Docs) paste as rich text.
    if (safeHtml && typeof clipboard.writeHTML === "function") {
      clipboard.writeHTML(safeHtml);
      return true;
    }

    // Best: write both formats in one shot (avoids writeText overwriting HTML).
    if (safeHtml && typeof clipboard.write === "function") {
      clipboard.write({ text: safeText, html: safeHtml });
      return true;
    }

    // Fallback: write plain text first, then HTML so HTML remains available.
    if (safeText && typeof clipboard.writeText === "function") {
      clipboard.writeText(safeText);
    }

    if (safeHtml && typeof clipboard.writeHTML === "function") {
      clipboard.writeHTML(safeHtml);
    }

    return true;
  }

  // Fallback: at least copy plain text.
  return writeClipboardTextSafe(safeText);
}

async function toSpeechPayload(input) {
  const payload = input && typeof input === "object" ? input : {};
  const hasBlob = typeof Blob !== "undefined";
  const fileLike = hasBlob
    ? (payload && payload.file instanceof Blob ? payload.file : input instanceof Blob ? input : null)
    : null;

  if (fileLike) {
    const mimeType = String(fileLike.type || "audio/webm").split(";")[0].trim() || "audio/webm";
    const filename =
      typeof fileLike.name === "string" && fileLike.name.trim()
        ? fileLike.name.trim()
        : mimeType.includes("wav")
          ? "speech.wav"
          : mimeType.includes("mp3")
            ? "speech.mp3"
            : "speech.webm";
    const arrayBuffer = await fileLike.arrayBuffer();
    return {
      audioBase64: Buffer.from(arrayBuffer).toString("base64"),
      mimeType,
      filename,
      languageCode: typeof payload.languageCode === "string" ? payload.languageCode : "",
      outputMode: typeof payload.outputMode === "string" ? payload.outputMode : "auto"
    };
  }

  return {
    audioBase64: String(payload.audioBase64 || ""),
    mimeType: String(payload.mimeType || "audio/webm").split(";")[0].trim() || "audio/webm",
    filename: String(payload.filename || "speech.webm").trim() || "speech.webm",
    languageCode: typeof payload.languageCode === "string" ? payload.languageCode : "",
    outputMode: typeof payload.outputMode === "string" ? payload.outputMode : "auto"
  };
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
  promptLibrary: {
    createSavedPrompt: (payload) => ipcRenderer.invoke("assistant:prompt-library:create-saved", payload),
    deleteSavedPrompt: (payload) => ipcRenderer.invoke("assistant:prompt-library:delete-saved", payload),
    fetchCategories: () => ipcRenderer.invoke("assistant:prompt-library:list-categories"),
    fetchSavedPrompts: () => ipcRenderer.invoke("assistant:prompt-library:list-saved"),
    fetchTemplates: () => ipcRenderer.invoke("assistant:prompt-library:list-templates"),
    updateSavedPrompt: (payload) => ipcRenderer.invoke("assistant:prompt-library:update-saved", payload)
  },
  synthesizeSpeech: (payload) => ipcRenderer.invoke("assistant:tts", payload),
  transcribeSpeech: async (payload) => ipcRenderer.invoke("assistant:stt", await toSpeechPayload(payload)),
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
  writeClipboardText: (text) => writeClipboardTextSafe(text),
  writeClipboardRich: (payload) => writeClipboardRichSafe(payload)
});

contextBridge.exposeInMainWorld("electronAPI", {
  copyText: (text) => writeClipboardTextSafe(text),
  copyRich: (payload) => writeClipboardRichSafe(payload),
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
