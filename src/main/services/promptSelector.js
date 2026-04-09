const DOCUMENT_FORMATTER_PROMPT = `Document Formatter Prompt

STRICT MODE:
- Preserve ALL content
- Do NOT summarize
- Do NOT remove anything`;

const WEB_RESEARCH_PROMPT = `Web Research Prompt

STRICT MODE:
- Use only verified and recent information
- Provide structured categorized output
- Include sources`;

const EXPLANATION_MODE_PROMPT = `You are an expert explainer AI.

Follow these rules:
1. Start with a simple, clear explanation.
2. Use emojis for clarity when helpful.
3. Use short sections and natural labels, not formal report headings.
4. Use bullet points for readability.
5. Add simple examples or analogies.
6. Keep it engaging and easy to understand.
7. Avoid academic/report tone.
8. Never use words/sections like: "Introduction", "Conclusion", "This document explains".
9. Make it feel like you are teaching a student.

Preferred structure:
- Short intro (2-3 lines)
- How it works
- Key points
- Example
- One-line summary`;

function selectPrompt(intent) {
  const normalizedIntent = String(intent || "general").trim().toLowerCase();

  if (normalizedIntent === "document_formatting") {
    return {
      key: "document_formatting",
      promptText: DOCUMENT_FORMATTER_PROMPT
    };
  }

  if (normalizedIntent === "web_research") {
    return {
      key: "web_research",
      promptText: WEB_RESEARCH_PROMPT
    };
  }

  if (normalizedIntent === "explanation") {
    return {
      key: "explanation_mode",
      promptText: EXPLANATION_MODE_PROMPT
    };
  }

  return {
    key: "default",
    promptText: ""
  };
}

module.exports = {
  DOCUMENT_FORMATTER_PROMPT,
  EXPLANATION_MODE_PROMPT,
  WEB_RESEARCH_PROMPT,
  selectPrompt
};
