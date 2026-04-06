(function (root, factory) {
  const sharedConstants =
    (root.SharedModules && root.SharedModules.constants) ||
    (typeof module === "object" && module.exports ? require("./constants") : null);
  const promptBuilder = factory(sharedConstants || {});

  if (typeof module === "object" && module.exports) {
    module.exports = promptBuilder;
  }

  root.SharedModules = root.SharedModules || {};
  root.SharedModules.promptBuilder = promptBuilder;
})(typeof globalThis !== "undefined" ? globalThis : this, function (constants) {
  const MASTER_SYSTEM_PROMPT = `You are a smart conversational AI assistant.

You MUST follow these rules strictly:

1. Reply in a simple, natural, human conversational tone.
2. Avoid report style and heavy formatting unless the user explicitly asks for it.
3. Do not hallucinate facts, news, dates, or events.
4. If uncertain, say: "I may be wrong, but based on general knowledge..." and then give a cautious answer.
5. Understand user intent first; answer directly and do not add unrelated assumptions.
6. Keep formatting clean: no unnecessary headings, no markdown spam, no rigid templates.
7. Adapt language to the user (Hindi, Hinglish, or English) and do not mix languages unless user does.
8. Give realistic examples only; never invent fake breaking news or fake sources.
9. Keep responses concise but complete (usually 3-6 short paragraphs or bullets when helpful).`;

  function sanitizeContextMessages(contextMessages, maxMessages = 5, maxMessageChars = 500) {
    if (!Array.isArray(contextMessages)) {
      return [];
    }

    return contextMessages
      .map((item) => ({
        role: item && item.role === "assistant" ? "assistant" : "user",
        content: (() => {
          const raw = String(item && item.content ? item.content : "").trim();
          if (raw.length <= maxMessageChars) {
            return raw;
          }
          return `${raw.slice(0, Math.max(0, maxMessageChars - 3))}...`;
        })()
      }))
      .filter((item) => item.content.length > 0)
      .slice(-maxMessages);
  }

  function formatConversationContext(messages) {
    return (messages || [])
      .map((msg) => {
        const role = msg.role === "assistant" ? "Assistant" : "User";
        return `- ${role}: ${msg.content}`;
      })
      .join("\n");
  }

  function formatRagResults(results, maxChars = 240) {
    const items = Array.isArray(results) ? results : [];
    return items
      .map((item) => String(item || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((item) => (item.length > maxChars ? `${item.slice(0, maxChars - 3)}...` : item))
      .slice(0, 3);
  }

  function shouldIncludeAppContext(userPrompt, hasScreenshot) {
    if (hasScreenshot) {
      return true;
    }

    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const appKeywords = [
      "app",
      "application",
      "screen",
      "window",
      "screenshot",
      "electron",
      "vscode",
      "excel",
      "word",
      "powerpoint",
      "chrome",
      "ui",
      "code",
      "coding",
      "bug",
      "error"
    ];

    return appKeywords.some((keyword) => text.includes(keyword));
  }

  function shouldIncludeConversationContext(userPrompt, hasScreenshot) {
    if (hasScreenshot) {
      return true;
    }

    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const standalonePatterns = [
      /\bfull\s*form\b/,
      /\bmeaning\b/,
      /\bdefine\b/,
      /\bwho\s+is\b/,
      /\bwhat\s+is\b/,
      /\bkya\s+hai\b/,
      /\bmatlab\b/
    ];

    return !standalonePatterns.some((pattern) => pattern.test(text));
  }

  // Heuristic to reduce hallucinations on factual queries.
  function isHighRiskFactQuery(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const factPatterns = [
      /\bfull\s*form\b/,
      /\bacronym\b/,
      /\bmeaning\b/,
      /\bexpand\b/,
      /\bwhat\s+is\b/,
      /\bwho\s+is\b/,
      /\bwhen\s+was\b/,
      /\bkya\s+hai\b/,
      /\bmatlab\b/,
      /\bceo\b/,
      /\bfounded\b/,
      /\baccount\s+types?\b/,
      /\btypes?\s+of\s+accounts?\b/
    ];

    return factPatterns.some((pattern) => pattern.test(text));
  }

  // Detect ambiguous "types of accounts" queries to request clarification.
  function isAmbiguousAccountTypesQuery(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const matchesAccountTypes =
      /\baccount\s+types?\b/.test(text) || /\btypes?\s+of\s+accounts?\b/.test(text);
    if (!matchesAccountTypes) {
      return false;
    }

    const accountingHints = [
      "personal",
      "real",
      "nominal",
      "ledger",
      "journal",
      "trial balance",
      "debit",
      "credit",
      "accounting"
    ];
    const bankingHints = [
      "bank",
      "savings",
      "current",
      "fixed deposit",
      "recurring",
      "interest",
      "credit card",
      "loan",
      "deposit"
    ];

    if (accountingHints.some((word) => text.includes(word))) {
      return false;
    }
    if (bankingHints.some((word) => text.includes(word))) {
      return false;
    }

    return true;
  }

  function isGreetingQuery(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const greetingPatterns = [
      /^\s*(hi|hello|hey|hii|hiii)\b/,
      /\bkya\s+haal\s+hai\b/,
      /\bkaise\s+ho\b/,
      /\bnamaste\b/,
      /\bss?alam\b/,
      /\bgood\s+(morning|afternoon|evening)\b/
    ];

    return greetingPatterns.some((pattern) => pattern.test(text));
  }

  function detectLanguage(text) {
    const source = String(text || "").trim();
    if (/[\u0900-\u097F]/.test(source)) return "hindi";
    const ratioHindiWords = (source.match(/(kya|hai|kar|tum|mujhe|kaise|bata)/gi) || []).length;
    if (ratioHindiWords >= 1) return "hinglish";
    return "english";
  }

  function normalize(text) {
    return String(text || "").toLowerCase().trim();
  }

  function getSignals(text) {
    const t = normalize(text);
    const words = t ? t.split(/\s+/).filter(Boolean) : [];
    return {
      wordCount: words.length,
      hasQuestion: /\?/.test(t),
      hasVerb: /\b(kar|kya|kaise|bata|help|explain|tell|guide|discuss)\b/i.test(t),
      isShort: t.length <= 12,
      isSingleWord: words.length === 1,
      isGreetingPattern: /^(hi+|hello+|hey+|hlo+|yo+)$/.test(t)
    };
  }

  function classifyConversationIntent(text) {
    const s = getSignals(text);
    if (s.isGreetingPattern || (s.isSingleWord && s.isShort)) {
      return "greeting";
    }
    if (s.hasVerb || s.wordCount >= 3 || s.hasQuestion) {
      return "meaningful";
    }
    return "casual";
  }

  function isCasualInput(text) {
    const intent = classifyConversationIntent(text);
    return intent === "casual" || intent === "greeting";
  }

  function isTechnicalRequest(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const technicalPatterns = [
      /```/,
      /`[^`]+`/,
      /\bcode\b/,
      /\bexplain\b/,
      /\bdebug\b/,
      /\btrace\b/,
      /\bsyntax\b/,
      /\bfunction\b/,
      /\bclass\b/,
      /\bapi\b/,
      /\bquery\b/,
      /\bregex\b/,
      /\bexception\b/,
      /\bstack\b/,
      /\bcompile\b/,
      /\berror\b/
    ];

    return technicalPatterns.some((pattern) => pattern.test(text));
  }

  function isDirectCodeRequest(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const directCodePatterns = [
      /\bcode\s+do\b/,
      /\bexample\s+do\b/,
      /\bbanake\s+do\b/,
      /\bban\w*\s+do\b/,
      /\bcode\s+chahiye\b/,
      /\bexample\s+chahiye\b/
    ];

    return directCodePatterns.some((pattern) => pattern.test(text));
  }

  function isTrendOrListQuery(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const trendPatterns = [
      /\btrend(s|ing)?\b/,
      /\btrending\b/,
      /\btop\s+\d+\b/,
      /\bbest\b/,
      /\bpopular\b/,
      /\blist\b/,
      /\btools?\b/,
      /\bapps?\b/,
      /\bsoftware\b/,
      /\bplatforms?\b/,
      /\bmarket\b/,
      /\brecommend(ations?)?\b/,
      /\bexamples?\b/,
      /\buseful\b/,
      /\bai\s+tools?\b/,
      /\btools?\s+ke\b/,
      /\btrend\s+kya\s+hai\b/,
      /\bmarket\s+me\s+trend\b/
    ];

    return trendPatterns.some((pattern) => pattern.test(text));
  }

  function isProblemQuery(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const problemPatterns = [
      /\berror\b/,
      /\bissue\b/,
      /\bproblem\b/,
      /\bbug\b/,
      /\bfail(ed|ing)?\b/,
      /\bnot\s+working\b/,
      /\bcrash\b/,
      /\bstuck\b/,
      /\bhang\b/,
      /\bkaam\s+nahi\b/,
      /\bnah(i|in)\s+chal\b/,
      /\bfeil(ad|ed)?\b/
    ];

    return problemPatterns.some((pattern) => pattern.test(text));
  }

  function isFixRequest(userPrompt) {
    const text = String(userPrompt || "").toLowerCase();
    if (!text) {
      return false;
    }

    const fixPatterns = [
      /\bfix\b/,
      /\bsolve\b/,
      /\bcorrect\b/,
      /\brepair\b/,
      /\bdebug\b/,
      /\bissue\b/,
      /\berror\b/,
      /\bproblem\b/
    ];

    return fixPatterns.some((pattern) => pattern.test(text));
  }

  function hasConcreteInput(userPrompt) {
    const text = String(userPrompt || "");
    if (!text) {
      return false;
    }

    const codeMarkers = [
      /```/,
      /`[^`]+`/,
      /\b(sum|avg|average|count|vlookup|if|select|insert|update|delete)\b/i,
      /[=;{}()[\]]/,
      /<[^>]+>/,
      /\b[A-Z]+\d+:[A-Z]+\d+\b/i,
      /\b#\w+\b/
    ];

    return codeMarkers.some((pattern) => pattern.test(text));
  }

  function isVagueProblemQuery(userPrompt) {
    const text = String(userPrompt || "").trim();
    if (!text) {
      return false;
    }

    if (!isProblemQuery(text)) {
      return false;
    }

    if (hasConcreteInput(text)) {
      return false;
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return wordCount <= 8;
  }

  function buildLegacyFinalPrompt(options = {}) {
    const questionText = String(options.userPrompt || "").trim();
    const memoryMessages = sanitizeContextMessages(
      options.memoryMessages || options.contextMessages,
      Number.isFinite(options.maxMemoryMessages) ? options.maxMemoryMessages : 8,
      Number.isFinite(options.maxMemoryMessageChars) ? options.maxMemoryMessageChars : 500
    );
    const memorySummary = String(options.memorySummary || "").trim();
    const ragResults = formatRagResults(options.ragResults, 240);
    const includeAppContext = shouldIncludeAppContext(questionText, Boolean(options.hasScreenshot));
    const includeConversationContext = shouldIncludeConversationContext(
      questionText,
      Boolean(options.hasScreenshot)
    );
    const factAccuracyMode = isHighRiskFactQuery(questionText);
    const accountTypesNeedsClarification = isAmbiguousAccountTypesQuery(questionText);
    const problemSolvingMode = isProblemQuery(questionText);
    const vagueProblemQuery = isVagueProblemQuery(questionText);
    const hasSpecificInput = hasConcreteInput(questionText);
    const isGreeting = isGreetingQuery(questionText);
    const conversationIntent = classifyConversationIntent(questionText);
    const casualInput = isCasualInput(questionText);
    const detectedLanguage = detectLanguage(questionText);
    const isTechnical = isTechnicalRequest(questionText);
    const isDirectCode = isDirectCodeRequest(questionText);
    const isTrendListQuery = isTrendOrListQuery(questionText);
    const isFixMode = isFixRequest(questionText);
    const detectedAppName = String(options.detectedAppName || "Unknown application").trim();

    const blocks = [
      "[SYSTEM INSTRUCTIONS]",
      "You are an AI intern helping a beginner student in a computer training institute.",
      "Always answer the student's question directly.",
      "ALWAYS follow these rules:",
      "- Give the direct answer first.",
      "- Do not ask for more info unless absolutely required.",
      "- Avoid template phrases like 'Here is information', 'Detailed explanation', 'Possible meanings', 'Code Request'.",
      "- Keep general answers short (3-6 lines) and avoid long paragraphs.",
      "If the question is unrelated to the detected application, ignore app context completely.",
      "Never claim confusion just because the detected app and question topic are different.",
      "If older conversation context is unrelated, ignore it and focus on the latest question.",
      "Reply in the same language style as the student (Hindi, English, or Hinglish) unless asked otherwise.",
      "Do not mix languages in one response unless the student does.",
      "Never restart conversation with a greeting if the user already shared a meaningful message.",
      "If user provides personal info or a statement, respond to that meaning first instead of asking generic 'how can I help'.",
      "Respond in valid GitHub-flavored Markdown only.",
      "Use headings only when they genuinely improve clarity. If you use headings, use ### Heading.",
      "Use bullet lists with '-' only. Never use '*' bullets.",
      "If code is requested, output the fenced code block first using ```language, then add a short beginner-friendly explanation unless the user asked for code only.",
      "Keep explanations concise, accurate, and beginner friendly.",
      "Avoid invalid Markdown, broken code fences, mixed bullet styles, and off-topic detours.",
      "Never fabricate facts, names, full forms, dates, institutions, or numbers.",
      "If you are not confident, clearly say you are not sure and ask for a reliable source or more context.",
      "Prefer saying 'I am not sure' over giving a wrong answer.",
      "Never over-guess: do not assume ranges, file names, or exact inputs that the student did not provide."
    ];

    blocks.push(
      "",
      "[RESPONSE STYLE SWITCHING]",
      "Choose the response style based on the user's input type.",
      "If greeting: be casual, short, and friendly. Ask how you can help.",
      "IMPORTANT RULE: If input is casual, do NOT use headings, keep response under 2 lines, and keep conversational tone.",
      `Language mode: ${detectedLanguage}. Match this language consistently.`,
      `Conversation intent: ${conversationIntent}. Continue naturally based on this intent.`,
      "If problem statement: give direct fix first, then brief explanation, then optional question.",
      "If technical request: be detailed and step-by-step, use the exact input provided.",
      "Do not force a rigid Answer/Explanation format for every response."
    );

    blocks.push(
      "",
      "[TOOL USAGE]",
      "You can use tools when needed.",
      "If tool results are provided, use them to answer directly.",
      "Prefer real data over guessing.",
      "If tool results are provided:",
      "- You MUST use them as the primary source.",
      "- You MAY improve formatting and clarity.",
      "- You MAY add short helpful explanations.",
      "- Do NOT contradict tool data.",
      "- Do NOT ignore tool results.",
      "If a tool fails, continue with the best possible answer without mentioning the failure."
    );

    blocks.push(
      "",
      "[RESPONSE MODE CONTROL]",
      "If the user asks for a list or trends: return a direct list only (with short 1-line descriptions).",
      "If the user asks for a fix: return the corrected solution only, then a very short note if needed.",
      "If the user is casual/greeting: respond casually and briefly.",
      "For general questions, keep the answer short (3-6 lines) and avoid long paragraphs.",
      "Never use template headings/phrases like 'Possible meanings', 'Verified information', 'Code Request', or 'Detailed explanation'."
    );

    if (isTrendListQuery) {
      blocks.push(
        "",
        "[TREND/LIST MODE]",
        "The user is asking for trends, tools, or a list.",
        "Do NOT use sections named 'Possible meanings' or 'Verified information'.",
        "Do NOT over-explain.",
        "Provide a direct, concise list of relevant items with a 1-line description each.",
        "If web data is available, use it. If not, provide general popular options and note they can change."
      );
    }

    if (isFixMode) {
      blocks.push(
        "",
        "[FIX MODE]",
        "Return the corrected solution only.",
        "Keep extra explanation to a minimum unless the user asks."
      );
    }

    if (problemSolvingMode) {
      blocks.push(
        "",
        "[PROBLEM-SOLVING MODE]",
        "Treat this as a problem-solving request.",
        "Provide direct fixes first, then explain briefly, then ask for missing details if needed."
      );
    }

    if (isGreeting || casualInput) {
      blocks.push(
        "",
        "[CASUAL MODE]",
        "Respond casually and briefly.",
        "Do not use headings.",
        "Keep response under 2 lines.",
        "Match user language exactly."
      );
    }

    if (conversationIntent === "meaningful") {
      blocks.push(
        "",
        "[MEANINGFUL MODE]",
        "Answer naturally and continue conversation based on user meaning.",
        "Do not restart with greeting.",
        "Ask follow-up only if truly needed."
      );
    }

    if (isTechnical) {
      blocks.push(
        "",
        "[TECHNICAL MODE]",
        "Provide a clear, detailed response.",
        "Use the exact code or formula provided by the student.",
        "If code is requested, output the code block first, then short explanation."
      );
    }

    if (isDirectCode) {
      blocks.push(
        "",
        "[DIRECT CODE REQUEST]",
        "The user explicitly asked for code or an example.",
        "Return code directly. Do not ask follow-up questions.",
        "Keep any extra text to one short line at most."
      );
    }

    if (vagueProblemQuery) {
      blocks.push(
        "",
        "[VAGUE INPUT HANDLING]",
        "Make an educated guess and list 2-4 common causes or fixes.",
        "Only if required to proceed, ask for specific missing details in short questions.",
        "Examples:",
        "- Aap apna formula share kar sakte ho?",
        "- Kya cells me text values hain?"
      );
    }

    if (hasSpecificInput) {
      blocks.push(
        "",
        "[SPECIFIC INPUT]",
        "Use the exact input provided by the student.",
        "Do not replace it with generic examples."
      );
    }

    if (factAccuracyMode) {
      blocks.push(
        "",
        "[FACT ACCURACY MODE]",
        "This question is factual. Do not guess.",
        "If web data is available, answer using that data first.",
        "If exact answer is still unclear, clearly say it is not confirmed and share closest verified information."
      );
    }

    if (accountTypesNeedsClarification) {
      blocks.push(
        "",
        "[AMBIGUITY CHECK]",
        "The phrase 'types of accounts' can mean accounting classification or bank account types.",
        "Ask a short clarification question before answering.",
        "Provide a brief list of both meanings:",
        "- Accounting: Personal, Real, Nominal",
        "- Banking: Savings, Current, Fixed Deposit, Recurring",
        "Then ask which one the student means."
      );
    }

    if (includeAppContext) {
      blocks.push("", "[APPLICATION CONTEXT]", `Detected application: ${detectedAppName}`);
    }

    if (includeConversationContext && (memoryMessages.length > 0 || memorySummary || ragResults.length > 0)) {
      if (memorySummary) {
        blocks.push("", "[MEMORY SUMMARY]", memorySummary);
      }

      if (ragResults.length > 0) {
        blocks.push("", "Relevant past context:", ragResults.map((item) => `- ${item}`).join("\n"));
      }

      if (memoryMessages.length > 0) {
        blocks.push("", "Conversation context:", formatConversationContext(memoryMessages));
      }
    }

    if (options.hasScreenshot) {
      blocks.push(
        "",
        "[SCREENSHOT CONTEXT]",
        "The student attached a screenshot. Use it only to support the student's question."
      );
    }

    blocks.push("", "[STUDENT QUESTION]", questionText);
    return blocks.join("\n");
  }

  function formatToolsData(toolsData) {
    if (!toolsData || typeof toolsData !== "object") {
      return "";
    }

    const parts = [];

    if (toolsData.webSearch && typeof toolsData.webSearch === "object") {
      const web = toolsData.webSearch;
      const summary = String(web.summary || "").trim();
      const topics = Array.isArray(web.relatedTopics) ? web.relatedTopics.filter(Boolean).slice(0, 6) : [];
      const sources = Array.isArray(web.sources)
        ? web.sources
            .slice(0, 6)
            .map((item) => {
              const title = String(item && item.title ? item.title : "Source").trim();
              const snippet = String(item && item.snippet ? item.snippet : "").trim();
              const url = String(item && item.url ? item.url : "").trim();
              return `- ${title}${snippet ? ` | ${snippet}` : ""}${url ? ` | ${url}` : ""}`;
            })
        : [];

      const webLines = ["Web Research Results:"];
      if (summary) {
        webLines.push(`Summary: ${summary}`);
      }
      if (topics.length > 0) {
        webLines.push("Related Topics:", ...topics.map((topic) => `- ${topic}`));
      }
      if (sources.length > 0) {
        webLines.push("Sources:", ...sources);
      }
      parts.push(webLines.join("\n"));
    }

    if (toolsData.toolResult) {
      parts.push(`Tool Output:\n${String(toolsData.toolResult).trim()}`);
    }

    return parts.filter(Boolean).join("\n\n");
  }

  function buildFinalPrompt(options = {}) {
    const isUnifiedShape =
      Object.prototype.hasOwnProperty.call(options, "systemPrompt") ||
      Object.prototype.hasOwnProperty.call(options, "userInput") ||
      Object.prototype.hasOwnProperty.call(options, "context") ||
      Object.prototype.hasOwnProperty.call(options, "toolsData");

    if (!isUnifiedShape) {
      return buildLegacyFinalPrompt(options);
    }

    const userInput = String(options.userInput || "").trim();
    const detectedLanguage = detectLanguage(userInput);
    const conversationIntent = classifyConversationIntent(userInput);
    const casualInput = isCasualInput(userInput);
    const context = options.context && typeof options.context === "object" ? options.context : {};
    const specializedPrompt = String(options.systemPrompt || "").trim();
    const isExplanationMode = /you are an expert explainer ai\./i.test(specializedPrompt);
    const toolsBlock = formatToolsData(options.toolsData);
    const memorySummary = String(context.memorySummary || "").trim();
    const detectedAppName = String(context.detectedAppName || "").trim();
    const ocrText = String(context.ocrText || "").trim();
    const hasScreenshot = Boolean(context.hasScreenshot);
    const ragResults = formatRagResults(context.ragResults || [], 240);
    const contextMessages = sanitizeContextMessages(context.contextMessages || context.memoryMessages, 8, 500);

    const effectiveMasterPrompt = isExplanationMode
      ? [
          "You are an expert assistant teaching a student.",
          "Be clear, simple, engaging, and beginner-friendly.",
          "Avoid rigid academic report style unless the user explicitly asks for it."
        ].join("\n")
      : MASTER_SYSTEM_PROMPT;

    const blocks = ["[MASTER SYSTEM PROMPT]", effectiveMasterPrompt];

    if (specializedPrompt) {
      blocks.push("", "[SELECTED SPECIAL PROMPT]", specializedPrompt);
    }

    const contextLines = [];

    if (detectedAppName) {
      contextLines.push(`Detected application: ${detectedAppName}`);
    }

    if (memorySummary) {
      contextLines.push("Memory summary:", memorySummary);
    }

    if (ragResults.length > 0) {
      contextLines.push("RAG context:", ragResults.map((item) => `- ${item}`).join("\n"));
    }

    if (contextMessages.length > 0) {
      contextLines.push("Recent context:", formatConversationContext(contextMessages));
    }

    if (hasScreenshot || ocrText) {
      contextLines.push("Screen context:");
      if (ocrText) {
        contextLines.push("OCR Extract:", ocrText);
      } else {
        contextLines.push("Screenshot is attached.");
      }
    }

    if (toolsBlock || contextLines.length > 0) {
      const toolContextBlocks = [];
      if (toolsBlock) {
        toolContextBlocks.push("Tool data:", toolsBlock);
      }
      if (contextLines.length > 0) {
        toolContextBlocks.push(...contextLines);
      }
      blocks.push("", "[TOOL / CONTEXT DATA]", ...toolContextBlocks);
    }

    blocks.push("", "[USER INPUT]", userInput || "(empty)");
    blocks.push(
      "",
      "LANGUAGE RULE (MANDATORY):",
      `- User language detected: ${detectedLanguage}`,
      "- Respond in the same language as the user input.",
      "- Do not mix languages."
    );
    blocks.push(
      "",
      "CONVERSATION RULES (MANDATORY):",
      `- User intent detected: ${conversationIntent}`,
      "- NEVER restart conversation with greeting.",
      "- If user shared personal info/statement, respond to that meaning first.",
      "- Never ignore user intent."
    );

    if (casualInput) {
      blocks.push(
        "",
        "FINAL OUTPUT RULES (MANDATORY):",
        "- Casual input detected",
        "- Do not use headings",
        "- Keep response under 2 lines",
        "- Keep tone conversational and human"
      );
    } else if (isExplanationMode) {
      blocks.push(
        "",
        "FINAL OUTPUT RULES (MANDATORY):",
        "- Start with a short, clear intro (2-3 lines)",
        "- Use concise sections: How it works, Key points, Example, One-line summary",
        "- Keep language simple and engaging",
        "- Use bullets where useful for readability",
        "- Do not use formal report headings like Introduction or Conclusion",
        "- Do not sound academic or document-like"
      );
    } else {
      blocks.push(
        "",
        "FINAL OUTPUT RULES (MANDATORY):",
        "- Keep response conversational and direct",
        "- Start with simple answer, then example, then optional extra detail",
        "- Avoid headings unless the user asks or they are truly necessary",
        "- Avoid markdown-heavy formatting and template-style sections",
        "- Use bullets only when truly needed for clarity",
        "- Do not use emojis unless they genuinely help",
        "- Ensure completeness and clarity",
        "- Avoid over-formatting"
      );
    }

    return blocks.join("\n");
  }

  function hasExcelErrorPattern(ocrText) {
    const normalized = String(ocrText || "").toLowerCase();
    return (
      normalized.includes("#name?") ||
      normalized.includes("#value") ||
      normalized.includes("#div/0") ||
      normalized.includes("sum(")
    );
  }

  function buildPromptWithOcr(userPrompt, extractedText, options = {}) {
    const openingAnalysis = Boolean(options.openingAnalysis);
    const safePrompt = String(userPrompt || "").trim();

    const ocrSection = extractedText
      ? `The following text was detected from the screen using OCR:\n\n${extractedText}`
      : "No readable OCR text was detected from the screenshot.";

    const excelPriority = hasExcelErrorPattern(extractedText)
      ? "OCR suggests Excel formula errors (#NAME?, #VALUE, #DIV/0, SUM(). Prioritize explaining formula mistakes and exact fix steps."
      : "";

    if (openingAnalysis) {
      return [
        "You are an AI intern helping a student in a computer training institute.",
        "Look at this screenshot and identify what application is open and whether the student might need help (for example Excel errors, coding errors, etc.).",
        "Explain what you see.",
        ocrSection,
        excelPriority
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    return [
      "You are an AI intern helping a student.",
      ocrSection,
      "Analyze the screenshot and explain any problems you detect (for example Excel formula errors, coding errors, etc.).",
      excelPriority,
      `Student question:\n${safePrompt || "Please analyze the attached screenshot and guide the student step by step."}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function shouldTriggerWebSearch(userPrompt) {
    const text = String(userPrompt || "").trim();
    if (!text) {
      return false;
    }

    return Array.isArray(constants.WEB_SEARCH_TRIGGER_PATTERNS)
      ? constants.WEB_SEARCH_TRIGGER_PATTERNS.some((pattern) => pattern.test(text))
      : false;
  }

  function isFullFormQuery(userPrompt) {
    const text = String(userPrompt || "");
    return Array.isArray(constants.FULL_FORM_QUERY_PATTERNS)
      ? constants.FULL_FORM_QUERY_PATTERNS.some((pattern) => pattern.test(text))
      : false;
  }

  return {
    buildFinalPrompt,
    buildLegacyFinalPrompt,
    buildPromptWithOcr,
    hasExcelErrorPattern,
    isFullFormQuery,
    isHighRiskFactQuery,
    isTrendOrListQuery,
    sanitizeContextMessages,
    shouldIncludeAppContext,
    shouldIncludeConversationContext,
    shouldTriggerWebSearch
  };
});
