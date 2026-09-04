import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const ALLOWED = new Set(["openai", "anthropic", "google", "xai", "opencode"]);

export function loginProviderId(id: string): string | undefined {
  if (!ALLOWED.has(id)) return undefined;
  return id;
}

export function startProviderLogin(
  id: string,
  spawnImpl: typeof spawn = spawn
): boolean {
  const provider = loginProviderId(id);
  if (!provider) return false;
  const bin = join(homedir(), ".opencode/bin/opencode");
  const script = `${bin} providers login -p ${provider}`;
  spawnImpl("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`], {
    detached: true,
    stdio: "ignore",
  }).unref();
  return true;
}
