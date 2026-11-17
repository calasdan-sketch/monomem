// The dashboard page: sign-in, Welcome (first run), and the app (4 tabs + the Settings sheet). No data in the page; every
// fetch carries the key. The script is /dashboard.js (src/ui/js-*.ts).
import { CSS } from "./css.js";

const TAB = (id: string, view: string, label: string, badge = ""): string =>
  `<button id="tab_${id}" onclick="${view}()">${label}${badge ? `<span id="${badge}"></span>` : ""}</button>`;

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Monomem</title>
<meta name="theme-color" content="#0B2E45">
<meta name="color-scheme" content="dark light">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" type="image/png" sizes="64x64">
<link rel="apple-touch-icon" href="/icon-192.png">
<style>${CSS}</style>
</head>
<body>
<div id="app" hidden>
<header class="top">
  <div class="bar">
    <div class="brand"><img src="/icon.svg" alt="" width="28" height="28"><span>Monomem</span></div>
    <input id="q" type="search" aria-label="Search notes" placeholder="Search notes" aria-keyshortcuts="/">
    <button id="btn_new" class="primary" aria-haspopup="dialog" aria-expanded="false" aria-keyshortcuts="n" onclick="toggleNew()">New note</button>
    <button id="btn_settings" class="icon" aria-label="Settings" aria-haspopup="dialog" title="Settings" onclick="openSettings()">&#9881;&#xFE0E;</button>
  </div>
</header>
<nav class="tabs" aria-label="Views">
  <div class="seg">
    ${TAB("list", "load", "Notes")}
    ${TAB("review", "loadReview", "Review", "review_n")}
    ${TAB("held", "loadHeld", "Held", "held_n")}
    ${TAB("activity", "loadChanges", "Activity")}
  </div>
</nav>
<main>
  <div class="viewhead">
    <button id="back" class="plain back" hidden onclick="goBack()">&lsaquo; Back</button>
    <h2 id="viewh" class="t-large">Notes</h2>
    <p id="viewd" class="t-callout muted"></p>
  </div>
  <div id="needs" class="banner" role="status" hidden></div>
  <div id="runner" class="banner" role="status" hidden></div>
  <details id="filters" class="filters">
    <summary>Filters</summary>
    <div class="row" role="group" aria-label="Filters">
      <label class="field"><span>Project</span><input id="ns" placeholder="All projects"></label>
      <label class="field"><span>Who can see it</span><select id="lvlf" onchange="applyFilter()"><option value="">Everyone and every level</option><option value="public">Public</option><option value="internal">Internal</option><option value="private">Private</option></select></label>
      <label class="chk"><input type="checkbox" id="inc" onchange="load()"> Show notes from distrusted writers</label>
    </div>
  </details>
  <div id="msg" class="msg" role="status" aria-live="polite"></div>
  <span id="armhint" class="sr" role="status" aria-live="polite"></span>
  <div id="list"></div>
  <p id="count" class="t-foot muted" role="status"></p>
</main>
<footer class="foot">Monomem by Calas Automations &middot; Press <kbd>?</kbd> for keyboard shortcuts</footer>
</div>

<div id="welcome" class="welcome" hidden></div>

<div id="gate" class="gate" hidden>
  <div class="gcard">
    <div class="ghead"><img src="/icon.svg" alt="" width="64" height="64"><h1>Monomem</h1><p>by Calas Automations</p></div>
    <div class="gbody">
      <p>Open Monomem from its Start menu entry, or run <code>monomem open</code> on this computer. It signs you in here.</p>
      <details>
        <summary class="muted">Use an app key instead</summary>
        <label class="field" style="margin-top:12px"><span>App key</span><input id="tok" type="password" autocomplete="off" placeholder="Paste the key" onkeydown="if(event.key==='Enter')saveTok()"></label>
        <p class="help">Your main key is in the file named .token in your Monomem data folder; <code>monomem doctor</code> shows where that is.</p>
        <button class="primary" onclick="saveTok()">Open</button>
      </details>
      <p id="gate_err" class="err" role="alert"></p>
    </div>
  </div>
</div>

<dialog id="newsheet" aria-labelledby="new_h" onclose="newClosed()">
  <form class="sheet" method="dialog" onsubmit="event.preventDefault();addNote()">
    <div class="sheethead"><h2 id="new_h" class="t-title">New note</h2><button type="button" class="plain" onclick="closeSheet('newsheet')">Cancel</button></div>
    <label class="field"><span>Title</span><input id="n_title" required placeholder="For example: We deploy with pnpm"></label>
    <label class="field"><span>Note</span><textarea id="n_body" placeholder="What your apps should know"></textarea></label>
    <details>
      <summary class="muted">More options</summary>
      <label class="field" style="margin-top:12px"><span>Project</span><input id="n_ns" placeholder="Leave empty for the default project"></label>
      <label class="field"><span>Tags</span><input id="n_tags" placeholder="Comma separated, for example: deploy, ci"></label>
      <label class="field"><span>Who can see this</span><select id="n_lvl"><option value="internal">Normal (internal)</option><option value="public">Everyone (public)</option><option value="private">Private (hidden from apps you limited)</option></select></label>
    </details>
    <p id="n_err" class="err" role="alert"></p>
    <div class="row" style="justify-content:flex-end"><button type="submit" class="primary">Save</button></div>
  </form>
</dialog>

<dialog id="settings" aria-labelledby="set_h">
  <div class="sheet">
    <div class="sheethead"><h2 id="set_h" class="t-title">Settings</h2><button class="plain" onclick="closeSheet('settings')">Done</button></div>
    <div id="set_body"></div>
  </div>
</dialog>

<dialog id="confirmsheet" aria-labelledby="cf_h">
  <div class="sheet">
    <h2 id="cf_h" class="t-title" style="margin-bottom:12px"></h2>
    <div id="cf_body"></div>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="plain" onclick="closeSheet('confirmsheet')">Cancel</button><button id="cf_ok" class="primary"></button></div>
  </div>
</dialog>

<dialog id="palette" aria-label="Command palette">
  <div class="sheet">
    <input id="pal_q" type="search" aria-label="Type a command" placeholder="Type a command" aria-controls="pal_list" style="width:100%">
    <ul id="pal_list" role="listbox" aria-label="Commands"></ul>
  </div>
</dialog>

<dialog id="helpsheet" aria-labelledby="help_h">
  <div class="sheet">
    <div class="sheethead"><h2 id="help_h" class="t-title">Keyboard shortcuts</h2><button class="plain" onclick="closeSheet('helpsheet')">Done</button></div>
    <div class="group">
      <div class="item"><span>Search notes</span><kbd>/</kbd></div>
      <div class="item"><span>New note</span><kbd>n</kbd></div>
      <div class="item"><span>Command palette</span><span><kbd>Ctrl</kbd> <kbd>K</kbd> or <kbd>&#8984;</kbd> <kbd>K</kbd></span></div>
      <div class="item"><span>Undo the last change</span><kbd>u</kbd></div>
      <div class="item"><span>Go to Notes, Review, Held, Activity</span><span><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></span></div>
      <div class="item"><span>This list</span><kbd>?</kbd></div>
      <div class="item"><span>Close a sheet</span><kbd>Esc</kbd></div>
    </div>
  </div>
</dialog>

<div id="toast" role="status" aria-live="polite"></div>
<script src="/dashboard.js"></script>
</body>
</html>`;
