(function (root) {
  const constants = root.SharedModules.constants;
  const promptBuilder = root.SharedModules.promptBuilder;

  function createScreenshotOCR(options = {}) {
    async function extractOcrText(base64Screenshot) {
      const safeBase64 = String(base64Screenshot || "").trim();
      if (!safeBase64) {
        return "";
      }

      try {
        options.setStatus("Running OCR on screenshot...", { busy: true });
        return (await options.assistantAPI.extractOcrText(safeBase64)) || "";
      } catch (error) {
        console.error("OCR failed:", error);
        return "";
      }
    }

    function hasIssueKeyword(message) {
      const normalized = String(message || "").toLowerCase();
      return constants.ISSUE_KEYWORDS.some((keyword) => normalized.includes(keyword));
    }

    return {
      buildPromptWithOcr: promptBuilder.buildPromptWithOcr,
      extractOcrText,
      hasIssueKeyword
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.screenshotOCR = {
    createScreenshotOCR
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
