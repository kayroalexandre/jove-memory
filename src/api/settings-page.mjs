/**
 * The settings page.
 *
 * A single HTML string, served by the same process as the API, because the
 * alternative is a build step and a bundle for a form with one field.
 *
 * Three things it deliberately is not:
 *
 *   - **Not a place the key can be read back from.** The form is
 *     write-only. After saving, the field is cleared and the response carries
 *     a fingerprint, never the value. A settings page that can display a
 *     secret is a settings page that puts it in a screenshot.
 *   - **Not a place the key is sent anywhere but this machine.** The page is
 *     served on 127.0.0.1, the form posts to the same origin, and there is no
 *     third-party script, font or stylesheet. A page that loads anything from a
 *     CDN is a page that has handed a credential to a CDN.
 *   - **Not dependent on JavaScript.** The form works with scripting disabled,
 *     because the thing it does is a POST.
 *
 * The styling is inline and there are no assets, so the whole surface area is
 * one file: no favicon request, no stylesheet, no font, nothing to phone home.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>jove-memory — settings</title>
<style>
  :root {
    --bg: #14161a; --panel: #1c1f26; --line: #2b2f39;
    --text: #e6e8ec; --muted: #9aa1ad; --accent: #6ea8fe; --ok: #5fd39a; --bad: #f2836b;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --line:#dfe3ea; --text:#1a1d22; --muted:#5b6472; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 40rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; font-weight: 600; }
  .sub { color: var(--muted); margin: 0 0 2rem; font-size: .9rem; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
            padding: 1.25rem; margin-bottom: 1rem; }
  h2 { font-size: .95rem; margin: 0 0 .9rem; font-weight: 600; }
  label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: .35rem; }
  input[type=password], input[type=text] {
    width: 100%; padding: .6rem .7rem; border-radius: 6px; border: 1px solid var(--line);
    background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: .9rem;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .row { display: flex; gap: .6rem; margin-top: .9rem; flex-wrap: wrap; }
  button {
    padding: .55rem 1rem; border-radius: 6px; border: 1px solid var(--line);
    background: var(--bg); color: var(--text); font-size: .88rem; cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #0d1117; font-weight: 600; }
  button.danger { color: var(--bad); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .state { display: flex; gap: .5rem; align-items: center; font-size: .88rem; margin-bottom: 1rem; }
  .dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.set { background: var(--ok); } .dot.unset { background: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .85em;
         background: var(--bg); padding: .1rem .3rem; border-radius: 4px; }
  .msg { margin-top: .9rem; font-size: .87rem; padding: .6rem .7rem; border-radius: 6px; display: none; }
  .msg.show { display: block; }
  .msg.ok { background: color-mix(in srgb, var(--ok) 14%, transparent); color: var(--ok); }
  .msg.bad { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; margin: 0; font-size: .85rem; }
  dt { color: var(--muted); } dd { margin: 0; font-family: ui-monospace, monospace; }
  .note { color: var(--muted); font-size: .82rem; margin: .8rem 0 0; }
  ol { margin: .5rem 0 0; padding-left: 1.2rem; font-size: .87rem; color: var(--muted); }
  ol li { margin: .25rem 0; }
</style>
</head>
<body>
<main>
  <h1>jove-memory</h1>
  <p class="sub">Settings — served from your own machine. Nothing on this page is loaded from anywhere else.</p>

  <section>
    <h2>OpenRouter API key</h2>
    <div class="state">
      <span class="dot" id="dot"></span>
      <span id="stateText">checking…</span>
    </div>

    <form method="post" action="/v1/settings/credentials" id="form">
      <label for="value">Paste the key from openrouter.ai/keys</label>
      <input id="value" name="value" type="password" autocomplete="off"
             autocapitalize="off" autocorrect="off" spellcheck="false"
             placeholder="sk-or-v1-…" required>
      <p class="note">
        Written only after encryption. It is never shown here again, never
        logged, and never sent anywhere but this process.
      </p>
      <div class="row">
        <button class="primary" type="submit" name="action" value="verify">Verify and save</button>
        <button type="submit" name="action" value="save">Save without verifying</button>
        <button class="danger" type="submit" name="action" value="clear" formnovalidate>Remove</button>
      </div>
    </form>

    <div class="msg" id="msg"></div>
  </section>

  <section id="detail" hidden>
    <h2>Stored credential</h2>
    <dl>
      <dt>Provider</dt><dd id="dProvider">—</dd>
      <dt>Key version</dt><dd id="dVersion">—</dd>
      <dt>Fingerprint</dt><dd id="dFingerprint">—</dd>
      <dt>Updated</dt><dd id="dUpdated">—</dd>
    </dl>
    <p class="note">
      The fingerprint identifies the ciphertext, not the key. It answers "did
      this change?" without anything that could narrow a key space.
    </p>
  </section>

  <section>
    <h2>Where the encryption key lives</h2>
    <p class="note" style="margin-top:0">
      The key in the database is encrypted. The key that encrypts it is not in
      the database — it is a file on this machine:
    </p>
    <dl><dt>Master key</dt><dd id="dMaster">—</dd></dl>
    <ol>
      <li>A database backup, replica or <code>pg_dump</code> yields ciphertext.</li>
      <li>Reading the master key file alone yields nothing usable.</li>
      <li>An attacker with both recovers the key. No single-place encryption changes that.</li>
    </ol>
  </section>
</main>

<script>
// Progressive enhancement only. The form works without this: it is a POST.
// What this adds is the status display and not reloading the page, so the
// typed value is not sitting in a form field waiting to be screenshotted.
(function () {
  var form = document.getElementById('form');
  var msg = document.getElementById('msg');
  var dot = document.getElementById('dot');
  var stateText = document.getElementById('stateText');

  function say(text, good) {
    msg.textContent = text;
    msg.className = 'msg show ' + (good ? 'ok' : 'bad');
  }
  function clearField() { document.getElementById('value').value = ''; }

  function paint(detail) {
    var set = !!detail;
    dot.className = 'dot ' + (set ? 'set' : 'unset');
    stateText.textContent = set
      ? 'configured — ' + detail.provider + ' / ' + detail.kind
      : 'no key configured — retrieval runs on three layers';
    var box = document.getElementById('detail');
    box.hidden = !set;
    if (!set) return;
    document.getElementById('dProvider').textContent = detail.provider + ' / ' + detail.kind;
    document.getElementById('dVersion').textContent = detail.keyVersion;
    document.getElementById('dFingerprint').textContent = detail.fingerprint;
    document.getElementById('dUpdated').textContent = detail.updatedAt;
  }

  function show(body) {
    return fetch('/v1/settings/credentials', {
      headers: { accept: 'application/json' }
    }).then(function (r) { return r.json(); }).then(function (body) {
      paint(body.credential);
      if (body.masterKeyPath) {
        document.getElementById('dMaster').textContent = body.masterKeyPath;
      }
    }).catch(function (err) { say('could not read the current state: ' + err.message, false); });
  }

  show();

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var action = event.submitter && event.submitter.value;
    var value = document.getElementById('value').value;

    if (action === 'clear' && !confirm('Remove the stored key?')) return;
    if (action !== 'clear' && !value.trim()) { say('paste a key first', false); return; }

    say('working…', true);
    fetch('/v1/settings/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action === 'clear' ? { action: 'clear' } : { action: action, value: value })
    }).then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        clearField();
        paint(res.body.credential);
        if (res.body.message) say(res.body.message, res.status < 400);
        else if (!res.body.ok && res.body.detail) say(res.body.detail, false);
      })
      .catch(function (err) { clearField(); say(err.message, false); });
  });
})();
</script>
</body>
</html>
`;

/** The page. A function so the constant is not exported by accident. */
export function settingsPage() {
  return PAGE;
}
