# AI System Design

## Model Routing
AI routing is handled in `src/main/aiClient.js`:
- If `OPENAI_API_KEY` is present and no screenshot is attached, OpenAI is used.
- If `GEMINI_API_KEY` is present and OpenAI is unavailable, Gemini is used.
- If a screenshot is attached, the vision model is used only when consent is ON.

## Prompt Building
Prompt construction lives in `src/shared/promptBuilder.js`:
- Adds system instructions for beginner-friendly responses.
- Injects app context when relevant.
- Adds accuracy mode for factual queries.
- Supports OCR-based prompts for screenshot analysis.

## Web Search
When trigger patterns are detected, web search is executed via `tools/webSearch.js` and the result is appended to the prompt with safety rules to prevent hallucinations.

## OCR Integration
OCR is performed in `src/main/screenshotService.js` using Tesseract.
- Screenshots are resized before OCR for performance.
- OCR text is merged into prompts only when screenshots are attached.

## Consent Logic
The UI includes a consent toggle ("External AI: ON/OFF"):
- OFF: screenshots and OCR text are never sent to external AI providers.
- ON: screenshot-based requests may use OpenAI or Gemini vision.

## Error Handling
Errors are surfaced to the renderer as user-friendly messages:
- "AI service unavailable" when OpenAI/Gemini requests fail.
- "No AI API configured" when no API key is set.
