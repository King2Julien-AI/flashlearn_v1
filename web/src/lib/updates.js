import { check } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

export async function checkForUpdatesOnStartup() {
  // Only run inside Tauri (not in browser dev)
  if (!window.__TAURI_INTERNALS__) return;

  try {
    const update = await check();
    if (!update?.available) return;

    const ok = await ask(
      `Update available: ${update.version}\n\n${update.body ?? ""}\n\nInstall now?`,
      { title: "Update available", okLabel: "Update", cancelLabel: "Later" }
    );

    if (!ok) return;

    await update.downloadAndInstall();
    await message("Update installed. Restarting…", { title: "Updated" });
    await relaunch();
  } catch {
    // Silent on startup by design (no scary popups)
  }
}