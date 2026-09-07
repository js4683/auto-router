import type { ProviderQuota } from "./quota.js";

export interface ProviderRow {
  id: string;
  accountId?: string;
  label: string;
  envKey: string;
  login: boolean;
  envSet: boolean;
  expires?: number;
  email?: string;
  plan?: string;
  quota?: ProviderQuota;
}

export interface RouteRow {
  at: number;
  via: string;
  modelId: string;
  status?: number;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function status(p: ProviderRow): { cls: string; text: string } {
  if (p.quota?.limited) return { cls: "err", text: "Rate limited" };
  if (p.login && p.expires && p.expires < Date.now()) return { cls: "warn", text: "Login expired" };
  if (p.login) return { cls: "ok", text: "Logged in" };
  if (p.envSet) return { cls: "ok", text: "API key" };
  return { cls: "no", text: "Not connected" };
}

function accountTitle(p: ProviderRow): string {
  const prefix: Record<string, string> = { openai: "codex", anthropic: "claude", xai: "xai", google: "gemini", opencode: "zen" };
  if (p.email) return `${prefix[p.id] ?? p.id}-${p.email}`;
  if (p.accountId) return `${prefix[p.id] ?? p.id}-extra-${p.accountId.slice(0, 8)}`;
  return p.label;
}

function tone(percent: number): string {
  if (percent >= 80) return "err";
  if (percent >= 50) return "warn";
  return "ok";
}

function bar(percent: number): string {
  const width = Math.max(0, Math.min(100, percent));
  return `<div class="bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}"><span class="fill ${tone(width)}" style="width:${width}%"></span></div>`;
}

export const UI_STYLES = `
:root { color-scheme: dark; --bg:#0e0e0e; --side:#111111; --panel:#161616; --fg:#ececec; --muted:#8a8a8a; --line:#2a2a2a; --ok:#3dd68c; --warn:#e6b84c; --err:#f07178; --no:#8a8a8a; --btn:#ececec; --btn-fg:#111; }
* { box-sizing: border-box; }
body { margin:0; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
a { color:var(--fg); }
.shell { display:flex; min-height:100vh; }
nav { width:15.5rem; background:var(--side); border-right:1px solid var(--line); padding:1.25rem 0.85rem; flex-shrink:0; }
.brand { font-weight:700; letter-spacing:0.04em; font-size:0.75rem; margin:0 0.5rem 1.25rem; }
.brand span { display:block; color:var(--muted); font-weight:500; letter-spacing:0; text-transform:none; margin-top:0.15rem; }
nav a { display:block; text-decoration:none; padding:0.45rem 0.65rem; border-radius:0.4rem; color:var(--muted); font-size:0.8125rem; }
nav a:hover, nav a.active { background:#1c1c1c; color:var(--fg); }
.group { font-size:0.65rem; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted); margin:1rem 0.65rem 0.35rem; }
main { flex:1; padding:1.5rem 1.5rem 3rem; min-width:0; }
header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
h1 { font-size:1.5rem; font-weight:650; margin:0; letter-spacing:-0.03em; }
.sub { color:var(--muted); margin:0.25rem 0 0; font-size:0.8125rem; }
.chips { display:flex; gap:0.4rem; flex-wrap:wrap; margin:0 0 1rem; }
.chip { border:1px solid var(--line); background:transparent; color:var(--muted); padding:0.3rem 0.65rem; font:inherit; cursor:pointer; border-radius:999px; }
.chip.on { color:var(--fg); border-color:#3a3a3a; background:#1a1a1a; }
.grid { display:grid; grid-template-columns:1fr; gap:0.85rem; }
@media (min-width: 900px) { .grid { grid-template-columns:1fr 1fr 1fr; } }
.card { border:1px solid var(--line); background:var(--panel); padding:1rem 1rem 0.9rem; border-radius:0.75rem; }
.row { display:flex; align-items:flex-start; justify-content:space-between; gap:0.75rem; }
.card h3 { font-size:0.8125rem; font-weight:600; margin:0; word-break:break-word; }
.meta { font-size:0.75rem; color:var(--muted); margin:0.35rem 0 0.75rem; }
.pill { font-size:0.6875rem; letter-spacing:0.04em; text-transform:uppercase; border:1px solid var(--line); padding:0.15rem 0.4rem; color:var(--no); white-space:nowrap; }
.pill.ok { color:var(--ok); border-color:#1f5c40; }
.pill.warn { color:var(--warn); border-color:#6b5420; }
.pill.err { color:var(--err); border-color:#6b3034; }
.hint { margin:0.4rem 0 0.75rem; font-size:0.75rem; color:var(--muted); }
.meter { margin:0.65rem 0 0.15rem; }
.meter .lab { display:flex; justify-content:space-between; gap:0.5rem; font-size:0.75rem; margin-bottom:0.25rem; }
.bar { height:0.35rem; background:#2a2a2a; border-radius:99px; overflow:hidden; }
.fill { display:block; height:100%; background:var(--ok); }
.fill.warn { background:var(--warn); }
.fill.err { background:var(--err); }
label { display:block; font-size:0.75rem; color:var(--muted); margin-bottom:0.25rem; }
input { width:100%; background:#0c0c0c; color:var(--fg); border:1px solid var(--line); padding:0.5rem 0.6rem; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; border-radius:0.4rem; }
input:focus, a:focus, button:focus { outline:2px solid #6e7380; outline-offset:2px; }
a.login { display:inline-block; margin:0.5rem 0 0.75rem; color:var(--fg); border:1px solid var(--line); padding:0.35rem 0.65rem; text-decoration:none; font-size:0.8125rem; font-weight:600; border-radius:999px; }
button.remove { display:inline-block; margin:0.5rem 0 0.75rem; background:none; color:var(--muted); border:1px solid var(--line); padding:0.35rem 0.65rem; font: inherit; font-size:0.8125rem; font-weight:600; border-radius:999px; cursor:pointer; }
.note { font-size:0.8125rem; color:var(--muted); margin:1rem 0; }
.actions { display:flex; gap:0.5rem; flex-wrap:wrap; }
button.save, #refresh-quota { background:var(--btn); color:var(--btn-fg); border:0; padding:0.5rem 0.9rem; font: inherit; font-weight:600; cursor:pointer; border-radius:999px; }
details.keys { margin-top:1.25rem; border:1px solid var(--line); border-radius:0.75rem; padding:0.75rem 1rem; background:var(--panel); }
details.keys summary { cursor:pointer; color:var(--muted); font-size:0.8125rem; }
table { width:100%; border-collapse:collapse; font-size:0.8125rem; }
th, td { text-align:left; padding:0.45rem 0.5rem; border-bottom:1px solid var(--line); }
th { color:var(--muted); font-weight:600; font-size:0.75rem; }
td.mono { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.empty { color:var(--muted); font-size:0.8125rem; margin:0; }
h2 { font-size:1rem; margin:1.5rem 0 0.75rem; font-weight:650; }
@media (max-width: 720px) { .shell { display:block; } nav { width:auto; border-right:0; border-bottom:1px solid var(--line); } }
`;

function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (!seen.has(id)) seen.set(id, row);
  }
  return [...seen.values()];
}

