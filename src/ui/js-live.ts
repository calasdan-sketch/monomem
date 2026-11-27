// Dashboard script, part 7: the live view. A cheap poll (the "Needs you" count and the change feed, every 3 s while the tab
// is visible, nothing while it is hidden), an opt-in browser notification when a write is held (counts only, never the held
// text), "Reject and distrust this writer" on a held card, and a note's history with a diff per version. Plain ES5 in a
// string; no backticks; everything from the store goes through esc() (or diffHtml, which escapes).
export const LIVE_JS = `
var LIVE = { every: 3000, slow: 10, n: 0, until: "", seen: {}, newN: 0, heldN: null, timer: 0, fails: 0, more: false, sig: "" };
function liveHeld(j){ var n = 0; ((j && j.items) || []).forEach(function(i){ if(i.kind === "held"){ n += Number(i.count || 0); } }); return n; }
function livePerm(){ try { return ("Notification" in window) ? Notification.permission : "unsupported"; } catch(e){ return "unsupported"; } }
function liveWants(){ try { return localStorage.getItem("om_notify") === "1"; } catch(e){ return false; } }
function liveAsked(){ try { return localStorage.getItem("om_notify") === "0"; } catch(e){ return false; } }
function liveBar(){
  var b = $("livebar"); if(!b){ return; }
  var out = [];
  // Three polls in a row failed: say so, because the held count and the change list are then stale (a stopped count looks like "nothing held").
  if(LIVE.fails >= 3){ out.push("<span>Live updates paused: Monomem is not answering. A held write could be waiting. Reload the page to try again.</span>"); }
  if(LIVE.newN){ out.push("<span>" + (LIVE.more ? "More than " : "") + plural(LIVE.newN, "change", "changes") + " since you looked.</span><button" + actA("liveShow") + ">Show</button>"); }
  // Asked only once something is actually held, never on page load, and never again after "No thanks".
  if(LIVE.heldN > 0 && livePerm() === "default" && !liveAsked()){
    out.push("<span>Get a browser notification when a write is held? It says only how many, never what.</span><button" + actA("liveNotifyOn") + ">Notify me</button><button class='plain'" + actA("liveNotifyNo") + ">No thanks</button>");
  }
  var sig = out.join(""); if(sig && sig !== LIVE.sig){ announce(String(sig).replace(/<[^>]*>/g, " ").replace(/s+/g, " ").trim()); }
  LIVE.sig = sig;
  b.innerHTML = sig; b.hidden = !out.length;
}
function liveNotify(n){
  if(!liveWants() || livePerm() !== "granted"){ return; }
  try {
    var x = new Notification("Monomem: " + plural(n, "write is", "writes are") + " held. Open to decide.", { tag: "monomem-held" });
    x.onclick = function(){ try { window.focus(); } catch(e){} loadHeld(); x.close(); };
  } catch(e){}
}
function liveNeeds(){
  return api("/ui/needs-you").then(function(j){
    var h = liveHeld(j);
    LIVE.fails = 0;
    setNeeds(j);
    if(LIVE.heldN !== null && h > LIVE.heldN){ liveNotify(h); if(VIEW === "held"){ loadHeld(); } }
    LIVE.heldN = h; liveBar();
  });
}
function liveChanges(){
  var first = !LIVE.until;
  return api("/changes?since=" + encodeURIComponent(LIVE.until || "30s") + "&limit=" + (first ? 1 : 50)).then(function(j){
    var fresh = 0;
    (j.changes || []).forEach(function(c){ var k = c.kind + ":" + c.id + ":" + c.rev + ":" + c.at; if(!LIVE.seen[k]){ LIVE.seen[k] = 1; fresh++; } });
    if(Object.keys(LIVE.seen).length > 500){ LIVE.seen = {}; }
    if(j.until){ LIVE.until = j.until; }
    if(!first && (j.changes || []).length >= 50){ LIVE.more = true; }
    if(first || !fresh){ return; }
    if(VIEW !== "list" && VIEW !== "changes"){ LIVE.more = false; }
    var top = (window.scrollY || 0) < 80;
    if(VIEW === "changes" && top){ loadChanges(); }
    else if(VIEW === "list" || VIEW === "changes"){ LIVE.newN += fresh; liveBar(); }
  });
}
function liveFail(e){
  // api() has already shown the sign-in screen on a 401: stop polling instead of asking every 3 s forever.
  if(e && e.message === "not signed in"){ if(LIVE.timer){ clearInterval(LIVE.timer); LIVE.timer = 0; } return; }
  LIVE.fails++; liveBar();
}
function liveTick(){
  if(!IS_ADMIN || ($("app") && $("app").hidden)){ return; }
  LIVE.n++;
  if(document.hidden){
    // Hidden tab: nothing, unless notifications are on; then only the count, every 30 s.
    if(liveWants() && LIVE.n % LIVE.slow === 0){ liveNeeds().catch(liveFail); }
    return;
  }
  liveNeeds().then(liveChanges).catch(liveFail);
}
function liveStart(){
  if(LIVE.timer){ return; }
  LIVE.timer = setInterval(liveTick, LIVE.every);
  try { document.addEventListener("visibilitychange", function(){ if(!document.hidden){ liveTick(); } }); } catch(e){}
}
function liveShow(){ LIVE.newN = 0; liveBar(); if(VIEW === "changes"){ loadChanges(); } else { load(); } }

function demoBanner(s){
  var b = $("demobar"); if(!b || !s || !s.demo){ return; }
  b.hidden = false; b.innerHTML = "<span><b>Demo store.</b> Made for this tour and deleted when you close it in the terminal. Your own notes are not here.</span>";
}
ACTS.liveShow = function(){ liveShow(); };
ACTS.liveNotifyNo = function(){ try { localStorage.setItem("om_notify", "0"); } catch(e){} liveBar(); };
ACTS.liveNotifyOn = function(){
  try {
    Notification.requestPermission().then(function(p){
      try { localStorage.setItem("om_notify", p === "granted" ? "1" : "0"); } catch(e){}
      liveBar(); toast(p === "granted" ? "You will get a notification when a write is held." : "Notifications stay off.");
    });
  } catch(e){ fail(e); }
};

// ---- Held card: Reject and distrust the writer (Reject itself cannot be undone; the distrust can) ----
function qHeldDistrust(id, writer){
  api("/quarantine/" + Number(id) + "/reject", { method:"POST" })
    .then(function(){
      // Reject cannot be undone and has happened: if the second step fails, say exactly that instead of a generic error.
      return api("/trust/distrust", { method:"POST", body: JSON.stringify({ namespace: "*", writer: writer }) }).catch(function(e){
        refreshHeld(); loadNeeds();
        toast("Rejected, but could not distrust " + shownWriter(writer) + ": " + ((e && e.message) || "unknown error") + ". The write is gone; the writer is still trusted.");
        return null;
      });
    })
    .then(function(r){
      if(!r){ return; }
      refreshHeld(); loadNeeds();
      toast("Rejected. " + shownWriter(writer) + " is distrusted: " + plural(r.matched_notes || 0, "note is", "notes are") + " hidden.", function(){
        api("/trust/distrust?namespace=*&writer=" + encodeURIComponent(writer), { method:"DELETE" }).then(function(){ refreshView(); toast("Trusted again."); }).catch(fail);
      });
    }).catch(fail);
}
ACTS.armHeldDistrust = function(el, a){ arm(el, function(){ qHeldDistrust(a[0], a[1]); }); };

// ---- a note's history, one diff per version ----
ACTS.noteHistory = function(el, a){
  closeMenus();
  var id = Number(a[0]);
  api("/notes/" + id + "/history?diff=1" + (inc() ? "&include_distrusted=1" : "")).then(function(h){
    var vs = h.versions || [];
    var html = "<p class='meta'>Now at version " + Number(h.current.version) + ", written by " + chip(h.current.written_by || "") + ".</p>" +
      (vs.length ? vs.map(function(v){
        return "<div class='card'><div class='meta'>Version " + Number(v.version) + byLine(v.written_by) + " &middot; replaced " + esc(ago(v.saved_at)) + " by " + chip(v.saved_by) + " (" + esc(v.reason) + ")</div>" +
          (v.diff && v.diff.length ? diffHtml(v.diff) : "<p class='meta'>Only details other than the text changed.</p>") + "</div>";
      }).join("") : "<p>No earlier versions are kept.</p>") +
      (h.hidden_by_trust_policy ? "<p class='help'>" + plural(h.hidden_by_trust_policy, "version is", "versions are") + " hidden: the writer is distrusted (Filters shows them).</p>" : "");
    ask("", "Close", function(){}, html, { title: "History of note #" + id, cls: "", close: true });
    // Information only: one Close button (the confirm button comes back when the sheet closes).
    var ok = $("cf_ok"), sheet = $("confirmsheet"); ok.hidden = true;
    var back = function(){ ok.hidden = false; sheet.removeEventListener("close", back); };
    sheet.addEventListener("close", back);
  }).catch(fail);
};
`;
