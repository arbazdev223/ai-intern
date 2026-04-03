const { fetchWithRetry } = require("./httpClient");
const { Blob } = require("buffer");

function createVoiceService() {
  const baseUrl = String(process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/+$/, "");

  function getApiKey() {
    return String(process.env.ELEVENLABS_API_KEY || "").trim();
  }

  function getVoiceId() {
    return String(process.env.ELEVENLABS_VOICE_ID || "").trim();
  }

  function getModelId() {
    return String(process.env.ELEVENLABS_MODEL_ID || "").trim();
  }

  async function synthesizeSpeech(payload = {}) {
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

  async function transcribeSpeech(payload = {}) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error("ElevenLabs API key is not configured.");
    }

    const audioBase64 = String(payload.audioBase64 || "").trim();
    if (!audioBase64) {
      throw new Error("Audio payload is required.");
    }

    const modelId = String(
      payload.modelId || process.env.ELEVENLABS_STT_MODEL_ID || "scribe_v2"
    ).trim();

    const mimeType = String(payload.mimeType || "audio/webm").trim() || "audio/webm";
    const filename = String(payload.filename || "audio.webm").trim() || "audio.webm";
    const buffer = Buffer.from(audioBase64, "base64");

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
    form.append("model_id", modelId);
    form.append("file", new Blob([buffer], { type: mimeType }), filename);

    if (payload.languageCode) {
      form.append("language_code", String(payload.languageCode));
    }

    if (payload.fileFormat) {
      form.append("file_format", String(payload.fileFormat));
    }

    const response = await fetchWithRetry(
      `${baseUrl}/v1/speech-to-text`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey
        },
        body: form
      },
      { label: "elevenlabs-stt", timeoutMs: 30000 }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const suffix = errorText ? `: ${errorText.slice(0, 240)}` : "";
      throw new Error(`ElevenLabs STT failed (${response.status})${suffix}`);
    }

    return response.json();
  }

  return {
    synthesizeSpeech,
    transcribeSpeech
  };
}

module.exports = {
  createVoiceService
};
