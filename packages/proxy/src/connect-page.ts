export interface ConnectPageInput {
  id: string;
  label: string;
  consoleUrl: string;
  oauth: boolean;
}

export function connectPage(input: ConnectPageInput): string {
  const oauth = input.oauth
    ? `<section>
  <h2>Subscription login</h2>
  <p id="code" class="code" hidden></p>
  <p><a id="open" class="btn" href="#" hidden target="_blank" rel="noreferrer">Open ${input.label} login</a></p>
  <form id="paste" hidden method="post" action="/connect/${input.id}/oauth/code">
    <input type="hidden" name="id" id="sid">
    <label for="authcode">Authorization code</label>
    <input id="authcode" name="code" autocomplete="off" required>
    <button class="btn" type="submit">Connect</button>
  </form>
  <p id="status">Starting…</p>
</section>
<script>
const id = ${JSON.stringify(input.id)};
async function start() {
  const res = await fetch("/connect/" + id + "/oauth/start", { method: "POST" });
  const data = await res.json();
  if (data.error) { document.getElementById("status").textContent = data.error; return; }
  const open = document.getElementById("open");
  open.hidden = false;
  open.href = data.url;
  if (data.method === "code") {
    document.getElementById("paste").hidden = false;
    document.getElementById("sid").value = data.id;
    document.getElementById("status").textContent = "Open login, then paste the code shown after you approve.";
    return;
  }
  if (data.method === "redirect") {
    document.getElementById("status").textContent = "Opening Google login…";
    location.href = data.url;
    return;
  }
  const code = document.getElementById("code");
  code.hidden = false;
  code.textContent = "Code: " + data.user_code;
  document.getElementById("status").textContent = "Open the login page, enter the code, then wait here.";
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch("/connect/" + id + "/oauth/poll?id=" + encodeURIComponent(data.id));
    const body = await poll.json();
    if (body.done) { document.getElementById("status").textContent = "Connected. Redirecting…"; location.href = "/"; return; }
    if (body.error) { document.getElementById("status").textContent = body.error; return; }
  }
}
start();
</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${input.label}</title>
<style>
:root { color-scheme: dark; --bg:#111113; --fg:#ececec; --muted:#9a9aa3; --line:#2a2a30; --btn:#ececec; --btn-fg:#111113; }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
main { max-width:36rem; margin:0 auto; padding:2rem 1.25rem; }
a { color:var(--fg); }
.btn { display:inline-block; background:var(--btn); color:var(--btn-fg); text-decoration:none; padding:0.5rem 0.85rem; font-weight:600; border:0; cursor:pointer; }
label, input { display:block; width:100%; }
input { margin:0.35rem 0 0.75rem; background:#0c0c0e; color:var(--fg); border:1px solid var(--line); padding:0.5rem; font:13px ui-monospace, Menlo, monospace; }
.code { font:18px ui-monospace, Menlo, monospace; letter-spacing:0.08em; }
.muted { color:var(--muted); font-size:0.875rem; }
h1 { font-size:1.25rem; }
section { border:1px solid var(--line); padding:1rem; margin:1rem 0; }
</style>
</head>
<body>
<main>
<p><a href="/">← auto-router</a></p>
<h1>Connect ${input.label}</h1>
${oauth}
<section>
  <h2>API key</h2>
  <p class="muted">Opens the provider site. Paste a key if you use keys instead of a subscription.</p>
  <p><a class="btn" href="${input.consoleUrl}" target="_blank" rel="noreferrer">Open ${input.label}</a></p>
  <form method="post" action="/connect/${input.id}/key">
    <label for="key">API key</label>
    <input id="key" name="key" type="password" autocomplete="off" required>
    <button class="btn" type="submit">Save key</button>
  </form>
</section>
</main>
</body>
</html>`;
}
