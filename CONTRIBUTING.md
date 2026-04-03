# Contributing to IFDA AI

Thanks for improving IFDA AI. Keep changes small, safe, and easy to review.

## Setup
```
npm install
npm start
```

Optional for OpenAI:
- Set `OPENAI_API_KEY` in your environment or `.env`.

## Tests
```
npm test
npm run test:watch
```

## Coding Guidelines
- Prefer small, focused changes.
- Keep logic split between `main`, `renderer`, and `shared`.
- Avoid heavy dependencies unless justified.
- Keep UI changes minimal and consistent with existing styles.

## Security Rules
- Never commit secrets or API keys.
- Validate IPC inputs in `src/main/ipcHandlers.js`.
- Respect the consent toggle before sending screen data externally.
- Do not log prompt content or screenshot data.

## Pull Request Checklist
- Tests added or updated (if behavior changed).
- No secrets in code or docs.
- Privacy and consent logic preserved.
