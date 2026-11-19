// Dashboard script, part 5: the Settings sheet and the Welcome screen (first run).
// Anything that touches this computer (connect apps, update, remove, start with the computer, backups, the switches) goes
// through /ui/* routes that need the local sign-in from monomem open; the page says so in plain words when it is missing.
export const SETTINGS_JS = `
var APPS = [];
function localMissing(e){ return e && e.body && e.body.local_required; }
function onOffSwitch(id, label, help, on, handler){
  return "<label class='switch'><span><span>"+label+"</span>"+(help ? "<span class='help' style='display:block'>"+help+"</span>" : "")+"</span>"+
    "<input type='checkbox' role='switch' id='"+id+"'"+(on ? " checked" : "")+" onchange='"+handler+"'></label>";
}
// The automatic behaviours, one switch each: the Welcome consent step and Settings show the same list.
function autoSwitches(s){
  s = s || {};
  return onOffSwitch("sw_backups", "Back up my notes every day", "A copy of your notes in your Monomem folder each day. Your encryption key is never copied.", s.daily_backups !== "off", "setSetting(&quot;daily_backups&quot;,this.checked)")+
    onOffSwitch("sw_recall", "Add matching notes to each prompt", "At each prompt, up to 3 notes that match it are added for your app. Off by default.", s.prompt_recall === "on", "setSetting(&quot;prompt_recall&quot;,this.checked)")+
    onOffSwitch("sw_claude", "Bring in Claude Code's memory as it changes", "While Monomem runs, files Claude Code changed are copied in every 10 minutes, unconfirmed (from outside) until you confirm them. Off by default.", s.claude_refresh === "on", "setSetting(&quot;claude_refresh&quot;,this.checked)")+
    "<div class='switch'><span><span>Start Monomem with my computer</span><span class='help' style='display:block'>Keeps this page and backups available. Your apps start Monomem themselves either way.</span></span>"+
    "<span class='row'><button onclick='setService(true)'>Turn on</button><button class='plain' onclick='setService(false)'>Turn off</button></span></div>";
}
function setSetting(key, on){
  var b = {}; b[key] = on ? "on" : "off";
  api("/ui/settings", { method:"PUT", body: JSON.stringify(b) }).then(function(j){ STATE.settings = j.settings; toast(on ? "Turned on." : "Turned off."); })
    .catch(function(e){ say(e.message, true); var el = $({ daily_backups:"sw_backups", prompt_recall:"sw_recall", claude_refresh:"sw_claude" }[key]); if(el){ el.checked = !on; } });
}
function setService(on){
  toast(on ? "Setting up..." : "Turning off...");
  api("/ui/service", { method:"POST", body: JSON.stringify({ on: on }) }).then(function(r){ showOut("set_out", r); toast(r.ok ? (on ? "Monomem now starts with your computer." : "Monomem no longer starts with your computer.") : "That did not work; see the details."); }).catch(function(e){ say(e.message, true); });
}
function showOut(id, r){ var el = $(id); if(el){ el.innerHTML = r && r.output ? "<pre class='out'>"+esc(r.output)+"</pre>" : ""; } }

function openSettings(){
  var s = STATE.settings || {}, b = STATE.backup;
  var last = b ? (b.ok ? "Last backup " + esc(ago(b.at)) + "." : "<span class='err'>The last backup failed (" + esc(ago(b.at)) + ").</span>") : "No backup yet.";
  var nav = function(label, fn){ return "<button class='item' onclick='"+fn+"'><span>"+label+"</span><span class='muted' aria-hidden='true'>&rsaquo;</span></button>"; };
  $("set_body").innerHTML =
    "<section><h3>Monomem</h3><div class='group'><div class='item'><div><b>Version " + esc(STATE.version || "") + "</b><div class='help'>Updates only when you ask. Checking asks github.com for the newest version; nothing else is sent.</div></div>"+
      "<button id='upd_btn' onclick='checkUpdate()'>Check for updates</button></div><div id='upd_out'></div></div></section>"+
    "<section><h3>Your apps</h3><div class='group' id='set_apps'><div class='item muted'>Looking for apps...</div></div>"+
      "<div class='acts' id='undo_row' hidden><button class='plain' onclick='undoConnect()'>Undo the last connect</button></div><div id='set_out'></div></section>"+
    "<section><h3>Automatic</h3><div class='group'>"+autoSwitches(s)+"</div></section>"+
    syncSection()+
    "<section><h3>Backups</h3><div class='group'><div class='item'><div id='bk_line'>"+last+"</div><button onclick='backupNow()'>Back up now</button></div>"+
      "<div class='item'><div>A copy you can read (.json). It holds every note this key can see, not encrypted.</div><button onclick='doExport()'>Download</button></div>"+
      "<div class='item'><div>Add notes from a .json copy</div><button onclick='document.getElementById(&quot;imp&quot;).click()'>Choose file</button></div>"+
      "<input id='imp' type='file' accept='application/json' aria-label='File to add notes from (.json)' hidden onchange='doImport(this)'></div></section>"+
    "<section><h3>More</h3><div class='group list'>"+nav("Usage", "fromSettings(loadMeter)()")+nav("Tidy up", "fromSettings(loadQuality)()")+nav("Apps and keys", "fromSettings(loadApps)()")+
      nav("Activity log", "fromSettings(loadAudit)()")+nav("Archived notes", "fromSettings(loadArchived)()")+nav("Keyboard shortcuts", "closeSheet(&quot;settings&quot;);openSheet(&quot;helpsheet&quot;)")+
      nav("Show the Welcome screen", "closeSheet(&quot;settings&quot;);showWelcome(0)")+"</div></section>"+
    "<section><div class='group'><div class='item'><div>Take Monomem out of every app. Your notes stay.</div><button class='destructive' onclick='removeMonomem()'>Remove</button></div>"+
      "<div class='item'><div>Sign out of this page</div><button class='plain' onclick='closeSheet(&quot;settings&quot;);logout()'>Sign out</button></div></div></section>";
  openSheet("settings");
  loadApps2("set_apps", false);
  loadSync();
}
// Use Monomem on another computer: plain words for monomem sync setup; the button runs it (local sign-in, like Connect).
function syncSection(){
  return "<section><h3>Use Monomem on another computer</h3><div class='group'><div class='item'><div>"+
    "<p>Keep your notes the same on your laptop and your desktop. You need a folder both computers already share (OneDrive, Dropbox, iCloud Drive, Google Drive, a network or USB drive) or a private git repository you own. There is no Monomem account and no Monomem server: every file put there is sealed (encrypted).</p>"+
    "<ol class='t-callout'><li>Here: type the shared folder (or the git address) and press Set up. This runs <code>monomem sync setup</code>.</li>"+
    "<li>Monomem makes a sync key, the file <code>.sync-key</code> in your Monomem folder. Copy it to the other computer with a USB stick or your password manager. Never put it in the shared folder or the repository: anyone with the key and the folder can read your notes.</li>"+
    "<li>On the other computer: put the key in its Monomem folder, then run <code>monomem sync setup</code> there with the same folder or address.</li>"+
    "<li>After that, run <code>monomem sync</code> when you switch computers, or turn on automatic sync with <code>monomem sync setup --auto on</code>.</li></ol>"+
    "<p class='help'>A note you forget or delete on one computer is archived on the other, never deleted there. When both changed the same note, one text is held for you to choose.</p>"+
    "<div id='sync_now' class='help'></div>"+
    "<label class='field'><span>Shared folder or private git address</span><input id='sync_target' placeholder='For example: your OneDrive folder'></label>"+
    "<label class='field'><span>Name for this computer (optional)</span><input id='sync_name' maxlength='40' placeholder='For example: Work laptop'></label>"+
    "<div class='acts'><button class='primary' onclick='syncSetup()'>Set up</button></div><div id='sync_out'></div></div></div></div></section>";
}
function loadSync(){
  api("/ui/sync").then(function(j){
    var el = $("sync_now"); if(!el){ return; }
    var line = j.set ? "Set up on this computer (" + (j.kind === "git" ? "git: " : "folder: ") + esc(j.where) + "). " : "Not set up on this computer yet.";
    var p = j.problem;
    // A failed or late sync: what happened, when, and what to do, with a button (Needs you sends the person here).
    el.innerHTML = !p ? line + (j.set ? (j.auto ? "Syncs by itself every " + Number(j.every_minutes) + " minutes." : "Press Sync now when you switch computers.") + " <button class='plain' onclick='syncNow()'>Sync now</button>" : "")
      : line + "<span class='err'>" + (p.kind === "failed" ? "The last sync failed " + esc(ago(p.at)) + (p.error ? ": " + esc(String(p.error).replace(/[.\\s]+$/, "")) : "") + "."
        : "Automatic sync is on, but the last one was " + esc(ago(p.at)) + ".") + "</span> " +
        (p.kind === "failed" ? "Check that this computer can reach the shared folder or the git address, then press Sync now."
          : "It only runs while Monomem is running: turn on Start Monomem with my computer above, or press Sync now.") +
        " <button onclick='syncNow()'>Sync now</button>";
  }).catch(function(e){ var el = $("sync_now"); if(el){ el.textContent = localMissing(e) ? "To set this up from here, open Monomem from " + whereEntry() + ", or run monomem open on this computer." : ""; } });
}
function syncNow(){
  toast("Syncing...");
  return api("/ui/sync/now", { method:"POST" }).then(function(r){
    showOut("sync_out", r); toast(r.ok ? "Synced." : "The sync did not finish; see the details."); loadSync(); loadNeeds();
  }).catch(function(e){ say(e.message, true); });
}
function syncSetup(){
  var t = ($("sync_target").value || "").trim(), n = ($("sync_name").value || "").trim();
  if(!t){ say("Type the shared folder or the git address first.", true); return; }
  toast("Setting up sync...");
  var b = { target: t }; if(n){ b.name = n; }
  return api("/ui/sync/setup", { method:"POST", body: JSON.stringify(b) }).then(function(r){
    var out = $("sync_out"); if(out){ out.innerHTML = "<pre class='out'>"+esc(r.output || "")+"</pre>"; }
    toast(r.ok ? "Sync is set up. Copy the key to your other computer next." : "That did not work; see the details.");
    if(r.ok){ loadSync(); }
  }).catch(function(e){ say(e.message, true); });
}
// Detected apps with Connect / Not this one (the same detection and setup as monomem setup). Repair: a connection the
// server's daily check (app-detect.ts) found would not start; it runs the same setup for that app (backup + undo).
function appRow(a, welcome){
  var id = esc(a.id);
  if(a.problem){
    return "<div class='app'><div><b>"+esc(a.label)+"</b><div class='help'>Needs repair: "+esc(a.problem)+"</div></div><button onclick='connectApp(&quot;"+id+"&quot;)'>Repair</button></div>";
  }
  var right = a.connected ? "<span class='lbl ok'>Connected</span>"
    : a.declined && !welcome ? "<span class='muted t-foot'>Skipped</span> <button class='plain' onclick='connectApp(&quot;"+id+"&quot;)'>Connect</button>"
    : "<span class='row'><button onclick='connectApp(&quot;"+id+"&quot;)'>Connect</button><button class='plain' onclick='declineApp(&quot;"+id+"&quot;)'>Not this one</button></span>";
  return "<div class='app'><div><b>"+esc(a.label)+"</b>"+(a.new && !a.connected ? " <span class='lbl'>New<span class='sr'>: installed after Monomem was set up</span></span>" : "")+(a.connected ? "<div class='help'>"+esc(restartHint(a.id))+"</div>" : "")+"</div>"+right+"</div>";
}
function restartHint(id){
  return { "claude-code":"Quit Claude Code (type /exit) and start it again.", "cursor":"In Cursor, open Settings, then MCP, and switch Monomem on.", "claude-desktop":"Quit Claude Desktop from the tray or menu bar, then open it again." }[id] || "Quit the app and open it again.";
}
function loadApps2(boxId, welcome){
  api("/ui/apps").then(function(j){
    APPS = j.apps || [];
    var u = $("undo_row"); if(u){ u.hidden = !j.can_undo; }
    var box = $(boxId); if(!box){ return; }
    box.innerHTML = APPS.length ? APPS.map(function(a){ return appRow(a, welcome); }).join("") : "<div class='item muted'>No AI apps found on this computer. Install one (Claude Code, Cursor, Codex...) and open this again.</div>";
  }).catch(function(e){
    var box = $(boxId); if(box){ box.innerHTML = "<div class='item muted'>" + (localMissing(e) ? "To see and connect your apps, open Monomem from " + whereEntry() + ", or run monomem open on this computer." : esc(e.message)) + "</div>"; }
  });
}
function appsBox(){ return $("wl_apps") && !$("welcome").hidden ? "wl_apps" : "set_apps"; }
function connectApp(id){
  toast("Connecting...");
  api("/ui/apps/connect", { method:"POST", body: JSON.stringify({ id: id }) }).then(function(r){
    loadApps2(appsBox(), appsBox() === "wl_apps");
    toast("Connected. A copy of each changed file was kept.", undoConnect);
  }).catch(function(e){ say(e.message, true); if(e.body){ showOut(appsBox() === "wl_apps" ? "wl_out" : "set_out", e.body); } });
}
function declineApp(id){
  var list = ((STATE.settings || {}).declined_apps || []).concat([id]);
  api("/ui/settings", { method:"PUT", body: JSON.stringify({ declined_apps: list }) }).then(function(j){ STATE.settings = j.settings; loadApps2(appsBox(), appsBox() === "wl_apps"); })
    .catch(function(e){ say(e.message, true); });
}
// Puts back every file the last connect changed (monomem setup --undo).
function undoConnect(){
  api("/ui/apps/undo", { method:"POST" }).then(function(r){ loadApps2(appsBox(), appsBox() === "wl_apps"); toast(r.ok ? "Put back as it was." : "Nothing to undo."); })
    .catch(function(e){ say(e.message, true); });
}
// Update: only when pressed. First ask (monomem update --check), then offer Update now if a newer one exists.
function checkUpdate(){
  var out = $("upd_out"); if(out){ out.innerHTML = "<p class='help'>Asking github.com...</p>"; }
  api("/ui/update", { method:"POST", body: JSON.stringify({ check: true }) }).then(function(r){
    var newer = r.ok && / is out /.test(r.output || "");
    if(out){ out.innerHTML = "<pre class='out'>"+esc(r.output || "")+"</pre>" + (newer ? "<div class='acts'><button class='primary' onclick='doUpdate()'>Update now</button></div>" : ""); }
  }).catch(function(e){ if(out){ out.innerHTML = "<p class='err'>"+esc(e.message)+"</p>"; } });
}
// The update runs apart from this server, then stops it and starts the new version: show its output, reload on the new one.
function doUpdate(){
  var out = $("upd_out"); if(out){ out.innerHTML = "<p class='help'>Updating. Monomem restarts by itself; this page reloads when the new version answers.</p>"; }
  api("/ui/update", { method:"POST", body: JSON.stringify({ check: false }) }).then(function(){ waitUpdate(0); })
    .catch(function(e){ if(out){ out.innerHTML = "<p class='err'>"+esc(e.message)+"</p>"; } });
}
function waitUpdate(n){
  var out = $("upd_out");
  if(n >= 180){ if(out){ out.innerHTML += "<p class='help'>Still restarting. Reload this page in a moment (when Monomem is set to start with " + osName() + ", it can take up to 5 minutes).</p>"; } return; }
  setTimeout(function(){
    api("/health").then(function(h){
      if(h.version && h.version !== STATE.version){ location.reload(); return; }
      return api("/ui/update/log").then(function(l){
        if(out){ out.innerHTML = "<pre class='out'>"+esc(l.output || "")+"</pre>"; }
        if(l.done === null || l.done === 0){ waitUpdate(n+1); }
      });
    }).catch(function(){ waitUpdate(n+1); });
  }, 2000);
}
function backupNow(){
  api("/ui/backup", { method:"POST" }).then(function(r){
    STATE.backup = { ok: true, at: r.at }; var l = $("bk_line"); if(l){ l.textContent = "Last backup just now."; }
    loadNeeds(); toast(r.key_left_out ? "Backed up. Keep a copy of your encryption key somewhere safe too." : "Backed up.");
  }).catch(function(e){ say(e.message, true); loadNeeds(); });
}
function removeMonomem(){
  ask("Monomem is taken out of every app it was added to (each app's settings get a backup first). Your notes stay, and setup can add it back any time.", "Remove from my apps", function(){
    api("/ui/remove", { method:"POST" }).then(function(r){ showOut("set_out", r); toast(r.ok ? "Removed from your apps. Your notes are still here." : "That did not finish; see the details in Settings."); }).catch(function(e){ say(e.message, true); });
  });
}
function doExport(){
  api("/export").then(function(j){
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type:"application/json" }));
    a.download = "monomem-notes.json"; a.click();
  }).catch(fail);
}
function doImport(input){
  var f = input.files[0]; if(!f){ return; }
  var reader = new FileReader();
  reader.onload = function(){
    try {
      var data = JSON.parse(reader.result);
      api("/import", { method:"POST", body: JSON.stringify({ notes: data.notes || data }) }).then(function(j){ load(); toast("Added " + plural(j.imported, "note", "notes") + "."); }).catch(fail);
    } catch(e){ say("That file is not a Monomem .json copy.", true); }
  };
  reader.readAsText(f);
  input.value = "";
}

// ---- Welcome: Connect your apps, Try it, then what Monomem does by itself and where to find it ----
var WSTEP = 0, TRY_T = 0, TRY_SINCE = "";
function dots(n){ return "<ol class='steps' aria-label='Step "+(n+1)+" of 3'>"+[0,1,2].map(function(i){ return "<li"+(i === n ? " aria-current='step'" : "")+"></li>"; }).join("")+"</ol>"; }
function wcard(n, title, body, buttons){
  return "<div class='gcard'><div class='ghead'><img src='/icon.svg' alt='' width='64' height='64'><h1>"+title+"</h1></div><div class='gbody'>"+dots(n)+body+
    "<div class='row' style='justify-content:space-between;margin-top:24px'>"+buttons+"</div><div id='wl_out'></div></div></div>";
}
function showWelcome(n){
  WSTEP = n; clearInterval(TRY_T);
  show("welcome");
  var w = $("welcome");
  if(n === 0){
    w.innerHTML = wcard(0, "Welcome to Monomem", "<p>Monomem gives your AI apps one shared memory. Connect the apps you use:</p><div id='wl_apps'><p class='muted'>Looking for apps...</p></div>"+
      "<p class='help'>Monomem adds one entry to each app's settings and keeps a copy of every file it changes. Changed your mind? Settings, then Undo the last connect, puts it back.</p>"+
      "<p style='margin-top:16px'><b>Bring in memories</b> from other tools on this computer (optional):</p><div id='wl_mem'><p class='muted'>Looking...</p></div>"+
      "<p class='help'>Each note comes in unconfirmed (from outside): your apps do not get it at session start until you confirm it (the Review tab, or <code>monomem confirm &lt;id&gt;</code>). A Notion export or a mem0 file: <code>monomem import --from notion --path &lt;export.zip&gt;</code> (or <code>--from mem0</code>).</p>",
      "<button class='plain' onclick='finishWelcome()'>Skip</button><button class='primary' onclick='showWelcome(1)'>Next</button>");
    loadApps2("wl_apps", true);
    loadMemSources();
  } else if(n === 1){
    TRY_SINCE = new Date().toISOString();
    w.innerHTML = wcard(1, "Try it", "<p>In one of your connected apps, type:</p><p class='say' id='wl_say'>Save to Monomem: we deploy with pnpm</p>"+
      "<div class='acts'><button onclick='copyText(&quot;wl_say&quot;)'>Copy</button></div><p class='t-callout' id='wl_seen' role='status' aria-live='polite'>Waiting for your app to save it...</p>",
      "<button class='plain' onclick='showWelcome(0)'>Back</button><button class='primary' onclick='showWelcome(2)'>Next</button>");
    TRY_T = setInterval(trySeen, 3000);
  } else {
    w.innerHTML = wcard(2, "You're set", "<p><b>Monomem does these by itself.</b> Change them any time in Settings.</p><div class='group'>"+autoSwitches(STATE.settings)+"</div>"+
      "<p style='margin-top:16px'><b>What happens now</b></p><ul class='t-callout'><li>Each time an app starts, it gets the notes that matter for the project.</li>"+
      "<li>Writes that hold a secret are refused; writes that look like an injected instruction are held until you decide (the Held tab).</li>"+
      "<li>You can close this window. Your apps start Monomem themselves.</li>"+
      "<li>To come back, open Monomem from " + whereEntry() + (INSTALL_EVT ? ", or install this page as an app" : "") + ".</li></ul>"+
      (INSTALL_EVT ? "<div class='acts'><button onclick='installApp()'>Install as an app</button></div>" : ""),
      "<button class='plain' onclick='showWelcome(1)'>Back</button><button class='primary' onclick='finishWelcome()'>Open my notes</button>");
  }
}
// Other memory tools found on this computer: one "Bring in" each, asked first, then the ordinary import runs.
function loadMemSources(){
  api("/ui/import").then(function(j){
    var box = $("wl_mem"); if(!box){ return; }
    var list = j.sources || [];
    box.innerHTML = list.length ? list.map(function(s){
      return "<div class='app'><div><b>"+esc(s.label)+"</b><div class='help'>"+esc(s.where)+"</div></div><button onclick='bringIn(&quot;"+esc(s.id)+"&quot;,&quot;"+esc(s.label)+"&quot;)'>Bring in</button></div>";
    }).join("") : "<p class='muted'>No other memory tools found here.</p>";
  }).catch(function(e){ var box = $("wl_mem"); if(box){ box.innerHTML = "<p class='muted'>" + (localMissing(e) ? "To look for them, open Monomem from " + whereEntry() + ", or run monomem open on this computer." : esc(e.message)) + "</p>"; } });
}
function bringIn(id, label){
  ask("Copy " + label + " into Monomem? Nothing leaves this computer. Anything that looks like a secret is skipped, and every note stays unconfirmed (from outside) until you confirm it (the Review tab).", "Bring in", function(){
    toast("Bringing in...");
    api("/ui/import", { method:"POST", body: JSON.stringify({ id: id }) }).then(function(r){ showOut("wl_out", r); toast(r.ok ? "Done. The notes wait in Review." : "That did not finish; see the details."); loadMemSources(); loadNeeds(); })
      .catch(function(e){ say(e.message, true); });
  });
}
function trySeen(){
  api("/changes?since=" + encodeURIComponent(TRY_SINCE) + "&limit=5").then(function(j){
    var c = (j.changes || []).filter(function(e){ return e.kind === "created"; })[0], el = $("wl_seen");
    if(c && el){ clearInterval(TRY_T); el.innerHTML = "It worked: <b>"+esc(c.title)+"</b> was saved by "+chip(c.written_by || "")+"."; }
  }).catch(function(){});
}
function finishWelcome(){
  clearInterval(TRY_T);
  api("/ui/settings", { method:"PUT", body: JSON.stringify({ welcome_done: true }) }).then(function(j){ STATE.settings = j.settings; STATE.welcome_done = true; }).catch(function(){});
  try { history.replaceState(null, "", location.pathname); } catch(e){}
  show("app"); load(); loadNeeds();
}
// Chrome and Edge offer "Install"; the page keeps the offer for the Welcome and Settings buttons.
var INSTALL_EVT = null;
try { window.addEventListener("beforeinstallprompt", function(e){ e.preventDefault(); INSTALL_EVT = e; }); } catch(e){}
function installApp(){ var e = INSTALL_EVT; INSTALL_EVT = null; if(e){ e.prompt(); } }
`;
