# Project Guidelines & Rules for Fantasy Score

## 1. Version Bump After Each Commit / Release (CRITICAL)

Whenever changes are made to this codebase, **the application version MUST be bumped with/after each commit**.
This dynamic version mechanism ensures users immediately receive fresh CSS and JS updates, while preserving the browser's persistent cache for heavy assets (such as the ~85MB Kokoro ONNX model).

### Files that MUST stay in sync:
1. **`version.json`**:
   - Update `"version"` (e.g. `v1.2.2`).
   - Update `"build"` (current epoch timestamp in milliseconds, `Date.now()`).
   - Update `"commit"` (git short hash).
   - Update `"updatedAt"` (ISO 8601 UTC timestamp).
2. **`index.html`**:
   - Update `<link rel="stylesheet" id="app-styles" href="styles.css?v=X.X.X">`
   - Update `<script src="app.js?v=X.X.X"></script>`
   - Update `<span id="app-version">vX.X.X</span>` in the footer.
3. **`app.js`**:
   - Update `const APP_VERSION = 'vX.X.X';` on line 1.

> **Helper script**: You can run `node scripts/bump-version.js [patch|minor|major]` to automatically update all three files and fetch the latest git commit hash.

---

## 2. Voice & Audio Architecture
- **Strictly Kokoro TTS Only**: Voice generation must exclusively use `@huggingface/transformers` with `onnx-community/Kokoro-82M-ONNX` (`dtype: 'q8'`).
- **NO Native Browser TTS**: Do NOT use or fall back to `window.speechSynthesis`.
- **Audio Playback**: `KokoroTTS.generate()` returns a `RawAudio` instance (Float32Array waveform data). Play it via the Web Audio API (`AudioContext` / `AudioBufferSourceNode`) or Blob URL fallback (`raw.toBlob()`).

---

## 3. Cache Separation Strategy
- **Application Code**: Always bypass stale browser cache via `version.json` polling + versioned query strings (`?v=X.X.X`).
- **Heavy Assets**: The Kokoro ONNX weights and static graphics (`favicon.svg`) must NOT use random timestamps or cache-busting so they remain persistently cached in IndexedDB / CacheStorage.

---

## 4. UI & Layout Principles
- **Matchup Grid**: The team-vs-team starters view must remain side-by-side (2-column layout) even on mobile screens (`<= 640px`), utilizing compact starter cards.
- **Zero-Build Stack**: Maintain vanilla HTML, CSS, and JS without bundlers or compile steps.
