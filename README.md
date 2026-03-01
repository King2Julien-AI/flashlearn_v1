# FlashLearn — Offline flashcard trainer (Tauri v2 + Vite)

FlashLearn is a lightweight, offline-first flashcard / vocabulary trainer built with **Tauri v2** (Rust) and a **Vite** web frontend.

It started as a personal project out of frustration with overly complex study workflows (and yes, partly because I’ve wanted to build my own vocab trainer since high school). The goal is a **simple, fast, no-nonsense** study app that works fully offline.

> Status: **Alpha** (private testing). UI/UX is still evolving.

---

## Download & Install (recommended)

Grab the latest release from the GitHub Releases page:

* [https://github.com/King2Julien-AI/flashlearn_v1/releases](https://github.com/King2Julien-AI/flashlearn_v1/releases)

Each release contains platform installers for manual install **plus** updater artifacts, `latest.json`, and signature files (`.sig`) used by the in-app updater.

### macOS

Choose the correct `.dmg` for your Mac:

* **Apple Silicon (M1/M2/M3/…)**
* **Intel**

Install:

1. Open the DMG
2. Drag **FlashLearn.app** into **Applications**
3. Start the app from **Applications** or run:

```zsh
open -a FlashLearn
```

#### macOS: “App can’t be opened” (not notarized)

This app is currently **not notarized** (Developer ID / notarization costs money and this is private-use for now). macOS Gatekeeper will likely block it the first time.

If you trust the app, you can remove Apple’s quarantine flag **once**:

Run:
```zsh
xattr -dr com.apple.quarantine /Applications/FlashLearn.app
open -a FlashLearn
```

Then start the app again normally.

> ⚠️ Security note: I do my best to keep this project clean, but you install it at your own risk.

---

### Linux

Download:

* the `.AppImage` asset from the release

Install/run:

```bash
chmod +x FlashLearn*.AppImage
./FlashLearn*.AppImage
```

---

### Windows

Download:

* the `.msi` asset from the release

Install:

1. Run the `.msi`
2. If Windows SmartScreen warns you, click **More info → Run anyway**

---

## Auto-updates (Tauri updater)

Releases published by the GitHub Actions workflow include:

* `latest.json` (update manifest)
* updater bundles for each supported platform
* `.sig` files (signatures)

The app checks `https://github.com/King2Julien-AI/flashlearn_v1/releases/latest/download/latest.json` on startup. `latest.json` points to the signed updater bundles, while the DMG/AppImage/MSI assets remain available for direct manual installs.

---

## Project structure

* `web/` — frontend (Vite)
* `src-tauri/` — desktop shell (Tauri v2 / Rust)

---

## Development

### 1) Install dependencies

```bash
npm install
```

### 2) Run frontend (browser dev)

```bash
npm run dev
```

### 3) Run desktop app (Tauri dev)

```bash
npm run tauri:dev
```

### 4) Build desktop bundles/installers

```bash
npm run tauri:build
```

---

## Troubleshooting

### macOS: “App is damaged” / can’t be opened

This is usually Gatekeeper/quarantine. Remove quarantine:

```zsh
sudo xattr -dr com.apple.quarantine /Applications/FlashLearn.app
```

### Linux: AppImage won’t start

Make sure it’s executable:

```bash
chmod +x FlashLearn-*.AppImage
```

### Windows: SmartScreen warning

Use:
**More info → Run anyway**

---

## License / usage

Currently intended for **private use / testing**. (If/when this becomes public-facing, signing + notarization will be added.)

---
