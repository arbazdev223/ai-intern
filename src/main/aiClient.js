const constants = require("../shared/constants");
const promptBuilder = require("../shared/promptBuilder");
const { generateEmbedding } = require("./rag/embeddingService");
const { createVectorStore } = require("./rag/vectorStore");
const { createModelService } = require("./services/modelService");
const { createIntentService } = require("./services/intentService");
const { selectPrompt } = require("./services/promptSelector");
const { createToolService } = require("./services/toolService");
const { createRagService } = require("./services/ragService");
const { createResponseService } = require("./services/responseService");
const { createControlService } = require("./services/controlService");
const { createFileService } = require("./services/fileService");
const { createImageService } = require("./services/imageService");
const LRUCache = require("./utils/lruCache");
const { estimateTokens } = require("./utils/tokenUtils");

function createAiClient(options = {}) {
  const acronymStopWords = new Set(constants.ACRONYM_STOP_WORDS || []);
  const vectorStore = createVectorStore();
  const supportedOutputTypes = new Set(["pdf", "excel", "html", "doc", "docx", "image", "json"]);
  const CREATIVE_SYSTEM_PROMPT = `
You are a creative assistant.

Your job:
- If the user asks for a prompt (image prompt, creative prompt), return an improved, polished prompt only.
- If the user asks for a creative output (story, poem, scene, dialogue, tagline, ad copy), return the output directly.

Rules:
- Do not explain.
- Do not add headings unless the user asked.
- Match the user's language and tone.
- Keep the output clean and ready to use.
`.trim();
  const CODE_SYSTEM_PROMPT = `
You are a coding assistant.

Your job:
- Return only the requested code.
- Do not add explanations unless the user explicitly asked for them.
- Use a single Markdown code block with the correct language tag when possible.
- Keep formatting clean and minimal.
`.trim();
  let didWarnLegacyKey = false;
  let didWarnInvalidKey = false;

  function isLikelyOpenAIKey(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      return false;
    }

    return trimmed.startsWith("sk-") && trimmed.length >= 16;
  }

  function getOpenAIKey() {
    const primaryKey = String(process.env.OPENAI_API_KEY || "").trim();
    const legacyKey = String(process.env.GPT_key || "").trim();
    const envKey = primaryKey || legacyKey;

    if (!envKey) {
      return "";
    }

    // Reject suspicious values to avoid leaking invalid keys into requests.
    if (!isLikelyOpenAIKey(envKey)) {
      if (!didWarnInvalidKey) {
        console.warn("OpenAI API key format looks invalid; ignoring it.");
        didWarnInvalidKey = true;
      }
      return "";
    }

    // Keep legacy compatibility but warn once.
    if (!primaryKey && legacyKey && !didWarnLegacyKey) {
      console.warn("GPT_key is deprecated. Please migrate to OPENAI_API_KEY.");
      didWarnLegacyKey = true;
    }

    return envKey;
  }

  function getOpenAIModel() {
    return modelService.getOpenAIModel();
  }

  function getOpenAIVisionModel() {
    return modelService.getOpenAIModel();
  }

  function getGeminiKey() {
    return String(process.env.GEMINI_API_KEY || "").trim();
  }

  function getGeminiModel() {
    return modelService.getGeminiModel();
  }

  function getGeminiVisionModel() {
    return modelService.getGeminiModel();
  }

  let openAIClient = null;
  let geminiClient = null;

  // Initialize service adapters
  const modelService = createModelService();
  const intentService = createIntentService(modelService);
  const toolService = createToolService({ searchService: options.searchService });
  const ragService = createRagService();
  const responseService = createResponseService();
  const fileService = createFileService();

  // Response cache (prompt -> response)
  const RESPONSE_CACHE_MAX_ENTRIES = Number.isFinite(Number(process.env.RESPONSE_CACHE_MAX_ENTRIES))
    ? Number(process.env.RESPONSE_CACHE_MAX_ENTRIES)
    : 300;
  const RESPONSE_CACHE = new LRUCache(RESPONSE_CACHE_MAX_ENTRIES);
  const RESPONSE_CACHE_TTL_MS = Number.isFinite(Number(process.env.RESPONSE_CACHE_TTL_MS))
    ? Number(process.env.RESPONSE_CACHE_TTL_MS)
    : 1000 * 60 * 20; // 20 minutes

  const metrics = require("./utils/metrics");
  const controlService = createControlService({ modelService, metrics, responseCache: RESPONSE_CACHE, responseCacheTTL: RESPONSE_CACHE_TTL_MS });
  const imageService = createImageService({ metrics });
  const screenshotService = options.screenshotService;

  async function persistGeneratedImageUrl(url) {
    const rawUrl = String(url || "").trim();
    if (!rawUrl) {
      return "";
    }

    const dataUrlMatch = rawUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i);
    if (!dataUrlMatch) {
      return rawUrl;
    }

    if (!screenshotService || typeof screenshotService.saveScreenshot !== "function") {
      return rawUrl;
    }

    try {
      const stored = await screenshotService.saveScreenshot(dataUrlMatch[1], {
        prefix: "generated"
      });
      const imagePath = String((stored && stored.imagePath) || "").trim();
      return imagePath || rawUrl;
    } catch (error) {
      console.warn(
        "[ai] failed to persist generated image",
        error && error.message ? error.message : error
      );
      return rawUrl;
    }
  }

  function getOpenAIClient() {
    return modelService.getOpenAIClient();
  }

  function getGeminiClient() {
    return modelService.getGeminiClient();
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractRequestedAcronym(userPrompt) {
    const original = String(userPrompt || "").trim();
    if (!original) {
      return null;
    }

    const uppercaseMatch = original.match(/\b([A-Z]{2,10})\b/);
    if (uppercaseMatch) {
      return uppercaseMatch[1];
    }

    const lower = original.toLowerCase();
    const fullFormIndex = lower.search(/\bfull\s*form\b/);
    const prefixText = fullFormIndex >= 0 ? original.slice(0, fullFormIndex) : original;
    const words = prefixText.match(/\b[a-zA-Z]{2,12}\b/g) || [];

    for (let index = words.length - 1; index >= 0; index -= 1) {
      const word = words[index];
      const normalized = word.toLowerCase();
      if (acronymStopWords.has(normalized)) {
        continue;
      }
      if (normalized.length >= 2 && normalized.length <= 8) {
        return normalized.toUpperCase();
      }
    }

    return null;
  }

  function formatWebSources(webResult, limit = 3, optionsArg = {}) {
    function cleanExternalText(value) {
      return String(value || "")
        .replace(/\[BEGIN EXTERNAL CONTENT\]\s*/gi, "")
        .replace(/\s*\[END EXTERNAL CONTENT\]/gi, "")
        .trim();
    }

    function prettifySourceTitle(value, maxChars = 90) {
      const cleaned = cleanExternalText(value)
        .replace(/<[^>]+>/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!cleaned) {
        return "Source";
      }

      const parts = cleaned.split(/\s+[\-|:]\s+/).map((item) => item.trim()).filter(Boolean);
      const primary = parts[0] || cleaned;
      return primary.length > maxChars ? `${primary.slice(0, maxChars - 3)}...` : primary;
    }

    const requireHttpUrl = Boolean(optionsArg && optionsArg.requireHttpUrl);

    const sources = Array.isArray(webResult && webResult.sources)
      ? webResult.sources.slice(0, limit)
      : [];
    if (sources.length === 0) {
      return [];
    }

    return sources
      .filter((item) => {
        if (!requireHttpUrl) {
          return true;
        }

        const url = cleanExternalText(item && item.url ? item.url : "");
        if (!url || !/^https?:\/\//i.test(url)) {
          return false;
        }
        return true;
      })
      .map((item) => {
      const title = prettifySourceTitle((item && (item.title || item.url)) || "Source");
      const url = cleanExternalText(item && item.url ? item.url : "");
      return url ? `- [${title}](${url})` : `- ${title}`;
      });
  }

  function buildWebEvidenceText(webResult) {
    const summary = String(webResult && webResult.summary ? webResult.summary : "").trim();
    const sourceSnippets = Array.isArray(webResult && webResult.sources)
      ? webResult.sources
          .map((item) => `${item && item.title ? item.title : ""} ${item && item.snippet ? item.snippet : ""}`.trim())
          .filter(Boolean)
      : [];

    return [summary, ...sourceSnippets].filter(Boolean).join("\n");
  }

  function extractVerifiedAcronymExpansion(acronym, webResult) {
    const safeAcronym = String(acronym || "").trim();
    if (!safeAcronym) {
      return null;
    }

    const evidence = buildWebEvidenceText(webResult);
    if (!evidence) {
      return null;
    }

    const escapedAcronym = escapeRegExp(safeAcronym);
    const patterns = [
      new RegExp(
        `\\b${escapedAcronym}\\b\\s*(?:stands\\s+for|full\\s+form(?:\\s+is)?|means|=|:)\\s*([A-Za-z][A-Za-z&()'\\- ]{4,120})`,
        "i"
      ),
      new RegExp(`([A-Z][A-Za-z&()'\\- ]{4,120})\\s*\\(\\s*${escapedAcronym}\\s*\\)`, "i")
    ];

    for (const pattern of patterns) {
      const match = evidence.match(pattern);
      if (!match || !match[1]) {
        continue;
      }

      const candidate = match[1].split(/[.;\n]/)[0].replace(/\s+/g, " ").trim();
      if (!candidate) {
        continue;
      }

      const badSignal =
        /\b(offers|provides|awarded|certified|affiliated|courses|students|training|programs|collaboration)\b/i;
      if (badSignal.test(candidate)) {
        continue;
      }

      const wordCount = candidate.split(/\s+/).length;
      if (wordCount < 2 || wordCount > 12) {
        continue;
      }

      return candidate;
    }

    return null;
  }

  function buildNotConfirmedFullFormResponse(options = {}) {
    const safeAcronym = String(options.acronym || "this term").trim();
    const lines = [
      `Mujhe ${safeAcronym} ka verified full form reliable web sources me clear nahi mila, isliye main guess nahi karunga.`,
      "Agar aap official website ya trusted source ka exact link bhej do, to main us basis par confirm karke bata dunga."
    ];

    const sourceLines = formatWebSources(options.webResult, 4);
    if (sourceLines.length > 0) {
      lines.push("", "Checked sources:", ...sourceLines);
    }

    return lines.join("\n");
  }

  function buildVerifiedFullFormResponse(options = {}) {
    const safeAcronym = String(options.acronym || "").trim();
    const safeExpansion = String(options.expansion || "").trim();
    const lines = [`${safeAcronym} ka full form ${safeExpansion} hai.`];

    const sourceLines = formatWebSources(options.webResult, 3);
    if (sourceLines.length > 0) {
      lines.push("", "Sources:", ...sourceLines);
    }

    return lines.join("\n");
  }

  function buildWebSearchDirectResponse(webResult, userPrompt) {
    function cleanExternalText(value) {
      return String(value || "")
        .replace(/\[BEGIN EXTERNAL CONTENT\]\s*/gi, "")
        .replace(/\s*\[END EXTERNAL CONTENT\]/gi, "")
        .trim();
    }

    const summary = cleanExternalText(webResult && webResult.summary ? webResult.summary : "");
    const relatedTopics = Array.isArray(webResult && webResult.relatedTopics)
      ? webResult.relatedTopics
          .map((item) => cleanExternalText(item))
          .filter(Boolean)
          .slice(0, 6)
      : [];

    const lines = [];
    if (summary) {
      lines.push(`Based on general understanding, ${summary}`);
    } else {
      const promptPreview = String(userPrompt || "").trim();
      lines.push(
        promptPreview
          ? `Maine web search kiya, lekin concise summary clear nahi mili for: ${promptPreview}`
          : "Maine web search kiya, lekin concise summary clear nahi mili."
      );
    }

    if (relatedTopics.length > 0) {
      lines.push("", `Simple examples: ${relatedTopics.slice(0, 3).join(", ")}`);
      lines.push(
        "In short, agar aap chaho to main in points me se kisi ek topic ko step-by-step deeply explain kar sakta hoon."
      );
    } else {
      lines.push(
        "Agar aap deep explanation chahte ho, to topic thoda specific likho (example: Iran-US conflict timeline, causes, impact)."
      );
    }

    return lines.join("\n");
  }

  function wantsDeepWebExplanation(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const deepPatterns = [
      /\bdeep\b/,
      /\bdeeply\b/,
      /\bdetailed\b/,
      /\bin\s+detail\b/,
      /\bdetail\s+me\b/,
      /\bdeep\s+me\b/,
      /\bexplain\b/,
      /\bexample\b/,
      /\banalysis\b/,
      /\btimeline\b/
    ];

    return deepPatterns.some((pattern) => pattern.test(text)) || text.length > 80;
  }

  function buildWebSearchFactsBlock(webResult) {
    const summary = String(webResult && webResult.summary ? webResult.summary : "").trim();
    const relatedTopics = Array.isArray(webResult && webResult.relatedTopics)
      ? webResult.relatedTopics
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];
    const sources = Array.isArray(webResult && webResult.sources)
      ? webResult.sources.slice(0, 5)
      : [];

    const lines = [];
    if (summary) {
      lines.push("Summary:", summary);
    }
    if (relatedTopics.length > 0) {
      lines.push("", "Related Topics:");
      relatedTopics.forEach((topic) => lines.push(`- ${topic}`));
    }
    if (sources.length > 0) {
      lines.push("", "Source Snippets:");
      sources.forEach((item, index) => {
        const title = String(item && item.title ? item.title : `Source ${index + 1}`).trim();
        const snippet = String(item && item.snippet ? item.snippet : "").trim();
        const url = String(item && item.url ? item.url : "").trim();
        lines.push(`- ${title}${snippet ? ` | ${snippet}` : ""}${url ? ` | ${url}` : ""}`);
      });
    }

    return lines.join("\n").trim();
  }

  function isCurrentEventsPrompt(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const patterns = [
      /\b(world|global|international|geopolitics?)\b/,
      /\b(latest|today|current|breaking|headline|news|updates?)\b/,
      /\b(abhi|aaj|duniya|kya\s+chal\s+raha)\b/
    ];

    return patterns.some((pattern) => pattern.test(text));
  }

  function buildCurrentEventsHeadlinesResponse(userPrompt, webResult) {
    function cleanHeadlineText(value) {
      return String(value || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function normalizeHeadline(value) {
      const cleaned = cleanHeadlineText(value);
      if (!cleaned) {
        return "";
      }

      const parts = cleaned.split(/\s+[\-|:]\s+/).map((item) => item.trim()).filter(Boolean);
      const primary = parts[0] || cleaned;
      return primary.length > 130 ? `${primary.slice(0, 127)}...` : primary;
    }

    function scoreHeadline(value, query) {
      const text = String(value || "").toLowerCase();
      if (!text) {
        return -10;
      }

      const queryTokens = String(query || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2)
        .slice(0, 16);

      let score = 0;
      queryTokens.forEach((token) => {
        if (text.includes(token)) {
          score += 2;
        }
      });

      // Generic noise guard to reduce obvious non-news pages without relying on domain allowlists.
      const noisySignals = ["biography", "lyrics", "song", "class", "prelims", "exam", "program"];
      noisySignals.forEach((token) => {
        if (text.includes(token)) {
          score -= 2;
        }
      });

      return score;
    }

    const safePrompt = String(userPrompt || "").trim();
    const rawSources = Array.isArray(webResult && webResult.sources) ? webResult.sources.slice(0, 12) : [];
    const rankedSources = rawSources
      .map((item) => {
        const title = normalizeHeadline(item && item.title ? item.title : "");
        const snippet = cleanHeadlineText(item && item.snippet ? item.snippet : "");
        const sourceName = String(item && item.source ? item.source : "").trim();
        return {
          ...item,
          title,
          snippet,
          sourceName,
          score: scoreHeadline(`${title} ${snippet}`, userPrompt)
        };
      })
      .filter((item) => Boolean(item.title))
      .sort((left, right) => right.score - left.score);

    const dedupedSources = [];
    const seenTitles = new Set();
    rankedSources.forEach((item) => {
      const key = String(item.title || "").toLowerCase();
      if (!key || seenTitles.has(key)) {
        return;
      }
      seenTitles.add(key);
      dedupedSources.push(item);
    });

    const sources = dedupedSources.filter((item) => item.score >= 1).slice(0, 5);

    if (sources.length === 0) {
      return safePrompt
        ? `Abhi reliable live headlines clear nahi mili for: ${safePrompt}. Thoda specific pucho (country/topic/time window), phir main exact update dunga.`
        : "Abhi reliable live headlines clear nahi mili. Thoda specific pucho (country/topic/time window), phir main exact update dunga.";
    }

    const lines = ["Based on recent reports, ye situation abhi is direction me dikh rahi hai:"];
    sources.forEach((item) => {
      const title = normalizeHeadline(item && item.title ? item.title : "");
      const sourceName = String(item && item.sourceName ? item.sourceName : item && item.source ? item.source : "").trim();
      const snippet = cleanHeadlineText(item && item.snippet ? item.snippet : "");
      if (!title) {
        return;
      }
      const compactSnippet = snippet.length > 92 ? `${snippet.slice(0, 89)}...` : snippet;
      const detail = compactSnippet ? ` ${compactSnippet}` : "";
      lines.push(`${title}${sourceName ? ` (${sourceName})` : ""}.${detail}`);
    });

    lines.push(
      "",
      "As of latest available information, situation quickly change ho sakti hai, so reliable updates follow karte rehna important hai."
    );

    return lines.join("\n");
  }

  function buildCurrentEventsStructuredResponse(userPrompt, webResult, optionsArg = {}) {
    function cleanText(value) {
      return String(value || "")
        .replace(/\[BEGIN EXTERNAL CONTENT\]\s*/gi, "")
        .replace(/\s*\[END EXTERNAL CONTENT\]/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function scoreSource(itemText, queryText) {
      const text = String(itemText || "").toLowerCase();
      if (!text) {
        return -10;
      }

      const queryTokens = String(queryText || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2)
        .slice(0, 16);

      let score = 0;
      queryTokens.forEach((token) => {
        if (text.includes(token)) {
          score += 2;
        }
      });

      const noisySignals = ["biography", "lyrics", "song", "class", "prelims", "exam", "program", "devotional"];
      noisySignals.forEach((token) => {
        if (text.includes(token)) {
          score -= 2;
        }
      });

      return score;
    }

    const summary = cleanText(webResult && webResult.summary ? webResult.summary : "");
    const sources = Array.isArray(webResult && webResult.sources)
      ? webResult.sources
          .map((item) => ({
            title: cleanText(item && item.title ? item.title : ""),
            snippet: cleanText(item && item.snippet ? item.snippet : ""),
            source: cleanText(item && item.source ? item.source : "")
          }))
          .map((item) => ({
            ...item,
            score: scoreSource(`${item.title} ${item.snippet}`, userPrompt)
          }))
          .filter((item) => item.title)
          .sort((left, right) => right.score - left.score)
          .slice(0, 4)
      : [];

    const reliableSources = sources.filter((item) => item.score >= 1);

    if (reliableSources.length === 0) {
      const promptPreview = String(userPrompt || "").trim();
      return promptPreview
        ? `Abhi reliable live headlines clear nahi mili for: ${promptPreview}. Thoda specific pucho (country/topic/time window), phir main exact update dunga.`
        : "Abhi reliable live headlines clear nahi mili. Thoda specific pucho (country/topic/time window), phir main exact update dunga.";
    }

    const useHeadings = Boolean(optionsArg.useHeadings);

    const contextLine = summary
      ? summary
      : "Latest snippets show ongoing geopolitical tension, policy signaling, and regional risk discussion.";

    const exampleLines = reliableSources.map((item) => {
      const detail = item.snippet ? ` - ${item.snippet}` : "";
      const sourceTag = item.source ? ` (${item.source})` : "";
      return `- ${item.title}${sourceTag}${detail}`;
    });

    if (!useHeadings) {
      return [
        `Based on recent reports, ${contextLine}`,
        "",
        ...exampleLines,
        "",
        "As of latest available information, situation quickly change ho sakti hai, so reliable updates follow karte rehna important hai."
      ].join("\n");
    }

    const lines = [
      "### Quick Summary",
      `Based on recent reports, ${contextLine}`,
      "",
      "### Context",
      "Iran-U.S. tensions are usually discussed through security, sanctions, regional alliances, and nuclear-policy concerns. Exact battlefield claims can change quickly and should be cross-verified.",
      "",
      "### Verified Examples From Current Search",
      ...exampleLines,
      "",
      "### Practical Takeaway",
      "Situation is fluid. For reliable understanding, track multiple trusted outlets and focus on confirmed updates rather than single-source claims."
    ];

    return lines.join("\n");
  }

  function getCautiousPrefixForPrompt(userPrompt) {
    const text = String(userPrompt || "");
    if (/[\u0900-\u097F]/.test(text)) {
      return "Main galat ho sakta hoon, lekin available reports ke base par, ";
    }
    if (/\b(kya|kaise|hai|me|mujhe|bata|samjha)\b/i.test(text)) {
      return "Main galat ho sakta hoon, lekin available reports ke base par, ";
    }
    return "I may be wrong, but based on available reports, ";
  }

  function enforceCautiousCurrentEventsAnswer(text, userPrompt) {
    const safe = String(text || "").trim();
    if (!safe) {
      return safe;
    }
    if (!isCurrentEventsPrompt(userPrompt)) {
      return safe;
    }

    let normalized = safe;

    // Replace a known high-risk hard-claim pattern with cautious wording.
    normalized = normalized.replace(
      /the\s+u\.?s\.?\s+attacked\s+three[^.]*?(fordow|isfahan|natanz)[^.]*\./i,
      "Some reports in the available snippets mention alleged strikes related to Iranian nuclear facilities (including Fordow, Isfahan, and Natanz), but exact operational details should be cross-verified from multiple trusted outlets."
    );

    const hasCautiousPhrase =
      /i may be wrong|based on available reports|based on recent reports|according to reports|as of latest available information|main galat ho sakta hoon|reports ke base par/i.test(
        normalized
      );

    const hasHighConfidenceConflictClaim =
      /\b(u\.?s\.?|united states|iran|israel)\b/i.test(normalized) &&
      /\b(attacked|bombed|destroyed|killed|directly attacked|confirmed strike|will last|definitely)\b/i.test(
        normalized
      );

    if (hasHighConfidenceConflictClaim && !hasCautiousPhrase) {
      normalized = `${getCautiousPrefixForPrompt(userPrompt)}${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
    }

    return normalized;
  }

  async function synthesizeWebSearchResponse(optionsArg = {}) {
    const userPrompt = String(optionsArg.userPrompt || "").trim();
    const webResult = optionsArg.webResult || {};
    const openAIEnabled = Boolean(optionsArg.openAIEnabled);
    const geminiEnabled = Boolean(optionsArg.geminiEnabled);

    const factsBlock = buildWebSearchFactsBlock(webResult);
    if (!factsBlock) {
      return buildWebSearchDirectResponse(webResult, userPrompt);
    }

    const deepMode = wantsDeepWebExplanation(userPrompt);

    const synthesisPrompt = [
      "You are a smart teacher assistant explaining search findings to a student.",
      "Use only the provided facts/snippets. Do not invent events.",
      "Write in the same language as the user input. Do not mix languages.",
      "If snippets are generic (homepage/about text), say clearly that exact breaking details are limited.",
      "Do not invent specific dates, attacks, statements, or locations unless explicitly present in the provided facts.",
      deepMode
        ? "User asked for depth: give a detailed but simple explanation in 4 parts: simple answer, known context, 2-3 concrete examples from provided facts, and practical takeaway."
        : "Keep it concise, natural, conversational, and easy to read.",
      deepMode
        ? "Use short paragraphs or bullets for clarity, but avoid markdown headings."
        : "Start with simple answer, then one short example, then optional extra detail.",
      "Light emoji use is allowed for readability.",
      "Do not use markdown headings or report format.",
      "Avoid report style formatting.",
      "If query is about real-world events, use safe phrasing like 'Based on recent reports' or 'As of latest available information'.",
      "",
      `User question: ${userPrompt || "(empty)"}`,
      "",
      "Search findings:",
      factsBlock
    ].join("\n");

    try {
      if (openAIEnabled) {
        const model = modelService.getOpenAIModel();
        const text = await modelService.callOpenAIChat({
          model,
          messages: [
            {
              role: "system",
              content: "You summarize search findings accurately and conservatively."
            },
            { role: "user", content: synthesisPrompt }
          ],
          temperature: 0.2
        });
        const safeText = String(text || "").trim();
        if (safeText) {
          return enforceCautiousCurrentEventsAnswer(safeText, userPrompt);
        }
      }

      if (geminiEnabled) {
        const text = await modelService.callGeminiText(synthesisPrompt);
        const safeText = String(text || "").trim();
        if (safeText) {
          return enforceCautiousCurrentEventsAnswer(safeText, userPrompt);
        }
      }
    } catch (_error) {}

    return buildWebSearchDirectResponse(webResult, userPrompt);
  }

  async function refineCurrentEventsResponse(optionsArg = {}) {
    const userPrompt = String(optionsArg.userPrompt || "").trim();
    const webResult = optionsArg.webResult || {};
    const draftResponse = String(optionsArg.draftResponse || "").trim();
    const openAIEnabled = Boolean(optionsArg.openAIEnabled);
    const geminiEnabled = Boolean(optionsArg.geminiEnabled);

    if (!draftResponse || /reliable live headlines clear nahi mili/i.test(draftResponse)) {
      return draftResponse;
    }

    const factsBlock = buildWebSearchFactsBlock(webResult);
    if (!factsBlock) {
      return draftResponse;
    }

    const refinementPrompt = [
      "You improve a current-events answer for a student.",
      "Use only provided facts. Do not add any new event or claim.",
      "Keep the same meaning as draft, just improve clarity and relevance.",
      "Reject sports/entertainment/devotional framing unless facts are explicitly about policy/economy/conflict/government news.",
      "Write in the same language as user input.",
      "Keep it concise, conversational, and direct.",
      "Start with simple answer, then one example, then optional extra detail.",
      "Do not use markdown headings unless user explicitly asks.",
      "Use safe phrasing for uncertain latest updates.",
      "",
      `User question: ${userPrompt || "(empty)"}`,
      "",
      "Draft answer:",
      draftResponse,
      "",
      "Search findings:",
      factsBlock
    ].join("\n");

    try {
      if (openAIEnabled) {
        const model = modelService.getOpenAIModel();
        const text = await modelService.callOpenAIChat({
          model,
          messages: [
            {
              role: "system",
              content: "You polish factual news summaries without hallucinating."
            },
            { role: "user", content: refinementPrompt }
          ],
          temperature: 0.1
        });
        const safeText = String(text || "").trim();
        if (safeText) {
          return enforceCautiousCurrentEventsAnswer(safeText, userPrompt);
        }
      }

      if (geminiEnabled) {
        const text = await modelService.callGeminiText(refinementPrompt);
        const safeText = String(text || "").trim();
        if (safeText) {
          return enforceCautiousCurrentEventsAnswer(safeText, userPrompt);
        }
      }
    } catch (_error) {}

    return draftResponse;
  }

  function buildMemoryChunk(userPrompt, assistantText) {
    const safeUser = String(userPrompt || "").replace(/\s+/g, " ").trim();
    const safeAssistant = String(assistantText || "").replace(/\s+/g, " ").trim();
    if (!safeUser || !safeAssistant) {
      return "";
    }

    const combined = `User: ${safeUser}\nAssistant: ${safeAssistant}`;
    const maxChars = 2000;
    return combined.length > maxChars ? `${combined.slice(0, maxChars - 3)}...` : combined;
  }

  function buildLightweightPrompt(optionsArg = {}) {
    const safeUser = String(optionsArg.userPrompt || "").trim();
    const summary = String(optionsArg.memorySummary || "").trim();
    const contextMessages = Array.isArray(optionsArg.contextMessages) ? optionsArg.contextMessages : [];
    const sanitized = promptBuilder.sanitizeContextMessages(contextMessages, 6, 400);

    const lines = [];
    if (summary) {
      lines.push("Conversation summary:", summary);
    }
    if (sanitized.length > 0) {
      lines.push("Recent conversation:");
      sanitized.forEach((msg) => {
        const role = msg.role === "assistant" ? "Assistant" : "User";
        lines.push(`- ${role}: ${msg.content}`);
      });
    }
    lines.push("User request:", safeUser || "(empty)");
    return lines.join("\n");
  }

  function truncateText(value, maxChars = 1800) {
    const safe = String(value || "").trim();
    if (!safe) {
      return "";
    }
    return safe.length > maxChars ? `${safe.slice(0, maxChars - 3)}...` : safe;
  }

  function extractCodeSnippet(text) {
    const source = String(text || "");
    const fenceMatch = source.match(/```([\w+-]*)\s*([\s\S]*?)```/);
    if (fenceMatch) {
      return {
        language: fenceMatch[1] ? fenceMatch[1].trim() : "",
        code: fenceMatch[2].trim()
      };
    }

    const inlineMatch = source.match(/`([^`]{8,})`/);
    if (inlineMatch) {
      return { language: "", code: inlineMatch[1].trim() };
    }

    return null;
  }

  function extractExcelFormula(text) {
    const source = String(text || "");
    const match = source.match(/=\s*[^=\n\r]{3,}/);
    return match ? match[0].trim() : "";
  }

  function sanitizeOutputType(value) {
    const cleaned = String(value || "").trim().toLowerCase();
    if (cleaned === "doc") {
      return "docx";
    }
    return supportedOutputTypes.has(cleaned) ? cleaned : "";
  }

  function sanitizeOutputTypes(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    const cleaned = values
      .map((value) => sanitizeOutputType(value))
      .filter(Boolean);
    return [...new Set(cleaned)];
  }

  function isLikelyHtmlSnippet(snippet) {
    if (!snippet || !snippet.code) {
      return false;
    }
    const language = String(snippet.language || "").toLowerCase();
    if (language.includes("html") || language.includes("xml")) {
      return true;
    }
    return /<!doctype|<html|<body|<div|<section|<table/i.test(snippet.code);
  }

  function isLikelyExcelSnippet(snippet) {
    if (!snippet || !snippet.code) {
      return false;
    }
    const language = String(snippet.language || "").toLowerCase();
    if (/(csv|tsv|json|excel|xlsx)/.test(language)) {
      return true;
    }
    return snippet.code.includes(",") || snippet.code.includes("\t");
  }

  function detectExplicitFileRequest(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const phrases = [
      "file bana do",
      "file de do",
      "download file",
      "download do",
      "pdf bana do",
      "pdf bana",
      "html file de do",
      "html bana do",
      "index.html bana do",
      "index html bana do",
      "excel bana do",
      "excel sheet bana",
      "doc bana",
      "docx bana",
      "json file bana",
      "save as file",
      "generate file"
    ];

    return phrases.some((phrase) => text.includes(phrase));
  }

  function detectFileRequestQuestion(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const phrases = [
      "bana sakte ho",
      "file bana doge",
      "de sakte ho",
      "bana doge",
      "file bana sakte ho",
      "file de sakte ho",
      "download de sakte ho",
      "download karwa sakte ho"
    ];

    return phrases.some((phrase) => text.includes(phrase));
  }

  function isLikelyImageGenerationRequest(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const positivePatterns = [
      /\bimage\b/,
      /\bimages\b/,
      /\bphoto\b/,
      /\bpicture\b/,
      /\bpic\b/,
      /\billustration\b/,
      /\bwallpaper\b/,
      /\bposter\b/,
      /\blogo\b/,
      /\bsketch\b/,
      /\bdraw\b/,
      /\brender\b/,
      /\bgenerate\s+(an\s+)?image\b/,
      /\bcreate\s+(an\s+)?image\b/,
      /\bmake\s+(an\s+)?image\b/,
      /\bimage\s+bana(o|do|na)\b/,
      /\bphoto\s+bana(o|do|na)\b/,
      /\bpic\s+bana(o|do|na)\b/
    ];

    return positivePatterns.some((pattern) => pattern.test(text));
  }

  function generateCasualReply(_input, language = "english") {
    const normalizedLanguage = String(language || "english").toLowerCase();

    if (normalizedLanguage === "hindi") {
      return "जी, बताइए मैं कैसे मदद कर सकता हूँ?";
    }

    if (normalizedLanguage === "hinglish") {
      return "Haan bolo 🙂 kya help chahiye?";
    }

    return "Hi! How can I help you?";
  }

  function selectFileContent(outputType, responseText, userPrompt) {
    const response = String(responseText || "").trim();
    const fallback = response || String(userPrompt || "").trim();
    if (!outputType) {
      return fallback;
    }

    const snippet = extractCodeSnippet(response);

    if (outputType === "html") {
      if (isLikelyHtmlSnippet(snippet)) {
        return snippet.code;
      }
      if (/<!doctype|<html|<body|<div|<section|<table/i.test(response)) {
        return response;
      }
    }

    if (outputType === "excel") {
      if (isLikelyExcelSnippet(snippet)) {
        return snippet.code;
      }
    }

    if (outputType === "image") {
      return truncateText(fallback, 1200);
    }

    return fallback;
  }

  function extractJsonFromText(text) {
    const source = String(text || "").trim();
    if (!source) {
      return null;
    }

    const candidates = [];
    candidates.push(source);

    const snippet = extractCodeSnippet(source);
    if (snippet && snippet.code) {
      candidates.push(String(snippet.code).trim());
    }

    const firstBrace = source.indexOf("{");
    const lastBrace = source.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidates.push(source.slice(firstBrace, lastBrace + 1).trim());
    }

    const firstBracket = source.indexOf("[");
    const lastBracket = source.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      candidates.push(source.slice(firstBracket, lastBracket + 1).trim());
    }

    for (const candidate of candidates) {
      try {
        if (!candidate) {
          continue;
        }
        return JSON.parse(candidate);
      } catch (_error) {
        // try next
      }
    }

    return null;
  }

  function buildDocStructureFromText(text) {
    const safe = String(text || "").trim();
    const rawParagraphs = safe ? safe.split(/\n{2,}/) : [];
    const paragraphs = rawParagraphs
      .map((chunk) => chunk.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    return {
      title: "AI Output",
      sections: [
        {
          heading: "",
          paragraphs: paragraphs.length > 0 ? paragraphs : ["(No content)"]
        }
      ]
    };
  }

  function normalizeDocStructure(parsed, fallbackText) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return buildDocStructureFromText(fallbackText);
    }

    const title = String(parsed.title || "AI Output").trim() || "AI Output";
    const rawSections = Array.isArray(parsed.sections) ? parsed.sections : [];
    const sections = rawSections
      .map((section) => {
        if (!section || typeof section !== "object") {
          return null;
        }
        const heading = String(section.heading || "").trim();
        const rawParagraphs = Array.isArray(section.paragraphs)
          ? section.paragraphs
          : typeof section.paragraphs === "string"
            ? [section.paragraphs]
            : [];
        const paragraphs = rawParagraphs
          .map((paragraph) => String(paragraph || "").replace(/\s+/g, " ").trim())
          .filter(Boolean);
        if (!heading && paragraphs.length === 0) {
          return null;
        }
        return { heading, paragraphs: paragraphs.length > 0 ? paragraphs : [" "] };
      })
      .filter(Boolean);

    if (sections.length === 0) {
      return buildDocStructureFromText(fallbackText);
    }

    return { title, sections };
  }

  function normalizeExcelStructured(parsed) {
    if (!parsed) {
      return null;
    }

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return parsed;
      }
      if (parsed.every((row) => Array.isArray(row))) {
        return parsed;
      }
      if (parsed.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
        return parsed;
      }
      return null;
    }

    if (parsed && typeof parsed === "object") {
      const hasRows = Array.isArray(parsed.rows) || Array.isArray(parsed.data);
      if (hasRows) {
        return parsed;
      }
    }

    return null;
  }

  function buildStructuredPrompt(outputType, userPrompt, responseText) {
    const safeUserPrompt = String(userPrompt || "").trim();
    const safeResponse = String(responseText || "").trim();

    if (outputType === "excel") {
      return [
        "You are preparing data for an Excel file.",
        "Return ONLY valid JSON with no markdown.",
        "Output must be a JSON array of objects.",
        "Each object should have the same keys (column headers).",
        "If insufficient data, return an empty array [].",
        "",
        "User request:",
        safeUserPrompt || "(empty)",
        "",
        "Assistant response (if helpful):",
        safeResponse || "(empty)"
      ].join("\n");
    }

    if (outputType === "pdf" || outputType === "doc" || outputType === "docx") {
      return [
        "You are preparing structured content for a document.",
        "Return ONLY valid JSON with no markdown.",
        "Output schema:",
        "{",
        '  "title": "string",',
        '  "sections": [',
        '    { "heading": "string", "paragraphs": ["para1", "para2"] }',
        "  ]",
        "}",
        "If insufficient data, still return a title and one section with brief paragraphs.",
        "",
        "User request:",
        safeUserPrompt || "(empty)",
        "",
        "Assistant response (if helpful):",
        safeResponse || "(empty)"
      ].join("\n");
    }

    return "";
  }

  async function requestStructuredOutput(outputType, userPrompt, responseText, optionsArg = {}) {
    const type = String(outputType || "").trim().toLowerCase();
    if (!type || (type !== "excel" && type !== "pdf" && type !== "doc" && type !== "docx")) {
      return null;
    }

    const prompt = buildStructuredPrompt(type, userPrompt, responseText);
    if (!prompt) {
      return null;
    }

    const openAIEnabled = Boolean(optionsArg.openAIEnabled);
    const geminiEnabled = Boolean(optionsArg.geminiEnabled);

    let raw = "";
    if (openAIEnabled) {
      try {
        const model = modelService.getOpenAIModel();
        raw = await modelService.callOpenAIChat({
          model,
          messages: [
            { role: "system", content: "Return only valid JSON." },
            { role: "user", content: prompt }
          ],
          temperature: 0.1
        });
      } catch (_error) {
        raw = "";
      }
    } else if (geminiEnabled) {
      try {
        raw = await modelService.callGeminiText(prompt);
      } catch (_error) {
        raw = "";
      }
    }

    if (!raw) {
      return null;
    }

    const parsed = extractJsonFromText(raw);
    if (!parsed) {
      return null;
    }

    if (type === "excel") {
      return normalizeExcelStructured(parsed);
    }

    return normalizeDocStructure(parsed, responseText || userPrompt);
  }

  function buildFileNotice(responseText, files) {
    if (!Array.isArray(files) || files.length === 0) {
      return responseText;
    }

    const baseText = String(responseText || "").trim();
    const lines = [baseText, "", "---", "Files ready:"];
    files.forEach((file) => {
      if (!file || !file.filePath) {
        return;
      }
      const label = String(file.outputType || file.type || "").trim() || "file";
      const name = String(file.fileName || "").trim();
      const suffix = name ? ` (${name})` : "";
      lines.push(`- ${label}: \`${file.filePath}\`${suffix}`);
    });
    return lines.filter(Boolean).join("\n");
  }

  function isWeakResponse(text) {
    if (!text) return true;

    const normalized = String(text || "").trim();
    const tooShort = normalized.length < 200;
    const noHeadings =
      !normalized.includes("#") &&
      !normalized.includes("•") &&
      !normalized.includes("-");
    const noStructure = normalized.split("\n").length < 5;

    return tooShort || noHeadings || noStructure;
  }

  async function rewriteIfWeakResponse(originalText, optionsArg = {}) {
    const sourceText = String(originalText || "").trim();
    if (!isWeakResponse(sourceText)) {
      return sourceText;
    }

    console.log("[AI QUALITY FIX TRIGGERED]");

    const rewritePrompt = [
      "Rewrite the following response into a highly structured, detailed, and professional format.",
      "",
      "RULES:",
      "- Add headings and subheadings",
      "- Use bullet points",
      "- Expand explanations",
      "- Do not remove any information",
      "",
      "Response:",
      sourceText
    ].join("\n");

    const openAIEnabled = Boolean(optionsArg.openAIEnabled);
    const geminiEnabled = Boolean(optionsArg.geminiEnabled);
    const preferredProvider = String(optionsArg.preferredProvider || "").trim().toLowerCase();

    const providers = [];
    if (preferredProvider === "openai" && openAIEnabled) {
      providers.push("openai");
    }
    if (preferredProvider === "gemini" && geminiEnabled) {
      providers.push("gemini");
    }
    if (openAIEnabled && !providers.includes("openai")) {
      providers.push("openai");
    }
    if (geminiEnabled && !providers.includes("gemini")) {
      providers.push("gemini");
    }

    for (const provider of providers) {
      try {
        if (provider === "openai") {
          const model = modelService.getOpenAIModel();
          const rewritten = await modelService.callOpenAIChat({
            model,
            messages: [
              { role: "system", content: "Rewrite output into professional structured format." },
              { role: "user", content: rewritePrompt }
            ],
            temperature: 0.2
          });
          const safe = String(rewritten || "").trim();
          if (safe) {
            return safe;
          }
          continue;
        }

        if (provider === "gemini") {
          const rewritten = await modelService.callGeminiText(rewritePrompt);
          const safe = String(rewritten || "").trim();
          if (safe) {
            return safe;
          }
        }
      } catch (_error) {}
    }

    return sourceText;
  }

  function deriveOutputTypesFromPrompt(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    const outputTypes = [];

    if (text.includes("pdf")) outputTypes.push("pdf");
    if (text.includes("excel") || text.includes("xlsx") || text.includes("sheet")) outputTypes.push("excel");
    if (text.includes("docx") || text.includes("word") || text.includes("doc")) outputTypes.push("docx");
    if (text.includes("html") || text.includes("web page") || text.includes("webpage")) outputTypes.push("html");
    if (text.includes("json")) outputTypes.push("json");
    if (text.includes("image") || text.includes("poster") || text.includes("logo")) outputTypes.push("image");

    return outputTypes.length > 0 ? Array.from(new Set(outputTypes)) : ["html"];
  }

  async function generateImageResponseFromPrompt(userPrompt, payload = {}) {
    const openAIKey = getOpenAIKey();
    if (!openAIKey) {
      return {
        response: "Image generation is unavailable. Please configure OPENAI_API_KEY.",
        usedModel: "none",
        provider: "unconfigured",
        currentApp: options.getCurrentApp(),
        openAIEnabled: false,
        geminiEnabled: Boolean(getGeminiClient())
      };
    }

    try {
      const imageResult = await imageService.generateImage(userPrompt, {
        size: payload.imageSize,
        enhance: payload.imageEnhance,
        count: payload.imageCount
      });
      const requestedCount = Number.isFinite(Number(payload.imageCount))
        ? Number(payload.imageCount)
        : 1;
      const allUrls = Array.isArray(imageResult.urls) ? imageResult.urls : [];
      const limitedUrls = requestedCount > 1 ? allUrls : allUrls.slice(0, 1);
      const persistedUrls = await Promise.all(limitedUrls.map((url) => persistGeneratedImageUrl(url)));
      const finalUrls = persistedUrls.filter(Boolean);
      const limitedImages = finalUrls.map((url) => ({ url }));
      return {
        type: "image",
        imageUrl: finalUrls[0] || imageResult.url,
        imageUrls: finalUrls,
        images: limitedImages,
        prompt: imageResult.prompt,
        message: "Here is your generated image",
        response: "Here is your generated image",
        usedModel: `openai:${imageResult.model}`,
        provider: "openai-image",
        currentApp: options.getCurrentApp(),
        openAIEnabled: true,
        geminiEnabled: Boolean(getGeminiClient())
      };
    } catch (error) {
      console.warn(
        "[ai] image generation failed",
        error && error.message ? error.message : error
      );
      return {
        response: "Image generation failed. Please try again.",
        usedModel: "openai-image",
        provider: "openai-image",
        currentApp: options.getCurrentApp(),
        openAIEnabled: true,
        geminiEnabled: Boolean(getGeminiClient())
      };
    }
  }

  function extractOcrTextFromPrompt(promptText) {
    const source = String(promptText || "");
    const marker = "The following text was detected from the screen using OCR:";
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) {
      return "";
    }

    let text = source.slice(markerIndex + marker.length).trim();
    const cutoffMarkers = ["\n\nStudent question:", "\n\nAnalyze the screenshot", "\n\nAnalyze"];
    let cutoffIndex = -1;
    cutoffMarkers.forEach((markerValue) => {
      const idx = text.indexOf(markerValue);
      if (idx !== -1 && (cutoffIndex === -1 || idx < cutoffIndex)) {
        cutoffIndex = idx;
      }
    });

    if (cutoffIndex !== -1) {
      text = text.slice(0, cutoffIndex).trim();
    }

    if (text.toLowerCase().includes("no readable ocr text")) {
      return "";
    }

    return text;
  }

  async function classifyTaskIntent(userPrompt, optionsArg = {}) {
    if (intentService && typeof intentService.classifyTaskIntent === "function") {
      return intentService.classifyTaskIntent(userPrompt, optionsArg);
    }
    return intentService.classifyIntent(userPrompt, optionsArg);
  }

  async function classifyInputType(userPrompt) {
    if (typeof intentService.classifyInputType === "function") {
      return intentService.classifyInputType(userPrompt);
    }
    return { type: "teaching", confidence: 0.5 };
  }

  function mapIntentToTool(intentLabel) {
    return intentService.mapIntentToTool(intentLabel);
  }

  function applyIntentOverrides(aiIntent, hasScreenshot) {
    if (hasScreenshot) {
      return "ocr";
    }
    return aiIntent;
  }

  async function runTool(payload, toolName) {
    return toolService.executeTool(payload, toolName);
  }

  async function retrieveRagContext(userPrompt) {
    return ragService.getRelevantContext(userPrompt);
  }

  function queueMemoryWrite(userPrompt, assistantText) {
    const chunk = buildMemoryChunk(userPrompt, assistantText);
    if (!chunk) {
      return;
    }
    // Use ragService to persist memory asynchronously
    ragService.storeMemory({ text: chunk }).catch(() => {});
  }

  async function callOpenAIText(promptText) {
    const model = modelService.getOpenAIModel();
    const content = await modelService.callOpenAIChat({ model, messages: [{ role: "user", content: promptText }], temperature: 0.2 });
    return { response: content, usedModel: `openai:${model}`, currentApp: options.getCurrentApp() };
  }

  async function callOpenAIVision(promptText, screenshotBase64) {
    const model = modelService.getOpenAIModel();
    const content = await modelService.callOpenAIVision({ model, promptText, screenshotBase64 });
    return { response: content, usedModel: `openai:${model}`, currentApp: options.getCurrentApp() };
  }

  async function callGeminiText(promptText) {
    const content = await modelService.callGeminiText(promptText);
    const model = modelService.getGeminiModel();
    return { response: content, usedModel: `gemini:${model}`, currentApp: options.getCurrentApp() };
  }

  async function callGeminiVision(promptText, screenshotBase64) {
    const content = await modelService.callGeminiVision(promptText, screenshotBase64);
    const model = modelService.getGeminiModel();
    return { response: content, usedModel: `gemini:${model}`, currentApp: options.getCurrentApp() };
  }

  async function generate(payload = {}) {
    const requestStartedAt = Date.now();
    const userPrompt = String(payload.userPrompt || "").trim();
    const screenshotBase64 = String(payload.screenshotBase64 || "").trim();
    const allowExternalScreenshot = Boolean(payload.allowExternalScreenshot);
    const rawPrompt = Boolean(payload.rawPrompt);
    const forceImageGeneration = Boolean(payload.forceImageGeneration);

    if (!userPrompt) {
      throw new Error("Prompt is empty.");
    }

    if (forceImageGeneration) {
      return generateImageResponseFromPrompt(userPrompt, payload);
    }

    const responseMode =
      intentService && typeof intentService.detectResponseMode === "function"
        ? intentService.detectResponseMode(userPrompt)
        : "detailed";
    const conversationIntent =
      intentService && typeof intentService.classifyIntent === "function"
        ? intentService.classifyIntent(userPrompt)
        : "meaningful";
    const language =
      intentService && typeof intentService.detectLanguage === "function"
        ? intentService.detectLanguage(userPrompt)
        : "english";
    const tone =
      intentService && typeof intentService.getTone === "function"
        ? intentService.getTone(userPrompt)
        : "formal";
    const isCasualMode = tone === "casual";

    if (!rawPrompt && conversationIntent === "greeting") {
      const casualReply = generateCasualReply(userPrompt, language);
      return {
        type: "text",
        content: casualReply,
        response: casualReply,
        usedModel: "none",
        provider: "casual-local",
        currentApp: options.getCurrentApp(),
        openAIEnabled: Boolean(getOpenAIClient()),
        geminiEnabled: Boolean(getGeminiClient())
      };
    }

    const explicitFileRequest = detectExplicitFileRequest(userPrompt);
    const intentResult = !rawPrompt
      ? await classifyTaskIntent(userPrompt, { hasScreenshot: Boolean(screenshotBase64) })
      : { intent: "general", needs_web: false, needs_rag: false };
    const normalizedIntent = String(intentResult && intentResult.intent ? intentResult.intent : "general");
    const needsWeb = Boolean(intentResult && intentResult.needs_web);
    const needsRag = Boolean(intentResult && intentResult.needs_rag);
    const openAIEnabled = Boolean(getOpenAIClient());
    const geminiEnabled = Boolean(getGeminiClient());

    const modeInstruction =
      conversationIntent === "casual" || responseMode === "minimal"
        ? "Respond in exactly one line. Be natural and concise."
        : responseMode === "short"
          ? "Respond briefly in 2-4 sentences. Keep it clear and direct."
          : "Respond clearly in natural teacher-like conversation. Start simple, then example, then optional extra detail. Avoid headings unless user asks.";
    const toneInstruction =
      tone === "casual"
        ? "Respond in a friendly, natural, conversational tone. No headings."
        : "";
    const languageInstruction = "Respond in the same language as the user input. Do not mix languages.";
    const responseIntentInstruction =
      conversationIntent === "casual"
        ? "Respond in 1-2 lines. Keep it natural and conversational."
        : conversationIntent === "meaningful"
          ? "Respond helpfully to the user's meaning. Ask a brief follow-up only if needed. Do not greet again."
          : "";

    if (normalizedIntent === "hybrid") {
      const preferredModelName = openAIEnabled ? modelService.getOpenAIModel() : modelService.getGeminiModel();
      const budget = modelService.getModelBudget(preferredModelName);
      const hybridPromptBase = promptBuilder.buildFinalPrompt({
        systemPrompt: selectPrompt("explanation").promptText,
        userInput: userPrompt,
        context: {
          contextMessages: payload.contextMessages,
          memoryMessages: payload.memoryMessages || payload.contextMessages,
          memorySummary: payload.memorySummary,
          ragResults: [],
          hasScreenshot: Boolean(screenshotBase64),
          ocrText: screenshotBase64 ? extractOcrTextFromPrompt(userPrompt) : "",
          detectedAppName: options.getCurrentApp()
        },
        toolsData: null
      });

      const hybridPrompt = `${hybridPromptBase}\n\n${modeInstruction}${toneInstruction ? `\n${toneInstruction}` : ""}\n${languageInstruction}${responseIntentInstruction ? `\n${responseIntentInstruction}` : ""}\n\nProvide an explanation first. Keep it accurate and useful before image generation.`;

      let explanationText = "I can explain this and generate an image for it.";
      let explanationUsedModel = "none";
      let explanationProvider = "unconfigured";

      if (openAIEnabled || geminiEnabled) {
        try {
          const textResult = await controlService.request({
            finalPrompt: hybridPrompt,
            screenshotBase64,
            rawPrompt,
            userPrompt,
            intentKey: "hybrid:text",
            inputType: "teaching",
            systemPrompt: "",
            openAIEnabled,
            geminiEnabled,
            modelBudget: budget
          });

          const skipWeakResponseCheck = responseMode === "minimal";
          explanationText = skipWeakResponseCheck
            ? String(textResult.response || "").trim() || explanationText
            : await rewriteIfWeakResponse(textResult.response, {
                openAIEnabled,
                geminiEnabled,
                preferredProvider: textResult.provider
              });
          explanationUsedModel = String(textResult.usedModel || "none").trim() || "none";
          explanationProvider = String(textResult.provider || "unknown").trim() || "unknown";
        } catch (_error) {
          explanationText = "I can explain this, but text generation is temporarily unavailable.";
        }
      }

      const imageResult = await generateImageResponseFromPrompt(userPrompt, payload);
      const hasImage = Boolean(imageResult && (imageResult.imageUrl || (Array.isArray(imageResult.imageUrls) && imageResult.imageUrls.length > 0)));

      return {
        type: "hybrid",
        explanation: explanationText,
        response: explanationText,
        imageUrl: imageResult && imageResult.imageUrl ? imageResult.imageUrl : "",
        imageUrls: imageResult && Array.isArray(imageResult.imageUrls) ? imageResult.imageUrls : [],
        images: imageResult && Array.isArray(imageResult.images) ? imageResult.images : [],
        prompt: userPrompt,
        message: hasImage ? "Explanation + image generated" : "Explanation generated. Image generation failed.",
        usedModel: hasImage ? `${explanationUsedModel}+${String(imageResult.usedModel || "openai-image")}` : explanationUsedModel,
        provider: hasImage ? "hybrid" : explanationProvider,
        currentApp: options.getCurrentApp(),
        openAIEnabled,
        geminiEnabled
      };
    }

    if (normalizedIntent === "image_generation") {
      return {
        type: "image_prompt",
        prompt: userPrompt,
        message: "🎨 Image prompt detected",
        response: "🎨 Image prompt detected",
        usedModel: "none",
        provider: "image-prompt",
        currentApp: options.getCurrentApp(),
        openAIEnabled: Boolean(getOpenAIClient()),
        geminiEnabled: Boolean(getGeminiClient())
      };
    }

    const fileRequested = !rawPrompt && explicitFileRequest && normalizedIntent === "document_formatting";
    const shouldGenerateImage =
      !rawPrompt && !fileRequested && isLikelyImageGenerationRequest(userPrompt) && normalizedIntent !== "document_formatting";

    if (shouldGenerateImage) {
      return generateImageResponseFromPrompt(userPrompt, payload);
    }

    const outputTypes = fileRequested ? deriveOutputTypesFromPrompt(userPrompt) : [];

    const selectedPrompt = selectPrompt(normalizedIntent);
    const selectedTool =
      !rawPrompt &&
      !screenshotBase64 &&
      (needsWeb || promptBuilder.shouldTriggerWebSearch(userPrompt))
        ? "webSearch"
        : "";

    console.info("[ai] request:start", {
      hasScreenshot: Boolean(screenshotBase64),
      promptLength: userPrompt.length,
      allowExternalScreenshot
    });

    console.log("Selected Tool:", selectedTool || "none");

    let toolResult = "";
    let webSearchResult = null;

    if (selectedTool === "webSearch") {
      try {
        const tooling = await runTool(payload, selectedTool);
        toolResult = tooling.toolResult || "";
        webSearchResult = tooling.webSearchResult || null;
      } catch (_error) {
        toolResult = "";
        webSearchResult = null;
      }
    }

    const ragResults = !rawPrompt && needsRag ? await retrieveRagContext(userPrompt) : [];

    if (selectedTool === "webSearch" && webSearchResult) {
      const openAIEnabledForWeb = Boolean(getOpenAIClient());
      const geminiEnabledForWeb = Boolean(getGeminiClient());
      const currentEventsMode = isCurrentEventsPrompt(userPrompt);
      const deepCurrentEvents = wantsDeepWebExplanation(userPrompt);
      const synthesized = currentEventsMode
        ? buildCurrentEventsStructuredResponse(userPrompt, webSearchResult, {
            useHeadings: deepCurrentEvents
          })
        : await synthesizeWebSearchResponse({
            userPrompt,
            webResult: webSearchResult,
            openAIEnabled: openAIEnabledForWeb,
            geminiEnabled: geminiEnabledForWeb
          });
      const synthesizedText = String(synthesized || "").trim();
      const isNoReliableHeadline = /reliable live headlines clear nahi mili/i.test(synthesizedText);
      const sourceLines = currentEventsMode
        ? formatWebSources(webSearchResult, 8, { requireHttpUrl: true })
        : formatWebSources(webSearchResult, 5);
      const responseWithSources =
        synthesizedText;

      return {
        response: responseWithSources || buildWebSearchDirectResponse(webSearchResult, userPrompt),
        usedModel: "tool:webSearch",
        provider: "tool:webSearch",
        currentApp: options.getCurrentApp(),
        openAIEnabled: openAIEnabledForWeb,
        geminiEnabled: geminiEnabledForWeb
      };
    }

    // Build final prompt with token budgeting based on selected model
    const preferredModelName = openAIEnabled ? modelService.getOpenAIModel() : modelService.getGeminiModel();
    const budget = modelService.getModelBudget(preferredModelName);

    const finalPromptBase = promptBuilder.buildFinalPrompt({
      systemPrompt: selectedPrompt.promptText,
      userInput: userPrompt,
      context: {
        contextMessages: payload.contextMessages,
        memoryMessages: payload.memoryMessages || payload.contextMessages,
        memorySummary: payload.memorySummary,
        ragResults,
        hasScreenshot: Boolean(screenshotBase64),
        ocrText: screenshotBase64 ? extractOcrTextFromPrompt(userPrompt) : "",
        detectedAppName: options.getCurrentApp()
      },
      toolsData: webSearchResult ? { webSearch: webSearchResult } : toolResult ? { toolResult } : null
    });

    const expectsLongResponse =
      normalizedIntent === "document_formatting" ||
      normalizedIntent === "web_research" ||
      needsRag ||
      userPrompt.length > 180;

    const finalPrompt = expectsLongResponse
      ? `${finalPromptBase}${modeInstruction ? `\n\n${modeInstruction}` : ""}${toneInstruction ? `\n${toneInstruction}` : ""}\n${languageInstruction}${responseIntentInstruction ? `\n${responseIntentInstruction}` : ""}\n\nMake the response comprehensive and in-depth.`
      : `${finalPromptBase}${modeInstruction ? `\n\n${modeInstruction}` : ""}${toneInstruction ? `\n${toneInstruction}` : ""}\n${languageInstruction}${responseIntentInstruction ? `\n${responseIntentInstruction}` : ""}`;

    if (screenshotBase64 && !allowExternalScreenshot) {
      return {
        response:
          "External AI off hai. Screenshot analyze karne ke liye External AI toggle ON karein.",
        usedModel: "none",
        currentApp: options.getCurrentApp(),
        provider: "blocked",
        openAIEnabled,
        geminiEnabled
      };
    }

    if (!openAIEnabled && !geminiEnabled) {
      return {
        response: "No AI API configured.",
        usedModel: "none",
        currentApp: options.getCurrentApp(),
        provider: "unconfigured",
        openAIEnabled,
        geminiEnabled
      };
    }

    try {
      const cacheIntentKey = rawPrompt ? `raw:${normalizedIntent}` : normalizedIntent;

      const responsePayload = await controlService.request({
        finalPrompt,
        screenshotBase64,
        rawPrompt,
        userPrompt,
        intentKey: cacheIntentKey,
        inputType: "teaching",
        systemPrompt: "",
        openAIEnabled,
        geminiEnabled,
        modelBudget: budget
      });

      const skipWeakResponseCheck = responseMode === "minimal" || conversationIntent === "casual";
      const qualityCheckedResponse = skipWeakResponseCheck
        ? String(responsePayload.response || "")
        : await rewriteIfWeakResponse(responsePayload.response, {
            openAIEnabled,
            geminiEnabled,
            preferredProvider: responsePayload.provider
          });

      const normalizedResponsePayload = {
        ...responsePayload,
        response: qualityCheckedResponse
      };

      console.info("[ai] request:end", {
        durationMs: Date.now() - requestStartedAt,
        usedModel: normalizedResponsePayload.usedModel || "unknown"
      });
      if (!rawPrompt) {
        try { queueMemoryWrite(userPrompt, normalizedResponsePayload.response); } catch (_e) {}
      }

      let files = [];
      if (Array.isArray(outputTypes) && outputTypes.length > 0) {
        for (const outputType of outputTypes) {
          try {
            const fileContent = selectFileContent(outputType, normalizedResponsePayload.response, userPrompt);
            const structured = null;

            let filePayload = null;
            if (outputType === "excel") {
              filePayload = {
                data: structured ?? fileContent,
                text: fileContent,
                prefix: `ai-${outputType}`,
                fileName: ""
              };
            } else if (outputType === "json") {
              const jsonData =
                extractJsonFromText(fileContent) ?? (fileContent ? { content: fileContent } : {});
              filePayload = {
                data: jsonData,
                text: fileContent,
                prefix: `ai-${outputType}`,
                fileName: ""
              };
            } else {
              filePayload = {
                text: fileContent,
                structured,
                prefix: `ai-${outputType}`,
                fileName: ""
              };
            }
            const info = await fileService.generateFile(outputType, filePayload);
            if (info) {
              files.push(info);
            }
          } catch (error) {
            console.warn(
              "[ai] file generation failed",
              error && error.message ? error.message : error
            );
          }
        }
      }

      const finalResponseText =
        files.length > 0 ? buildFileNotice(normalizedResponsePayload.response, files) : normalizedResponsePayload.response;
      const primaryFile = files.length > 0 ? files[0] : null;
      return {
        ...normalizedResponsePayload,
        response: finalResponseText,
        fileInfo: primaryFile,
        outputType: primaryFile ? primaryFile.outputType : "",
        files,
        currentApp: options.getCurrentApp(),
        openAIEnabled,
        geminiEnabled
      };
    } catch (error) {
      console.warn("[ai] control:request failed", error && error.message ? error.message : "");
    }

    return {
      response: "AI service unavailable. Please try again.",
      usedModel: "none",
      currentApp: options.getCurrentApp(),
      provider: "unavailable",
      openAIEnabled,
      geminiEnabled
    };
  }

  return {
    classifyInputType,
    generate
  };
}

module.exports = {
  createAiClient
};
