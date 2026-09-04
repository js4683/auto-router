export interface ProviderRow {
  id: string;
  label: string;
  envKey: string;
  login: boolean;
  envSet: boolean;
}

function pill(ok: boolean, okText: string, noText: string): string {
  const cls = ok ? "ok" : "no";
  return `<span class="pill ${cls}">${ok ? okText : noText}</span>`;
}

export function settingsPage(providers: ProviderRow[], healthy: boolean): string {
  const cards = providers
    .map(
      (p) => `<article class="card">
  <div class="row">
    <h2>${p.label}</h2>
    <div class="pills">${pill(p.login, "login", "no login")} ${pill(p.envSet, "api key", "no key")}</div>
  </div>
  <p class="hint">Uses OpenCode/Claude login first, then this key.</p>
  <label for="${p.envKey}">${p.envKey}</label>
  <input id="${p.envKey}" name="${p.envKey}" type="password" autocomplete="off" spellcheck="false">
</article>`
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>auto-router</title>
<style>
:root { color-scheme: dark; --bg:#111113; --fg:#ececec; --muted:#9a9aa3; --line:#2a2a30; --ok:#8fd19a; --no:#c9c9ce; --btn:#ececec; --btn-fg:#111113; }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
main { max-width: 36rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
header { display:flex; align-items:baseline; justify-content:space-between; gap:1rem; margin-bottom:1.5rem; border-bottom:1px solid var(--line); padding-bottom:1rem; }
h1 { font-size:1.125rem; font-weight:600; margin:0; letter-spacing:-0.02em; }
.status { font-size:0.8125rem; color:var(--muted); }
.card { border:1px solid var(--line); padding:1rem 1rem 1.125rem; margin:0 0 0.75rem; }
.row { display:flex; align-items:center; justify-content:space-between; gap:0.75rem; }
h2 { font-size:0.9375rem; font-weight:600; margin:0; }
.pills { display:flex; gap:0.375rem; flex-wrap:wrap; }
.pill { font-size:0.6875rem; letter-spacing:0.04em; text-transform:uppercase; border:1px solid var(--line); padding:0.15rem 0.4rem; color:var(--no); }
.pill.ok { color:var(--ok); border-color:#2f5c38; }
.hint { margin:0.35rem 0 0.75rem; font-size:0.75rem; color:var(--muted); }
label { display:block; font-size:0.75rem; color:var(--muted); margin-bottom:0.25rem; }
input { width:100%; background:#0c0c0e; color:var(--fg); border:1px solid var(--line); padding:0.5rem 0.6rem; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
input:focus { outline:1px solid #6e6e78; }
.note { font-size:0.8125rem; color:var(--muted); margin:1rem 0; }
button { margin-top:0.5rem; background:var(--btn); color:var(--btn-fg); border:0; padding:0.55rem 1rem; font: inherit; font-weight:600; cursor:pointer; }
button:focus { outline:2px solid #6e6e78; outline-offset:2px; }
</style>
</head>
<body>
<main>
<header>
  <h1>auto-router</h1>
  <p class="status">${healthy ? "proxy up · 127.0.0.1:8787" : "proxy down"}</p>
</header>
<form method="post" action="/settings">
${cards}
<article class="card">
  <div class="row"><h2>Cursor</h2><span class="pill">client only</span></div>
  <p class="hint">Point Cursor at this proxy. Cursor Pro login cannot be used.</p>
</article>
<p class="note">Leave a field blank to keep the current key. Restart the proxy after save if routes still miss keys.</p>
<button type="submit">Save keys</button>
</form>
</main>
</body>
</html>`;
}
