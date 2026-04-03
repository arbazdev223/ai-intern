const promptBuilder = require("../../shared/promptBuilder");
const { estimateTokens } = require("../utils/tokenUtils");
const { sanitizeExternalContent, sanitizeUserInput } = require("../utils/sanitizer");

function truncateText(value, maxChars = 1800) {
  const safe = String(value || "").trim();
  if (!safe) return "";
  return safe.length > maxChars ? `${safe.slice(0, maxChars - 3)}...` : safe;
}

function buildNotConfirmedFullFormResponse(options = {}) {
  const safeAcronym = String(options.acronym || "this term").trim();
  const lines = [
    "### Not Confirmed",
    `Mujhe \`${safeAcronym}\` ka verified full form reliable web sources me clear nahi mila, isliye main guess nahi karunga.`,
    "",
    "### Next Step",
    "- Official website ya trusted source ka exact link bhejo. Main uske basis par verified answer dunga."
  ];
  const sourceLines = Array.isArray(options.webResult && options.webResult.sources) ? options.webResult.sources.slice(0,4).map((item) => {
    const title = String((item && (item.title || item.url)) || "Source").trim();
    const url = String(item && item.url ? item.url : "").trim();
    return url ? `- [${title}](${url})` : `- ${title}`;
  }) : [];
  if (sourceLines.length > 0) lines.push("", "### Sources Checked", ...sourceLines);
  return lines.join("\n");
}

function buildVerifiedFullFormResponse(options = {}) {
  const safeAcronym = String(options.acronym || "").trim();
  const safeExpansion = String(options.expansion || "").trim();
  const lines = [
    "### Full Form",
    `\`${safeAcronym}\` ka full form **${safeExpansion}** hai.`
  ];
  const sourceLines = Array.isArray(options.webResult && options.webResult.sources) ? options.webResult.sources.slice(0,3).map((item) => {
    const title = String((item && (item.title || item.url)) || "Source").trim();
    const url = String(item && item.url ? item.url : "").trim();
    return url ? `- [${title}](${url})` : `- ${title}`;
  }) : [];
  if (sourceLines.length > 0) lines.push("", "### Sources", ...sourceLines);
  return lines.join("\n");
}

function createResponseService(options = {}) {
  const promptSvc = promptBuilder;

  function buildFinalPrompt(opts) {
    return promptSvc.buildFinalPrompt(opts);
  }

  async function buildFinalPromptWithBudget(opts = {}, budgetTokens = 8000) {
    // opts should include: userPrompt, ragResults (array), memoryMessages (array), toolResult (string), and other promptBuilder options
    const working = Object.assign({}, opts);

    // Sanitize user input and external pieces before composing the prompt
    working.userPrompt = sanitizeUserInput(working.userPrompt);
    if (Array.isArray(working.ragResults)) {
      working.ragResults = working.ragResults.map((r) => sanitizeExternalContent(r, 400));
    }
    if (Array.isArray(working.memoryMessages)) {
      working.memoryMessages = working.memoryMessages.map((m) => {
        if (!m || typeof m !== "object") return m;
        return { ...m, content: sanitizeExternalContent(m.content, 400) };
      });
    }
    if (working.toolResult) {
      working.toolResult = sanitizeExternalContent(working.toolResult, 1200);
    }
    function assemblePrompt(obj) {
      const base = promptSvc.buildFinalPrompt(obj);
      if (obj && obj.toolResult) {
        return `${base}\n\n[TOOL RESULTS]\n${obj.toolResult}\n\nUse this data to answer the user properly.`;
      }
      return base;
    }

    // estimate before trimming
    const originalPrompt = assemblePrompt(Object.assign({}, working));
    const estimatedBefore = estimateTokens(originalPrompt);
    let final = originalPrompt;
    let estimated = estimatedBefore;

    // Trimming order: toolResult (lowest), memoryMessages, ragResults
    while (estimated > budgetTokens) {
      const hadTool = Boolean(working.toolResult);
      if (hadTool) {
        working.toolResult = "";
      } else if (Array.isArray(working.memoryMessages) && working.memoryMessages.length > 0) {
        // remove the oldest memory message
        working.memoryMessages = working.memoryMessages.slice(0, Math.max(0, working.memoryMessages.length - 1));
      } else if (Array.isArray(working.ragResults) && working.ragResults.length > 0) {
        // remove the least relevant RAG (last)
        working.ragResults = working.ragResults.slice(0, Math.max(0, working.ragResults.length - 1));
      } else {
        // nothing left to trim
        break;
      }

      final = assemblePrompt(working);
      estimated = estimateTokens(final);
    }
    // report token usage
    try { require("../utils/metrics").recordTokenUsage(estimatedBefore, Math.max(0, estimatedBefore - estimated), opts.modelName || "unknown"); } catch (_e) {}
    return final;
  }

  return {
    buildFinalPrompt,
    buildFinalPromptWithBudget,
    truncateText,
    buildNotConfirmedFullFormResponse,
    buildVerifiedFullFormResponse
  };
}

module.exports = { createResponseService };
