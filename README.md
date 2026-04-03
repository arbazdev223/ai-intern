# IFDA AI (Electron Desktop Assistant)

IFDA AI is a lightweight Electron desktop assistant that uses OpenAI or Gemini for chat + vision, with OCR-powered screenshot analysis.

## Features
- OpenAI or Gemini chat + vision (requires API key)
- Screenshot capture and OCR (Tesseract)
- Privacy consent toggle for sending screen data externally
- IPC-based architecture (main + renderer separation)

## Quick Start (5 minutes)
1. Install dependencies:
```
npm install
```

2. Run the app:
```
npm start
```

## Environment Variables
Optional (for external AI usage):
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `OPENAI_VISION_MODEL` (default: `gpt-4o-mini`)
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (default: `gemini-1.5-flash`)
- `GEMINI_VISION_MODEL` (default: `gemini-1.5-flash`)
- `IFDA_UPDATE_OWNER` (GitHub owner for releases)
- `IFDA_UPDATE_REPO` (GitHub repo name for releases)
- `GITHUB_TOKEN` (only required for private repo auto-updates)

Use `.env.example` as a reference for local setup.

## Tests
```
npm test
```

Watch mode:
```
npm run test:watch
```

## Privacy Notes
- The app needs at least one API key (`OPENAI_API_KEY` or `GEMINI_API_KEY`) to generate AI responses.
- Screenshots and OCR text are never sent externally unless the consent toggle is ON.
- The consent toggle is visible in the composer area as "External AI: ON/OFF".

## Repository Tour
- `src/main`: Electron main process (IPC, window management, AI routing)
- `src/renderer`: UI and chat logic
- `src/shared`: shared constants and prompt construction
- `tools`: web search helper

For deeper details, see:
- `docs/architecture.md`
- `docs/ai-system.md`
- `docs/debugging.md`

## App Updates (No repeated EXE sharing)
One-time install ke baad app auto-update kar sakti hai.

### How it works
- App startup par update check hota hai (packaged mode).
- Naya release mile to update background me download hota hai.
- Download complete hone par install prompt aata hai.

### Release process for maintainers
1. Version bump in `package.json`.
2. Commit and push.
3. Tag create and push:
	- `git tag v1.0.2`
	- `git push origin v1.0.2`
4. GitHub Actions workflow `Release - Windows` NSIS build publish karega.

### Manual publish command (Windows)
`npm run release:win`
