(function (root, factory) {
  const constants = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = constants;
  }

  root.SharedModules = root.SharedModules || {};
  root.SharedModules.constants = constants;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const WEB_SEARCH_SAFETY_PROMPT = [
    "You are a careful AI assistant that avoids hallucination.",
    "",
    "Rules for answering questions:",
    "1. Detect ambiguous terms.",
    "If a user asks about a term that can have multiple meanings (such as abbreviations, acronyms, or short names), do not assume only one meaning.",
    "2. If the meaning is unclear, respond with clarification instead of guessing.",
    'Use this structure:',
    '"I found multiple possible meanings for this term."',
    "- Meaning 1",
    "- Meaning 2",
    "- Meaning 3",
    "Then ask the user to confirm which one they mean.",
    "3. Only provide a final answer when a reliable source confirms the meaning OR the user provides context or a link.",
    "4. If a link is provided, use the link as the primary reference and extract information from it.",
    '5. Never invent facts. If reliable information is missing, say: "I could not find a verified answer from reliable sources."',
    "6. Prefer verified information over guesses.",
    "7. When possible, show sections named: Possible Meanings, Verified Information, Sources.",
    "Always prioritize accuracy over confidence.",
    "",
    "When answering factual questions:",
    "- Do not fabricate information.",
    "- If uncertain, say that the information is not verified.",
    "- Never guess institutional names, acronyms, or official expansions without confirmation.",
    "",
    "Use these response patterns when needed:",
    "- Not confirmed",
    "- Multiple meanings exist",
    "- More context required"
  ].join("\n");

  return {
    SMALL_CHAT_WIDTH: 550,
    SMALL_CHAT_HEIGHT: 550,
    EXPANDED_CHAT_WIDTH: 700,
    EXPANDED_CHAT_HEIGHT: 800,
    FLOAT_BUTTON_SIZE: 100,
    WINDOW_MARGIN: 16,
    TOGGLE_SHORTCUT: "CommandOrControl+Shift+A",
    ACTIVE_APP_POLL_MS: 3000,
    WEB_SEARCH_TRIGGER_PATTERNS: [
      /\bwhat\s+is\b/i,
      /\bwho\s+is\b/i,
      /\bfull\s*form\b/i,
      /\bmeaning\b/i,
      /\bdefinition\b/i,
      /\blatest\b/i,
      /\bsearch\b/i
    ],
    WEB_SEARCH_SAFETY_PROMPT,
    FULL_FORM_QUERY_PATTERNS: [/\bfull\s*form\b/i, /\bacronym\b/i, /\bexpand\b/i],
    ACRONYM_STOP_WORDS: [
      "a",
      "an",
      "and",
      "for",
      "from",
      "is",
      "of",
      "please",
      "search",
      "find",
      "me",
      "tell",
      "what",
      "who",
      "full",
      "form",
      "meaning",
      "definition",
      "latest",
      "ka",
      "kya",
      "hai",
      "mujhe",
      "institute"
    ],
    ISSUE_KEYWORDS: ["error", "issue", "problem", "not working", "fix this"],
    OCR_MAX_CHARS: 4500,
    CAPTURE_HIDE_DELAY_MS: 200,
    AUTO_SCROLL_THRESHOLD_PX: 60,
    STREAM_RENDER_DEBOUNCE_MS: 45,
    STREAM_CHUNK_DELAY_MS: 14,
    STREAM_CHUNK_SIZE: 12,
    ENABLE_CODE_LINE_NUMBERS: false,
    CHAT_STORAGE_MAX: 40,
    CHAT_TITLE_MAX: 60,
    WELCOME_MESSAGE: "Hi. Student I am ready to help with your current screen and questions.",
    CHAT_STORAGE_KEY: "ai-intern-chat-sessions-v2",
    SAVED_PROMPTS_KEY: "ai-intern-saved-prompts-v1",
    SAVED_PROMPTS_MAX: 100,
    SCREENSHOT_DIR_NAME: "screenshots",
    PROMPT_LIBRARY_CATEGORIES: [
      {
        id: "coding-help",
        title: "Coding Help",
        description: "Understand code, fix issues, and improve quality.",
        prompts: [
          {
            id: "explain-code",
            title: "Explain Code",
            prompt:
              "Explain this code step-by-step for a beginner. Tell me what each important line does and include a simple example."
          },
          {
            id: "fix-error",
            title: "Fix Error",
            prompt:
              "Help me fix this error. First identify the root cause, then give the corrected code, then list verification steps."
          },
          {
            id: "optimize-code",
            title: "Optimize Code",
            prompt:
              "Optimize this code for readability and performance. Return improved code first, then short explanation of optimizations."
          }
        ]
      },
      {
        id: "web-development",
        title: "Web Development",
        description: "Generate pages, UI blocks, and frontend structure.",
        prompts: [
          {
            id: "generate-html-page",
            title: "Generate HTML Page",
            prompt:
              "Generate a clean responsive HTML page with CSS and JavaScript. Keep it beginner friendly and explain the file structure."
          },
          {
            id: "landing-section",
            title: "Landing Section",
            prompt:
              "Create a modern landing page hero section with HTML, CSS, and JavaScript. Show the code first, then briefly explain it."
          },
          {
            id: "responsive-layout",
            title: "Responsive Layout",
            prompt:
              "Create a responsive page layout with header, sidebar, content area, and footer using clean HTML and CSS."
          }
        ]
      },
      {
        id: "conversion-tools",
        title: "Conversion Tools",
        description: "Convert code and transform one format into another.",
        prompts: [
          {
            id: "convert-code",
            title: "Convert Code",
            prompt:
              "Convert this code to another language while preserving behavior. Show converted code first, then key differences."
          },
          {
            id: "json-to-table",
            title: "JSON to Table",
            prompt:
              "Convert this JSON data into a readable HTML table. Show the final code first, then explain the structure."
          },
          {
            id: "sql-to-query-builder",
            title: "SQL Explanation",
            prompt:
              "Explain this SQL query in simple language and show what each clause does."
          }
        ]
      }
    ]
  };
});
