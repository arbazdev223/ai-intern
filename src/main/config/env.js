const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT_ENV_PATH = path.resolve(__dirname, "..", "..", "..", ".env");

let didLoadDotenv = false;
let didLogDebug = false;
let loadedEnvPaths = [];
let envFileHint = "";

function getElectronApp() {
  try {
    const electron = require("electron");
    return electron && electron.app ? electron.app : null;
  } catch (_error) {
    return null;
  }
}

function safeGetUserDataDir(app) {
  try {
    if (app && typeof app.getPath === "function") {
      return String(app.getPath("userData") || "");
    }
  } catch (_error) {}

  return "";
}

function getFallbackUserDataDir(app) {
  const base =
    process.env.APPDATA || (os.homedir() ? path.join(os.homedir(), "AppData", "Roaming") : "");
  const appName = app && typeof app.getName === "function" ? app.getName() : "AI Intern";
  return base ? path.join(base, appName) : "";
}

function chooseEnvFileHint() {
  const app = getElectronApp();
  const isPackaged = Boolean(app && app.isPackaged);

  if (!isPackaged) {
    return ROOT_ENV_PATH;
  }

  let userDataDir = safeGetUserDataDir(app);
  if (!userDataDir) {
    userDataDir = getFallbackUserDataDir(app);
  }

  const userEnvPath = userDataDir ? path.join(userDataDir, ".env") : "";
  return userEnvPath || ROOT_ENV_PATH;
}

function getEnvCandidatePaths() {
  const app = getElectronApp();
  const isPackaged = Boolean(app && app.isPackaged);

  const candidates = [];
  const explicitEnvPath = String(process.env.IFDA_ENV_PATH || "").trim();

  if (explicitEnvPath) {
    candidates.push(explicitEnvPath);
  }

  if (isPackaged) {
    // In packaged builds there is no repo-root .env next to app.asar.
    let userDataDir = safeGetUserDataDir(app);
    if (!userDataDir) {
      userDataDir = getFallbackUserDataDir(app);
    }

    const userEnvPath = userDataDir ? path.join(userDataDir, ".env") : "";
    if (userEnvPath) {
      candidates.push(userEnvPath);
    }

    // Optional portable fallback (.env next to the exe).
    try {
      candidates.push(path.join(path.dirname(process.execPath), ".env"));
    } catch (_error) {}

    return Array.from(new Set(candidates.filter(Boolean)));
  }

  // Dev: prefer repo root and current working dir.
  candidates.push(ROOT_ENV_PATH);
  candidates.push(path.resolve(process.cwd(), ".env"));
  return Array.from(new Set(candidates.filter(Boolean)));
}

