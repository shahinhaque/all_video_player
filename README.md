# CloudPlay – Lightweight Cloud Video Player

A lightweight, cross-browser (Chrome & Firefox) Manifest V3 extension designed to stream video files—**MPEG-TS (`.ts`) first**, plus MP4, MKV, WebM, and HLS—directly from **MEGA, Google Drive, and OneDrive** share links.

## Key Features
- **MPEG-TS First**: Custom transmuxing pipeline to MSE with random-access seeking and memory-capped sliding window buffer.
- **Direct Cloud Streaming**: Range-based byte streaming directly from Google Drive, OneDrive, and MEGA (with client-side WebCrypto AES-CTR streaming decryption).
- **Playlist & Navigation**: Natural alphanumeric sorting ("Ep 2" before "Ep 10"), auto-play next, previous navigation, playback position resume, and Media Session API support.
- **Ultra-lightweight**: Vanilla TypeScript core, zero bulky UI frameworks, lazy-loaded codecs and engines, strict gzipped bundle size budget (< 150 KB).

## Project Structure
- `PLAN.md` - Comprehensive 11-phase implementation plan and architectural specification.
- `src/core/` - Core contracts, types, and unified error handling.
- `src/lib/` - Browser polyfills, media sniffers, streams, and utility helpers.
- `src/providers/` - Provider implementations for Google Drive, OneDrive, and MEGA.
- `src/engines/` - Playback engines (Native `<video>`, TS via transmuxer to MSE).
- `src/player/` - Standalone player UI page.
- `src/background/` - Extension service worker / background event page.
- `src/content/` - Lightweight content scripts for cloud web interfaces.
- `scripts/build.mjs` - esbuild script with per-browser manifest generation and size-budget checking.

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Build for Chrome (dist/chrome)
npm run build:chrome

# Build for Firefox (dist/firefox)
npm run build:firefox

# Build both targets
npm run build
```
