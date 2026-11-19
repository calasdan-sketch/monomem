// Dashboard script, part 2: signing in, the Notes view, the calm note card with one "..." menu, archive with Undo, the
// new-note sheet, and Archived notes (the one place a note is deleted for good).
export const NOTES_JS = `
// After sign-in: who am I, then Welcome (first run) or Notes.
function start(){
  show("app");
  load();
  api("/whoami").then(function(w){
    var isAdmin = w.scope === "admin" && !w.namespace && !w.max_sensitivity;
    if(isAdmin && !IS_ADMIN){ IS_ADMIN = true; if(VIEW === "list"){ load(); } }
    if(!isAdmin){ say("Signed in as " + (w.label || "unnamed") + ": " + String(w.can_see || "").replace(/[.\\s]+$/, "") + "."); return; }
    loadNeeds();
    api("/ui/state").then(function(s){
      STATE = s;
      var h = ""; try { h = location.hash || ""; } catch(e){}
      if(!s.welcome_done || h === "#welcome"){ showWelcome(0); }
      else if(h === "#new"){ toggleNew(); } else if(h === "#review"){ loadReview(); }
    }).catch(function(){});
  }).catch(function(){ /* the notes call reports any problem */ });
}
var STATE = {};

function inc(){ var c = $("inc"); return !!(c && c.checked); }
function incRefused(e){ if(inc() && /admin/i.test(String(e && e.message))){ $("inc").checked = false; } }
function nsQs(sep, noDistrusted){
  var ns = String($("ns").value || "").trim();
  var qs = (ns ? ("namespace=" + encodeURIComponent(ns)) : "") + (!noDistrusted && inc() ? ((ns ? "&" : "") + "include_distrusted=1") : "");
  return qs ? (sep + qs) : "";
}
function applyFilter(){ if(VIEW === "list"){ load(); } }

// One line per task runner that looks stopped (each target has its own heartbeat); the older servers' single notice otherwise.
function loadRunner(){
  var el = $("runner");
  api("/runner/status").then(function(j){
    var lines = [];
    ((j && j.targets) || []).forEach(function(t){ if(t.notice){ lines.push(t.notice); } });
    if(!lines.length && j && j.notice){ lines.push(j.notice); }
    el.textContent = "";
    lines.forEach(function(l){ var d = document.createElement("div"); d.textContent = l; el.appendChild(d); });
    el.hidden = !lines.length;
  }).catch(function(){ el.hidden = true; });
}

function load(){
  setView("list");
  loadRunner();
  var q = String($("q").value || "").trim();
  var path = q ? "/search?q=" + encodeURIComponent(q) + nsQs("&") : "/notes" + nsQs("?");
  api(path).then(function(j){ render(j.results || j.notes || []); }).catch(function(e){ incRefused(e); failList(e); });
}

// Labels on a card, most important first; at most two show, the rest are listed in the card's menu. Plain sentences only:
// the server's *_label fields ("[unconfirmed - from outside content]") are written for agents and never shown here.
function labelsOf(n){
  var out = [];
  if(n.distrusted){ out.push(["danger", "Distrusted writer", "An owner distrusts the app that wrote this. Treat it as hostile."]); }
  if(n.flagged){ out.push(["caution", "Flagged", "An app said this looks wrong."]); }
  if(n.code_changed){ out.push(["caution", "Code changed", "The code this note describes changed since it was written."]); }
  if(n.claims_failed){ out.push(["caution", "No longer true in code", "A check or cited lines this note carries no longer match the files."]); }
  if(n.unconfirmed){ out.push(["caution", "Not confirmed", "From outside content; nobody confirmed it yet, so it is kept out of session start."]); }
  if(n.new_writer){ out.push(["caution", "New writer", "Monomem saw this app for the first time. Its notes do not count as a second source yet."]); }
  if(n.basis === "inferred"){ out.push(["", "Inferred", "The app cited nothing it saw."]); }
  if(n.built_on_distrusted){ out.push(["caution", "Built on a distrusted note", "It was written after reading a note from a writer an owner distrusts."]); }
  if(n.disputed){ out.push(["caution", "Disputed", "Another app says something different."]); }
  if(n.expired){ out.push(["", "Check again", "Not re-confirmed in time: check it is still true."]); }
  if(n.restated_by){ out.push(["", "Said again", "An app said this again. That is not a second source."]); }
  if(n.pinned){ out.push(["brand", "Pinned", "Shown first at every session start. Apps cannot change it."]); }
  if((n.tags||[]).indexOf("never-show") >= 0){ out.push(["", "Not shown at start", "Kept out of session start; still searchable."]); }
  // Observed is the calm case: it is listed in the menu only (the 4th field marks it), so the two-label row stays quiet.
  var ev = n.basis === "observed" && n.evidence && n.evidence[0];
  if(ev){ out.push(["", "Observed", "The app says it saw: " + ev.kind + " " + ev.ref + (n.evidence.length > 1 ? " (and " + (n.evidence.length - 1) + " more)" : "") + ". Monomem did not check it.", true]); }
  return out;
}
function cardLabels(n){ return labelsOf(n).filter(function(l){ return !l[3]; }); }
function lbl(l){ return "<span class='lbl "+l[0]+"'>"+esc(l[1])+(l[2] ? "<span class='sr'>: "+esc(l[2])+"</span>" : "")+"</span>"; }
function needsPerson(n){ return (n.tags||[]).some(function(t){ return String(t).indexOf("obs.origin:") === 0; }) && !(n.confirmed_kind === "human" && n.confirmed_rev === n.rev); }
var LVL_OPT = { "public":"Everyone (public)", "internal":"Normal (internal)", "private":"Private (hidden from apps you limited)" };

function noteMenu(n){
  var id = Number(n.id), items = [], labels = labelsOf(n);
  labels.forEach(function(l){ if(l[2]){ items.push("<p><b>"+esc(l[1])+":</b> "+esc(l[2])+"</p>"); } });
  if(labels.some(function(l){ return l[2]; })){ items.push("<hr>"); }
  if(IS_ADMIN && (n.unconfirmed || n.expired)){ items.push("<button role='menuitem'"+actA("confirmNote",[id])+">Confirm: I checked it</button>"); }
  if(IS_ADMIN){
    items.push(n.pinned ? "<button role='menuitem'"+actA("setPin",[id,false])+">Unpin</button>"
      : needsPerson(n) ? "<p>To pin it, confirm it first (Review).</p>"
      : "<button role='menuitem'"+actA("setPin",[id,true])+">Pin to every session start</button>");
  }
  items.push((n.tags||[]).indexOf("never-show") >= 0
    ? "<button role='menuitem' aria-label='show note #"+id+" at session start again'"+actA("neverShow",[id,false])+">Show at session start again</button>"
    : "<button role='menuitem' aria-label='never show note #"+id+"'"+actA("neverShow",[id,true])+">Don't show at session start</button>");
  var l = LVL_OPT[n.sensitivity] ? n.sensitivity : "internal";
  items.push("<hr><div class='cap'>Who can see this</div>" + ["public","internal","private"].map(function(o){
    return "<button role='menuitemradio' aria-checked='"+(o === l)+"'"+actA("setLabel",[id,o])+">"+LVL_OPT[o]+"</button>"; }).join(""));
  if(IS_ADMIN){ items.push("<hr><button role='menuitem'"+actA("touchedNote",[id])+">What did this touch?</button>"); }
  if(IS_ADMIN){ items.push("<button role='menuitem' aria-label='archive note #"+id+"'"+actA("archiveNote",[id])+">Archive</button>"); }
  return "<details class='menu'><summary aria-label='More for note #"+id+"' title='More'>&middot;&middot;&middot;</summary><div class='pop' role='menu'>"+items.join("")+"</div></details>";
}
function noteCard(n, extra){
  var labels = cardLabels(n);
  return "<article class='card' id='note"+Number(n.id)+"'><div class='nhead'><h3 class='t-head'>"+esc(n.title)+"</h3>"+noteMenu(n)+"</div>"+
    "<div class='meta'>"+chip(n.written_by || "")+" &middot; "+esc(n.namespace)+" &middot; "+esc(ago(n.updated_at))+" &middot; #"+Number(n.id)+"</div>"+
    chipsRow(labels.slice(0, 2).map(lbl).join("") + tagsInner(n.tags))+
    (n.body ? "<div class='body clamp'>"+esc(n.body)+"</div>" : "")+(extra || "")+"</article>";
}
function render(notes){
  var list = $("list");
  if(!String($("q").value || "").trim()){ notes = notes.slice().sort(function(a, b){ return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); }); }
  var lf = $("lvlf").value || "";
  if(lf){ notes = notes.filter(function(n){ return (n.sensitivity || "internal") === lf; }); }
  $("count").textContent = plural(notes.length, "note", "notes") + (lf ? " (" + lf + ")" : "");
  if(!notes.length){
    var q = String($("q").value || "").trim(), ns = String($("ns").value || "").trim();
    list.innerHTML = lf ? empty("No notes at that level", "Choose another level in Filters.")
      : q ? empty("No notes match", "Try fewer words, or clear the Project filter.")
      : ns ? empty("No notes in this project", "Clear the Project filter to see every project.")
      : empty("No notes yet", "In any connected app, type: Save to Monomem: we deploy with pnpm", "<div class='acts' style='justify-content:center'><button class='primary'"+actA("toggleNew")+">Add a note</button></div>");
    return;
  }
  list.innerHTML = notes.map(function(n){ return noteCard(n); }).join("");
}

// ---- note actions (each says what happened; reversible ones offer Undo) ----
function closeMenus(){ try { [].forEach.call(document.querySelectorAll("details.menu[open]"), function(d){ d.open = false; }); } catch(e){} }
function edit(id, change){
  return api("/notes/" + id).then(function(j){ var n = j.note || j; return api("/notes/" + id, { method:"PUT", body: JSON.stringify(change(n)) }).then(function(r){ return { before: n, r: r }; }); });
}
function setLabel(id, level){
  closeMenus();
  edit(id, function(n){ return { sensitivity: level, if_rev: n.rev }; }).then(function(x){
    var was = x.before.sensitivity || "internal"; refreshView();
    toast("Now visible to: " + LVL_OPT[level].toLowerCase() + ".", was === level ? null : function(){ setLabel(id, was); });
  }).catch(function(e){ refreshView(); say("Could not change who can see it: " + e.message, true); });
}
function neverShow(id, on){
  closeMenus();
  edit(id, function(n){ return { tags: (n.tags || []).filter(function(t){ return t !== "never-show"; }).concat(on ? ["never-show"] : []), if_rev: n.rev }; })
    .then(function(){ refreshView(); toast(on ? "It won't be shown at session start." : "It can be shown at session start again.", function(){ neverShow(id, !on); }); })
    .catch(fail);
}
function setPin(id, on){
  closeMenus();
  api("/pinned", { method:"PUT", body: JSON.stringify({ id: id, pinned: on }) })
    .then(function(){ refreshView(); toast(on ? "Pinned: shown first at every session start." : "Unpinned.", function(){ setPin(id, !on); }); })
    .catch(fail);
}
function confirmNote(id){
  closeMenus();
  api("/notes/" + Number(id) + "/confirm", { method:"POST", body: JSON.stringify({ source: "checked in the dashboard" }) })
    .then(function(r){ refreshView(); loadNeeds(); toast(r && r.message ? r.message : "Confirmed."); })
    .catch(fail);
}
// Archive, not delete: the note leaves search and session start, and Undo (or Archived notes) brings it back.
function archiveNote(id){
  closeMenus();
  api("/notes/" + id + "/archive", { method:"POST" })
    .then(function(){ refreshView(); toast("Archived.", function(){ restoreNote(id); }); })
    .catch(fail);
}
function restoreNote(id){
  api("/notes/" + id + "/restore", { method:"POST" }).then(function(){ refreshView(); toast("Restored."); }).catch(fail);
}
// "What did this touch?": who read the note and what was built on it (proven apart from likely), then an optional rollback by
// note: the server's plan first, one confirm, all or nothing. Likely items are only listed, never undone from here.
// "What did this touch?": the server's JSON (blast-radius.ts) as short sentences with calm times; the CLI text is not shown.
function noteRef(n){ return "#" + Number(n.id) + " &ldquo;" + esc(n.title) + "&rdquo;"; }
function ulist(rows, f){ return "<ul class='t-callout'>" + rows.slice(0, 20).map(function(r){ return "<li>" + f(r) + "</li>"; }).join("") + (rows.length > 20 ? "<li>and " + (rows.length - 20) + " more</li>" : "") + "</ul>"; }
function touchedHtml(t){
  var out = ["<p><b>Note " + noteRef(t) + "</b>" + (t.namespace && t.namespace !== "default" ? " in project " + esc(t.namespace) : "") + "</p>"];
  if(!t.reads_total){ out.push("<p>No app read it in the last " + plural(t.retention_days, "day", "days") + ".</p>"); }
  else {
    var by = {}, order = [];
    (t.reads || []).forEach(function(r){
      var e = by[r.reader]; if(!e){ e = by[r.reader] = { n: 0, last: r.at, start: false }; order.push(r.reader); }
      e.n++; if(String(r.at) > String(e.last)){ e.last = r.at; } if(r.session_id){ e.start = true; }
    });
    out.push("<p>Read " + plural(t.reads_total, "time", "times") + " (recorded):</p>" + ulist(order, function(w){ var e = by[w];
      return chip(w) + " " + plural(e.n, "time", "times") + ", last " + esc(ago(e.last)) + (e.start ? ", also at session start" : ""); }));
  }
  var built = t.built_on || [], proven = built.filter(function(n){ return n.basis === "proven"; }), likely = built.filter(function(n){ return n.basis !== "proven"; });
  var line = function(n){ return noteRef(n) + (n.task ? " (task)" : "") + " by " + chip(n.by) + ", " + esc(ago(n.at)); };
  if(proven.length){ out.push("<p>Built on it (the app said so when it saved):</p>" + ulist(proven, line)); }
  if(likely.length){ out.push("<p>Written after reading it (maybe: the same app, within " + plural(t.window_hours, "hour", "hours") + "; check by hand):</p>" + ulist(likely, line)); }
  if((t.claimed_tasks || []).length){ out.push("<p>Tasks taken after reading it (maybe):</p>" + ulist(t.claimed_tasks, line)); }
  if((t.replaced || []).length){ out.push("<p>Notes it replaced:</p>" + ulist(t.replaced, line)); }
  if(!built.length && !(t.claimed_tasks || []).length && !(t.replaced || []).length){ out.push("<p>Nothing recorded was built on it.</p>"); }
  if(t.hidden){ out.push("<p>" + plural(t.hidden, "more note you cannot see here is", "more notes you cannot see here are") + " not listed.</p>"); }
  out.push("<p class='help'>Not shown: reads older than " + plural(t.retention_days, "day", "days") + ", reads while read logging was off, and what an app did with the note outside Monomem. &ldquo;Maybe&rdquo; means the same app wrote after reading it; it does not prove the app used this note.</p>");
  return out.join("");
}
var SKIP_WORDS = { conflict:"someone else changed it later", cannot_fully_undo:"it cannot be fully undone", operator_only:"pinned, or in a project where you approve first", replaced:"already replaced", archived:"already archived" };
function planHtml(p){
  var acts = p.actions || [], of = function(k){ return acts.filter(function(a){ return a.action === k; }); }, out = [];
  var parts = [["archive", "Archive", "note", "notes"], ["restore", "Put back the earlier text of", "note", "notes"], ["unreplace", "Bring back", "note it replaced", "notes it replaced"], ["unflag", "Clear the flags on", "note", "notes"], ["release", "Release", "task it took", "tasks it took"]];
  parts.forEach(function(x){ var rows = of(x[0]); if(rows.length){ out.push("<p>" + x[1] + " " + plural(rows.length, x[2], x[3]) + ":</p>" + ulist(rows, noteRef)); } });
  if((p.skipped || []).length){ out.push("<p>Left as " + (p.skipped.length === 1 ? "it is" : "they are") + ":</p>" + ulist(p.skipped, function(k){ return noteRef(k) + ": " + esc(SKIP_WORDS[k.reason] || "left as it is"); })); }
  out.push("<p class='help'>Nothing is deleted: archived notes can be restored from Archived notes (Settings), and each changed note keeps its old text in its history.</p>");
  return out.join("");
}
function touchedNote(id){
  closeMenus();
  id = Number(id);
  api("/notes/" + id + "/touched").then(function(t){
    ask("", "Undo it and what was built on it", function(){
      api("/rollback/preview", { method:"POST", body: JSON.stringify({ note: id }) }).then(function(p){
        if(!p.actions || !p.actions.length){ toast("Nothing to undo."); return; }
        ask("", "Undo", function(){
          api("/rollback/confirm", { method:"POST", body: JSON.stringify({ note: id, token: p.token }) })
            .then(function(r){ refreshView(); loadNeeds(); toast(r && r.message ? r.message : "Undone."); }).catch(fail);
        }, planHtml(p), { title: "Undo note #" + id + " and what was built on it?", cls: "destructive fill" });
      }).catch(fail);
    }, touchedHtml(t), { title: "What did this touch?", cls: "", close: true });
  }).catch(fail);
}
function refreshView(){ var f = { list: load, review: loadReview, held: loadHeld, archived: loadArchived, quality: loadQuality }[VIEW]; if(f){ f(); } }

// ---- new note sheet ----
function toggleNew(){
  var d = $("newsheet");
  if(d.open){ closeSheet("newsheet"); newClosed(); return; }
  $("n_err").textContent = "";
  $("btn_new").setAttribute("aria-expanded", "true");
  openSheet("newsheet");
  try { $("n_title").focus(); } catch(e){}
}
function newClosed(){ $("btn_new").setAttribute("aria-expanded", "false"); }
function addNote(){
  var title = String($("n_title").value || "").trim();
  var err = $("n_err"); err.textContent = "";
  if(!title){ err.textContent = "Give the note a title."; return; }
  var tags = String($("n_tags").value || "").split(",").map(function(t){ return t.trim(); }).filter(Boolean);
  var payload = { title: title, body: $("n_body").value, tags: tags, namespace: String($("n_ns").value || "").trim() || undefined, sensitivity: $("n_lvl").value };
  api("/notes", { method:"POST", body: JSON.stringify(payload) }).then(function(j){
    $("n_title").value = ""; $("n_body").value = ""; $("n_tags").value = "";
    closeSheet("newsheet"); newClosed();
    if(j && j.quarantined){ loadNeeds(); toast("Held for your review: it looked like a secret or an instruction."); loadHeld(); return; }
    load();
    var id = j && j.note && j.note.id;
    toast("Saved.", IS_ADMIN && id ? function(){ archiveNote(id); } : null);
  }).catch(function(e){ err.textContent = e.message; });
}

// ---- Archived notes (Settings): restore, or delete for good ----
function loadArchived(){
  setView("archived", openSettings);
  api("/notes?archived=1&limit=200").then(function(j){
    var ns = j.notes || [];
    $("count").textContent = plural(ns.length, "archived note", "archived notes");
    $("list").innerHTML = ns.length ? ns.map(function(n){
      return "<article class='card'><h3 class='t-head'>"+esc(n.title)+"</h3><div class='meta'>"+chip(n.written_by || "")+" &middot; "+esc(n.namespace)+" &middot; archived "+esc(ago(n.archived_at || n.updated_at))+"</div>"+
        (n.body ? "<div class='body clamp'>"+esc(n.body)+"</div>" : "")+
        acts("<button class='primary'"+actA("restoreNote",[Number(n.id)])+">Restore</button><button class='destructive' aria-label='delete note #"+Number(n.id)+" for good' data-confirm='Delete for good?'"+actA("armDel",[Number(n.id)])+">Delete for good</button>")+"</article>";
    }).join("") : empty("Nothing archived", "Notes you archive wait here, and you can bring them back.");
  }).catch(failList);
}
function del(id){ api("/notes/" + id, { method:"DELETE" }).then(function(){ refreshView(); toast("Deleted for good."); }).catch(fail); }
`;