export function settingsPage(providers: ProviderRow[], healthy: boolean, routes: RouteRow[] = []): string {
  const connected = providers.filter((p) => p.login || p.envSet).length;
  const limited = providers.filter((p) => p.quota?.limited).length;
  const connectLinks = uniqueBy(providers, (p) => p.id);
  const keyRows = uniqueBy(providers, (p) => p.envKey);
  const cards = providers
    .map((p) => {
      const st = status(p);
      const meters = [...(p.quota?.meters ?? [])];
      if (p.quota?.limited && meters.length === 0) meters.push({ label: "Rate limit", used: 1, limit: 1, remaining: 0, percent: 100 });
      const meterHtml = meters
        .map(
          (m) => `<div class="meter"><div class="lab"><span>${esc(m.label)}</span><strong>${m.percent}%</strong></div>${bar(m.percent)}<p class="hint">${m.resetLabel ? `Resets ${esc(m.resetLabel)}` : `${m.remaining} / ${m.limit} remaining`}</p></div>`,
        )
        .join("");
      const emptyQuota = meterHtml ? "" : `<p class="hint">No quota sample yet. Click Refresh quota.</p>`;
      const remove = p.accountId
        ? `<button type="button" class="login remove" data-remove="${esc(p.accountId)}">Remove</button>`
        : "";
      return `<article class="card" data-provider="${esc(p.id)}">
  <div class="row">
    <h3>${esc(accountTitle(p))}</h3>
    <span class="pill ${st.cls}">${esc(st.text)}</span>
  </div>
  <p class="meta">${p.plan ? `Plan ${esc(p.plan)}` : esc(p.label)}</p>
  ${meterHtml}${emptyQuota}
  <p class="actions"><a class="login" href="/connect/${esc(p.id)}">Add account</a>${remove}</p>
</article>`;
    })
    .join("");
  const routeRows = routes.length
    ? routes
        .map(
          (r) =>
            `<tr><td>${new Date(r.at).toISOString().slice(11, 19)}</td><td>${esc(r.via)}</td><td class="mono">${esc(r.modelId)}</td><td>${r.status ?? ""}</td></tr>`,
        )
        .join("")
    : "";
  const routeBody = routes.length
    ? `<table><thead><tr><th>Time (UTC)</th><th>Via</th><th>Model</th><th>HTTP</th></tr></thead><tbody>${routeRows}</tbody></table>`
    : `<p class="empty">No routes yet.</p>`;
  const chips = [
    ["all", "All"],
    ["anthropic", "Claude"],
    ["google", "Gemini"],
    ["openai", "Codex"],
    ["xai", "xAI"],
    ["opencode", "Zen"],
  ]
    .map(([id, label], index) => `<button type="button" class="chip${index === 0 ? " on" : ""}" data-filter="${id}">${label}</button>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="12">
<title>Quota Management · auto-router</title>
<style>${UI_STYLES}</style>
</head>
<body>
<div class="shell">
<nav aria-label="Console">
  <p class="brand">AUTO-ROUTER<span>Local proxy console</span></p>
  <p class="group">Operate</p>
  <a class="active" href="#quota">Quota Management</a>
  <a href="#accounts">Accounts</a>
  <p class="group">Observe</p>
  <a href="#routes">Recent routes</a>
  <p class="group">Auth</p>
  ${connectLinks.map((p) => `<a href="/connect/${esc(p.id)}">${esc(p.label)}</a>`).join("")}
</nav>
<main>
<header>
  <div>
    <h1 id="quota">Quota Management</h1>
    <p class="sub">${connected} logged in · ${limited} limited · proxy ${healthy ? "up" : "down"} · 127.0.0.1:8787</p>
  </div>
  <div class="actions"><button type="button" id="refresh-quota">Refresh quota</button></div>
</header>
<div class="chips" role="tablist">${chips}</div>
<div class="grid" id="accounts">
${cards}
<article class="card" data-provider="cursor">
  <div class="row"><h3>Cursor</h3><span class="pill">client only</span></div>
  <p class="meta">No Cursor Pro quota. Point the client at this proxy.</p>
</article>
</div>
<form method="post" action="/settings">
<details class="keys">
  <summary>API keys</summary>
  ${keyRows
    .map(
      (p) => `<p><label for="${esc(p.envKey)}">${esc(p.envKey)}</label><input id="${esc(p.envKey)}" name="${esc(p.envKey)}" type="password" autocomplete="off" spellcheck="false"></p>`,
    )
    .join("")}
  <p class="note">Leave blank to keep the current key.</p>
  <button class="save" type="submit">Save keys</button>
</details>
</form>
<h2 id="routes">Recent routes</h2>
<div class="card">${routeBody}</div>
</main>
</div>
<script>
document.querySelectorAll("[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.getAttribute("data-filter");
    document.querySelectorAll("[data-filter]").forEach((el) => el.classList.toggle("on", el === btn));
    document.querySelectorAll("[data-provider]").forEach((card) => {
      card.hidden = id !== "all" && card.getAttribute("data-provider") !== id;
    });
  });
});
document.getElementById("refresh-quota")?.addEventListener("click", async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try { await fetch("/quota/refresh", { method: "POST" }); } catch {}
  location.reload();
});
document.querySelectorAll("[data-remove]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const id = btn.getAttribute("data-remove");
    if (!confirm("Remove account " + id + "?")) return;
    btn.disabled = true;
    try {
      await fetch("/accounts/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch {}
    location.reload();
  });
});
</script>
</body>
</html>`;
}
