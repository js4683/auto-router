import { ENV_KEYS } from "./env-file.js";

export function settingsPage(masked: Record<string, string>): string {
  const rows = ENV_KEYS.map((key) => {
    const state = masked[key] === "set" ? "set" : "missing";
    return `<label>${key} (${state})<input type="password" name="${key}" autocomplete="off"></label>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>auto-router</title></head><body><h1>auto-router</h1><form method="post" action="/settings">${rows}<button type="submit">Save</button></form></body></html>`;
}
