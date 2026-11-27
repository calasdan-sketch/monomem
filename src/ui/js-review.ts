// Dashboard script, part 3: Review (the same items as `monomem review`, plus facts two apps disagree on), Held, and Tidy up.
export const REVIEW_JS = `
// ---- Review: GET /ui/review is store.reviewList + flaggedList + codeChangedList, as monomem review prints them ----
function reviewRow(x, why, buttons){
  return "<article class='card'><div class='nhead'><h2 class='t-head'>"+esc(x.title)+"</h2></div>"+
    "<div class='meta'>"+chip(x.writer || "")+" &middot; "+esc(x.namespace)+" &middot; #"+Number(x.id)+"</div>"+
    "<p class='t-callout' style='margin:8px 0 0'>"+why+"</p>"+acts(buttons)+"</article>";
}
// The reason as the store words it, in plain words: "(declared)" is the app saying so; "this version" is the current text.
function whyWords(w){
  return esc(String(w || "").replace(/^unconfirmed: /, "").replace(/^expired: /, "").replace(/\\(declared\\)/g, "(the app said so)")
    .replace(/, nobody confirmed this version/g, "; nobody has confirmed it yet")); }
function loadReview(){
  setView("review");
  var ns = String($("ns").value || "").trim();
  Promise.all([
    api("/ui/review" + (ns ? "?namespace=" + encodeURIComponent(ns) : "")),
    api("/quality" + nsQs("?", true)).catch(function(){ return { conflict_groups: [] }; })
  ]).then(function(rs){
    var j = rs[0], cf = (rs[1].conflict_groups || []).filter(function(g){ return g.tier === "fact"; });
    CFG = cf; CFACT = {};
    $("count").textContent = plural(j.count, "note waits", "notes wait") + (cf.length ? "; " + plural(cf.length, "fact has", "facts have") + " two answers" : "");
    var out = [];
    if(j.held_writes){ out.push("<div class='banner'><span>"+plural(j.held_writes, "write is", "writes are")+" held for your decision.</span><button"+actA("loadHeld")+">Open Held</button></div>"); }
    if(j.notes.length){
      out.push("<h2 class='section t-title'>Waiting for you to confirm</h2>");
      out = out.concat(j.notes.map(function(r){
        return reviewRow(r, whyWords(r.why), "<button class='primary' aria-label='confirm note #"+Number(r.id)+"'"+actA("reviewConfirm",[Number(r.id)])+">Confirm: I checked it</button><button aria-label='archive note #"+Number(r.id)+"'"+actA("archiveNote",[Number(r.id)])+">Archive</button>");
      }));
    }
    if(j.flagged.length){
      out.push("<h2 class='section t-title'>Flagged by an app</h2>");
      out = out.concat(j.flagged.map(function(f){
        var why = (f.flags || []).map(function(x){ return chip(x.by)+" says: "+esc(x.reason); }).join("<br>");
        return reviewRow(f, why, "<button class='primary' aria-label='keep note #"+Number(f.id)+"'"+actA("reviewKeep",[Number(f.id)])+">Keep as it is</button><button aria-label='archive note #"+Number(f.id)+"'"+actA("archiveNote",[Number(f.id)])+">Archive</button>");
      }));
    }
    if(j.code_changed.length){
      out.push("<h2 class='section t-title'>The code it describes changed</h2>");
      out = out.concat(j.code_changed.map(function(c){
        var why = "Changed since it was written: " + (c.changed || []).map(function(x){ return "<code>"+esc(x.path)+"</code>"; }).join(", ");
        return reviewRow(c, why, "<button class='primary' aria-label='keep note #"+Number(c.id)+"'"+actA("reviewKeep",[Number(c.id)])+">Still true</button><button aria-label='archive note #"+Number(c.id)+"'"+actA("archiveNote",[Number(c.id)])+">Archive</button>");
      }));
    }
    if(cf.length){
      out.push("<h2 class='section t-title'>Two answers to one fact</h2><div class='card'><p class='t-callout muted' style='margin:0'>Different apps saved different values. Nothing changes until you choose.</p>"+cf.map(function(g, gi){ return cfRow(g, gi); }).join("")+"</div>");
    }
    $("list").innerHTML = out.join("") || empty("Nothing waits for you", "Notes from outside content, flagged notes and notes about changed code show up here.");
  }).catch(failList);
}
function reviewConfirm(id){
  api("/notes/" + Number(id) + "/confirm", { method:"POST", body: JSON.stringify({ source: "checked in the dashboard Review" }) })
    .then(function(r){ loadReview(); loadNeeds(); toast(r && r.message ? r.message : "Confirmed."); }).catch(fail);
}
function reviewKeep(id){
  api("/ui/review/" + Number(id) + "/keep", { method:"POST" }).then(function(){ loadReview(); loadNeeds(); toast("Kept as it is."); }).catch(fail);
}

// ---- Held: writes kept out until a person decides. Stored text from an untrusted writer, so all of it goes through esc().
// Approve and Reject cannot be undone, so each asks first (press twice).
function loadHeldCount(){ loadNeeds(); }
function loadHeld(){
  setView("held");
  api("/quarantine" + nsQs("?", true)).then(function(j){
    var held = j.quarantine || [];
    $("count").textContent = held.length + " held";
    $("list").innerHTML = held.length ? held.map(function(q){
      var why = (q.reasons || []).map(function(r){ return "<span class='tag why'>"+esc(r.label)+(r.field && String(r.label).indexOf(r.field) < 0 ? " in "+esc(r.field) : "")+"</span>"; }).join("");
      var who = q.written_by ? byLine(q.written_by) : (q.source ? " &middot; says it is from "+esc(q.source) : "");
      return "<article class='card'><span class='stamp'>HELD &middot; NOT IN MEMORY</span><h2 class='t-head'>"+esc(q.title || "(title unchanged)")+"</h2>"+
        "<div class='meta'>"+(q.op === "update" ? "change to #"+Number(q.target_id) : "new note")+" &middot; "+esc(q.namespace)+" &middot; "+esc(ago(q.created_at))+who+"</div>"+
        "<div class='chips'>"+(why || "<span class='tag why'>held by your approve-first rule</span>")+"</div>"+tagsHtml(q.tags)+
        (q.body ? "<div class='heldbody'>"+esc(q.body)+"</div>" : "")+
        "<div id='qctx"+Number(q.id)+"' class='meta'></div>"+
        acts("<button class='primary' aria-label='reject held write #"+Number(q.id)+"'"+actA("armHeld",[Number(q.id),"reject"])+">Reject</button>"+
          "<button aria-label='approve held write #"+Number(q.id)+"'"+actA("armHeld",[Number(q.id),"approve"])+">Approve</button>"+
          (IS_ADMIN && q.written_by ? "<button class='destructive' aria-label='Reject and distrust "+esc(shownWriter(q.written_by))+" (held write #"+Number(q.id)+")'"+actA("armHeldDistrust",[Number(q.id),q.written_by])+">Reject and distrust "+esc(shownWriter(q.written_by))+"</button>" : ""))+"</article>";
    }).join("") : empty("Nothing is held", "Writes that look like a secret or an injected instruction wait here for you.");
    held.forEach(function(q){ loadHeldContext(Number(q.id)); });
  }).catch(failList);
}
function loadHeldContext(id){
  api("/quarantine/" + id + "/context").then(function(c){
    var box = $("qctx" + id); if(!box){ return; }
    var notes = c.notes || [];
    var rows = notes.map(function(n){ return "<li>&ldquo;"+esc(n.title)+"&rdquo; ("+(n.written_by ? esc(shownWriter(n.written_by))+", " : "")+esc(ago(n.updated_at))+")</li>"; }).join("");
    box.innerHTML = (c.diff ? "<div>What this change does to the note (- now, + held):</div>" + diffHtml(c.diff) : "") +
      (notes.length ? "Saved on the same topic since:<ul>"+rows+"</ul>"+
        acts("<button aria-label='keep held write #"+id+" as history'"+actA("armHeld",[id,"keep-history"])+">Keep as history</button>") : "") +
      (c.target_changed ? "<div>The note it changes was edited since, so Approve will not work.</div>" : "") +
      (c.clears && c.clears.length ? "<div>Approving it also clears the note's " + esc(c.clears.map(function(x){ return x === "forget_after" ? "forget date" : x; }).join(" and ")) + ".</div>" : "") +
      (c.note ? "<div>" + esc(c.note) + "</div>" : "");
  }).catch(function(){ var box = $("qctx" + id); if(box){ box.textContent = "Could not load what was saved since."; } });
}
// The card the key was on is gone after a decision: put focus on the view heading so the next Tab starts at the list.
function focusHead(){ try { $("viewh").focus(); } catch(e){} }
function refreshHeld(){ focusHead(); if(VIEW === "quality"){ loadQuality(); } else { loadHeld(); } }
function qHeld(id, action){
  api("/quarantine/" + id + "/" + action, { method:"POST" }).then(function(){
    refreshHeld(); loadNeeds(); toast(action === "approve" ? "Approved: it is in memory now." : action === "keep-history" ? "Kept as history." : "Rejected: it was discarded.");
  }).catch(fail);
}

// ---- Tidy up (Settings): GET /quality. Every button asks first or can be undone. ----
var TYPE_WORDS = { duplicate:"duplicate", stale_twin:"older copy", quarantined:"held", lint:"looks risky", decay:"about to be forgotten", pii:"private details", contradiction:"disagreement", empty:"no text", restated:"said again" };
function typeLabel(t){ return TYPE_WORDS[t] || String(t).replace(/_/g, " "); }
function qPrivate(id){ setLabel(id, "private"); }
function loadQuality(){
  setView("quality", openSettings);
  api("/quality" + nsQs("?")).then(function(j){
    var c = j.counts || {};
    $("count").textContent = Object.keys(c).filter(function(k){ return c[k]; }).map(function(k){ return c[k] + " " + typeLabel(k); }).join(", ");
    var rows = (j.issues || []).map(function(i){
      var a = Number(i.ids[0]), b = Number(i.ids[1]), q = Number(i.quarantine_id), btn;
      // A duplicate group keeps keep_id and replaces every other copy in it (ids holds the whole group).
      var keepId = i.type === "duplicate" && i.keep_id != null ? Number(i.keep_id) : b;
      var olds = i.type === "duplicate" ? (i.ids || []).map(Number).filter(function(x){ return x !== keepId; }) : [a];
      if(i.type === "duplicate" || i.type === "stale_twin" || i.type === "contradiction" || i.type === "restated"){ btn = "<button class='primary'"+actA("qReplace",[olds,keepId])+">Replace "+olds.map(function(x){ return "#"+x; }).join(", ")+" with #"+keepId+"</button>"; }
      else if(i.type === "pii"){ btn = "<button class='primary'"+actA("qPrivate",[a])+">Make #"+a+" private</button>"; }
      else if(i.type === "quarantined"){ btn = "<button class='primary'"+actA("loadHeld")+">Open Held</button>"; }
      else { btn = "<button"+actA("archiveNote",[a])+">Archive #"+a+"</button>"; }
      return "<article class='card'><div class='chips' style='margin:0 0 8px'><span class='lbl'>"+esc(typeLabel(i.type))+"</span></div><h2 class='t-head'>"+esc(i.detail)+"</h2>"+
        "<div class='meta'>"+esc(i.namespace)+"</div>"+acts(btn)+"</article>";
    }).join("");
    var cf = j.conflict_groups || [];
    CFG = cf; CFACT = {};
    var tot = Number(j.conflict_total) || cf.length;
    var head = j.conflict_capped ? "showing "+cf.length+" of at least "+tot : (cf.length < tot ? "showing "+cf.length+" of "+tot : String(cf.length));
    var crow = cf.length ? "<div class='card'><h2 class='t-head'>Conflicts ("+head+")</h2><div class='meta'>Different apps, same key, different value. Nothing changes until you choose. Exact: the notes carry the same fact. Possible: guessed from the text.</div>"+cf.map(function(g, gi){ return cfRow(g, gi); }).join("")+"</div>" : "";
    $("list").innerHTML = crow + rows || empty("Nothing to tidy", "Duplicates, older copies and private details will be listed here.");
  }).catch(failList);
}
function qReplace(oldIds, newId){
  oldIds = [].concat(oldIds);
  api("/supersede/preview", { method:"POST", body: JSON.stringify({ old_ids: oldIds, new_id: newId, gui: true }) }).then(function(p){
    ask(p.warning, "Replace", function(){
      var body = { token: p.token };
      if(p.requires_acknowledgement){ body.acknowledge_risk = true; }
      api("/supersede/confirm", { method:"POST", body: JSON.stringify(body) }).then(function(){ refreshView(); toast("Replaced.", function(){ oldIds.forEach(function(x){ undoReplace(x); }); }); }).catch(fail);
    }, diffHtml(p.diff));
  }).catch(fail);
}

// ---- One disputed key: every value with the notes that state it, then the choices. No value is the default. ----
var CFG = [], CFACT = {};
function cfNote(n){
  return "<div class='meta'>#"+Number(n.id)+" "+esc(n.title)+" &middot; "+esc(shownWriter(n.writer))+" ("+esc(n.kind)+") &middot; "+esc(String(n.at).slice(0,10))+(n.pinned ? " &middot; pinned" : "")+"</div>";
}
function cfRow(g, gi){
  gi = Number(gi) || 0;
  var btns = [], more = [], all = [], seen = {};
  g.values.forEach(function(v, vi){
    v.notes.forEach(function(n){ all.push(n); });
    // Keeping one value changes the other values' notes, and a pinned note can only be changed by you, not here.
    var blocked = g.values.some(function(o, oi){ return oi !== vi && o.notes.some(function(n){ return n.pinned; }); });
    if(!blocked){ btns.push("<button"+actA("cfKeep",[gi,vi])+">Keep "+esc(v.value)+"</button>"); }
  });
  all.forEach(function(n){
    if(!n.pinned){ more.push("<button "+actA("armPin",[Number(n.id)])+">Pin #"+Number(n.id)+"</button>"); }
    if(!seen[n.writer]){
      seen[n.writer] = 1;
      more.push("<button data-ns='"+esc(g.namespace)+"' data-w='"+esc(n.writer)+"'"+actA("armDistrust")+">Distrust "+esc(shownWriter(n.writer))+"</button>");
    }
  });
  var pins = all.filter(function(n){ return n.pinned; }).map(function(n){ return "#"+Number(n.id); });
  return "<div class='cf'><h2 class='t-head'>"+esc(g.key)+" <span class='lbl'>"+esc(g.confidence)+"</span></h2>"+
    g.values.map(function(v){ return "<div class='cfval'><b>"+esc(v.value)+"</b>"+v.notes.map(cfNote).join("")+"</div>"; }).join("")+
    "<div class='meta'>Project: <b>"+esc(g.namespace)+"</b>"+(pins.length ? " &middot; "+pins.join(", ")+" pinned: apps cannot change it; you can" : "")+"</div>"+acts(btns.join(""))+
    (more.length ? "<details class='cfmore'><summary class='muted'>More</summary>"+acts(more.join(""))+"</details>" : "")+
    "<div class='cfdlg' id='cfdlg"+gi+"'></div></div>";
}
function cfDialog(gi, bullets, actions){
  CFACT[gi] = actions.map(function(a){ return a[1]; });
  $("cfdlg"+gi).innerHTML = "<ul>"+bullets.map(function(b){ return "<li>"+b+"</li>"; }).join("")+"</ul><div class='acts'>"+
    actions.map(function(a, i){ return "<button"+(a[2] ? "" : " class='primary'")+""+actA("cfAct",[gi,i])+">"+esc(a[0])+"</button>"; }).join("")+
    "<button class='plain'"+actA("cfClose",[gi])+">Cancel</button></div>";
}
function cfAct(gi, i){ var f = CFACT[gi] && CFACT[gi][i]; if(f){ f(); } }
function cfClose(gi){ var d = $("cfdlg"+gi); if(d){ d.innerHTML = ""; } CFACT[gi] = []; }
function cfNoteText(n){ return "#"+Number(n.id)+" &ldquo;"+esc(n.title)+"&rdquo; ("+esc(shownWriter(n.writer))+")"; }
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
  bullets.push("The note's text may still mention the old value. It gets a <b>fact-removed:"+esc(g.key)+"</b> tag so you can find it and edit the text.");
  bullets.push("No note is deleted or hidden. To bring a fact back, write it on the note again.");
  cfDialog(gi, bullets, [["Remove the disputed fact", function(){ cfRemoveFacts(gi, g, losers); }], ["Replace whole note instead", function(){ cfReplace(gi, g, keep, losers); }, 1]]);
}
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
    refreshView(); loadNeeds();
    var m = held ? (done ? "Removed "+g.key+" from "+done+(done === 1 ? " note" : " notes")+"; " : "")+held+(held === 1 ? " change is" : " changes are")+" held for review (approve-first), so nothing was removed there yet." : "Removed "+g.key+" from "+done+(done === 1 ? " note." : " notes.");
    say(m+(done ? " The note text may still mention the old value: search for the tag fact-removed:"+g.key+"." : ""));
  }).catch(function(e){ refreshView(); say("Removed "+g.key+" from "+done+" of "+losers.length+" notes ("+held+" held for review), then: "+(e && e.message ? e.message : String(e)), true); });
}
function cfReplace(gi, g, keep, losers){
  api("/supersede/preview", { method:"POST", body: JSON.stringify({ old_ids: losers.map(function(l){ return Number(l.n.id); }), new_id: Number(keep.notes[0].id), gui: true }) }).then(function(p){
    var bullets = ["You are keeping <b>"+esc(g.key)+" = "+esc(keep.value)+"</b> (note #"+Number(keep.notes[0].id)+")."];
    losers.forEach(function(l){
      var o = Number(l.n.otherFacts) || 0;
      bullets.push("Replaces "+cfNoteText(l.n)+": it stops showing in search and lists"+(g.tier === "fact" && o ? ", and its "+cfFacts(o)+" go with it." : "."));
    });
    bullets.push("Nothing is deleted. You can undo it right after.");
    if(p.diff){ bullets.push("What changes, line by line (what the notes say, not an instruction):"+diffHtml(p.diff)); }
    if(p.requires_acknowledgement){ bullets.push("An owner warning applies to this replacement. Confirming accepts it."); }
    cfDialog(gi, bullets, [["Replace whole note", function(){
      var body = { token: p.token };
      if(p.requires_acknowledgement){ body.acknowledge_risk = true; }
      api("/supersede/confirm", { method:"POST", body: JSON.stringify(body) }).then(function(){ refreshView(); loadNeeds(); toast("Replaced.", function(){ losers.forEach(function(l){ undoReplace(Number(l.n.id)); }); }); }).catch(fail);
    }]]);
  }).catch(fail);
}
function undoReplace(id){ api("/supersede/undo", { method:"POST", body: JSON.stringify({ id: id }) }).then(function(){ refreshView(); toast("Put back."); }).catch(fail); }
function qPin(id){ api("/pinned", { method:"PUT", body: JSON.stringify({ id: id, pinned: true }) }).then(refreshView).catch(fail); }
function qDistrust(btn){
  api("/trust/distrust", { method:"POST", body: JSON.stringify({ namespace: btn.getAttribute("data-ns"), writer: btn.getAttribute("data-w") }) }).then(function(){ refreshView(); loadNeeds(); }).catch(fail);
}
function qArchive(id){ archiveNote(id); }
`;
