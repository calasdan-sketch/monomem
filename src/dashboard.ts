import { humanWriterMap } from "./actor.js";
// A tiny self-contained dashboard served at GET "/" so you can browse, search,
// add, and delete notes in the shared store from a browser. No framework, no
// external requests -- just vanilla HTML/CSS/JS. The page itself is public
// (it holds no data); every data call it makes carries the bearer token the
// user pastes once (kept in sessionStorage for that tab only).

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>monomem</title>
<link rel="icon" href="/favicon.ico" type="image/png" sizes="64x64">
<style>
  /* Brand: the calasautomations.com palette (calas-theme.css): navy #0B2E45, ocean #155F87, gold #F0C171.
     Every colour is a token; the light theme only redefines tokens. Fonts: the site's names first (used when installed;
     the CSP blocks web-font downloads), then the closest system fonts (Georgia for Libre Baskerville). */
  :root{color-scheme:dark;--gold:#F0C171;--navy:#0B2E45;--fs:15px;--r:14px;--r-s:9px;
    --sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --serif:"Libre Baskerville",Georgia,"Times New Roman",serif;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;
    --bg:#0B1A26;--panel:#102434;--panel2:#183041;--seg:#0D1F2C;--line:#1F3A4D;--field-line:#5a7b92;
    --ink:#EEF4F8;--dim:#B4C4CF;--body:#D6E2EA;--accent:#4FA3D1;--focus:#7CC4EA;
    --btn-bg:#4FA3D1;--btn-fg:#0B1A26;--danger:#ffa3a3;--danger-bg:#b3261e;--danger-fg:#fff;--ok:#6FD9A2;--warn:#F0C171;
    --shadow:inset 0 1px 0 rgba(255,255,255,.04);
    --chip-s:45%;--chip-bg-l:24%;--chip-fg-l:86%;--chip-fg-s:80%}
  @media (prefers-color-scheme:light){:root{color-scheme:light;
    --bg:#F1F6F9;--panel:#FFFFFF;--panel2:#EAF0F4;--seg:#EAF0F4;--line:#D9E3EA;--field-line:#66717B;
    --ink:#12212C;--dim:#4E5B66;--body:#12212C;--accent:#155F87;--focus:#155F87;
    --btn-bg:#155F87;--btn-fg:#ffffff;--danger:#b3261e;--danger-bg:#b3261e;--danger-fg:#fff;--ok:#17794A;--warn:#8A5A12;
    --shadow:0 1px 2px rgba(11,46,69,.05),0 8px 20px -12px rgba(11,46,69,.22);
    --chip-s:60%;--chip-bg-l:90%;--chip-fg-l:20%;--chip-fg-s:70%}}
  /* The navy band (header, sign-in card) looks the same in both themes, so it redefines the tokens inside it. */
  .navy{color-scheme:dark;background:var(--navy);border-bottom:3px solid var(--gold);color:var(--ink);
    --panel:#143c58;--panel2:#1d4a69;--ink:#ffffff;--dim:#a9bfcf;--field-line:#5d87a4;--accent:var(--gold);--focus:var(--gold);
    --btn-bg:var(--gold);--btn-fg:var(--navy)}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;
    font:var(--fs)/1.5 var(--sans)}
  h1,h2{font-family:var(--serif);font-weight:700;letter-spacing:-.01em}
  header{display:flex;gap:12px;align-items:center;padding:12px max(16px,calc((100% - 900px)/2 + 16px));flex-wrap:wrap}
  @media (min-width:700px){header{position:sticky;top:0;z-index:2}}
  .brand{display:flex;align-items:center;gap:9px;margin-right:auto}
  .brand img{width:28px;height:28px;display:block}
  h1{font-size:17px;margin:0;font-weight:700;letter-spacing:-.01em}
  h1 span{color:var(--accent)}
  header #q{border-radius:999px;padding-left:16px}
  input,textarea,button,select{font:inherit;color:var(--ink);background:var(--panel);
    border:1px solid var(--field-line);border-radius:var(--r-s);padding:6px 12px;min-height:36px}
  input[type=checkbox]{min-height:0;width:18px;height:18px;margin:0;accent-color:var(--accent)}
  :focus-visible{outline:3px solid var(--focus);outline-offset:2px}
  button{cursor:pointer;background:var(--btn-bg);border-color:var(--btn-bg);color:var(--btn-fg);font-weight:600;
    transition:background-color .15s,box-shadow .15s,transform .1s}
  @media (prefers-reduced-motion:no-preference){button:active{transform:scale(.98)}}
  @media (prefers-reduced-motion:reduce){button{transition:none}}
  button.ghost{background:var(--panel);color:var(--ink);border-color:var(--field-line)}
  button.danger{background:transparent;border-color:transparent;color:var(--danger);padding:4px 8px}
  button.linkbtn{background:none;border:0;color:var(--accent);text-decoration:underline;text-underline-offset:3px;
    padding:4px 2px;font-weight:500;min-height:0}
  small.tech{color:var(--dim);font-size:.78em;font-weight:500;margin-left:.4em}
  /* Tabs: the four you use daily in one segmented group, the rest quieter beside it. */
  nav{display:flex;gap:10px 16px;flex-wrap:wrap;justify-content:space-between;align-items:center;padding:16px 16px 0;max-width:900px;margin:0 auto}
  .seg{display:flex;flex-wrap:wrap;gap:2px;padding:3px;background:var(--seg);border-radius:12px}
  .seg2{background:transparent;padding:3px 0}
  nav button{background:transparent;color:var(--ink);border-color:transparent;font-weight:500;padding:5px 13px;min-height:34px}
  .seg2 button{color:var(--dim)}
  nav button:hover{background:var(--panel2)}
  [hidden]{display:none!important}
  nav button.lit{border-color:var(--danger)}
  nav button[aria-current=page]{background:var(--panel);color:var(--ink);font-weight:650;
    box-shadow:var(--shadow),inset 0 -2px 0 var(--accent)}
  .pill{display:inline-block;background:var(--danger-bg);color:var(--danger-fg);border-radius:999px;
    padding:0 7px;font-size:11px;font-weight:700;margin-left:6px;line-height:17px}
  .strip{display:block;width:100%;text-align:left;margin-bottom:12px;background:transparent;color:var(--danger);
    border:1px solid var(--danger);border-left:5px solid var(--danger-bg);border-radius:var(--r-s);font-weight:600}
  .card.held{border-left:5px solid var(--danger-bg)}
  .stamp{display:inline-block;border:2px solid var(--danger);color:var(--danger);border-radius:4px;
    padding:0 7px;font-size:11px;font-weight:800;letter-spacing:.08em;margin-bottom:6px}
  .heldbody{font:13px/1.45 var(--mono);white-space:pre-wrap;
    overflow-wrap:anywhere;color:var(--body);border:1px dashed var(--danger);border-radius:6px;padding:8px 10px;margin-top:8px}
  .grow{flex:1 1 140px;min-width:0}
  .ns{width:170px;max-width:100%}
  main{max-width:900px;margin:0 auto;padding:14px 16px 18px}
  .filters{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:flex-end;padding:0 0 14px;border-bottom:1px solid var(--line)}
  .fld{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;color:var(--dim)}
  .filters .ghost{margin-left:auto}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);
    padding:16px 18px;margin-bottom:12px;box-shadow:var(--shadow)}
  .card h3{margin:0 0 4px;font-size:16px;font-weight:650;overflow-wrap:anywhere}
  .meta{color:var(--dim);font-size:12px;margin-bottom:8px;overflow-wrap:anywhere}
  .tag{display:inline-block;background:var(--panel2);border:1px solid var(--line);
    border-radius:999px;padding:1px 9px;font-size:12px;margin:0 5px 3px 0;color:var(--dim)}
  .tag.why{color:var(--ink);border-color:var(--danger)}
  .chip{display:inline-block;border-radius:6px;padding:0 7px;font-size:12px;font-weight:600;
    background:hsl(var(--h) var(--chip-s) var(--chip-bg-l));color:hsl(var(--h) var(--chip-fg-s) var(--chip-fg-l))}
  .chip .tech{color:inherit;opacity:.75}
  .badge-pin{display:inline-block;background:var(--gold);color:var(--navy);border-radius:6px;
    padding:0 7px;font-size:11px;font-weight:700;margin-left:6px;vertical-align:middle}
  .body{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--body);font-size:14px;line-height:1.55}
  .cardhead{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}
  .cardhead>div:first-child{flex:1 1 220px;min-width:0}
  #new textarea{width:100%;min-height:90px;resize:vertical}
  #new{display:none}
  .muted{color:var(--dim)}
  .empty{text-align:center;padding:32px 20px;border:1px dashed var(--line);border-radius:var(--r)}
  .err{color:var(--danger)}
  .msg{min-height:0;margin-bottom:10px}
  .msg:empty{display:none}
  .gate{max-width:440px;margin:10vh auto;padding:0 16px}
  .gcard{background:var(--panel);border:1px solid var(--line);border-radius:20px;overflow:hidden;box-shadow:var(--shadow);text-align:center}
  .gcard .navy{padding:30px 20px 22px}
  .gcard .navy img{width:56px;height:56px}
  .gword{font-size:30px;margin:8px 0 2px}
  .gbody{padding:20px 24px 24px}
  .gate input{width:100%;margin:14px 0 12px;text-align:center}
  .gate button{width:100%}
  .by{font-size:12px;color:var(--dim);margin:0}
  footer{max-width:900px;margin:8px auto 0;padding:14px 16px 40px;color:var(--dim);border-top:1px solid var(--line);
    font-size:13px;display:flex;gap:6px 16px;align-items:center;flex-wrap:wrap}
  footer #count{margin-right:auto}
  footer .by{flex-basis:100%;margin-top:8px}
  .hint{font-size:12px;margin-left:-10px}
  .badge-bad{display:inline-block;background:var(--danger-bg);color:var(--danger-fg);border-radius:6px;
    padding:0 7px;font-size:11px;font-weight:700;margin-left:6px;vertical-align:middle}
  #runner div+div{margin-top:4px}
  label.chk{display:flex;gap:8px;align-items:center;color:var(--dim);font-size:13px;min-height:36px}
  .scroll{overflow-x:auto}
  .msg{overflow-wrap:anywhere}
  .cf{border-top:1px solid var(--line);padding:10px 0 2px}
  .cf h3{margin:0 0 6px}
  .cfval{margin:6px 0}
  .cfmore{margin-top:6px}
  .cfdlg:empty{display:none}
  .cfdlg{margin-top:8px;padding:8px 10px;border:1px solid var(--line);border-radius:6px}
  .cfdlg ul{margin:0 0 6px;padding-left:18px}
  .cf .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .cf .acts button{max-width:100%;overflow-wrap:anywhere}
  /* Phones: the search gets its own row under the brand; the note text comes before its action buttons. */
  @media (max-width:600px){
    header #q{order:2;flex-basis:100%}
    .card{display:flex;flex-direction:column}
    .cardhead{display:contents}
    .cardhead>div:first-child{order:1;flex:none}
    .card>.body,.card>.heldbody{order:2}
    .card .acts{order:3;margin-top:10px}
  }
  .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .viewh{font-size:22px;font-weight:700;letter-spacing:-.015em;margin:18px 0 2px}
  #viewd{margin:0 0 14px;font-size:14px;max-width:68ch}
  .tag.fact{color:var(--ink);border-color:var(--accent)}
  code{background:var(--panel2);border-radius:4px;padding:0 4px}
  .lvl{display:inline-block;border-radius:6px;padding:0 8px;font-size:11px;font-weight:700;margin-left:6px;vertical-align:middle;border:1px solid var(--line)}
  .lvl-public{color:var(--ok);border-color:var(--ok)}
  .lvl-internal{color:var(--dim)}
  .lvl-private{color:var(--warn);border-color:var(--warn)}
  .nolimit{color:var(--warn);font-weight:700}
  #who{color:var(--dim);font-size:13px;margin:0 0 14px}
  #who:empty{display:none}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:18px 28px;margin:10px 0 6px}
  .stat b{display:block;font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.15}
  .stat span{color:var(--dim);font-size:13px}
  .stats,table{font-variant-numeric:tabular-nums}
  pre.snip{white-space:pre-wrap;word-break:break-all;background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-s);padding:10px;font-size:12px}
  table.apps{width:100%;font-size:13px;border-collapse:collapse}
  table.apps td,table.apps th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
  table.apps th{color:var(--dim);font-weight:600}
  table.apps .n{text-align:right}
  /* Phones: tables become one small card per row, nothing scrolls sideways. */
  @media (max-width:600px){
    table.apps,table.apps tbody{display:block;width:100%}
    table.apps tr.hd{display:none}
    table.apps tr{display:block;padding:8px 0;border-bottom:1px solid var(--line)}
    table.apps td{display:flex;justify-content:space-between;gap:12px;border:0;padding:2px 0;text-align:right;overflow-wrap:anywhere}
    table.apps td::before{content:attr(data-l);color:var(--dim);text-align:left;flex:0 0 38%}
    table.apps td:empty{display:none}
  }
