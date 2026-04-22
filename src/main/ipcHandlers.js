// Guard rails to avoid oversized IPC payloads and accidental memory spikes.
const MAX_TEXT_BYTES = 50 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_CONTEXT_MESSAGES = 12;

function getByteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function ensurePayloadObject(payload, label) {
  if (!payload || typeof payload !== "object") {
    throw new Error(`${label} payload must be an object.`);
  }
}

function ensureStringField(payload, field, maxBytes, { allowEmpty = false } = {}) {
  const value = payload && typeof payload[field] === "string" ? payload[field] : "";
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) {
    throw new Error(`${field} is required.`);
  }
  if (getByteLength(value) > maxBytes) {
    throw new Error(`${field} exceeds size limit.`);
  }
  return value;
}

function ensureBase64Field(payload, field) {
  const value = ensureStringField(payload, field, MAX_IMAGE_BYTES);
  return value.trim();
}

function sanitizeErrorMessage(error) {
  return String(error && error.message ? error.message : "Unknown error");
}

function validateGeneratePayload(payload) {
  ensurePayloadObject(payload, "Generate");
  ensureStringField(payload, "userPrompt", MAX_TEXT_BYTES);

  if (payload.screenshotBase64) {
    ensureStringField(payload, "screenshotBase64", MAX_IMAGE_BYTES, { allowEmpty: false });
  }

  if (payload.contextMessages) {
    if (!Array.isArray(payload.contextMessages)) {
      throw new Error("contextMessages must be an array.");
    }
    if (payload.contextMessages.length > MAX_CONTEXT_MESSAGES) {
      throw new Error("contextMessages exceeds size limit.");
    }

    payload.contextMessages.forEach((message) => {
      if (!message || typeof message !== "object") {
        throw new Error("contextMessages entries must be objects.");
      }
      const content = String(message.content || "");
      if (getByteLength(content) > MAX_TEXT_BYTES) {
        throw new Error("contextMessages entry exceeds size limit.");
      }
    });
  }
}

function validateTtsPayload(payload) {
  ensurePayloadObject(payload, "TTS");
  ensureStringField(payload, "text", MAX_TEXT_BYTES);

  if (payload.voiceId) {
    ensureStringField(payload, "voiceId", 256);
  }

  if (payload.modelId) {
    ensureStringField(payload, "modelId", 256);
  }
}

function validateSttPayload(payload) {
  ensurePayloadObject(payload, "STT");
  ensureStringField(payload, "audioBase64", MAX_AUDIO_BYTES);

  if (payload.mimeType) {
    ensureStringField(payload, "mimeType", 128);
  }

  if (payload.modelId) {
    ensureStringField(payload, "modelId", 128);
  }

  if (payload.filename) {
    ensureStringField(payload, "filename", 256);
  }

  if (payload.languageCode) {
    ensureStringField(payload, "languageCode", 32);
  }

  if (payload.outputMode) {
    ensureStringField(payload, "outputMode", 32);
  }
}

function validatePromptLibrarySavedPromptPayload(payload, { requirePromptId = false } = {}) {
  ensurePayloadObject(payload, "Prompt library");

  const result = {
    title: ensureStringField(payload, "title", 512),
    prompt: ensureStringField(payload, "prompt", MAX_TEXT_BYTES),
    sourceTemplateId: "",
    isFavorite: Boolean(payload.isFavorite)
  };

  if (payload.sourceTemplateId) {
    result.sourceTemplateId = ensureStringField(payload, "sourceTemplateId", 256);
  }

  if (requirePromptId) {
    result.promptId = ensureStringField(payload, "promptId", 256);
  }

  return result;
}

function validatePromptLibraryPromptIdPayload(payload) {
  ensurePayloadObject(payload, "Prompt library");
  return {
    promptId: ensureStringField(payload, "promptId", 256)
  };
}

