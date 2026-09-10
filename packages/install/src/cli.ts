import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { runInstall, type InstallClient, type RunInstallInput } from "./clients.js";

const CLIENTS: InstallClient[] = ["claude", "codex", "opencode", "cursor"];
export const INSTALL_USAGE = "usage: auto-router install [--claude] [--codex] [--opencode] [--cursor] [--uninstall] [--base-url <url>]";

export interface InstallCliOptions {
  clients: InstallClient[];
  uninstall: boolean;
  baseUrl: string;
}

export interface InstallCliIO {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

function normalizeBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return value.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function parseInstallArgs(args: string[]): InstallCliOptions | { help: true } | { error: string } {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const selected: InstallClient[] = [];
  let uninstall = false;
  let baseUrl = "http://127.0.0.1:8787";
  let baseSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--uninstall") {
      if (uninstall) return { error: `error: duplicate flag ${arg}\n${INSTALL_USAGE}\n` };
      uninstall = true;
      continue;
    }
    if (arg === "--base-url") {
      if (baseSeen) return { error: `error: duplicate flag ${arg}\n${INSTALL_USAGE}\n` };
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: `error: ${arg} requires a value\n${INSTALL_USAGE}\n` };
      const normalized = normalizeBaseUrl(value);
      if (!normalized) return { error: `error: invalid base URL\n${INSTALL_USAGE}\n` };
      baseUrl = normalized;
      baseSeen = true;
      index += 1;
      continue;
    }
    const client = arg.startsWith("--") ? arg.slice(2) : "";
    if (CLIENTS.includes(client as InstallClient)) {
      if (selected.includes(client as InstallClient)) return { error: `error: duplicate flag ${arg}\n${INSTALL_USAGE}\n` };
      selected.push(client as InstallClient);
      continue;
    }
    return { error: `error: unknown flag or argument ${arg}\n${INSTALL_USAGE}\n` };
  }
  return { clients: selected.length ? selected : [...CLIENTS], uninstall, baseUrl };
}

export async function mainInstall(
  args: string[] = process.argv.slice(2),
  io: InstallCliIO = { stdout: process.stdout, stderr: process.stderr },
  home = homedir(),
  install: (input: RunInstallInput) => { written: string[]; notes: string[] } = runInstall,
): Promise<number> {
  const parsed = parseInstallArgs(args);
  if ("help" in parsed) {
    io.stdout.write(`${INSTALL_USAGE}\n`);
    return 0;
  }
  if ("error" in parsed) {
    io.stderr.write(parsed.error);
    return 2;
  }
  try {
    const result = install({ home, ...parsed });
    for (const path of result.written) io.stdout.write(`${path}\n`);
    for (const note of result.notes) io.stdout.write(`${note}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`error: ${error instanceof Error ? error.message : "installation failed"}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await mainInstall();
}
