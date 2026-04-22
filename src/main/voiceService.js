const { fetchWithRetry } = require("./httpClient");
const { Blob } = require("buffer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const fsPromises = require("fs/promises");
const { spawn } = require("child_process");

function createVoiceService() {
  const baseUrl = String(process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/+$/, "");
  const openAiBaseUrl = String(process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
  const saveDebugAudio = String(process.env.VOICE_SAVE_DEBUG_AUDIO || "false").trim().toLowerCase() === "true";
  const debugVoiceLogs = String(process.env.VOICE_DEBUG_LOGS || "false").trim().toLowerCase() === "true";

  function logVoiceDebug(message, payload) {
    if (!debugVoiceLogs) {
      return;
    }

    if (typeof payload === "undefined") {
      console.info(`[voice][debug] ${message}`);
      return;
    }

    console.info(`[voice][debug] ${message}`, payload);
  }

  function warnVoiceDebug(message, payload) {
    if (!debugVoiceLogs) {
      return;
    }

    if (typeof payload === "undefined") {
      console.warn(`[voice][debug] ${message}`);
      return;
    }

    console.warn(`[voice][debug] ${message}`, payload);
  }

  function isElevenLabsBypassed() {
    const raw = String(process.env.ELEVENLABS_BYPASS || "true").trim().toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes";
  }

  function getApiKey() {
    return String(process.env.ELEVENLABS_API_KEY || "").trim();
  }

  function getOpenAiApiKey() {
    return String(process.env.OPENAI_API_KEY || "").trim();
  }

  function normalizeTranscript(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isLowConfidenceSingleWord(text) {
    const normalized = normalizeTranscript(text).toLowerCase();
    if (!normalized) {
      return true;
    }
    if (/^(you|u|yo|yeah|ya|hmm|um|uh)\.?$/.test(normalized)) {
      return true;
    }
    return normalized.split(" ").length <= 1;
  }

  function scoreTranscript(text) {
    const normalized = normalizeTranscript(text);
    if (!normalized) {
      return 0;
    }
    const wordCount = normalized.split(" ").filter(Boolean).length;
    return Math.max(wordCount, normalized.length / 8);
  }

  function hasLettersOrDigits(text) {
    const normalized = normalizeTranscript(text);
    if (!normalized) {
      return false;
    }
    try {
      return /[\p{L}\p{N}]/u.test(normalized);
    } catch (_error) {
      return /[A-Za-z0-9]/.test(normalized);
    }
  }

  function isMeaninglessTranscript(text) {
    const normalized = normalizeTranscript(text);
    if (!normalized) {
      return true;
    }

    if (!hasLettersOrDigits(normalized)) {
      return true;
    }

    const compact = normalized.replace(/\s+/g, "");
    if (/^(\.{2,}|…{2,}|[-_]{2,}|[!?]{2,})$/.test(compact)) {
      return true;
    }

    const words = normalized
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean);

    if (!words.length) {
      return true;
    }

    const uniqueWords = new Set(words);
    if (words.length >= 4 && uniqueWords.size <= 2) {
      return true;
    }

    const longestWord = words.reduce((max, word) => Math.max(max, word.length), 0);
    if (words.length >= 4 && longestWord <= 2) {
      return true;
    }

    return false;
  }

  function looksLikeInstructionLeak(text) {
    const normalized = normalizeTranscript(text).toLowerCase();
    if (!normalized) {
      return false;
    }
    return (
      normalized.includes("preserve original words") ||
      normalized.includes("transcribe exactly what is spoken") ||
      normalized.includes("original words and sentence")
    );
  }

  function looksLikeMojibake(text) {
    const normalized = normalizeTranscript(text);
    if (!normalized) {
      return false;
    }

    if (/αñ|ΓÇ|Ã|â|█|�|┐|╢|╜|╕|╣|╛|╡/.test(normalized)) {
      return true;
    }

    // Strong signal for UTF-8/Windows-1252 decoding corruption patterns.
    if (/(?:[αΓÃâ][^\s]{0,2}[ñÑÇ])|(?:[ñÑÇ]{2,})/.test(normalized)) {
      return true;
    }

    const latinExtended = normalized.match(/[\u00C0-\u024F]/g);
    if (latinExtended && latinExtended.length >= Math.max(4, Math.floor(normalized.length * 0.15))) {
      return true;
    }

    const suspicious = normalized.match(/[\u2500-\u257F\u2580-\u259F\u0370-\u03FF\uFFFD]/g);
    if (!suspicious) {
      return false;
    }

    return suspicious.length >= Math.max(4, Math.floor(normalized.length * 0.08));
  }

  async function resolvePythonSttScriptPath() {
    const candidates = [
      path.resolve(process.cwd(), "scripts", "stt_faster_whisper.py"),
      path.resolve(__dirname, "..", "..", "scripts", "stt_faster_whisper.py")
    ];

    for (const candidate of candidates) {
      try {
        await fsPromises.access(candidate);
        return candidate;
      } catch (_error) {}
    }

    throw new Error("Python STT script not found (scripts/stt_faster_whisper.py).");
  }

  function runPythonStt(scriptPath, audioPath, languageCode) {
    const modelName = String(process.env.PYTHON_STT_MODEL || "small").trim() || "small";
    const args = [scriptPath, "--input", audioPath, "--model", modelName];
    if (languageCode) {
      args.push("--language", String(languageCode).trim());
    }

    const commandCandidates = [
      { command: String(process.env.PYTHON_EXECUTABLE || "python").trim(), prefixArgs: [] },
      { command: "py", prefixArgs: ["-3"] }
    ];

    async function tryRun(index) {
      if (index >= commandCandidates.length) {
        throw new Error("Python runtime not found. Install Python 3 and faster-whisper.");
      }

      const candidate = commandCandidates[index];

      return new Promise((resolve, reject) => {
        const child = spawn(candidate.command, [...candidate.prefixArgs, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
          stdout += String(chunk || "");
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk || "");
        });

        child.on("error", async () => {
          try {
            const next = await tryRun(index + 1);
            resolve(next);
          } catch (error) {
            reject(error);
          }
        });

        child.on("close", async (code) => {
          if (code !== 0) {
            const message = stderr.trim() || stdout.trim() || `exit ${code}`;
            if (/not found|is not recognized|enoent/i.test(message)) {
              try {
                const next = await tryRun(index + 1);
                resolve(next);
                return;
              } catch (error) {
                reject(error);
                return;
              }
            }
            reject(new Error(`Python STT failed (${code}): ${message.slice(0, 260)}`));
            return;
          }

          const raw = stdout.trim();
          if (!raw) {
            reject(new Error("Python STT returned empty output."));
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (_error) {
            reject(new Error(`Python STT output is not valid JSON: ${raw.slice(0, 260)}`));
          }
        });
      });
    }

    return tryRun(0);
  }

  async function transcribeWithPythonFallback({ buffer, mimeType, languageCode }) {
    const ext = String(mimeType || "audio/webm").includes("wav") ? ".wav" : ".webm";
    const tempFile = path.join(os.tmpdir(), `ifda-stt-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    try {
      await fsPromises.writeFile(tempFile, buffer);
      const result = await runPythonStt(await resolvePythonSttScriptPath(), tempFile, languageCode);
      return normalizeTranscript(result && result.text ? result.text : "");
    } finally {
      await fsPromises.unlink(tempFile).catch(() => {});
    }
  }

  async function transcribeWhisperAttempt({
    apiKey,
    buffer,
    mimeType,
    filename,
    language,
    model
  }) {
    let FormDataCtor = typeof FormData !== "undefined" ? FormData : null;
    if (!FormDataCtor) {
      try {
        FormDataCtor = require("undici").FormData;
      } catch (_error) {
        FormDataCtor = null;
      }
    }
    if (!FormDataCtor) {
      throw new Error("FormData is not available in this runtime.");
    }

    const form = new FormDataCtor();
    form.append("model", String(model || "whisper-1"));
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    form.append("temperature", "0");
    if (language) {
      form.append("language", language);
    }

    const response = await fetchWithRetry(
      `${openAiBaseUrl}/v1/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: form
      },
      { label: "openai-whisper-stt", timeoutMs: 45000 }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const suffix = errorText ? `: ${errorText.slice(0, 240)}` : "";
      throw new Error(`OpenAI Whisper STT failed (${response.status})${suffix}`);
    }

    const data = await response.json().catch(() => ({}));
    logVoiceDebug("Whisper response received", {
      hasText: Boolean(data && data.text),
      language: language || "",
      model: String(model || "whisper-1")
    });
    return {
      text: normalizeTranscript(data && data.text ? data.text : ""),
      raw: data,
      language: language || ""
    };
  }

  async function transcribeWhisperTranslationAttempt({
    apiKey,
    buffer,
    mimeType,
    filename,
    model
  }) {
    let FormDataCtor = typeof FormData !== "undefined" ? FormData : null;
    if (!FormDataCtor) {
      try {
        FormDataCtor = require("undici").FormData;
      } catch (_error) {
        FormDataCtor = null;
      }
    }
    if (!FormDataCtor) {
      throw new Error("FormData is not available in this runtime.");
    }

    const form = new FormDataCtor();
    form.append("model", String(model || "whisper-1"));
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    form.append("temperature", "0");

    const response = await fetchWithRetry(
      `${openAiBaseUrl}/v1/audio/translations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: form
      },
      { label: "openai-whisper-translation", timeoutMs: 45000 }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const suffix = errorText ? `: ${errorText.slice(0, 240)}` : "";
      throw new Error(`OpenAI Whisper translation failed (${response.status})${suffix}`);
    }

    const data = await response.json().catch(() => ({}));
    return {
      text: normalizeTranscript(data && data.text ? data.text : ""),
      raw: data,
      language: "en"
    };
  }

  function getVoiceId() {
    return String(process.env.ELEVENLABS_VOICE_ID || "").trim();
  }

  function getModelId() {
    return String(process.env.ELEVENLABS_MODEL_ID || "").trim();
  }

  async function synthesizeSpeech(payload = {}) {
    if (isElevenLabsBypassed()) {
      return {
        audioBase64: "",
        contentType: "audio/mpeg",
        unavailableReason: "elevenlabs_bypassed",
        message: "ElevenLabs is bypassed by configuration."
      };
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error("ElevenLabs API key is not configured.");
    }

    const text = String(payload.text || "").trim();
    if (!text) {
      throw new Error("Speech text is required.");
    }

    const voiceId = String(payload.voiceId || getVoiceId()).trim();
    if (!voiceId) {
      throw new Error("ElevenLabs voice ID is not configured.");
    }

    const body = { text };
    const modelId = String(payload.modelId || getModelId()).trim();
    if (modelId) {
      body.model_id = modelId;
    }

    if (payload.voiceSettings && typeof payload.voiceSettings === "object") {
      body.voice_settings = payload.voiceSettings;
    }

    const response = await fetchWithRetry(
      `${baseUrl}/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey
        },
        body: JSON.stringify(body)
      },
      { label: "elevenlabs-tts" }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const suffix = errorText ? `: ${errorText.slice(0, 240)}` : "";
      throw new Error(`ElevenLabs TTS failed (${response.status})${suffix}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString("base64");
    const contentType = response.headers.get("content-type") || "audio/mpeg";

    return {
      audioBase64,
      contentType
    };
  }

  function normalizeSttMimeType(value) {
    const normalized = String(value || "audio/webm").split(";")[0].trim().toLowerCase();
    const allowed = new Set([
      "audio/webm",
      "audio/wav",
      "audio/x-wav",
      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/m4a",
      "audio/ogg"
    ]);
    if (allowed.has(normalized)) {
      return normalized;
    }
    return "audio/webm";
  }

  function ensureSttFilename(filenameValue, mimeType) {
    const safeName = String(filenameValue || "").trim();
    const fallbackByMime = {
      "audio/webm": "speech.webm",
      "audio/wav": "speech.wav",
      "audio/x-wav": "speech.wav",
      "audio/mpeg": "speech.mp3",
      "audio/mp3": "speech.mp3",
      "audio/mp4": "speech.m4a",
      "audio/m4a": "speech.m4a",
      "audio/ogg": "speech.ogg"
    };

    if (!safeName) {
      return fallbackByMime[mimeType] || "speech.webm";
    }

    const lower = safeName.toLowerCase();
    const expectedExt = String((fallbackByMime[mimeType] || "speech.webm").split(".").pop() || "webm");
    if (lower.endsWith(`.${expectedExt}`)) {
      return safeName;
    }

    return `${safeName.replace(/\.[a-z0-9]+$/i, "")}.${expectedExt}`;
  }

  function normalizeOutputMode(value) {
    const mode = String(value || "auto").trim().toLowerCase();
    if (mode === "hindi" || mode === "english") {
      return mode;
    }
    return "auto";
  }

  async function transcribeSpeech(payload = {}) {
    const apiKey = getOpenAiApiKey();

    const audioBase64 = String(payload.audioBase64 || "").trim();
    if (!audioBase64) {
      throw new Error("Audio payload is required.");
    }

    if (!apiKey) {
      throw new Error("OpenAI API key is not configured.");
    }

    const mimeType = normalizeSttMimeType(payload.mimeType || "audio/webm");
    const filename = ensureSttFilename(payload.filename || "speech.webm", mimeType);
    const outputMode = normalizeOutputMode(payload.outputMode);
    const buffer = Buffer.from(audioBase64, "base64");
    if (!buffer || buffer.length === 0) {
      throw new Error("Empty audio file.");
    }
    logVoiceDebug("STT payload accepted", {
      filename,
      mimeType,
      bytes: buffer.length
    });
    const preferLocalStt = String(process.env.PREFER_LOCAL_STT || "false").trim().toLowerCase() === "true";

    if (saveDebugAudio) {
      try {
        const debugPath = String(process.env.VOICE_DEBUG_AUDIO_PATH || "").trim() ||
          path.join(os.tmpdir(), "ifda-debug-audio.webm");
        fs.writeFileSync(debugPath, buffer);
        logVoiceDebug("Saved debug audio file", {
          path: debugPath,
          bytes: buffer.length
        });
      } catch (error) {
        warnVoiceDebug("Failed to save debug audio file", error && error.message ? error.message : error);
      }
    }

    const requestedLanguageCode = String(payload.languageCode || "").trim();
    const languageCode =
      outputMode === "hindi"
        ? "hi"
        : outputMode === "english"
          ? "en"
          : requestedLanguageCode;

    if (outputMode === "english") {
      try {
        const translated = await transcribeWhisperTranslationAttempt({
          apiKey,
          buffer,
          mimeType,
          filename,
          model: "whisper-1"
        });
        if (translated && translated.text && !isMeaninglessTranscript(translated.text)) {
          return {
            text: translated.text,
            provider: "openai-whisper-translation",
            language: "en"
          };
        }
      } catch (error) {
        warnVoiceDebug("Whisper translation mode failed", error && error.message ? error.message : error);
      }
    }

    if (preferLocalStt) {
      try {
        const localText = await transcribeWithPythonFallback({
          buffer,
          mimeType,
          languageCode: languageCode || ""
        });
        if (localText && !looksLikeMojibake(localText) && !isMeaninglessTranscript(localText)) {
          logVoiceDebug("Local faster-whisper primary used", {
            length: String(localText || "").length
          });
          return {
            text: localText,
            provider: "python-faster-whisper",
            language: String(languageCode || "").trim()
          };
        }
        if (localText) {
          warnVoiceDebug("Local faster-whisper primary rejected as low-confidence transcript");
        }
      } catch (error) {
        warnVoiceDebug("Local faster-whisper primary failed", error && error.message ? error.message : error);
      }
    }
    const attempts = [{ language: languageCode || "", model: "whisper-1" }];
    if (!languageCode || /^en/i.test(languageCode)) {
      attempts.push({ language: "en", model: "whisper-1" });
    }
    if (/^hi/i.test(languageCode)) {
      attempts.push({ language: "hi", model: "whisper-1" });
    }

    let best = { text: "", language: "", score: 0, provider: "openai-whisper-1" };
    let primaryText = "";
    let attemptIndex = 0;
    for (const attempt of attempts) {
      const result = await transcribeWhisperAttempt({
        apiKey,
        buffer,
        mimeType,
        filename,
        language: attempt.language,
        model: attempt.model
      });
      if (attemptIndex === 0) {
        primaryText = result.text;
      }
      attemptIndex += 1;

      if (looksLikeInstructionLeak(result.text)) {
        continue;
      }
      if (looksLikeMojibake(result.text)) {
        continue;
      }

      const score = scoreTranscript(result.text);
      if (score > best.score) {
        best = {
          text: result.text,
          language: result.language,
          score,
          provider: attempt.model
        };
      }

      if (result.text && !isLowConfidenceSingleWord(result.text)) {
        best = {
          text: result.text,
          language: result.language,
          score: Math.max(score, 999),
          provider: attempt.model
        };
        break;
      }
    }

    if (!best.text || isLowConfidenceSingleWord(best.text)) {
      const configuredFallback = String(process.env.OPENAI_STT_FALLBACK_MODEL || "").trim();
      const fallbackModels = [
        configuredFallback,
        "gpt-4o-mini-transcribe",
        "gpt-4o-transcribe"
      ].filter(Boolean);

      const attempted = new Set(["whisper-1"]);
      for (const fallbackModel of fallbackModels) {
        if (attempted.has(fallbackModel)) {
          continue;
        }
        attempted.add(fallbackModel);

        try {
          const fallbackResult = await transcribeWhisperAttempt({
            apiKey,
            buffer,
            mimeType,
            filename,
            language: languageCode || "",
            model: fallbackModel
          });

          if (
            !fallbackResult.text ||
            looksLikeMojibake(fallbackResult.text) ||
            isMeaninglessTranscript(fallbackResult.text)
          ) {
            continue;
          }

          best = {
            text: fallbackResult.text,
            language: fallbackResult.language,
            score: Math.max(best.score, scoreTranscript(fallbackResult.text) + 100),
            provider: fallbackModel
          };

          if (!isLowConfidenceSingleWord(fallbackResult.text)) {
            break;
          }
        } catch (error) {
          warnVoiceDebug(
            `Fallback STT model failed (${fallbackModel})`,
            error && error.message ? error.message : error
          );
        }
      }
    }

    const shouldForceLocal = isLowConfidenceSingleWord(primaryText);
    if (
      shouldForceLocal ||
      !best.text ||
      isLowConfidenceSingleWord(best.text) ||
      looksLikeMojibake(best.text) ||
      isMeaninglessTranscript(best.text)
    ) {
      try {
        const localText = await transcribeWithPythonFallback({
          buffer,
          mimeType,
          languageCode: languageCode || ""
        });
        if (localText && !looksLikeMojibake(localText) && !isMeaninglessTranscript(localText)) {
          best = {
            text: localText,
            language: languageCode || "",
            score: Math.max(best.score, scoreTranscript(localText) + 120),
            provider: "python-faster-whisper"
          };
          logVoiceDebug("Local faster-whisper fallback used", {
            length: String(localText || "").length
          });
        }
      } catch (error) {
        warnVoiceDebug("Local faster-whisper fallback failed", error && error.message ? error.message : error);
      }
    }

    const text = normalizeTranscript(best.text);
    if (isMeaninglessTranscript(text)) {
      return {
        text: "",
        provider: String(best.provider || "python-faster-whisper"),
        language: String(best.language || languageCode || "").trim()
      };
    }
    return {
      text,
      provider: String(best.provider || "openai-whisper-1"),
      language: String(best.language || languageCode || "").trim()
    };
  }

  return {
    synthesizeSpeech,
    transcribeSpeech
  };
}

module.exports = {
  createVoiceService
};
