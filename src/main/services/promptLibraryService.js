const { getEnv } = require("../config/env");
const { fetchWithRetry } = require("../httpClient");

const DEFAULT_TIMEOUT_MS = 15000;

function createPromptLibraryService() {
  function getConfig() {
    const env = getEnv();
    return {
      apiBase: String(env.PROMPT_LIBRARY_API_BASE || "").replace(/\/+$/, ""),
      bearerToken: String(env.PROMPT_LIBRARY_BEARER_TOKEN || "").trim(),
      masterSecret: String(env.PROMPT_LIBRARY_MASTER_SECRET || "").trim(),
      userId: String(env.PROMPT_LIBRARY_USER_ID || "").trim()
    };
  }

  function hasWriteCredentials(config = getConfig()) {
    return Boolean(config.bearerToken || config.masterSecret);
  }

  function buildHeaders(config, { authRequired = false } = {}) {
    const headers = {
      "Content-Type": "application/json"
    };

    if (config.bearerToken) {
      headers.Authorization = `Bearer ${config.bearerToken}`;
    } else if (config.masterSecret) {
      headers["x-master-secret"] = config.masterSecret;
    } else if (authRequired) {
      throw new Error("Prompt library write access is not configured.");
    }

    return headers;
  }

  async function request(path, requestOptions = {}) {
    const config = getConfig();
    if (!config.apiBase) {
      throw new Error("Prompt library API base URL is not configured.");
    }

    const response = await fetchWithRetry(
      `${config.apiBase}${path}`,
      {
        method: requestOptions.method || "GET",
        headers: buildHeaders(config, {
          authRequired: Boolean(requestOptions.authRequired)
        }),
        body: requestOptions.body
      },
      {
        label: `prompt-library:${requestOptions.method || "GET"}:${path}`,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        retries: 1,
        baseDelayMs: 250
      }
    );

    const text = await response.text().catch(() => "");
    let payload = {};

    try {
      payload = text ? JSON.parse(text) : {};
    } catch (_error) {
      payload = {};
    }

    if (!response.ok) {
      const message =
        (payload && payload.message && String(payload.message)) ||
        `Prompt library request failed (${response.status}).`;
      throw new Error(message);
    }

    return payload;
  }

  function parseArrayPayload(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && Array.isArray(payload.data)) {
      return payload.data;
    }

    return [];
  }

  async function fetchCategories() {
    const payload = await request("/categories");
    return parseArrayPayload(payload);
  }

  async function fetchTemplates() {
    const payload = await request("/templates?page=1&limit=500");
    return parseArrayPayload(payload);
  }

  async function fetchSavedPrompts() {
    const config = getConfig();
    if (!hasWriteCredentials(config)) {
      return null;
    }

    const query = config.masterSecret && config.userId ? `?userId=${encodeURIComponent(config.userId)}` : "";
    const payload = await request(`/saved${query}`, {
      method: "GET",
      authRequired: true
    });
    return parseArrayPayload(payload);
  }

  async function createSavedPrompt(payload = {}) {
    const config = getConfig();
    const body = {
      title: payload.title,
      prompt: payload.prompt,
      sourceTemplateId: payload.sourceTemplateId || undefined,
      isFavorite: Boolean(payload.isFavorite)
    };

    if (config.masterSecret && config.userId) {
      body.userId = config.userId;
    }

    const created = await request("/saved", {
      method: "POST",
      authRequired: true,
      body: JSON.stringify(body)
    });

    return created && created.data ? created.data : created;
  }

  async function updateSavedPrompt(promptId, payload = {}) {
    const config = getConfig();
    const body = {
      title: payload.title,
      prompt: payload.prompt,
      isFavorite: Boolean(payload.isFavorite)
    };

    if (config.masterSecret && config.userId) {
      body.userId = config.userId;
    }

    await request(`/saved/${encodeURIComponent(String(promptId || "").trim())}`, {
      method: "PATCH",
      authRequired: true,
      body: JSON.stringify(body)
    });

    return true;
  }

  async function deleteSavedPrompt(promptId) {
    await request(`/saved/${encodeURIComponent(String(promptId || "").trim())}`, {
      method: "DELETE",
      authRequired: true
    });

    return true;
  }

  return {
    createSavedPrompt,
    deleteSavedPrompt,
    fetchCategories,
    fetchSavedPrompts,
    fetchTemplates,
    hasWriteCredentials,
    updateSavedPrompt
  };
}

module.exports = {
  createPromptLibraryService
};