function loadDotenvOnce() {
  if (didLoadDotenv) {
    return;
  }

  didLoadDotenv = true;
  loadedEnvPaths = [];
  envFileHint = chooseEnvFileHint();

  try {
    const dotenv = require("dotenv");
    const candidatePaths = getEnvCandidatePaths();

    candidatePaths.forEach((candidatePath) => {
      try {
        if (fs.existsSync(candidatePath)) {
          dotenv.config({ path: candidatePath, override: false });
          loadedEnvPaths.push(candidatePath);
        }
      } catch (_error) {}
    });
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
    OPENAI_RESEARCH_MODEL: trimEnv(process.env.OPENAI_RESEARCH_MODEL || ""),
    GEMINI_MODEL: trimEnv(process.env.GEMINI_MODEL || "gemini-1.5-flash"),
    PROMPT_LIBRARY_API_BASE: trimEnv(
      process.env.PROMPT_LIBRARY_API_BASE || "https://ims.ifda.in/api/prompt-library"
    ),
    PROMPT_LIBRARY_BEARER_TOKEN: trimEnv(process.env.PROMPT_LIBRARY_BEARER_TOKEN),
    PROMPT_LIBRARY_MASTER_SECRET: trimEnv(process.env.PROMPT_LIBRARY_MASTER_SECRET),
    PROMPT_LIBRARY_USER_ID: trimEnv(process.env.PROMPT_LIBRARY_USER_ID),
    ASSIGNMENTS_API_BASE: trimEnv(process.env.ASSIGNMENTS_API_BASE || "http://localhost:5000/api/assignments"),
    ASSIGNMENTS_MASTER_TOKEN: trimEnv(process.env.ASSIGNMENTS_MASTER_TOKEN),
    IFDA_AUTO_UPDATE_ENABLED: trimEnv(process.env.IFDA_AUTO_UPDATE_ENABLED),
    IFDA_UPDATE_OWNER: trimEnv(process.env.IFDA_UPDATE_OWNER),
    IFDA_UPDATE_REPO: trimEnv(process.env.IFDA_UPDATE_REPO),
    DEBUG_ENV: trimEnv(process.env.DEBUG_ENV)
  };

  // Production builds: if no environment keys are configured, fall back to bundled secrets.
  // Note: this is NOT secure against reverse-engineering. Prefer a backend/proxy long-term.
  if (!env.OPENAI_API_KEY && !env.GEMINI_API_KEY) {
    const app = getElectronApp();
    const isPackaged = Boolean(app && app.isPackaged);

    if (isPackaged) {
      try {
        // This file is generated during build (see scripts/generateBundledSecrets.js).
        // It is gitignored and should never be committed.
        // eslint-disable-next-line global-require
        const bundled = require("./bundledSecrets");
        if (bundled && typeof bundled === "object") {
          if (!env.OPENAI_API_KEY && bundled.OPENAI_API_KEY) {
            env.OPENAI_API_KEY = trimEnv(bundled.OPENAI_API_KEY);
          }
          if (!env.GEMINI_API_KEY && bundled.GEMINI_API_KEY) {
            env.GEMINI_API_KEY = trimEnv(bundled.GEMINI_API_KEY);
          }
        }
      } catch (_error) {
        // Ignore if bundled file does not exist.
      }
    }
  }

  if (env.DEBUG_ENV.toLowerCase() === "true" && !didLogDebug) {
    didLogDebug = true;
    console.log("ENV CHECK:", {
      loadedEnvPaths,
      envFileHint,
      hasOpenAIKey: Boolean(env.OPENAI_API_KEY),
      hasGeminiKey: Boolean(env.GEMINI_API_KEY)
    });
  }

  return env;
}

function getEnvFileHint() {
  loadDotenvOnce();
  return envFileHint || ROOT_ENV_PATH;
}

function getLoadedEnvPaths() {
  loadDotenvOnce();
  return [...loadedEnvPaths];
}

function ensureEnvTemplateExists() {
  const hintPath = getEnvFileHint();
  if (!hintPath || !hintPath.endsWith(".env")) {
    return "";
  }

  try {
    if (fs.existsSync(hintPath)) {
      return hintPath;
    }

    fs.mkdirSync(path.dirname(hintPath), { recursive: true });

    const template = [
      "# IFDA AI configuration (.env)",
      "OPENAI_API_KEY=",
      "OPENAI_MODEL=gpt-4o-mini",
      "OPENAI_RESEARCH_MODEL=gpt-4.1",
      "OPENAI_VISION_MODEL=gpt-4o-mini",
      "",
      "# Gemini (optional)",
      "GEMINI_API_KEY=",
      "GEMINI_MODEL=gemini-1.5-flash",
      "GEMINI_VISION_MODEL=gemini-1.5-flash",
      "",
      "# IFDA IMS assignments (optional)",
      "ASSIGNMENTS_API_BASE=http://localhost:5000/api/assignments",
      "ASSIGNMENTS_MASTER_TOKEN=",
      ""
    ].join("\n");

    fs.writeFileSync(hintPath, template, { encoding: "utf8", flag: "wx" });
    return hintPath;
  } catch (_error) {
    return hintPath;
  }
}

function ensureAiProviderConfigured() {
  const env = getEnv();
  if (env.OPENAI_API_KEY || env.GEMINI_API_KEY) {
    return env;
  }

  const hintPath = ensureEnvTemplateExists();
  throw new Error(
    hintPath
      ? `Missing OPENAI_API_KEY. Add OPENAI_API_KEY or GEMINI_API_KEY in: ${hintPath}`
      : "Missing OPENAI_API_KEY. Add OPENAI_API_KEY or GEMINI_API_KEY in your environment."
  );
}

module.exports = {
  ROOT_ENV_PATH,
  getEnv,
  getEnvFileHint,
  getLoadedEnvPaths,
  ensureEnvTemplateExists,
  ensureAiProviderConfigured
};
