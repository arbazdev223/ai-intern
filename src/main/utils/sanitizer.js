function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function removeDangerousPhrases(text) {
  if (!text) return "";
  let out = String(text);
  const patterns = [
    /ignore (the )?previous instructions/gi,
    /ignore all previous instructions/gi,
    /disregard (the )?previous instructions/gi,
    /do not follow (the )?previous instructions/gi,
    /do not follow any previous instructions/gi,
    /don't follow previous instructions/gi,
    /ignore any prior instructions/gi,
    /override (the )?system prompt/gi,
    /you are now (.*) assistant/gi,
    /please follow these new instructions/gi
  ];

  for (const re of patterns) {
    const before = out;
    out = out.replace(re, "");
    // record if removal happened
    if (before !== out) {
      try { require("./metrics").recordSanitizer("sanitizer", true, { pattern: String(re) }); } catch (_e) {}
    }
  }

  return out;
}

function escapeCodeFences(text) {
  // Replace triple backticks to avoid injecting code fences
  return String(text || "").replace(/```/g, "[CODE_BLOCK]");
}

function sanitizeExternalContent(text, maxChars = 1000) {
  if (!text) return "";
  let t = normalizeWhitespace(text);
  t = removeDangerousPhrases(t);
  t = escapeCodeFences(t);
  if (t.length > maxChars) {
    t = `${t.slice(0, maxChars - 3)}...`;
  }
  // wrap to ensure it's treated as data
  return `[BEGIN EXTERNAL CONTENT]\n${t}\n[END EXTERNAL CONTENT]`;
}

function sanitizeUserInput(text, maxChars = 3000) {
  if (!text) return "";
  let t = normalizeWhitespace(text);
  t = removeDangerousPhrases(t);
  t = escapeCodeFences(t);
  if (t.length > maxChars) t = `${t.slice(0, maxChars - 3)}...`;
  return t;
}

module.exports = {
  sanitizeExternalContent,
  sanitizeUserInput,
  normalizeWhitespace
};
