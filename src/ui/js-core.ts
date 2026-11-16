// Dashboard script, part 1: helpers, the key, views and tabs, the "Needs you" badge, toasts with Undo, sheets, keyboard
// shortcuts and the command palette. Plain ES5 in a string (no build step, no framework); no backticks inside.
// Everything shown that came from the store goes through esc().
import { humanWriterMap } from "../actor.js";

export const CORE_JS = `
var TOKKEY = "om_tok";
function store(k){ try { return sessionStorage.getItem(TOKKEY + k) || ""; } catch(e){ return ""; } }
function tok(){ return store(""); }
// The person session from a terminal's monomem open (confirms count as a person's) and the local session from any
// monomem open on this computer (connect apps, update, backups). Both are kept for this tab only.
function dsess(){ return store(":ds"); }
function lsess(){ return store(":ls"); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }
function $(id){ return document.getElementById(id); }
function plural(n, one, many){ return Number(n) + " " + (Number(n) === 1 ? one : many); }

// A small coloured chip per writer: a stable hash of the label picks the hue (never red: red means danger here).
var HUES = [30,195,96,261,162,327,63,228,129,294], hueOf = {};
function hue(s){ s = String(s); if(hueOf[s] !== undefined) return hueOf[s];
  var h = 0; for(var i = 0; i < s.length; i++){ h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  var used = {}; for(var k in hueOf) used[hueOf[k]] = 1;
  for(var j = 0; j < HUES.length; j++){ var c = HUES[(h + j) % HUES.length]; if(!used[c]){ return (hueOf[s] = c); } }
  return (hueOf[s] = HUES[h % HUES.length]); }
// Display only: the stored labels stay "primary" / "cli".
function shownWriter(w){ return w === "primary" ? "you (main key)" : w === "cli" ? "terminal" : String(w || "unknown"); }
function chip(label){ return "<span class='chip' style='--h:"+hue(label)+"'>"+esc(shownWriter(label))+"</span>"; }
function byLine(w){ return w ? " &middot; by "+chip(w) : ""; }
function when(s){ return esc(String(s||"").slice(0,16).replace("T"," ")); }
// "3 minutes ago", "yesterday", else the date: calmer than a timestamp.
function ago(s){
  var t = Date.parse(s || ""); if(!t){ return ""; }
  var m = Math.round((Date.now() - t) / 60000);
  if(m < 1){ return "just now"; } if(m < 60){ return plural(m, "minute", "minutes") + " ago"; }
  var h = Math.round(m / 60); if(h < 24){ return plural(h, "hour", "hours") + " ago"; }
  var d = Math.round(h / 24); if(d === 1){ return "yesterday"; } if(d < 14){ return d + " days ago"; }
  return when(s).slice(0, 10);
}
// Tags in plain words: an origin tag (obs.origin:*) says where the text came from; a fact tag reads "key = value".
function originWords(t){
  if(t === "obs.origin:declared"){ return "from outside content (the app said so)"; }
  if(t === "obs.origin:via:memory"){ return "written after reading an unconfirmed note"; }
  if(t.indexOf("obs.origin:tool:") === 0){ return "its session read outside content through " + t.slice(16); }
  return t.indexOf("obs.origin:") === 0 ? "from outside content" : "";
}
function tagChip(t){
  var o = originWords(String(t).trim());
  if(o){ return "<span class='tag why'>"+esc(o)+"</span>"; }
  var m = /^fact:([^=]+)=(.*)$/.exec(String(t).trim());
  return m ? "<span class='tag fact'>"+esc(m[1].trim())+" = "+esc(m[2].trim())+"</span>" : "<span class='tag'>"+esc(t)+"</span>";
}
var HIDDEN_TAGS = { "never-show":1, "reviewed":1 };
function tagsInner(list){ return (list||[]).filter(function(t){ return !HIDDEN_TAGS[t]; }).map(tagChip).join(""); }
function chipsRow(inner){ return inner ? "<div class='chips'>"+inner+"</div>" : ""; }
function tagsHtml(list){ return chipsRow(tagsInner(list)); }
function acts(html){ return "<div class='acts'>"+html+"</div>"; }
function empty(title, text, btn){ return "<div class='empty'><h3 class='t-head'>"+title+"</h3>"+(text ? "<p class='muted'>"+text+"</p>" : "")+(btn || "")+"</div>"; }

// Messages go to the status line, never a pop-up.
function say(text, isErr){ var m = $("msg"); m.className = "msg" + (isErr ? " err" : ""); m.textContent = text || ""; }
function fail(e){ say(e && e.message ? e.message : String(e), true); }
function failList(e){ $("list").innerHTML = "<p class='err'>"+esc(e && e.message ? e.message : String(e))+"</p>"; }

// Two-step button for actions that cannot be undone: the first press asks, the second (within 10 s) acts.
function arm(btn, fn){
  var al = btn.getAttribute("aria-label");
  if(btn.getAttribute("data-armed")){ clearTimeout(btn._t); btn.removeAttribute("data-armed"); if(al){ btn.setAttribute("aria-label", al.replace(/^confirm /, "")); } var h = $("armhint"); if(h){ h.textContent = ""; } fn(); return; }
  var was = btn.textContent;
  btn.setAttribute("data-armed", "1");
  btn.textContent = btn.getAttribute("data-confirm") || ("Confirm " + was.toLowerCase() + "?");
  if(al){ btn.setAttribute("aria-label", "confirm " + al); }
  var m = $("armhint"); if(m){ m.textContent = "Press " + was + " again within 10 seconds to confirm."; }
  var hint = m ? m.textContent : "";
  btn._t = setTimeout(function(){ btn.removeAttribute("data-armed"); btn.textContent = was; if(al){ btn.setAttribute("aria-label", al); } if(m && m.textContent === hint) m.textContent = ""; }, 10000);
}
function diffHtml(lines){
  if(!lines || !lines.length){ return ""; }
  return "<div class='diff' role='group' aria-label='What changes, old to new'>"+lines.map(function(l){
    l = String(l); var c = l.charAt(0);
    return c === "-" ? "<div class='del'><span class='sr'>removed: </span>"+esc(l)+"</div>"
      : c === "+" ? "<div class='add'><span class='sr'>added: </span>"+esc(l)+"</div>" : "<div>"+esc(l)+"</div>";
  }).join("")+"</div>";
}

// ---- sheets (native dialog) ----
var OPENER = {};
function openSheet(id){ var d = $(id); OPENER[id] = document.activeElement; try { if(!d.open){ d.showModal(); } } catch(e){ d.open = true; } }
function closeSheet(id){ var d = $(id); try { d.close(); } catch(e){ d.open = false; } var o = OPENER[id]; if(o && o.focus){ try { o.focus(); } catch(e){} } }
// A confirm sheet: a title, escaped or server-built HTML, and one button. Used where a step cannot be undone.
function ask(text, okLabel, fn, extraHtml){
  $("cf_h").textContent = okLabel;
  $("cf_body").innerHTML = "<p>"+esc(text)+"</p>" + (extraHtml || "");
  var ok = $("cf_ok"); ok.textContent = okLabel;
  ok.className = /delete|remove/i.test(okLabel) ? "destructive fill" : "primary";
  ok.onclick = function(){ closeSheet("confirmsheet"); fn(); };
  openSheet("confirmsheet");
  try { ok.focus(); } catch(e){}
}

// ---- toast with Undo (u undoes the last one) ----
var UNDO = null, TOAST_T = 0;
function toast(text, undoFn){
  var t = $("toast"); clearTimeout(TOAST_T);
  UNDO = undoFn || null;
  t.innerHTML = "<span>"+esc(text)+"</span>" + (undoFn ? "<button onclick='undoLast()'>Undo</button>" : "");
  TOAST_T = setTimeout(function(){ t.innerHTML = ""; }, undoFn ? 8000 : 4000);
}
function undoLast(){ var f = UNDO; UNDO = null; $("toast").innerHTML = ""; if(f){ f(); } else { toast("Nothing to undo."); } }

// ---- the key and the server ----
function api(path, opts){
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers["Authorization"] = "Bearer " + tok();
  if(dsess()){ opts.headers["X-Monomem-Dashboard"] = dsess(); }
  if(lsess()){ opts.headers["X-Monomem-Local"] = lsess(); }
  if(opts.body){ opts.headers["Content-Type"] = "application/json"; }
  return fetch(path, opts).then(function(r){
    if(r.status === 401){ logout("That key was not accepted. Open Monomem again from its Start menu entry, or run  monomem open  on this computer."); throw new Error("not signed in"); }
    return r.json().then(function(j){ if(!r.ok){ var e = new Error(j.error || r.status); e.body = j; throw e; } return j; });
  });
}

// ---- views ----
// Four tabs; everything else opens from Settings and has a Back button.
var VIEW = "list", IS_ADMIN = false, BACK = null;
var VIEWS = {
  list:["Notes","What your apps know. Newest first; pinned notes on top."],
  review:["Review","Notes that wait for you: from outside content and not confirmed, flagged by an app, about code that changed, or two answers to one fact. The same list as monomem review."],
  held:["Held","Writes kept out of memory until you approve or reject them: ones that looked like a secret or an injected instruction, and ones to a project where you approve first."],
  changes:["Activity","What changed, what each app did, open tasks and the last handoff."],
  sessions:["Sessions","App sessions Monomem recorded, each with its timeline."],
  session:["Session",""],
  quality:["Tidy up","Duplicates, notes about to be forgotten, private details and other things worth a look."],
  meter:["Usage","What Monomem adds to your apps' context, and the size of your notes."],
  apps:["Apps and keys","The apps that may connect, and what each may see. A key is shown once, when it is made."],
  audit:["Activity log","Who changed what, and when. Never the text of a note."],
  archived:["Archived notes","Notes you archived. Restore one, or delete it for good."]
};
var TABS = { list:"list", review:"review", held:"held", changes:"activity", sessions:"activity", session:"activity" };
function setView(v, back){
  VIEW = v; BACK = back || null;
  say("");
  $("viewh").textContent = VIEWS[v][0];
  $("viewd").textContent = VIEWS[v][1];
  $("back").hidden = !BACK;
  $("filters").hidden = v !== "list";
  ["list","review","held","activity"].forEach(function(t){ $("tab_" + t).ariaCurrent = TABS[v] === t ? "page" : null; });
  showNeeds();
  $("count").textContent = "";
}
function goBack(){ var b = BACK; if(b){ b(); } else { load(); } }
function fromSettings(fn){ return function(){ closeSheet("settings"); fn(); }; }

// ---- Needs you: one count (held, unconfirmed, disagreements, a failed backup) on the tabs, the title and the app icon ----
var NEEDS = { count: 0, items: [] };
function badge(id, n, what){ var el = $(id); if(el){ el.innerHTML = n ? " <span class='badge' aria-hidden='true'>"+Number(n)+"</span><span class='sr'>, "+plural(n, what, what + "s")+" waiting</span>" : ""; } }
function setNeeds(j){
  NEEDS = j || { count: 0, items: [] };
  var by = {}; (NEEDS.items || []).forEach(function(i){ by[i.view] = (by[i.view] || 0) + Number(i.count || 0); });
  badge("held_n", by.held || 0, "write");
  badge("review_n", by.review || 0, "item");
  try { document.title = (NEEDS.count ? "(" + Number(NEEDS.count) + ") " : "") + "Monomem"; } catch(e){}
  try { if(navigator.setAppBadge){ if(NEEDS.count){ navigator.setAppBadge(NEEDS.count); } else { navigator.clearAppBadge(); } } } catch(e){}
  showNeeds();
}
// One calm banner on Notes only: what waits, and one button to the first place that settles it.
function showNeeds(){
  var b = $("needs"), items = NEEDS.items || [];
  if(!b){ return; }
  b.hidden = !(VIEW === "list" && items.length);
  if(b.hidden){ return; }
  var go = { held:"loadHeld()", review:"loadReview()", settings:"openSettings()" }[items[0].view] || "loadReview()";
  b.innerHTML = "<div><b>" + (NEEDS.count === 1 ? "1 thing needs you" : Number(NEEDS.count) + " things need you") + "</b><ul class='t-callout'>" +
    items.map(function(i){ return "<li>"+esc(i.text)+"</li>"; }).join("") + "</ul></div><button class='primary' onclick='"+go+"'>Review</button>";
}
function loadNeeds(){ if(!IS_ADMIN){ return; } api("/ui/needs-you").then(setNeeds).catch(function(){ setNeeds(null); }); }

// ---- keyboard: / search, n new note, Ctrl/Cmd+K palette, u undo, ? shortcuts, 1-4 tabs, Esc closes ----
function typing(e){ var t = e.target || {}; var n = String(t.tagName || "").toLowerCase(); return n === "input" || n === "textarea" || n === "select" || t.isContentEditable; }
function anySheetOpen(){ return ["newsheet","settings","confirmsheet","palette","helpsheet"].some(function(id){ var d = $(id); return d && d.open; }); }
function onKey(e){
  if((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k"){ e.preventDefault(); openPalette(); return; }
  if(e.ctrlKey || e.metaKey || e.altKey || typing(e) || anySheetOpen() || $("app").hidden){ return; }
  var k = e.key, f = { "/": function(){ $("q").focus(); }, "n": toggleNew, "u": undoLast, "?": function(){ openSheet("helpsheet"); },
    "1": load, "2": loadReview, "3": loadHeld, "4": loadChanges }[k];
  if(f){ e.preventDefault(); f(); }
}
var COMMANDS = [
  ["Go to Notes", function(){ load(); }], ["Go to Review", function(){ loadReview(); }], ["Go to Held", function(){ loadHeld(); }],
  ["Go to Activity", function(){ loadChanges(); }], ["New note", function(){ toggleNew(); }], ["Settings", function(){ openSettings(); }],
  ["Check for updates", function(){ openSettings(); checkUpdate(); }], ["Back up now", function(){ openSettings(); backupNow(); }],
  ["Usage", function(){ loadMeter(); }], ["Tidy up", function(){ loadQuality(); }], ["Apps and keys", function(){ loadApps(); }],
  ["Activity log", function(){ loadAudit(); }], ["Sessions", function(){ loadSessions(); }], ["Archived notes", function(){ loadArchived(); }],
  ["Keyboard shortcuts", function(){ openSheet("helpsheet"); }], ["Show the Welcome screen", function(){ showWelcome(0); }], ["Sign out", function(){ logout(); }]
];
var PAL = [];
function palFilter(){
  var q = String($("pal_q").value || "").toLowerCase().trim();
  PAL = COMMANDS.filter(function(c){ return !q || c[0].toLowerCase().indexOf(q) >= 0; });
  $("pal_list").innerHTML = PAL.map(function(c, i){ return "<li><button role='option' aria-selected='"+(i === 0)+"' onclick='palRun("+i+")'>"+esc(c[0])+"</button></li>"; }).join("") || "<li class='muted' style='padding:8px'>No command matches.</li>";
}
function palRun(i){ var c = PAL[i]; closeSheet("palette"); if(c){ c[1](); } }
function openPalette(){ if($("app").hidden){ return; } $("pal_q").value = ""; palFilter(); openSheet("palette"); try { $("pal_q").focus(); } catch(e){} }

function show(which){ ["app","gate","welcome"].forEach(function(id){ $(id).hidden = id !== which; }); }
function saveTok(){
  var v = String($("tok").value || "").trim();
  if(!v){ return; }
  try { sessionStorage.setItem(TOKKEY, v); } catch(e){}
  start();
}
function logout(why){
  try { ["", ":ds", ":ls"].forEach(function(k){ sessionStorage.removeItem(TOKKEY + k); }); } catch(e){}
  show("gate");
  var g = $("gate_err"); if(g){ g.textContent = (typeof why === "string") ? why : ""; }
}
`;

