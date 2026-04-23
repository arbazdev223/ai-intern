function extractCodeSnippet(text) {
  const source = String(text || "");
  const fenceMatch = source.match(/```([\w+-]*)\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return { language: fenceMatch[1] ? fenceMatch[1].trim() : "", code: fenceMatch[2].trim() };
  }
  const inlineMatch = source.match(/`([^`]{8,})`/);
  if (inlineMatch) return { language: "", code: inlineMatch[1].trim() };
  return null;
}

function extractExcelFormula(text) {
  const source = String(text || "");
  const match = source.match(/=\s*[^=\n\r]{3,}/);
  return match ? match[0].trim() : "";
}

function extractOcrTextFromPrompt(promptText) {
  const source = String(promptText || "");
  const marker = "The following text was detected from the screen using OCR:";
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return "";
  let text = source.slice(markerIndex + marker.length).trim();
  const cutoffMarkers = ["\n\nStudent question:", "\n\nAnalyze the screenshot", "\n\nAnalyze"];
  let cutoffIndex = -1;
  cutoffMarkers.forEach((markerValue) => {
    const idx = text.indexOf(markerValue);
    if (idx !== -1 && (cutoffIndex === -1 || idx < cutoffIndex)) cutoffIndex = idx;
  });
  if (cutoffIndex !== -1) text = text.slice(0, cutoffIndex).trim();
  if (text.toLowerCase().includes("no readable ocr text")) return "";
  return text;
}

function normalizeSearchQuery(query) {
  return String(query || "")
    .replace(/\b(search|research|google|find|look\s*up|web\s*search)\b/gi, " ")
    .replace(/\b(karke|karo|kijiye|krdo|batao|bataye|please|pls)\b/gi, " ")
    .replace(/[?:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createToolService(options = {}) {
  const searchService = options.searchService || null;
  const assignmentsService = options.assignmentsService || null;
  const linkReaderService = options.linkReaderService || null;
  const { sanitizeUserInput } = require("../utils/sanitizer");

  function sanitizeSearchField(value, maxChars) {
    return sanitizeUserInput(String(value || ""), maxChars)
      .replace(/\[BEGIN EXTERNAL CONTENT\]\s*/gi, "")
      .replace(/\s*\[END EXTERNAL CONTENT\]/gi, "")
      .trim();
  }

  async function executeTool(payload, toolName) {
    const userPrompt = String(payload.userPrompt || "");
    const ocrText = String(payload.ocrText || payload.extractedText || "").trim();
    let toolResult = "";
    let webSearchResult = null;
    let assignmentsResult = null;
    let linkReaderResult = null;

    if (toolName === "ocrReader") {
      const extracted = ocrText || extractOcrTextFromPrompt(userPrompt);
      const snippet = extracted ? (extracted.length > 1200 ? `${extracted.slice(0, 1197)}...` : extracted) : "";
      if (!snippet) throw new Error("OCR text unavailable");
      toolResult = `[TOOL:ocrReader]\nExtracted OCR text:\n${snippet}`;
    } else if (toolName === "excelHelper") {
      const formula = extractExcelFormula(userPrompt);
      const helperLines = ["[TOOL:excelHelper]"];
      if (formula) helperLines.push(`Detected formula: ${formula}`);
      helperLines.push("Focus on Excel formula logic and exact fix steps.");
      toolResult = helperLines.join("\n");
    } else if (toolName === "codeFix") {
      const snippet = extractCodeSnippet(userPrompt);
      const helperLines = ["[TOOL:codeFix]"];
      if (snippet && snippet.code) {
        const lang = snippet.language ? ` (${snippet.language})` : "";
        helperLines.push(`Detected code${lang}:\n${snippet.code.length > 1400 ? `${snippet.code.slice(0,1397)}...` : snippet.code}`);
      } else {
        helperLines.push("No code snippet detected. Ask for the exact code/error output.");
      }
      helperLines.push("Provide the fixed code first, then a brief explanation.");
      toolResult = helperLines.join("\n");
    } else if (toolName === "webSearch") {
      if (!searchService || typeof searchService.search !== "function") {
        throw new Error("Web search unavailable");
      }
      const safeQuery = normalizeSearchQuery(sanitizeSearchField(userPrompt, 240)) || sanitizeSearchField(userPrompt, 240);
      const rawWeb = await searchService.search(safeQuery);
      // sanitize fields before using them
      const web = {
        summary: sanitizeSearchField(rawWeb && rawWeb.summary ? rawWeb.summary : "", 800),
        relatedTopics: Array.isArray(rawWeb && rawWeb.relatedTopics)
          ? rawWeb.relatedTopics.slice(0, 5).map((t) => sanitizeSearchField(t, 120))
          : [],
        sources: Array.isArray(rawWeb && rawWeb.sources)
          ? rawWeb.sources.slice(0, 4).map((item) => ({
              title: sanitizeSearchField(item && (item.title || item.url) ? (item.title || item.url) : "", 200),
              url: sanitizeSearchField(item && item.url ? item.url : "", 400),
              snippet: sanitizeSearchField(item && item.snippet ? item.snippet : "", 400)
            }))
          : []
      };

      webSearchResult = web;
      const lines = [web.summary || "No direct summary found."];
      if (web.relatedTopics && web.relatedTopics.length > 0) {
        lines.push("", "Related topics:");
        web.relatedTopics.forEach((t) => lines.push(`- ${t}`));
      }
      const sources = (web.sources || []).map((item) => (item.url ? `- [${item.title}](${item.url})` : `- ${item.title}`));
      if (sources.length) lines.push("", "Sources:", ...sources);
      toolResult = `[TOOL:webSearch]\n${lines.join("\n")}`;
    } else if (toolName === "assignmentsSearch") {
      if (!assignmentsService || typeof assignmentsService.searchAssignments !== "function") {
        throw new Error("Assignments search unavailable");
      }

      const safeQuery = sanitizeSearchField(userPrompt, 240);
      const result = await assignmentsService.searchAssignments(safeQuery, { limit: 3, includeDocumentText: true });
      const matches = Array.isArray(result && result.matches) ? result.matches : [];
      assignmentsResult = {
        total: Number.isFinite(Number(result && result.total)) ? Number(result.total) : matches.length,
        matches: matches.map((item) => ({
          id: String(item && item._id ? item._id : ""),
          topicName: sanitizeSearchField(item && item.topicName ? item.topicName : "", 140),
          documentType: sanitizeSearchField(item && item.documentType ? item.documentType : "", 40),
          documentText: sanitizeSearchField(item && item.documentText ? item.documentText : "", 8000),
          course: Array.isArray(item && item.course)
            ? item.course.slice(0, 2).map((c) => ({
                title: sanitizeSearchField(c && c.title ? c.title : "", 140),
                code: sanitizeSearchField(c && c.code ? c.code : "", 80)
              }))
            : []
        }))
      };

      const lines = ["Relevant assignments found:", ""];
      if (!assignmentsResult.matches.length) {
        lines.push("No matching assignments found. Try including the course code/title or the assignment topic.");
      } else {
        assignmentsResult.matches.forEach((item, idx) => {
          const courseLabel =
            Array.isArray(item.course) && item.course.length
              ? ` (${item.course.map((c) => c.code || c.title).filter(Boolean).join(", ")})`
              : "";
          lines.push(`${idx + 1}. ${item.topicName || "Untitled"}${courseLabel}`);
          if (item.documentText) {
            lines.push(`   - Content: ${item.documentText.slice(0, 280)}${item.documentText.length > 280 ? "..." : ""}`);
          } else {
            lines.push("   - Content: (No document text extracted)");
          }
        });
      }

      toolResult = `[TOOL:assignmentsSearch]\n${lines.join("\n")}`;
    } else if (toolName === "linkReader") {
      if (!linkReaderService || typeof linkReaderService.fetchUrlText !== "function") {
        throw new Error("Link reader unavailable");
      }

      const overrideUrl = String(payload.urlContext || payload.urlOverride || "").trim();
      const url =
        overrideUrl ||
        (linkReaderService.extractFirstUrl ? linkReaderService.extractFirstUrl(userPrompt) : "");
      if (!url) {
        throw new Error("No URL detected");
      }

      const raw = await linkReaderService.fetchUrlText(url);
      const pageText = sanitizeSearchField(raw && raw.text ? raw.text : "", 8000);
      linkReaderResult = {
        url: sanitizeSearchField(raw && raw.url ? raw.url : url, 500),
        title: sanitizeSearchField(raw && raw.title ? raw.title : "", 240),
        contentType: sanitizeSearchField(raw && raw.contentType ? raw.contentType : "", 120),
        truncated: Boolean(raw && raw.truncated),
        text: pageText
      };

      const preview = pageText ? (pageText.length > 900 ? `${pageText.slice(0, 897)}...` : pageText) : "";
      toolResult = `[TOOL:linkReader]\nFetched: ${linkReaderResult.title || linkReaderResult.url}\nURL: ${linkReaderResult.url}\n\nContent preview:\n${preview || "(No readable text extracted)"}\n`;
    }

    return { toolResult, webSearchResult, assignmentsResult, linkReaderResult };
  }

  return { executeTool };
}

module.exports = { createToolService };
