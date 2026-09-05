import { homedir } from "node:os";
import { runInstall, type InstallClient } from "./clients.js";

const CLIENTS: InstallClient[] = ["claude", "codex", "opencode", "cursor"];

function parse(args: string[]): { clients: InstallClient[]; uninstall: boolean; baseUrl: string } {
  const clients = CLIENTS.filter((name) => args.includes(`--${name}`));
  const baseIndex = args.indexOf("--base-url");
  const baseUrl = baseIndex >= 0 && args[baseIndex + 1] ? args[baseIndex + 1] : "http://127.0.0.1:8787";
  return { clients: clients.length ? clients : CLIENTS, uninstall: args.includes("--uninstall"), baseUrl };
}

const parsed = parse(process.argv.slice(2));
const result = runInstall({ home: homedir(), ...parsed });
for (const path of result.written) console.log(path);
for (const note of result.notes) console.log(note);
