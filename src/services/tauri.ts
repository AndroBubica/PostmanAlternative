import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export function nativeInvoke<T>(command: string, args?: Record<string, unknown>) {
  return invoke<T>(command, args);
}

export function chooseInputFile(options: Parameters<typeof open>[0] = {}) {
  return open({ multiple: false, directory: false, ...options });
}

export function chooseOutputFile(options: Parameters<typeof save>[0]) {
  return save(options);
}
