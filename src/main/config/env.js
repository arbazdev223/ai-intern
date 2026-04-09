const path = require("path");

const ROOT_ENV_PATH = path.resolve(__dirname, "..", "..", "..", ".env");

let didLoadDotenv = false;
let didLogDebug = false;

function loadDotenvOnce() {
  if (didLoadDotenv) {
    return;
  }

  didLoadDotenv = true;
  try {
    // Load .env from project root without overriding already exported shell env vars.
    require("dotenv").config({ path: ROOT_ENV_PATH });
  } catch (error) {
    const message = String(error && error.message ? error.message : "").trim();
    if (message) {
      console.warn(`[env] dotenv load warning: ${message}`);
    }
  }
}

function trimEnv(value) {
  return String(value || "").trim();
}

function getEnv() {
  loadDotenvOnce();

  const env = {
    OPENAI_API_KEY: trimEnv(process.env.OPENAI_API_KEY || process.env.GPT_key),
    GEMINI_API_KEY: trimEnv(process.env.GEMINI_API_KEY),
    OPENAI_MODEL: trimEnv(process.env.GPT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini"),
    GEMINI_MODEL: trimEnv(process.env.GEMINI_MODEL || "gemini-1.5-flash"),
    DEBUG_ENV: trimEnv(process.env.DEBUG_ENV)
  };

  if (env.DEBUG_ENV.toLowerCase() === "true" && !didLogDebug) {
    didLogDebug = true;
    console.log("ENV CHECK:", {
      hasOpenAIKey: Boolean(env.OPENAI_API_KEY),
      hasGeminiKey: Boolean(env.GEMINI_API_KEY)
    });
  }

  return env;
}

function ensureAiProviderConfigured() {
  const env = getEnv();
  if (env.OPENAI_API_KEY || env.GEMINI_API_KEY) {
    return env;
  }

  throw new Error(
    "Missing OPENAI_API_KEY. Please check your .env configuration. Ensure .env is in project root and contains OPENAI_API_KEY (or GEMINI_API_KEY)."
  );
}

module.exports = {
  ROOT_ENV_PATH,
  getEnv,
  ensureAiProviderConfigured
};