</style>
</head>
<body>
<div id="app" style="display:none">
<header class="navy">
  <div class="brand"><img src="/favicon.ico" alt="" width="28" height="28"><h1>mono<span>mem</span></h1></div>
  <input id="q" class="grow" aria-label="Search notes" placeholder="Search notes">
  <button id="btn_new" aria-expanded="false" aria-controls="new" onclick="toggleNew()">+ New</button>
</header>
<nav aria-label="Views">
  <div class="seg">
  <button id="tab_list" onclick="load()" title="All notes, newest first">Notes</button>
  <button id="tab_review" onclick="loadReview()" title="Notes written by agents that you have not looked at yet">Review</button>
  <button id="tab_held" onclick="loadHeld()" title="Writes held out of shared memory until you approve or reject them: ones the linter flagged (secrets, injected instructions) and ones written to an approve-first namespace (admin token)">Held<span id="held_n"></span></button>
  <button id="tab_changes" onclick="loadChanges()" title="What changed in the last 24 hours">Changes</button>
  </div>
  <div class="seg seg2">
  <button id="tab_sessions" onclick="loadSessions()" title="Agent sessions Monomem recorded, each with its timeline">Sessions</button>
  <button id="tab_quality" onclick="loadQuality()" title="Duplicates, stale twins, held writes, linter findings, rows about to decay and writers who disagree (admin token)">Quality<span id="quality_n"></span></button>
  <button id="tab_meter" onclick="loadMeter()" title="What Monomem costs you: tokens injected and saved, local-model tokens, database size">Usage<small class="tech">meter</small></button>
  <button id="tab_apps" hidden onclick="loadApps()" title="The apps that are allowed to connect, and what each may see (administrators only)">Apps</button>
  <button id="tab_audit" hidden onclick="loadAudit()" title="Who changed what, and when (administrators only)">Activity log<small class="tech">audit</small></button>
  </div>
</nav>
<main>
  <div class="filters" role="group" aria-label="Filters">
    <label class="fld"><span>Project<small class="tech">namespace</small></span><input id="ns" class="ns" placeholder="All projects"></label>
    <label class="fld"><span>Label</span><select id="lvlf" aria-label="Show only notes with this label" onchange="applyFilter()"><option value="">all labels</option><option value="public">public</option><option value="internal">internal</option><option value="private">private</option></select></label>
    <label class="chk" title="Also show notes written by writers an admin distrusts (marked DISTRUSTED)"><input type="checkbox" id="inc" aria-describedby="inc_help" onchange="load()"> Show notes from distrusted writers<span id="inc_help" class="sr">Also show notes written by writers an admin distrusts. They are marked DISTRUSTED.</span></label>
    <button class="ghost" onclick="load()">Refresh</button>
  </div>
  <div id="new" class="card">
    <div class="row">
      <input id="n_title" class="grow" aria-label="Title" placeholder="Title">
      <input id="n_ns" class="grow" aria-label="Project (namespace), optional" placeholder="Project (namespace, optional)">
      <input id="n_tags" class="grow" aria-label="Tags, comma separated" placeholder="tags, comma, separated">
      <select id="n_lvl" aria-label="Who can see this note"><option value="internal">internal (normal)</option><option value="public">public (anyone)</option><option value="private">private (limited apps cannot see it; unlimited apps still can)</option></select>
    </div>
    <textarea id="n_body" aria-label="Body" placeholder="What should your assistants remember?"></textarea>
    <div class="row" style="margin-top:10px">
      <button onclick="addNote()">Save note</button>
      <span id="n_err" class="err" role="alert"></span>
    </div>
  </div>
  <h2 id="viewh" class="viewh">Notes</h2>
  <p id="viewd" class="muted"></p>
  <select id="chwin" hidden aria-label="How far back to look for changes" onchange="loadChanges()"><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option></select>
  <p id="who" role="status"></p>
  <div id="insights" class="card" style="display:none" aria-live="polite"></div>
  <div id="msg" class="msg" role="status" aria-live="polite"></div>
  <div id="runner" class="card err" style="display:none"></div>
  <button id="heldstrip" class="strip" onclick="loadHeld()" hidden></button>
  <div id="list"></div>
</main>
<footer>
  <span id="count" role="status"></span>
  <button class="linkbtn" onclick="doExport()" aria-describedby="exp_hint">Download backup<small class="tech">.json</small></button>
  <span id="exp_hint" class="hint">every note your key can see, unencrypted</span>
  <button class="linkbtn" onclick="document.getElementById('imp').click()">Add notes from a backup<small class="tech">.json</small></button>
  <input id="imp" type="file" accept="application/json" aria-label="Backup file to add notes from (.json)" style="display:none" onchange="doImport(this)">
  <button class="linkbtn" onclick="logout()">Sign out</button>
  <p class="by">by Calas Automations</p>
</footer>
</div>

<div id="gate" class="gate">
  <div class="gcard">
    <div class="navy"><img src="/favicon.ico" alt="" width="56" height="56"><h1 class="gword">mono<span>mem</span></h1><p class="by">by Calas Automations</p></div>
    <div class="gbody">
      <p class="muted"><label for="tok">Paste your access key to open your notes.</label> Easiest: run <code>monomem open</code> in a terminal and this page signs you in. The key is in the <code>.token</code> file in your Monomem data folder (or in <code>MONOMEM_TOKEN</code>, if you set it); <code>monomem doctor</code> shows where that is.</p>
      <input id="tok" type="password" placeholder="Your access key" onkeydown="if(event.key==='Enter')saveTok()">
      <button onclick="saveTok()">Open</button>
      <p id="gate_err" class="err" role="alert"></p>
    </div>
  </div>
