import { check } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

function isTauriDesktop() {
  return !!window.__TAURI_INTERNALS__;
}

export async function checkForUpdates(options = {}) {
  const { silent = false, notifyNoUpdate = false } = options;

  if (!isTauriDesktop()) {
    if (!silent) {
      await message("Update checks are only available in the desktop app.", { title: "Desktop only" });
    }
    return { status: "unavailable" };
  }

  try {
    const update = await check();
    if (!update?.available) {
      if (notifyNoUpdate) {
        await message("You already have the latest version installed.", { title: "Up to date" });
      }
      return { status: "up-to-date" };
    }

    const ok = await ask(
      `Update available: ${update.version}\n\n${update.body ?? ""}\n\nInstall now?`,
      { title: "Update available", okLabel: "Update", cancelLabel: "Later" }
    );

    if (!ok) return { status: "declined", version: update.version };

    await update.downloadAndInstall();
    await message("Update installed. Restarting…", { title: "Updated" });
    await relaunch();
    return { status: "installed", version: update.version };
  } catch (error) {
    console.warn("Updater check failed", error);
    if (!silent) {
      await message(`Could not check for updates.\n\n${String(error?.message ?? error)}`, {
        title: "Update check failed"
      });
    }
    return { status: "error", error };
  }
}

export async function checkForUpdatesOnStartup() {
  await checkForUpdates({ silent: true });
}