function sanitizeFileName(name, fallback) {
  const safe = String(name || "").replace(/[\\/:*?"<>|]+/g, "-").trim();
  return safe || String(fallback || "download");
}

function resolveImageExtension(contentType, url) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";

  const urlText = String(url || "");
  const match = urlText.match(/\.(png|jpe?g|webp|gif)(\?|#|$)/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
}

function resolveLocalImagePath(urlValue, path) {
  const raw = String(urlValue || "").trim();
  if (!raw) {
    return "";
  }

  if (/^file:\/\//i.test(raw)) {
    try {
      const { fileURLToPath } = require("url");
      return fileURLToPath(raw);
    } catch (_error) {
      throw new Error("Invalid image file url.");
    }
  }

  return path.isAbsolute(raw) ? raw : "";
}

async function downloadImageToPath(payload, app, fsPromises, path) {
  ensurePayloadObject(payload, "Download image");
  const url = ensureStringField(payload, "url", MAX_IMAGE_BYTES);
  let buffer = null;
  let extension = "png";
  const localImagePath = resolveLocalImagePath(url, path);

  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(url)) {
    const match = url.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/i);
    if (!match) {
      throw new Error("Invalid image data.");
    }
    const mime = match[1];
    extension = resolveImageExtension(`image/${mime}`, "");
    buffer = Buffer.from(match[2], "base64");
  } else if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed (${response.status}).`);
    }

    const contentType = response.headers.get("content-type") || "";
    extension = resolveImageExtension(contentType, url);
    buffer = Buffer.from(await response.arrayBuffer());
  } else if (localImagePath) {
    const stats = await fsPromises.stat(localImagePath);
    if (!stats.isFile()) {
      throw new Error("Image path is not a file.");
    }
    extension = resolveImageExtension("", localImagePath);
    buffer = await fsPromises.readFile(localImagePath);
  } else {
    throw new Error("Invalid image url.");
  }

  const suggested = sanitizeFileName(payload.fileName, `ai-image-${Date.now()}`);
  const normalizedName = suggested.includes(".") ? suggested : `${suggested}.${extension}`;
  const downloadDir = app.getPath("downloads");
  const targetPath = await ensureUniquePath(fsPromises, path.join(downloadDir, normalizedName));

  await fsPromises.writeFile(targetPath, buffer);
  return targetPath;
}

async function ensureUniquePath(fsPromises, filePath) {
  try {
    await fsPromises.access(filePath);
  } catch (_error) {
    return filePath;
  }

  const path = require("path");
  const base = path.basename(filePath, path.extname(filePath));
  const ext = path.extname(filePath);
  for (let index = 1; index <= 20; index += 1) {
    const nextPath = path.join(path.dirname(filePath), `${base}-${index}${ext}`);
    try {
      await fsPromises.access(nextPath);
    } catch (_error) {
      return nextPath;
    }
  }

  const random = Math.random().toString(36).slice(2, 8);
  return path.join(path.dirname(filePath), `${base}-${random}${ext}`);
}

function registerIpcHandlers(options = {}) {
  const {
    ipcMain,
    aiClient,
    screenshotService,
    voiceService,
    promptLibraryService,
    windowManager,
    updateService
  } = options;
  const { clipboard, app, shell } = require("electron");
  const fsPromises = require("fs/promises");
  const path = require("path");

  ipcMain.on("assistant:show-chat", () => {
    windowManager.showChatWindow();
  });

  ipcMain.handle("assistant:get-app-version", () => {
    if (!app || typeof app.getVersion !== "function") {
      return "";
    }
    return String(app.getVersion() || "");
  });

  ipcMain.handle("assistant:get-current-app", () => windowManager.getCurrentApp());

  ipcMain.handle("assistant:get-floating-button-position", () => {
    if (!windowManager || typeof windowManager.getFloatingButtonPosition !== "function") {
      return { x: 0, y: 0 };
    }
    return windowManager.getFloatingButtonPosition();
  });

  ipcMain.handle("assistant:move-floating-button", (_event, payload = {}) => {
    const x = Number(payload && payload.x);
    const y = Number(payload && payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Move floating button failed: x and y are required numbers.");
    }
    if (!windowManager || typeof windowManager.setFloatingButtonPosition !== "function") {
      return { x: 0, y: 0 };
    }
    return windowManager.setFloatingButtonPosition(x, y);
  });

  ipcMain.handle("assistant:hide-for-capture", () => windowManager.hideChatWindowForCapture());

  ipcMain.handle("assistant:show-after-capture", () => windowManager.showChatWindowAfterCapture());

  ipcMain.handle("assistant:get-expand-state", () => windowManager.getExpandState());

  ipcMain.handle("assistant:toggle-expand", () => windowManager.toggleExpandState());

  ipcMain.handle("check-update", async () => {
    if (!updateService || typeof updateService.checkForUpdatesManual !== "function") {
      return {
        ok: false,
        updateAvailable: false,
        reason: "updater_unavailable"
      };
    }
    return updateService.checkForUpdatesManual();
  });

  ipcMain.handle("install-update", async () => {
    if (!updateService || typeof updateService.installUpdateNow !== "function") {
      return {
        ok: false,
        reason: "updater_unavailable"
      };
    }
    return updateService.installUpdateNow();
  });

  ipcMain.handle("capture-screen", async () => screenshotService.captureScreen());

  ipcMain.handle("assistant:extract-ocr", async (_event, payload = {}) => {
    try {
      ensurePayloadObject(payload, "OCR");
      const base64Screenshot = ensureBase64Field(payload, "base64Screenshot");
      return await screenshotService.extractOcrText(base64Screenshot);
    } catch (error) {
      throw new Error(`OCR failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:store-screenshot", async (_event, payload = {}) => {
    try {
      ensurePayloadObject(payload, "Store screenshot");
      const base64Screenshot = ensureBase64Field(payload, "base64Screenshot");
      const prefix = typeof payload.prefix === "string" ? payload.prefix.trim() : "chat";
      return await screenshotService.saveScreenshot(base64Screenshot, {
        prefix: prefix || "chat"
      });
    } catch (error) {
      throw new Error(`Store screenshot failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:write-clipboard-text", async (_event, payload = {}) => {
    try {
      ensurePayloadObject(payload, "Clipboard write");
      const text = ensureStringField(payload, "text", MAX_TEXT_BYTES, { allowEmpty: true });
      clipboard.writeText(String(text || ""));
      return true;
    } catch (error) {
      throw new Error(`Clipboard write failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:classify-input", async (_event, payload = {}) => {
    try {
      ensurePayloadObject(payload, "Classify input");
      const userPrompt = ensureStringField(payload, "userPrompt", MAX_TEXT_BYTES);
      if (!aiClient || typeof aiClient.classifyInputType !== "function") {
        throw new Error("Classifier unavailable.");
      }
      return await aiClient.classifyInputType(String(userPrompt || "").trim());
    } catch (error) {
      throw new Error(`Classify input failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:download-image", async (_event, payload = {}) => {
    try {
      const targetPath = await downloadImageToPath(payload, app, fsPromises, path);

      return {
        filePath: targetPath,
        fileName: path.basename(targetPath)
      };
    } catch (error) {
      throw new Error(`Download image failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:open-image", async (_event, payload = {}) => {
    try {
      ensurePayloadObject(payload, "Open image");
      const url = ensureStringField(payload, "url", MAX_IMAGE_BYTES);
      const localImagePath = resolveLocalImagePath(url, path);
      const targetPath = localImagePath || (await downloadImageToPath(payload, app, fsPromises, path));
      const result = await shell.openPath(targetPath);
      if (result) {
        throw new Error(result);
      }
      return { filePath: targetPath };
    } catch (error) {
      throw new Error(`Open image failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:prompt-library:list-categories", async () => {
    try {
      if (!promptLibraryService || typeof promptLibraryService.fetchCategories !== "function") {
        return [];
      }
      return await promptLibraryService.fetchCategories();
    } catch (error) {
      throw new Error(`Prompt library categories failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:prompt-library:list-templates", async () => {
    try {
      if (!promptLibraryService || typeof promptLibraryService.fetchTemplates !== "function") {
        return [];
      }
      return await promptLibraryService.fetchTemplates();
    } catch (error) {
      throw new Error(`Prompt library templates failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:prompt-library:list-saved", async () => {
    try {
      if (!promptLibraryService || typeof promptLibraryService.fetchSavedPrompts !== "function") {
        return [];
      }
      return await promptLibraryService.fetchSavedPrompts();
    } catch (error) {
      throw new Error(`Prompt library saved prompts failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:prompt-library:create-saved", async (_event, payload = {}) => {
    try {
      if (!promptLibraryService || typeof promptLibraryService.createSavedPrompt !== "function") {
        throw new Error("Prompt library service unavailable.");
      }
      const normalized = validatePromptLibrarySavedPromptPayload(payload);
      return await promptLibraryService.createSavedPrompt(normalized);
    } catch (error) {
      throw new Error(`Prompt library save failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:prompt-library:update-saved", async (_event, payload = {}) => {
    try {
      if (!promptLibraryService || typeof promptLibraryService.updateSavedPrompt !== "function") {
        throw new Error("Prompt library service unavailable.");
      }
      const normalized = validatePromptLibrarySavedPromptPayload(payload, { requirePromptId: true });
      await promptLibraryService.updateSavedPrompt(normalized.promptId, normalized);
      return true;
    } catch (error) {
      throw new Error(`Prompt library update failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:prompt-library:delete-saved", async (_event, payload = {}) => {
    try {
      if (!promptLibraryService || typeof promptLibraryService.deleteSavedPrompt !== "function") {
        throw new Error("Prompt library service unavailable.");
      }
      const normalized = validatePromptLibraryPromptIdPayload(payload);
      await promptLibraryService.deleteSavedPrompt(normalized.promptId);
      return true;
    } catch (error) {
      throw new Error(`Prompt library delete failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("ai:generate", async (_event, payload = {}) => {
    try {
      validateGeneratePayload(payload);
      return await aiClient.generate(payload);
    } catch (error) {
      throw new Error(`Generate failed: ${sanitizeErrorMessage(error)}`);
    }
  });

  ipcMain.handle("assistant:tts", async (_event, payload = {}) => {
    try {
      if (!voiceService || typeof voiceService.synthesizeSpeech !== "function") {
        throw new Error("Voice service unavailable.");
      }
      validateTtsPayload(payload);
      return await voiceService.synthesizeSpeech(payload);
    } catch (error) {
      const safeMessage = sanitizeErrorMessage(error);
      const lower = String(safeMessage || "").toLowerCase();
      const isPlanLimit =
        lower.includes("paid_plan_required") ||
        (lower.includes("elevenlabs tts failed") && lower.includes("(402)"));

      if (isPlanLimit) {
        return {
          audioBase64: "",
          contentType: "audio/mpeg",
          unavailableReason: "paid_plan_required",
          message: "TTS unavailable for this ElevenLabs voice on current plan."
        };
      }

      throw new Error(`TTS failed: ${safeMessage}`);
    }
  });

  ipcMain.handle("assistant:stt", async (_event, payload = {}) => {
    try {
      if (!voiceService || typeof voiceService.transcribeSpeech !== "function") {
        throw new Error("Voice service unavailable.");
      }
      validateSttPayload(payload);
      return await voiceService.transcribeSpeech(payload);
    } catch (error) {
      throw new Error(`STT failed: ${sanitizeErrorMessage(error)}`);
    }
  });
}

module.exports = {
  registerIpcHandlers
};
