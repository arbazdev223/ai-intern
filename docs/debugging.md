# Debugging Guide

## Common Issues

### Missing API key
Symptoms:
- "No AI API configured"
- "AI service unavailable"

Fix:
- Set `OPENAI_API_KEY` or `GEMINI_API_KEY` in your environment or `.env`.

### OCR is slow or empty
Symptoms:
- OCR results are blank or take too long.

Fix:
- Verify Tesseract is installed via `tesseract.js` (already bundled).
- Try a higher-contrast screenshot.

### Consent OFF + screenshot
Symptoms:
- Screenshot analysis not used even with key.

Fix:
- Toggle "External AI: ON" to allow screen data to be sent externally.

## Reading Logs
Log tags are structured and safe (no prompt data):
- `[ai] request:start` / `[ai] request:end` / `[ai] request:error`
- `[ocr] start` / `[ocr] end`
- `[httpClient] retrying ...`
- `[startup] No AI API key set`

## Debugging Workflow
1. Reproduce the issue.
2. Check the console for the tags above.
3. Verify OpenAI/Gemini configuration.
