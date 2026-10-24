/**
 * Dashboard: a static single-page UI served at /dashboard. The shell contains
 * no data; the browser fetches /v1/status and /v1/usage/summary with the
 * local API key, so every data route still passes the auth middleware.
 *
 * The embedded JS deliberately avoids template literals so this file can be a
 * plain template string itself.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>miniroute dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0d1117; color: #e6edf3;
    font: 14px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 20px; border-bottom: 1px solid #21262d;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #3fb950; }
  #dot.err { background: #f85149; }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; }
  #gate {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 20px; max-width: 460px; margin: 60px auto; text-align: center;
  }
  #gate input {
    width: 100%; padding: 8px 10px; margin-top: 10px;
    background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px;
  }
  #gate button {
    margin-top: 10px; padding: 8px 16px; cursor: pointer;
    background: #238636; color: #fff; border: 0; border-radius: 6px; font-weight: 600;
  }
  #err { color: #f85149; margin: 0 0 12px; display: none; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px 14px; }
  .card .v { font-size: 20px; font-weight: 700; }
  .card .k { color: #8b949e; font-size: 12px; }
  .card .v.green { color: #3fb950; }
  h2 { font-size: 13px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #21262d; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 7px 12px; border-bottom: 1px solid #21262d; white-space: nowrap; }
  th { color: #8b949e; font-weight: 600; font-size: 12px; }
  td.num, th.num { text-align: right; }
  tr:last-child td { border-bottom: 0; }
  .ok { color: #3fb950; } .fail { color: #f85149; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .pill.open { background: #da3633; color: #fff; }
  .pill.closed { background: #1f6feb; color: #fff; }
  footer { color: #8b949e; font-size: 12px; padding: 16px 20px; }
</style>
</head>
<body>
<header>
  <span id="dot"></span>
  <h1>miniroute</h1>
  <span id="updated" style="color:#8b949e;font-size:12px"></span>
</header>
<main>
  <div id="gate">
    <strong>Local API key required</strong>
    <p style="color:#8b949e">Run <code>miniroute key</code> and paste it here. It is stored only in this browser.</p>
    <input id="key" type="password" placeholder="mr-...">
    <button onclick="saveKey()">Connect</button>
  </div>
  <div id="content" style="display:none">
    <p id="err"></p>
    <div class="cards">
      <div class="card"><div class="v" id="c-requests">0</div><div class="k">requests</div></div>
      <div class="card"><div class="v green" id="c-ok">0</div><div class="k">succeeded</div></div>
      <div class="card"><div class="v" id="c-in">0</div><div class="k">input tokens</div></div>
      <div class="card"><div class="v" id="c-out">0</div><div class="k">output tokens</div></div>
      <div class="card"><div class="v green" id="c-saved">0</div><div class="k">tokens saved by token saver</div></div>
    </div>
    <h2>Providers</h2>
    <table id="providers">
      <thead><tr><th>name</th><th>type</th><th>auth</th><th>accounts</th><th>breaker</th><th class="num">failures</th></tr></thead>
      <tbody></tbody>
    </table>
    <h2>Recent requests</h2>
    <table id="recent">
      <thead><tr><th>time</th><th>route</th><th>provider</th><th>model</th><th class="num">in</th><th class="num">out</th><th class="num">saved</th><th>ok</th><th class="num">ms</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</main>
<footer>config: ~/.miniroute/config.json &middot; hot-reloads on change &middot; token saver bypass: header x-miniroute-token-saver: off</footer>
<script>
  var KEY = localStorage.getItem('miniroute_key') || '';
  function saveKey() {
    KEY = document.getElementById('key').value.trim();
    localStorage.setItem('miniroute_key', KEY);
    refresh();
  }
  function fmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function api(path) {
    return fetch(path, { headers: { authorization: 'Bearer ' + KEY } });
  }
  function refresh() {
    if (!KEY) { document.getElementById('gate').style.display = 'block'; return; }
    document.getElementById('gate').style.display = 'none';
    document.getElementById('content').style.display = 'block';
    Promise.all([api('/v1/usage/summary'), api('/v1/status')]).then(function (rs) {
      if (rs[0].status === 401 || rs[1].status === 401) {
        var e = document.getElementById('err');
        e.textContent = 'Invalid API key - paste a fresh one from miniroute key.';
        e.style.display = 'block';
        document.getElementById('gate').style.display = 'block';
        document.getElementById('content').style.display = 'none';
        return;
      }
      e = document.getElementById('err');
      e.style.display = 'none';
      return Promise.all([rs[0].json(), rs[1].json()]).then(render);
    }).catch(function () {
      document.getElementById('dot').className = 'err';
    });
  }
  function render(summary, status) {
    document.getElementById('dot').className = '';
    document.getElementById('updated').textContent =
      'updated ' + new Date().toLocaleTimeString() + ' - auto-refresh 5s';
    var t = summary.totals;
    document.getElementById('c-requests').textContent = fmt(t.requests);
    document.getElementById('c-ok').textContent = fmt(t.ok_requests);
    document.getElementById('c-in').textContent = fmt(t.input_tokens);
    document.getElementById('c-out').textContent = fmt(t.output_tokens);
    document.getElementById('c-saved').textContent = fmt(t.saved_tokens || 0);
    var breakerByProvider = {};
    status.providers.forEach(function (p) { breakerByProvider[p.name] = p; });
    var rows = status.providers.map(function (p) {
      var b = p.breaker || {};
      var pill = b.open
        ? '<span class="pill open">OPEN</span>'
        : '<span class="pill closed">closed</span>';
      return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.type) + '</td><td>' + esc(p.auth) +
        '</td><td>' + esc(p.accounts) + '</td><td>' + pill + '</td><td class="num">' +
        (b.consecutiveFailures || 0) + '</td></tr>';
    }).join('');
    document.querySelector('#providers tbody').innerHTML = rows;
    var recents = (summary.recent || []).map(function (r) {
      var time = new Date(r.ts).toLocaleTimeString();
      var ok = r.ok ? '<span class="ok">ok</span>' : '<span class="fail">fail</span>';
      return '<tr><td>' + esc(time) + '</td><td>' + esc(r.route) + '</td><td>' + esc(r.provider) +
        '</td><td>' + esc(r.model) + '</td><td class="num">' + fmt(r.input_tokens) +
        '</td><td class="num">' + fmt(r.output_tokens) + '</td><td class="num">' + fmt(r.saved_tokens || 0) +
        '</td><td>' + ok + '</td><td class="num">' + r.duration_ms + '</td></tr>';
    }).join('');
    document.querySelector('#recent tbody').innerHTML = recents;
  }
  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>
`;
