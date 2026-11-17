// The consent page a person sees in the browser when claude.ai or ChatGPT asks to connect. No script at all; every
// value from the app (its name, its address) is escaped. The pairing code from `monomem oauth pair` is the person gate.

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#111}" +
  "h1{font-size:1.4rem}.box{border:1px solid #bbb;border-radius:8px;padding:1rem;margin:1rem 0}.warn{color:#8a1c00}" +
  "label{display:block;margin:.4rem 0}input[type=text]{font-size:1.2rem;letter-spacing:.1em;padding:.3rem;width:12rem}" +
  "button{font-size:1rem;padding:.5rem 1.2rem;margin-right:.6rem}";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function errorHtml(message: string): string {
  return page("Monomem: cannot connect", `<h1>Monomem cannot connect this app</h1><p>${esc(message)}</p>`);
}

export interface ConsentView {
  requestId: string;
  csrf: string;
  clientName: string;
  redirectHost: string;
  loopback: boolean;
  scope: "read" | "write";
  error?: string;
}

export function consentHtml(v: ConsentView): string {
  const checked = (s: string): string => (v.scope === s ? " checked" : "");
  return page(
    "Monomem: connect an app",
    `<h1>Connect an app to your Monomem memory?</h1>` +
      (v.error ? `<p class="warn" role="alert">${esc(v.error)}</p>` : "") +
      `<div class="box"><p>An app calling itself <strong>${esc(v.clientName)}</strong> asks for access. ` +
      `(The app chose that name; Monomem cannot check it.)</p>` +
      `<p>After you allow it, your browser goes back to <strong>${esc(v.redirectHost)}</strong>.</p>` +
      (v.loopback ? `<p class="warn">That address sends the answer only to a program on this computer. Allow it only if you started the connection here yourself.</p>` : "") +
      `</div>` +
      `<form method="post" action="/authorize">` +
      `<input type="hidden" name="request_id" value="${esc(v.requestId)}"><input type="hidden" name="csrf" value="${esc(v.csrf)}">` +
      `<fieldset class="box"><legend>What may it do?</legend>` +
      `<label><input type="radio" name="scope" value="read"${checked("read")}> Read notes</label>` +
      `<label><input type="radio" name="scope" value="write"${checked("write")}> Read and write notes</label>` +
      `<p>It can see public and internal notes, never private ones. It can never delete notes or manage keys. ` +
      `Notes it writes are marked "from outside" and stay unconfirmed until you confirm them.</p></fieldset>` +
      `<p><label for="pair">Pairing code. Run <code>monomem oauth pair</code> in a terminal on the computer where Monomem runs, then type the code here:</label>` +
      `<input type="text" id="pair" name="pair_code" autocomplete="off" autocapitalize="characters" spellcheck="false" required></p>` +
      `<p><button type="submit" name="action" value="allow">Allow</button><button type="submit" name="action" value="deny" formnovalidate>Deny</button></p>` +
      `</form><p>You can remove it later with <code>monomem keys remove</code> or in the dashboard.</p>`
  );
}
