# Architecture Overview

## Structure
- **Main process** (`src/main`): window lifecycle, IPC handlers, AI routing, OCR services, tray/shortcuts.
- **Renderer** (`src/renderer`): UI, chat state, rendering, attachments, prompt library.
- **Shared** (`src/shared`): constants and prompt building logic shared across contexts.

## IPC Flow
Renderer calls the `assistantAPI` bridge in `preload.js`. IPC channels are registered in `src/main/ipcHandlers.js`.

Key channels:
- `ai:generate`: AI requests
- `assistant:extract-ocr`: OCR text extraction
- `assistant:store-screenshot`: save screenshot to disk
- `capture-screen`: capture screen image

## AI Pipeline
1. Renderer builds prompt context and sends request via IPC.
2. Main process routes to:
   - OpenAI (if key present and consent allows screen data)
   - Gemini (if OpenAI unavailable)
3. Response is returned to renderer for Markdown rendering and display.

## OCR Pipeline
1. Renderer captures screenshot.
2. Main process extracts OCR text (downscaled image for performance).
3. OCR text is merged into the prompt when screenshot analysis is requested.

## Data/State Storage
- Chat sessions are stored in `localStorage` on the renderer side.
- Screenshots are saved to the Electron userData directory.

## Text Diagram
User -> Renderer -> IPC -> Main -> (OpenAI | Gemini | OCR) -> IPC -> Renderer -> UI