</div>
<script src="/dashboard.js"></script>
</body>
</html>`;

// Served at GET /dashboard.js. Kept as its own string (and out of the HTML
// above) so it can use normal quotes without clashing with this file's
// template literals. No backticks are used inside.
export const DASHBOARD_JS = `
var TOKKEY = "om_tok";
function tok(){ try { return sessionStorage.getItem(TOKKEY) || ""; } catch(e){ return ""; } }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }
function $(id){ return document.getElementById(id); }

// A small coloured chip per writer: a stable hash of the label picks the hue (the label itself is escaped text).
var HUES = [30,195,96,261,162,327,63,228,129,294], hueOf = {}; // ten hues in an order where neighbours are far apart, none red (red reads as danger next to delete)
function hue(s){ s = String(s); if(hueOf[s] !== undefined) return hueOf[s];
  var h = 0; for(var i = 0; i < s.length; i++){ h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  var used = {}; for(var k in hueOf) used[hueOf[k]] = 1;
  for(var j = 0; j < HUES.length; j++){ var c = HUES[(h + j) % HUES.length]; if(!used[c]){ return (hueOf[s] = c); } }
  return (hueOf[s] = HUES[h % HUES.length]); } // the stable hash picks a start; a hue another writer already has is skipped (past ten writers they repeat)
function shownWriter(w){ return w === "primary" ? "admin (setup)" : w === "cli" ? "terminal" : w; } // display only: the stored label stays "primary" / "cli"
function chip(label){ return "<span class='chip' style='--h:"+hue(label)+"'>"+esc(shownWriter(label))+(label === "cli" ? "<small class='tech'>cli</small>" : "")+"</span>"; }
// A fact tag reads "deploy_target = render", not the raw fact:deploy_target=render.
function tagChip(t){
  var m = /^fact:([^=]+)=(.*)$/.exec(String(t).trim());
  return m ? "<span class='tag fact'>"+esc(m[1].trim())+" = "+esc(m[2].trim())+"</span>" : "<span class='tag'>"+esc(t)+"</span>";
}
function tagsHtml(list){ return (list||[]).map(tagChip).join(""); }
function acts(html){ return "<div class='acts'>"+html+"</div>"; }
function byLine(w){ return w ? " &middot; by "+chip(w) : ""; }

// Messages (errors, results) go to the status line, never a popup dialog; say() replaces whatever was there.
function say(text, isErr){ var m = $("msg"); m.className = "msg" + (isErr ? " err" : ""); m.textContent = text || ""; }
function fail(e){ say(e && e.message ? e.message : String(e), true); }
function failList(e){ $("list").innerHTML = "<p class='err'>"+esc(e.message)+"</p>"; }
function empty(text){ return "<p class='muted empty'>"+text+"</p>"; }

// Inline confirm: the first click turns the button into "Confirm <label>?" for a few seconds; a second click runs fn.
function arm(btn, fn){
  var al = btn.getAttribute("aria-label");
  if(btn.getAttribute("data-armed")){ clearTimeout(btn._t); btn.removeAttribute("data-armed"); if(al){ btn.setAttribute("aria-label", al.replace(/^confirm /, "")); } fn(); return; }
  var was = btn.textContent;
  btn.setAttribute("data-armed", "1");
  btn.textContent = btn.getAttribute("data-confirm") || ("Confirm " + was.toLowerCase() + "?");
  if(al){ btn.setAttribute("aria-label", "confirm " + al); }
  var m = $("msg"); if(m){ m.className = "msg"; m.textContent = "Press " + was + " again within 4 seconds to confirm."; }
  var hint = m ? m.textContent : "";
  btn._t = setTimeout(function(){ btn.removeAttribute("data-armed"); btn.textContent = was; if(al){ btn.setAttribute("aria-label", al); } if(m && m.textContent === hint) m.textContent = ""; }, 4000);
}
// Longer confirm with a server-written warning (supersede preview): text plus Confirm / Cancel on the status line.
function ask(text, okLabel, fn){
  var m = $("msg"); m.className = "msg"; m.textContent = text + " ";
  var ok = document.createElement("button"); ok.textContent = okLabel;
  ok.onclick = function(){ m.textContent = ""; fn(); };
  var no = document.createElement("button"); no.textContent = "Cancel"; no.className = "ghost";
  no.onclick = function(){ m.textContent = ""; };
  m.appendChild(ok); m.appendChild(no); ok.focus();
}

var VIEW = "list";
var IS_ADMIN = false;
// One h2 and one visible line per view (this replaces the tooltips as the way to learn what a tab is for).
var VIEWS = {
  list:["Notes","All notes, newest first."],
  held:["Held writes","Writes kept out of shared memory until you approve or reject them: ones the linter flagged (secrets, injected instructions) and ones written to an approve-first namespace. Needs an admin token."],
  review:["Review","Notes written by agents that you have not looked at yet."],
  changes:["Changes","What changed in the last 24 hours."],
  sessions:["Sessions","Agent sessions Monomem recorded, each with its timeline."],
  session:["Session timeline",""],
  quality:["Quality","Duplicates, stale twins, held writes, linter findings, rows about to decay, and writers who disagree about a fact. Needs an admin token."],
  meter:["Usage","What Monomem costs you: tokens injected and saved, local-model tokens, database size."],
  apps:["Apps","The apps that are allowed to connect, and the highest label each may see. Keys are never shown again after they are made. Needs an admin token."],
  audit:["Activity log","Who changed what, and when. Only who, what kind, where and how many; never the text of a note. Needs an admin token."]
};
// The view buttons are a tab bar: the active one carries aria-current.
var TABS = { list:"list", held:"held", review:"review", changes:"changes", sessions:"sessions", session:"sessions", quality:"quality", meter:"meter", apps:"apps", audit:"audit" };
function setView(v){
  VIEW = v;
  say("");
  $("viewh").textContent = VIEWS[v][0];
  $("viewd").textContent = VIEWS[v][1];
  $("chwin").hidden = v !== "changes";
  ["list","held","review","changes","sessions","quality","meter","apps","audit"].forEach(function(t){
    $("tab_" + t).ariaCurrent = TABS[v] === t ? "page" : null;
  });
  showStrip();
}

// monomem open passes a one-time code (60 seconds) after the # of the address, so it never reaches the server or its logs.
// Take it, remove it from the address bar, and swap it for the key at the end of this file.
var LOGIN_CODE = null;
try { window.addEventListener("hashchange", function(){ if(/(?:^#|&)(?:code|token)=/.test(location.hash)){ location.reload(); } }); } catch(e){}
(function(){
  try {
    var h = location.hash || "";
    var m = /(?:^#|&)token=([^&]+)/.exec(h);
    if(m){ sessionStorage.setItem(TOKKEY, decodeURIComponent(m[1])); history.replaceState(null, "", location.pathname + location.search); }
    var c = /(?:^#|&)code=([0-9a-f]{32})/.exec(h);
    if(c){ LOGIN_CODE = c[1]; history.replaceState(null, "", location.pathname + location.search); }
  } catch(e){}
})();
// Give every table cell its column name, so on a phone each row can show as a small card.
function stackTables(){
  var tabs = document.querySelectorAll("#list table");
  for(var i = 0; i < tabs.length; i++){
    var rows = tabs[i].querySelectorAll("tr");
    if(!rows.length || tabs[i].getAttribute("data-stacked")){ continue; }
    tabs[i].setAttribute("data-stacked", "1");
    tabs[i].classList.add("apps");
    var heads = [].map.call(rows[0].children, function(c){ return c.textContent; });
    rows[0].classList.add("hd");
    for(var r = 1; r < rows.length; r++){
      for(var c = 0; c < rows[r].children.length; c++){ rows[r].children[c].setAttribute("data-l", heads[c] || ""); }
    }
  }
}
try { new MutationObserver(stackTables).observe(document.getElementById("list"), { childList:true, subtree:true }); } catch(e){}

function show(app){
  $("app").style.display = app ? "block" : "none";
  $("gate").style.display = app ? "none" : "block";
}
function saveTok(){
  var v = $("tok").value.trim();
  if(!v){ return; }
  try { sessionStorage.setItem(TOKKEY, v); } catch(e){}
  start();
}
// Show the notes, and (separately) who you are signed in as.
function start(){
  show(true);
  load();
  api("/whoami").then(function(w){
    var isAdmin = w.scope === "admin" && !w.namespace && !w.max_sensitivity;
    // Pin / Unpin buttons (PUT /pinned is admin-only): redraw the list once we know.
    if(isAdmin && !IS_ADMIN){ IS_ADMIN = true; if(VIEW === "list"){ load(); } }
    // An unlimited admin key sees everything; any other key keeps the server's own can_see wording.
    if(isAdmin){ $("who").innerHTML = "You're the owner: you can see everything. Pinned notes change only from the terminal.<small class='tech'>" + esc(w.label || "unnamed") + "</small>"; }
    else { $("who").textContent = "Signed in as " + (w.label || "unnamed") + ": " + String(w.can_see || "").replace(/[.\\s]+$/, "") + "."; }
    $("tab_apps").hidden = !isAdmin;
    $("tab_audit").hidden = !isAdmin;
    if(isAdmin){ loadInsights(); }
  }).catch(function(){ /* the notes call reports any problem */ });
}
function logout(why){
  try { sessionStorage.removeItem(TOKKEY); } catch(e){}
  show(false);
  var g = $("gate_err");
  if(g){ g.textContent = (typeof why === "string") ? why : ""; }
}
function toggleNew(){
  var n = $("new");
  var open = n.style.display !== "block";
  n.style.display = open ? "block" : "none";
  $("btn_new").setAttribute("aria-expanded", open ? "true" : "false");
}

function api(path, opts){
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers["Authorization"] = "Bearer " + tok();
  if(opts.body){ opts.headers["Content-Type"] = "application/json"; }
  return fetch(path, opts).then(function(r){
    if(r.status === 401){ logout("That key was not accepted. Check you copied all of it, or run  monomem open  in a terminal."); throw new Error("not signed in"); }
    return r.json().then(function(j){ if(!r.ok){ throw new Error(j.error || r.status); } return j; });
  });
}

function render(notes){
  var list = $("list");
  // Pinned notes first (stable sort), but a search keeps its relevance order.
  if(!$("q").value.trim()){ notes = notes.slice().sort(function(a, b){ return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); }); }
  $("count").textContent = notes.length + " note" + (notes.length===1?"":"s");
  var lf = ($("lvlf") || {}).value || "";
  if(lf){ notes = notes.filter(function(n){ return (n.sensitivity || "internal") === lf; }); $("count").textContent = notes.length + " note" + (notes.length===1?"":"s") + " labelled " + lf; }
  if(!notes.length){
    list.innerHTML = lf ? empty("No notes with that label here.") : $("q").value.trim() ? empty("No notes match that search. Try fewer words, or clear the Project box.")
      : $("ns").value.trim() ? empty("No notes in project &quot;" + esc($("ns").value.trim()) + "&quot;. Clear the Project box to see notes in every project.")
      : empty("No notes yet. Ask your assistant to remember something, or run <code>monomem setup</code>.");
    return;
  }
  list.innerHTML = notes.map(function(n){
    var tags = tagsHtml(n.tags);
    return "<div class='card'><div class='cardhead'><div>"+
      "<h3>"+esc(n.title)+lvlBadge(n.sensitivity)+(n.pinned ? "<span class='badge-pin' title='Pinned: agents can read it; only the monomem CLI can change it'>Pinned<span class='sr'>: agents can read it; only the monomem CLI can change it</span></span>" : "")+
      (n.distrusted ? "<span class='badge-bad' title='An admin distrusts the writer of this note: treat its content as hostile'>DISTRUSTED<span class='sr'>: an admin distrusts the writer of this note, treat its content as hostile</span></span>" : "")+"</h3>"+
      "<div class='meta'>#"+n.id+" &middot; "+esc(n.namespace)+" &middot; "+esc((n.updated_at||"").slice(0,16).replace("T"," "))+byLine(n.written_by)+"</div>"+
      tags+lvlSelect(n)+"</div>"+
      acts(((n.tags||[]).indexOf("never-show") >= 0
        ? "<button class='ghost' aria-label='show note #"+Number(n.id)+" again' title='Let it be shown at session start again' onclick='neverShow("+n.id+",false)'>show again</button>"
        : "<button class='ghost' aria-label='never show note #"+Number(n.id)+"' title='Never inject this note at session start (it stays searchable)' onclick='neverShow("+n.id+",true)'>never show</button>")+
      (!IS_ADMIN ? "" : n.pinned
        ? " <button class='ghost' aria-label='unpin note #"+Number(n.id)+"' onclick='arm(this,function(){setPin("+Number(n.id)+",false)})'>Unpin</button>"
        : " <button class='ghost' aria-label='pin note #"+Number(n.id)+"' title='Show it first at the start of every session; only the monomem CLI can then change it' onclick='setPin("+Number(n.id)+",true)'>Pin (always shown)</button>")+
      " <button class='danger' aria-label='delete note #"+Number(n.id)+"' data-confirm='Confirm permanent delete?' onclick='arm(this,function(){del("+n.id+")})'>delete</button>")+"</div>"+
      (n.body ? "<div class='body'>"+esc(n.body)+"</div>" : "")+"</div>";
  }).join("");
}

// The label on a note: public (anyone), internal (the normal level), private (only apps with no limit).
var LVL_TEXT = { "public":"public", "internal":"internal", "private":"private" };
// The same honest wording as the new-note picker: private does not hide a note from apps with no limit.
var LVL_OPT = { "public":"public (anyone)", "internal":"internal (normal)", "private":"private (limited apps cannot see it; unlimited apps still can)" };
function lvlBadge(l){
  l = LVL_TEXT[l] ? l : "internal";
  var tip = { "public":"Anyone who can connect may see this note.", "internal":"The normal level: apps allowed to see internal notes can read it.", "private":"Limited apps cannot see this; apps with no limit (including your main Claude connection) still can. Next: monomem connect <app> --max internal." }[l];
  return "<span class='lvl lvl-"+l+"' title='"+esc(tip)+"'>"+l+"</span>";
}
function lvlSelect(n){
  var l = LVL_TEXT[n.sensitivity] ? n.sensitivity : "internal";
  return "<div class='meta' style='margin-top:6px'><label>Who can see this? <select aria-label='Who can see note "+Number(n.id)+"' onchange='setLabel("+Number(n.id)+",this.value)'>"+
    ["public","internal","private"].map(function(o){ return "<option value='"+o+"'"+(o===l?" selected":"")+">"+LVL_OPT[o]+"</option>"; }).join("")+"</select></label></div>";
}
function setLabel(id, level){
  api("/notes/" + id).then(function(j){
    var n = j.note || j;
    return api("/notes/" + id, { method:"PUT", body: JSON.stringify({ sensitivity: level, if_rev: n.rev }) });
  }).then(function(){ load(); say("Note #" + id + " is now " + level + "."); })
    .catch(function(e){ load(); say("Could not change the label: " + e.message, true); });
}
function applyFilter(){ if(VIEW === "list"){ load(); } }

function inc(){ var c = $("inc"); return !!(c && c.checked); }

function loadRunner(){
  var el = $("runner");
  api("/runner/status").then(function(j){
    // One line per runner (each target has its own heartbeat); fall back to the single notice of older servers.
    var lines = [];
    ((j && j.targets) || []).forEach(function(t){ if(t.notice){ lines.push(t.notice); } });
    if(!lines.length && j && j.notice){ lines.push(j.notice); }
    el.textContent = "";
    if(lines.length){
      lines.forEach(function(l){ var d = document.createElement("div"); d.textContent = l; el.appendChild(d); });
      el.style.display = "block";
    } else { el.style.display = "none"; }
  }).catch(function(){ el.style.display = "none"; });
}

// "distrusted" needs an admin token: the server refuses it for any other (403); untick the box so the next load works.
function incRefused(e){
  if(inc() && /admin/i.test(String(e && e.message))){ $("inc").checked = false; }
}

function load(){
  setView("list");
  loadRunner();
  loadHeldCount();
  loadDisputeCount();
  var q = $("q").value.trim();
  var ns = $("ns").value.trim();
  var qs = (ns ? ("namespace=" + encodeURIComponent(ns)) : "") + (inc() ? ((ns ? "&" : "") + "include_distrusted=1") : "");
  var path;
  if(q){ path = "/search?q=" + encodeURIComponent(q) + (qs?("&"+qs):""); }
  else { path = "/notes" + (qs?("?"+qs):""); }
  api(path).then(function(j){ render(j.results || j.notes || []); })
    .catch(function(e){ incRefused(e); failList(e); });
}

function loadChanges(){
  setView("changes");
  var ns = $("ns").value.trim();
  var win = ($("chwin") || {}).value || "24h";
  var winText = { "24h":"24 hours", "7d":"7 days", "30d":"30 days" }[win] || win;
  var path = "/changes?since=" + encodeURIComponent(win) + "&limit=200" + (ns ? ("&namespace=" + encodeURIComponent(ns)) : "") + (inc() ? "&include_distrusted=1" : "");
  api(path).then(function(j){
    var c = j.counts || {};
    $("count").textContent = "last " + winText + ": " + (c.created||0) + " created, " +
      (c.updated||0) + " updated, " + (c.deleted||0) + " deleted" + (j.quarantined ? (", " + j.quarantined + " held") : "");
    var srcs = Object.keys(j.bySource || {}).map(function(k){
      var v = j.bySource[k];
      return "<span class='tag'>"+esc(k || "(no source)")+": +"+v.created+" ~"+v.updated+" -"+v.deleted+"</span>";
    }).join("");
    var rows = (j.changes || []).slice().reverse().map(function(e){
      var mark = e.kind === "created" ? "+" : (e.kind === "updated" ? "~" : "-");
      return "<div class='card'><h3>"+mark+" "+esc(e.title)+(e.distrusted ? "<span class='badge-bad'>DISTRUSTED</span>" : "")+"</h3><div class='meta'>"+esc(e.kind)+" &middot; #"+e.id+
        " &middot; "+esc(e.namespace)+" &middot; "+esc((e.at||"").slice(0,16).replace("T"," "))+
        byLine(e.written_by)+
        (e.source ? " &middot; claims "+esc(e.source) : "")+"</div></div>";
    }).join("");
    $("list").innerHTML = "<div class='row'>"+srcs+"</div>" +
      (rows || empty("Nothing changed in the last " + winText + ". New and edited notes will show up here."));
  }).catch(function(e){ incRefused(e); failList(e); });
}

// ---- Review queue: notes an AI agent wrote that nobody has looked at yet ----
// "Accepted" is the tag "reviewed" (tags do not change who wrote a note). Notes you or the server wrote yourself (cli,
// server, import:claude) are not queued. A writer the admin distrusts stays hidden, as everywhere else.
var HUMAN_WRITERS = ${JSON.stringify(humanWriterMap())};
function reviewQueue(notes, writer){
  return (notes || []).filter(function(n){
    if(HUMAN_WRITERS[n.written_by || ""]){ return false; }
    if((n.tags || []).indexOf("reviewed") >= 0){ return false; }
    // "stdio" also covers each self-declared stdio:<app> (trust.ts stdioFamily).
    return !writer || n.written_by === writer || (writer === "stdio" && String(n.written_by || "").indexOf("stdio:") === 0);
  });
}
function loadReview(){
  setView("review");
  var ns = $("ns").value.trim();
  var sel = $("rv_writer");
  var writer = sel ? sel.value : "";
  // Page through every note (500 at a time, at most 40 pages), so nothing past the first page is missed.
  var collected = [];
  function page(offset){
    return api("/notes?limit=500&offset=" + offset + (ns ? ("&namespace=" + encodeURIComponent(ns)) : "")).then(function(r){
      var got = r.notes || [];
      collected = collected.concat(got);
      return (got.length === 500 && offset < 20000) ? page(offset + 500) : { notes: collected, truncated: got.length === 500 };
    });
  }
  page(0).then(function(j){
    var all = reviewQueue(j.notes || []);
    var writers = {};
    all.forEach(function(n){ writers[n.written_by] = (writers[n.written_by] || 0) + 1; });
    var opts = "<option value=''>all writers (" + all.length + ")</option>" + Object.keys(writers).sort().map(function(w){
      return "<option value='" + esc(w) + "'" + (w === writer ? " selected" : "") + ">" + esc(shownWriter(w)) + " (" + writers[w] + ")</option>"; }).join("");
    var shown = reviewQueue(j.notes || [], writer);
    $("count").textContent = shown.length + " to review";
    var rows = shown.map(function(n){
      var tags = tagsHtml(n.tags);
      return "<div class='card'><div class='cardhead'><div><h3>"+esc(n.title)+(n.pinned ? "<span class='badge-pin'>Pinned</span>" : "")+"</h3><div class='meta'>#"+n.id+" &middot; "+esc(n.namespace)+
        " &middot; written by "+chip(n.written_by)+" &middot; "+esc((n.updated_at||"").slice(0,16).replace("T"," "))+"</div>"+tags+"</div>"+
        acts("<button aria-label='accept note #"+Number(n.id)+"' onclick='acceptNote("+n.id+")'>Accept</button> <button class='danger' aria-label='delete note #"+Number(n.id)+"' data-confirm='Confirm permanent delete?' onclick='arm(this,function(){del("+n.id+")})'>delete</button>")+"</div>"+
        (n.body ? "<div class='body'>"+esc(n.body)+"</div>" : "")+"</div>";
    }).join("");
    $("list").innerHTML = "<div class='row'><select id='rv_writer' aria-label='Filter by writer' onchange='loadReview()'>"+opts+"</select>"+
      "<span class='muted'>Accept keeps a note and marks it reviewed. Delete removes it.</span></div>" +
      (j.truncated ? "<p class='muted'>Showing the newest 20,000 notes only.</p>" : "") +
      (rows || empty("Nothing waiting for review. Notes your assistants write will queue here until you accept them."));
  }).catch(failList);
}
function acceptNote(id){
  api("/notes/" + id).then(function(j){
    var n = j.note || j;
    var tags = (n.tags || []).filter(function(t){ return t !== "reviewed"; }).concat(["reviewed"]);
    return api("/notes/" + id, { method:"PUT", body: JSON.stringify({ tags: tags, if_rev: n.rev }) });
  }).then(loadReview).catch(fail);
}

// ---- Held: writes the linter or a namespace policy kept out of the store until an admin decides (admin token) ----
// Everything shown is stored text from an untrusted writer, so all of it goes through esc().
var HELDN = 0;
function setHeldCount(n){
  HELDN = n;
  $("held_n").innerHTML = n ? "<span class='sr'>, " + Number(n) + " waiting</span><span class='pill' aria-hidden='true'>" + Number(n) + "</span>" : "";
  $("tab_held").className = n ? "lit" : "";
  showStrip();
}
// One line above the Notes list when something is held, so it is not missed.
function showStrip(){
  var s = $("heldstrip");
  s.hidden = !(HELDN > 0 && VIEW === "list");
  s.textContent = HELDN + (HELDN === 1 ? " write" : " writes") + " held for review \\u2192";
}
// Same pattern for the Quality tab: a red count of disputed facts (needs an admin token; anyone else sees no badge).
function setDisputeCount(n){
  $("quality_n").innerHTML = n ? "<span class='sr'>, " + Number(n) + (n === 1 ? " disputed fact" : " disputed facts") + "</span><span class='pill' aria-hidden='true'>" + Number(n) + "</span>" : "";
  $("tab_quality").className = n ? "lit" : "";
}
function loadDisputeCount(){
  api("/quality" + nsQs("?", true)).then(function(j){
    setDisputeCount((j.conflict_groups || []).filter(function(g){ return g.tier === "fact"; }).length);
  }).catch(function(){ setDisputeCount(0); });
}
function loadHeldCount(){
  api("/quarantine" + nsQs("?", true)).then(function(j){ setHeldCount((j.quarantine || []).length); })
    .catch(function(){ setHeldCount(0); });
}
function refreshHeld(){ if(VIEW === "quality"){ loadQuality(); } else { loadHeld(); } }
function loadHeld(){
  setView("held");
  api("/quarantine" + nsQs("?", true)).then(function(j){
    var held = j.quarantine || [];
    setHeldCount(held.length);
    $("count").textContent = held.length + " held";
    $("list").innerHTML = held.length ? held.map(function(q){
      var why = (q.reasons || []).map(function(r){ return "<span class='tag why'>"+esc(r.label)+(r.field && String(r.label).indexOf(r.field) < 0 ? " in "+esc(r.field) : "")+"</span>"; }).join("");
      var heldTags = tagsHtml(q.tags);
      var who = q.written_by ? byLine(q.written_by) : (q.source ? " &middot; claims "+esc(q.source) : "");
      return "<div class='card held'><div class='cardhead'><div><span class='stamp'>HELD &middot; NOT IN SHARED MEMORY</span><h3>"+esc(q.title || "(title unchanged)")+"</h3>"+
        "<div class='meta'>held #"+Number(q.id)+" &middot; "+(q.op === "update" ? "update of #"+Number(q.target_id) : "new note")+
        " &middot; "+esc(q.namespace)+" &middot; "+when(q.created_at)+who+"</div>"+(why || "<span class='tag why'>held by policy</span>")+(heldTags ? "<div>"+heldTags+"</div>" : "")+"</div>"+
        acts("<button aria-label='reject held write #"+Number(q.id)+"' onclick='arm(this,function(){qQuarantine("+Number(q.id)+",&quot;reject&quot;)})'>Reject</button> "+
        "<button class='ghost' aria-label='approve held write #"+Number(q.id)+"' onclick='arm(this,function(){qQuarantine("+Number(q.id)+",&quot;approve&quot;)})'>Approve</button>")+"</div>"+
        (q.body ? "<div class='heldbody'>"+esc(q.body)+"</div>" : "")+"</div>";
    }).join("") : empty("Nothing is held. Writes that look like secrets or injected instructions wait here for your approval.");
  }).catch(failList);
}

// ---- Sessions: what the capture hooks recorded, one session at a time (GET /sessions, GET /sessions/:id) ----
// Everything shown is stored text (prompts, titles, folders, even the session id), so all of it goes through esc(); the
// session id reaches the click handler through a data attribute, never spliced into script.
function nsQs(sep, noDistrusted){
  var ns = $("ns").value.trim();
  var qs = (ns ? ("namespace=" + encodeURIComponent(ns)) : "") + (!noDistrusted && inc() ? ((ns ? "&" : "") + "include_distrusted=1") : "");
  return qs ? (sep + qs) : "";
}
function when(s){ return esc(String(s||"").slice(0,16).replace("T"," ")); }
function loadSessions(){
  setView("sessions");
  api("/sessions?limit=100" + nsQs("&")).then(function(j){
    var ss = j.sessions || [];
    $("count").textContent = ss.length + " session" + (ss.length===1?"":"s");
    $("list").innerHTML = ss.length ? ss.map(function(s){
      return "<div class='card'><div class='cardhead'><div><h3>"+esc(s.summary || "(no summary yet)")+"</h3>"+
        "<div class='meta'>"+when(s.started_at)+(s.ended_at ? " to "+when(s.ended_at) : " &middot; open")+" &middot; "+esc(s.namespace)+
        " &middot; "+esc(s.cwd)+" &middot; "+Number(s.prompt_count||0)+" prompts, "+Number(s.event_count||0)+" events</div>"+
        "<div class='meta'>"+(s.model ? "Model at session start: <b>"+esc(s.model)+"</b> <small class='tech'>reported by the app, not verified; subagents and /model switches may differ</small>" : "Model: not reported by the app")+"</div></div>"+
        acts("<button class='ghost' data-sid='"+esc(s.id)+"' onclick='loadSession(this.getAttribute(&quot;data-sid&quot;))'>Timeline</button>")+"</div></div>";
    }).join("") : empty("No sessions recorded yet. Run <code>monomem setup --capture</code> to install the hooks.");
  }).catch(function(e){ incRefused(e); failList(e); });
}
// One session: the summary on top, then prompts and observations merged oldest first.
function loadSession(id){
  setView("session");
  api("/sessions/" + encodeURIComponent(id) + nsQs("?")).then(function(j){
    var items = (j.prompts || []).map(function(p){ return { at: p.at, html: "<span class='tag'>prompt</span>"+esc(p.text) }; })
      .concat((j.rows || []).filter(function(r){ return r.kind !== "summary"; }).map(function(r){
        return { at: r.date, html: "<span class='tag'>"+esc(r.type)+"</span>#"+Number(r.id)+" "+esc(r.title)+
          (r.distrusted ? "<span class='badge-bad'>DISTRUSTED</span>" : "")+
          ((r.files||[]).length ? "<div class='meta'>"+(r.files||[]).map(esc).join(", ")+"</div>" : "") };
      }));
    items.sort(function(a,b){ return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    var s = j.session || {}, sum = j.summary;
    $("count").textContent = items.length + " timeline entr" + (items.length===1?"y":"ies");
    $("list").innerHTML = "<div class='row'><button class='linkbtn' onclick='loadSessions()'>&larr; all sessions</button>"+
      "<span class='muted'>"+esc(s.id)+" &middot; "+esc(s.cwd)+"</span></div>"+
      (sum ? "<div class='card'><h3>"+esc(sum.title)+"</h3><div class='meta'>summary #"+Number(sum.id)+" &middot; "+when(sum.updated_at)+"</div>"+
        "<div class='body'>"+esc(sum.body)+"</div></div>" : "")+
      (items.length ? items.map(function(it){ return "<div class='card'><div class='meta'>"+when(it.at)+"</div>"+it.html+"</div>"; }).join("")
        : empty("Nothing recorded in this session yet."));
  }).catch(function(e){ incRefused(e); failList(e); });
}

// ---- Quality: what is worth a look (GET /quality, admin). Every button goes through a path that asks first and can be
// undone: replace = supersede preview, then confirm (undo: supersede undo), archive (undo: restore), quarantine approve/reject.
// The server calls a held write "quarantined"; the page says "held" everywhere.
function qPrivate(id){
  api("/notes/" + id).then(function(j){ var n = j.note || j; return api("/notes/" + id, { method:"PUT", body: JSON.stringify({ sensitivity: "private", if_rev: n.rev }) }); })
    .then(function(){ loadQuality(); say("Note #" + id + " is now private."); }).catch(fail);
}
function typeLabel(t){ return t === "quarantined" ? "held" : String(t); }
function loadQuality(){
  setView("quality");
  api("/quality" + nsQs("?")).then(function(j){
    var c = j.counts || {};
    $("count").textContent = Object.keys(c).map(function(k){ return c[k] + " " + typeLabel(k); }).join(", ");
    var rows = (j.issues || []).map(function(i){
      var a = Number(i.ids[0]), b = Number(i.ids[1]), q = Number(i.quarantine_id), btn = "";
      if(i.type === "duplicate" || i.type === "stale_twin"){ btn = "<button onclick='qReplace("+a+","+b+")'>Replace #"+a+" with #"+b+"</button>"; }
      else if(i.type === "contradiction"){ btn = "<button onclick='qReplace("+a+","+b+")'>Replace #"+a+" with #"+b+"</button>"; }
      else if(i.type === "pii"){ btn = "<button onclick='qPrivate("+a+")'>Make #"+a+" private</button>"; }
      else if(i.type === "quarantined"){ btn = "<button aria-label='reject held write #"+q+"' onclick='arm(this,function(){qQuarantine("+q+",&quot;reject&quot;)})'>Reject</button> <button class='ghost' aria-label='approve held write #"+q+"' onclick='arm(this,function(){qQuarantine("+q+",&quot;approve&quot;)})'>Approve</button>"; }
      else { btn = "<button class='ghost' onclick='arm(this,function(){qArchive("+a+")})'>Archive</button>"; }
      return "<div class='card'><div class='cardhead'><div><h3><span class='tag'>"+esc(typeLabel(i.type))+"</span>"+esc(i.detail)+"</h3>"+
        "<div class='meta'>"+esc(i.namespace)+" &middot; "+esc(i.fix)+(i.alt ? " &middot; or "+esc(i.alt) : "")+"</div></div>"+acts(btn)+"</div></div>";
    }).join("");
    var cf = j.conflict_groups || [];
    CFG = cf; CFACT = {};
    setDisputeCount(cf.filter(function(g){ return g.tier === "fact"; }).length);
    var tot = Number(j.conflict_total) || cf.length;
    var head = j.conflict_capped ? "showing "+cf.length+" of at least "+tot : (cf.length < tot ? "showing "+cf.length+" of "+tot : String(cf.length));
    var crow = cf.length ? "<div class='card'><h3>Conflicts ("+head+")</h3><div class='meta'>Different writers, same key, different value. Flag only: nothing changes until you press a button and confirm. Exact = the notes carry the same fact key. Possible = guessed from the text.</div>"+cf.map(function(g, gi){ return cfRow(g, gi); }).join("")+"</div>" : "";
    $("list").innerHTML = crow + rows || empty("No quality issues found. Duplicates, stale notes and held writes will be listed here.");
  }).catch(failList);
}
// One disputed key: every value with the notes that state it, then the buttons. No value is the default.
var CFG = [], CFACT = {};
function cfNote(n){
  return "<div class='meta'>#"+Number(n.id)+" "+esc(n.title)+" &middot; "+esc(n.writer)+" ("+esc(n.kind)+") &middot; "+esc(String(n.at).slice(0,10))+(n.pinned ? " &middot; pinned" : "")+"</div>";
}
function cfRow(g, gi){
  gi = Number(gi) || 0;
  var btns = [], more = [], all = [], seen = {};
  g.values.forEach(function(v, vi){
    v.notes.forEach(function(n){ all.push(n); });
    // Keeping one value changes the other values' notes, and a pinned note can only be changed from the CLI.
    var blocked = g.values.some(function(o, oi){ return oi !== vi && o.notes.some(function(n){ return n.pinned; }); });
    if(!blocked){ btns.push("<button class='ghost' onclick='cfKeep("+gi+","+vi+")'>Keep "+esc(v.value)+"</button>"); }
  });
  all.forEach(function(n){
    if(!n.pinned){ more.push("<button class='ghost' onclick='var x=this;arm(x,function(){qPin("+Number(n.id)+")})'>Pin #"+Number(n.id)+"</button>"); }
    if(!seen[n.writer]){
      seen[n.writer] = 1;
      more.push("<button class='ghost' data-ns='"+esc(g.namespace)+"' data-w='"+esc(n.writer)+"' onclick='var x=this;arm(x,function(){qDistrust(x)})'>Distrust "+esc(n.writer)+"</button>");
    }
  });
  var pins = all.filter(function(n){ return n.pinned; }).map(function(n){ return "#"+Number(n.id); });
  return "<div class='cf'><h3><span class='tag'>"+esc(g.confidence)+"</span>"+esc(g.key)+"</h3>"+
    g.values.map(function(v){ return "<div class='cfval'><b>"+esc(v.value)+"</b>"+v.notes.map(cfNote).join("")+"</div>"; }).join("")+
    "<div class='meta'>Project: <b>"+esc(g.namespace)+"</b>"+(pins.length ? " &middot; "+pins.join(", ")+" pinned: change it from the CLI" : "")+"</div>"+acts(btns.join(" "))+
    (more.length ? "<details class='cfmore'><summary class='muted'>More</summary>"+acts(more.join(" "))+"</details>" : "")+
    "<div class='cfdlg' id='cfdlg"+gi+"'></div></div>";
}
// The confirmation sits inside the clicked card: short bullets, then the buttons. Bullets are built from escaped pieces.
function cfDialog(gi, bullets, actions){
  CFACT[gi] = actions.map(function(a){ return a[1]; });
  $("cfdlg"+gi).innerHTML = "<ul>"+bullets.map(function(b){ return "<li>"+b+"</li>"; }).join("")+"</ul><div class='acts'>"+
    actions.map(function(a, i){ return "<button"+(a[2] ? " class='ghost'" : "")+" onclick='cfAct("+gi+","+i+")'>"+esc(a[0])+"</button>"; }).join(" ")+
    " <button class='ghost' onclick='cfClose("+gi+")'>Cancel</button></div>";
}
function cfAct(gi, i){ var f = CFACT[gi] && CFACT[gi][i]; if(f){ f(); } }
function cfClose(gi){ var d = $("cfdlg"+gi); if(d){ d.innerHTML = ""; } CFACT[gi] = []; }
function cfNoteText(n){ return "#"+Number(n.id)+" &ldquo;"+esc(n.title)+"&rdquo; ("+esc(n.writer)+")"; }
function cfFacts(n){ var k = Number(n); return k === 1 ? "1 other fact" : k+" other facts"; }
function cfKeep(gi, vi){
  var g = CFG[gi]; if(!g){ return; }
  var keep = g.values[vi], losers = [];
  g.values.forEach(function(v, i){ if(i !== vi){ v.notes.forEach(function(n){ losers.push({ n: n, value: v.value }); }); } });
  if(g.tier !== "fact"){ cfReplace(gi, g, keep, losers); return; }
  var bullets = ["You are keeping <b>"+esc(g.key)+" = "+esc(keep.value)+"</b>."];
  losers.forEach(function(l){
    var o = Number(l.n.otherFacts) || 0;
    bullets.push(cfNoteText(l.n)+" says "+esc(g.key)+" = "+esc(l.value)+". That one fact is removed. The note stays"+(o ? ", with its "+cfFacts(o)+"." : "."));
  });
  bullets.push("The note's text may still mention the old value. The note gets a <b>fact-removed:"+esc(g.key)+"</b> tag so you can find it and edit the text.");
  bullets.push("No note is deleted or hidden. To bring a fact back, write it on the note again.");
  cfDialog(gi, bullets, [["Remove the disputed fact", function(){ cfRemoveFacts(gi, g, losers); }], ["Replace whole note instead", function(){ cfReplace(gi, g, keep, losers); }, 1]]);
}
// Removes only the disputed fact tag, through the ordinary note edit (lint, approve-first and the pin gate still apply).
function cfRemoveFacts(gi, g, losers){
  var p = Promise.resolve(), done = 0, held = 0;
  losers.forEach(function(l){
    var fk = l.n.factKey || g.key, pre = "fact:"+fk+"=", mark = "fact-removed:"+fk;
    p = p.then(function(){
      return api("/notes/"+Number(l.n.id)).then(function(j){
        var n = j.note || j;
        var tags = (n.tags || []).filter(function(t){ return String(t).trim().indexOf(pre) !== 0 && t !== mark; }).concat([mark]);
        return api("/notes/"+Number(l.n.id), { method:"PUT", body: JSON.stringify({ tags: tags, if_rev: n.rev }) });
      }).then(function(r){ if(r && r.quarantined){ held++; } else { done++; } });
    });
  });
  p.then(function(){
    loadQuality();
    var m = held ? (done ? "Removed "+g.key+" from "+done+(done === 1 ? " note" : " notes")+"; " : "")+held+(held === 1 ? " change is" : " changes are")+" held for review (approve-first), so nothing was removed there yet." : "Removed "+g.key+" from "+done+(done === 1 ? " note." : " notes.");
    say(m+(done ? " The note text may still mention the old value: search for the tag fact-removed:"+g.key+"." : ""));
  })
   .catch(function(e){ loadQuality(); say("Removed "+g.key+" from "+done+" of "+losers.length+" notes ("+held+" held for review), then: "+(e && e.message ? e.message : String(e)), true); });
}
// Replace whole note: the server's preview issues the one-time code; the bullets are ours.
function cfReplace(gi, g, keep, losers){
  api("/supersede/preview", { method:"POST", body: JSON.stringify({ old_ids: losers.map(function(l){ return Number(l.n.id); }), new_id: Number(keep.notes[0].id), gui: true }) }).then(function(p){
    var bullets = ["You are keeping <b>"+esc(g.key)+" = "+esc(keep.value)+"</b> (note #"+Number(keep.notes[0].id)+")."];
    losers.forEach(function(l){
      var o = Number(l.n.otherFacts) || 0;
      bullets.push("Replaces "+cfNoteText(l.n)+": it stops showing in search and lists"+(g.tier === "fact" && o ? ", and its "+cfFacts(o)+" go with it." : "."));
    });
    bullets.push("Nothing is deleted. To bring one back: monomem supersede undo "+Number(losers[0].n.id)+".");
    if(p.requires_acknowledgement){ bullets.push("An administrator warning applies to this replacement. Confirming accepts it."); }
    cfDialog(gi, bullets, [["Replace whole note", function(){
      var body = { token: p.token };
      if(p.requires_acknowledgement){ body.acknowledge_risk = true; }
      api("/supersede/confirm", { method:"POST", body: JSON.stringify(body) }).then(loadQuality).catch(fail);
    }]]);
  }).catch(fail);
}
function qReplace(oldId, newId){
  // gui: the server words the question for a person (no request codes or POST instructions).
  api("/supersede/preview", { method:"POST", body: JSON.stringify({ old_ids: [oldId], new_id: newId, gui: true }) }).then(function(p){
    ask(p.warning, "Confirm replace", function(){
      var body = { token: p.token };
      if(p.requires_acknowledgement){ body.acknowledge_risk = true; }
      api("/supersede/confirm", { method:"POST", body: JSON.stringify(body) }).then(loadQuality).catch(fail);
    });
  }).catch(fail);
}
function qPin(id){
  api("/pinned", { method:"PUT", body: JSON.stringify({ id: id, pinned: true }) }).then(loadQuality).catch(fail);
}
function setPin(id, on){
  api("/pinned", { method:"PUT", body: JSON.stringify({ id: id, pinned: on }) })
    .then(function(){ load(); say(on ? "Note #" + id + " is pinned: it is shown first at the start of every session." : "Note #" + id + " is no longer pinned."); })
    .catch(fail);
}
function qDistrust(btn){
  api("/trust/distrust", { method:"POST", body: JSON.stringify({ namespace: btn.getAttribute("data-ns"), writer: btn.getAttribute("data-w") }) }).then(loadQuality).catch(fail);
}
// The caller's button already asked ("Confirm archive?"); these just act.
function qArchive(id){
  api("/notes/" + id + "/archive", { method:"POST" }).then(loadQuality).catch(fail);
}
function qQuarantine(id, action){
  api("/quarantine/" + id + "/" + action, { method:"POST" }).then(function(){
    refreshHeld(); loadHeldCount(); say("Held write #" + id + (action === "approve" ? " stored." : " discarded."));
  }).catch(fail);
}

// "Never show again": the never-show tag keeps a note out of the session-start context (it stays searchable).
function neverShow(id, on){
  api("/notes/" + id).then(function(j){
    var n = j.note || j;
    var tags = (n.tags || []).filter(function(t){ return t !== "never-show"; }).concat(on ? ["never-show"] : []);
    return api("/notes/" + id, { method:"PUT", body: JSON.stringify({ tags: tags, if_rev: n.rev }) });
  }).then(load).catch(fail);
}

// ---- Meter: what Monomem costs you (GET /stats -> meter). Numbers only. ----
function loadMeter(){
  setView("meter");
  var ns = $("ns").value.trim();
  api("/stats" + (ns ? ("?namespace=" + encodeURIComponent(ns)) : "")).then(function(j){
    var m = j.meter || {}, t = m.totals || {};
    function num(v){ return Number(v||0).toLocaleString(); }
    $("count").textContent = num(t.sessions) + " metered session" + (t.sessions===1?"":"s");
    var rows = (m.recent || []).map(function(r){
      return "<tr><td>"+when(r.updated_at)+"</td><td>"+(r.namespace ? esc(r.namespace) : "<span class='muted'>(none)</span>")+"</td><td class='n'>"+num(r.injected_tokens)+"</td><td class='n'>"+num(r.saved_tokens)+"</td><td class='n'>"+num(r.llm_tokens)+"</td></tr>";
    }).join("");
    function stat(big, text){ return "<div class='stat'><b>"+big+"</b><span>"+text+"</span></div>"; }
    $("list").innerHTML = "<div class='card'><h3>Totals</h3><div class='stats'>"+
      stat("~"+num(t.injected_tokens), "tokens injected at session start ("+num(t.injections)+(Number(t.injections) === 1 ? " time" : " times")+")")+
      stat("~"+num(t.saved_tokens), "tokens saved (estimate): the full text of the notes shown, minus the tokens injected")+
      stat(num(t.llm_tokens), "local-model tokens (0 = the optional summarizer is off)")+
      stat(num(m.capture_events), "capture events recorded")+
      stat((Number(m.db_bytes||0)/1048576).toFixed(1)+" MB", "database on disk")+"</div>"+
      "<div class='meta' style='margin-top:8px'>"+esc(m.note)+"</div></div>"+
      (rows ? "<div class='card'><h3>Recent sessions</h3><div class='scroll'><table class='apps'><tr><th scope='col'>updated</th><th scope='col'>project</th><th scope='col' class='n'>injected</th><th scope='col' class='n'>saved</th><th scope='col' class='n'>model</th></tr>"+rows+"</table></div></div>"
        : empty("No session metered yet: the numbers start with the next session the SessionStart hook runs for."));
  }).catch(failList);
}


// ---- Apps: which apps may connect and what each can see (admin only; GET/POST/DELETE /tokens). Keys are never listed;
// a new one is shown once, here, right after it is made.
function loadApps(){
  setView("apps");
  api("/tokens").then(function(j){
    var apps = j.apps || [];
    $("count").textContent = apps.length + " app" + (apps.length===1?"":"s") + " can connect";
    var rows = apps.map(function(a){
      var lim = a.max_sensitivity ? ("up to " + esc(a.max_sensitivity)) : "<span class='nolimit'>NO LIMIT" + (a.scope === "admin" ? " (sees everything)" : "") + "</span>";
      var rm = (a.source === "file") ? "<button class='danger' data-label='"+esc(a.label)+"' aria-label='Remove app "+esc(a.label)+"' onclick='arm(this,function(){removeApp(this.getAttribute(&quot;data-label&quot;))}.bind(this))'>remove</button>" : "<span class='muted'>set outside the dashboard</span>";
      return "<tr><td>"+esc(a.label)+"</td><td>"+esc(a.scope)+"</td><td>"+esc(a.namespace || "all")+"</td><td>"+lim+"</td><td>"+(a.last_used ? when(a.last_used) : "not since the server started")+"</td><td>"+rm+"</td></tr>";
    }).join("");
    $("list").innerHTML =
      "<div class='card'><h3>Apps that can connect</h3><table class='apps'><tr><th>name</th><th>may</th><th>project</th><th>sees notes labelled</th><th>last used</th><th></th></tr>"+rows+"</table>"+
      "<p class='meta'>Keys are not shown here. Removing an app cuts it off straight away.</p></div>"+
      "<div class='card'><h3>Add an app</h3><div class='row'>"+
      "<input id='ap_label' placeholder='name, e.g. cursor' aria-label='Name for the new app'>"+
      "<select id='ap_scope' aria-label='What the app may do'><option value='write'>read and write</option><option value='read'>read only</option></select>"+
      "<select id='ap_max' aria-label='Highest label the app may see'><option value='internal'>sees public + internal</option><option value='public'>sees public only</option><option value='private'>sees private notes too (still limited)</option><option value='none'>NO LIMIT (sees everything)</option></select>"+
      "<button onclick='addApp()'>Add app</button></div><div id='ap_out'></div></div>";
  }).catch(failList);
}
function addApp(){
  var label = $("ap_label").value.trim();
  var max = $("ap_max").value;
  if(!label){ say("Give the app a name first.", true); return; }
  var body = { label: label, scope: $("ap_scope").value };
  var go = function(){
    api("/tokens", { method:"POST", body: JSON.stringify(body) }).then(function(j){
      var out = $("ap_out");
      out.innerHTML = "<p><b>Copy this key now.</b> It is shown once and cannot be looked up later.</p>"+
        "<pre class='snip' id='ap_tok'></pre><button onclick='copyText(&quot;ap_tok&quot;)'>Copy key</button>"+
        "<p class='meta'>"+esc(j.access || "")+"</p>"+
        "<p>Paste this into the app's settings:</p><pre class='snip' id='ap_snip'></pre><button class='ghost' onclick='copyText(&quot;ap_snip&quot;)'>Copy settings</button>";
      $("ap_tok").textContent = j.token;
      $("ap_snip").textContent = j.snippet || "";
      $("ap_label").value = "";
      say("Added " + label + ".");
    }).catch(fail);
  };
  if(max === "none"){
    body.no_limit = true;
    ask("NO LIMIT means this app can read every private note and change any label. Only do this for an app you trust completely.", "Add it anyway", go);
  } else { body.max = max; go(); }
}
function copyText(id){
  var t = $(id).textContent;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(function(){ say("Copied."); }, function(){ say("Could not copy; select the text and copy it by hand.", true); });
  } else { say("Select the text and copy it by hand.", true); }
}
function removeApp(label){
  api("/tokens/" + encodeURIComponent(label), { method:"DELETE" }).then(function(){ loadApps(); say("Removed " + label + "."); }).catch(fail);
}

// ---- Top card: how tidy memory is and what changed lately (admin only). Counts and plain words; never note text. ----
function loadInsights(){
  var box = $("insights");
  api("/insights").then(function(j){
    var h = j.health || {};
    var ded = (h.deductions || []).map(function(d){ return "<li>-" + Number(d.points) + " " + esc(d.category) + ": " + esc(d.detail) + "</li>"; }).join("");
    box.innerHTML = "<div class='cardhead'><div><h3>Memory tidiness: " + Number(h.score) + " / 100</h3>" +
      "<div class='meta'>" + esc(String(j.text || "").split(String.fromCharCode(10))[0]) + "</div></div>" +
      acts("<button class='ghost' onclick='loadQuality()'>See what to fix</button>") + "</div>" +
      (ded ? "<ul class='meta'>" + ded + "</ul>" : "<div class='meta'>Nothing to deduct.</div>");
    box.style.display = "block";
  }).catch(function(){ box.style.display = "none"; });
}

// ---- Audit: who changed what (GET /audit, admin). Metadata only. ----
function loadAudit(){
  setView("audit");
  var op = ($("au_op") || {}).value || "";
  var since = ($("au_since") || {}).value || "24h";
  api("/audit?since=" + encodeURIComponent(since) + (op ? "&op=" + encodeURIComponent(op) : "") + "&limit=200").then(function(j){
    var es = j.entries || [];
    $("count").textContent = es.length + " entr" + (es.length===1?"y":"ies");
    var rows = es.map(function(e){
      return "<tr><td>" + when(e.ts) + "</td><td>" + esc(e.op) + "</td><td>" + esc(e.label || "command line / server") + "</td><td>" + esc(e.namespace || "") + "</td><td>" + (e.id != null ? "#" + Number(e.id) : "") + "</td></tr>";
    }).join("");
    var ops = ["", "create", "update", "delete"].map(function(o){ return "<option value='" + o + "'" + (o===op?" selected":"") + ">" + (o || "all actions") + "</option>"; }).join("");
    var wins = ["24h", "7d", "30d"].map(function(w){ return "<option value='" + w + "'" + (w===since?" selected":"") + ">last " + w + "</option>"; }).join("");
    $("list").innerHTML = "<div class='row'><select id='au_since' aria-label='How far back' onchange='loadAudit()'>" + wins + "</select><select id='au_op' aria-label='Kind of action' onchange='loadAudit()'>" + ops + "</select></div>" +
      (rows ? "<div class='card'><table class='apps'><tr><th>when</th><th>action</th><th>app</th><th>project</th><th>note</th></tr>" + rows + "</table></div>" : empty("Nothing logged in that time."));
  }).catch(failList);
}

function addNote(){
  var title = $("n_title").value.trim();
  var err = $("n_err"); err.textContent = "";
  if(!title){ err.textContent = "title is required"; return; }
  var tags = $("n_tags").value.split(",").map(function(t){return t.trim();}).filter(Boolean);
  var payload = { title: title, body: $("n_body").value,
    tags: tags, namespace: $("n_ns").value.trim() || undefined, sensitivity: $("n_lvl").value };
  api("/notes", { method:"POST", body: JSON.stringify(payload) })
    .then(function(j){
      $("n_title").value=""; $("n_body").value="";
      $("n_tags").value=""; toggleNew(); load();
      if(j && j.quarantined){ say("Held for admin review (held write #" + j.quarantined.id + "). See the Held tab."); } })
    .catch(function(e){ err.textContent = e.message; });
}

function del(id){
  api("/notes/" + id, { method:"DELETE" }).then(function(){ if(VIEW === "review"){ loadReview(); } else { load(); } }).catch(fail);
}

function doExport(){
  api("/export").then(function(j){
    var blob = new Blob([JSON.stringify(j, null, 2)], { type:"application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "monomem-export.json"; a.click();
  }).catch(fail);
}

function doImport(input){
  var f = input.files[0]; if(!f){ return; }
  var reader = new FileReader();
  reader.onload = function(){
    try {
      var data = JSON.parse(reader.result);
      var notes = data.notes || data;
      api("/import", { method:"POST", body: JSON.stringify({ notes: notes }) })
        .then(function(j){
          var a = j.attestations;
          load();
          say("Imported " + j.imported + " notes" + (a ? (" (" + a.verified + " with a verified writer attestation, " + a.unverified + " unverified)") : "")); })
        .catch(fail);
    } catch(e){ say("not valid JSON", true); }
  };
  reader.readAsText(f);
  input.value = "";
}

var t;
$("q").addEventListener("input", function(){ clearTimeout(t); t = setTimeout(load, 250); });
$("ns").addEventListener("input", function(){ clearTimeout(t); t = setTimeout(load, 250); });

if(LOGIN_CODE){
  fetch("/login", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ code: LOGIN_CODE }) })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
    .then(function(x){
      if(x.ok && x.j.token){ try { sessionStorage.setItem(TOKKEY, x.j.token); } catch(e){} start(); }
      else { show(false); $("gate_err").textContent = (x.j && x.j.error) || "That sign-in link did not work. Run monomem open again."; }
    })
    .catch(function(){ show(false); });
} else if(tok()){ start(); } else { show(false); $("tok").focus(); }
`;

// The brand mark (docs/brand/mark-gold-48.png), served at GET /favicon.ico without a token.
export const FAVICON_PNG = Buffer.from(
  "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",
  "base64",
);
