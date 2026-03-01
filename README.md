# FlashLearn — Offline flashcard study (Tauri v2 + Vite)

## Structure
- `web/` — frontend (Vite)
- `src-tauri/` — desktop shell (Tauri v2 / Rust)

## Commands

### 1) Install dependencies
```bash
npm install
```

### 2) Run in browser (web dev)
```bash
npm run dev
```

### 3) Run as desktop app (Tauri dev)
```bash
npm run tauri:dev
```

### 4) Build desktop bundles/installers
```bash
npm run tauri:build
```

This is a project originating from the frustration over ANKI since it has been too difficult and anoying to operate for me personally. Also since highschool I always wanted to build a vocab trainer which one can use this project for as well. It should be easy to operate (UI shall be improved) and intuitive in its functions. Thus there will be no time wasted getting to know the endless capabilities of your study app. This project is as of now in alpha testing and aims to be distributed as a normal application to be downloaded on macOS, Linux and Windows (since some people studying something related to programming still use named system).