// Read at build time: which writer labels are a person (the Review list never asks you about your own notes).
export const HUMAN_JS = `var HUMAN_WRITERS = ${JSON.stringify(humanWriterMap())};\n`;

// Last: sign-in from the address (monomem open), then start.
export const BOOT_JS = `
// monomem open puts a one-time code (60 seconds) after the # of the address, so it never reaches the server's logs.
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
try { document.addEventListener("keydown", onKey); } catch(e){}
try { $("pal_q").addEventListener("input", palFilter); $("pal_q").addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); palRun(0); } }); } catch(e){}
var qT;
$("q").addEventListener("input", function(){ clearTimeout(qT); qT = setTimeout(load, 250); });
$("ns").addEventListener("input", function(){ clearTimeout(qT); qT = setTimeout(load, 250); });
// Phones: give each table cell its column name so a row can show as a small card.
function stackTables(){
  var tabs = document.querySelectorAll("#list table");
  for(var i = 0; i < tabs.length; i++){
    var rows = tabs[i].querySelectorAll("tr");
    if(!rows.length || tabs[i].getAttribute("data-stacked")){ continue; }
    tabs[i].setAttribute("data-stacked", "1");
    tabs[i].classList.add("apps");
    var heads = [].map.call(rows[0].children, function(c){ return c.textContent; });
    rows[0].classList.add("hd");
    for(var r = 1; r < rows.length; r++){ for(var c = 0; c < rows[r].children.length; c++){ rows[r].children[c].setAttribute("data-l", heads[c] || ""); } }
  }
}
try { new MutationObserver(stackTables).observe(document.getElementById("list"), { childList:true, subtree:true }); } catch(e){}

if(LOGIN_CODE){
  fetch("/login", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ code: LOGIN_CODE }) })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
    .then(function(x){
      if(x.ok && x.j.token){
        try { sessionStorage.setItem(TOKKEY, x.j.token); if(x.j.dashboard_session){ sessionStorage.setItem(TOKKEY + ":ds", x.j.dashboard_session); } if(x.j.local_session){ sessionStorage.setItem(TOKKEY + ":ls", x.j.local_session); } } catch(e){}
        start();
      } else { show("gate"); $("gate_err").textContent = (x.j && x.j.error) || "That sign-in link did not work. Open Monomem again."; }
    })
    .catch(function(){ show("gate"); });
} else if(tok()){ start(); } else { show("gate"); }
`;
