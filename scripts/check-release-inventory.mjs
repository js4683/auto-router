import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT_FILES = new Set([
  ".gitignore",
  "PLAN.md",
  "README.md",
  "auto-router.json",
  "auto-router.schema.json",
  "demo.ts",
  "design.md",
  "package-lock.json",
  "package.json",
  "roadmap.md",
  "tsconfig.json",
]);

function isApprovedFixture(path) {
  return /(^|\/)fixtures?\//.test(path) && !/(^|\/)(?:private|production|real)[^/]*\.(?:json|jsonl|md)$/i.test(path);
}

function isAllowedLocation(path) {
  if (ROOT_FILES.has(path)) return true;
  if (/^(?:\.github|\.opencode\/plugins|docs|scripts)\//.test(path)) return true;
  if (!/^packages\/[^/]+\//.test(path)) return false;
  if (/^packages\/[^/]+\/(?:src|tests|fixtures)\//.test(path)) return true;
  return /^packages\/[^/]+\/(?:package\.json|package-lock\.json|tsconfig(?:\.[^/]+)?\.json)$/.test(path)
    || isApprovedFixture(path);
}

function inventoryViolation(path) {
  const lower = path.toLowerCase();
  const name = path.split("/").pop() ?? path;
  if (/^\.env(?:\.|$)/i.test(name) && name !== ".env.example") return "environment file";
  if (/(?:^|[._-])private(?:[._-]|$)|private-output/i.test(name)) return "private output marker";
  if (/(?:\.local\.|\.credentials\.|\.secret\.)/i.test(name)) return "local or secret output";
  if (/(?:^|\/)(?:\.eval-recordings|recordings?|vectors?|artifacts?)\//i.test(path) && !isApprovedFixture(path)) return "unapproved artifact directory";
  if (/(?:response|recording|vector|corpus|artifact|credential|secret)/i.test(name)
      && !isApprovedFixture(path)
      && !/(?:\.(?:ts|tsx|js|mjs|md)$|^package(?:-lock)?\.json$)/i.test(name)) {
    return "generated evaluation or credential output";
  }
  if (!isAllowedLocation(path)) return "unapproved release location";
  if (lower.includes("/node_modules/")) return "dependency output";
  return undefined;
}

export function checkReleaseInventory(paths) {
  return paths.map((path) => ({ path, reason: inventoryViolation(path) })).filter((item) => item.reason);
}

export function trackedCandidatePaths(root = process.cwd()) {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean).filter((path) => {
    const absolute = resolve(root, path);
    return existsSync(absolute) && !statSync(absolute).isDirectory();
  });
}

export function main(root = process.cwd()) {
  const violations = checkReleaseInventory(trackedCandidatePaths(root));
  if (violations.length) {
    for (const violation of violations) console.error(`${violation.path}: ${violation.reason}`);
    return 1;
  }
  console.log("release inventory: OK");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
