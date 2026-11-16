// Dashboard script, part 4: Activity (changes, "Undo what this app did", tasks, the last handoff, sessions) and the views
// Settings opens: Usage, Apps and keys, Activity log.
export const ACTIVITY_JS = `
var WIN_TEXT = { "24h":"24 hours", "7d":"7 days", "30d":"30 days" }, WIN = "24h";
function loadChanges(){
  setView("changes");
  var ns = String($("ns").value || "").trim();
  var winText = WIN_TEXT[WIN] || WIN;
  var path = "/changes?since=" + encodeURIComponent(WIN) + "&limit=200" + (ns ? ("&namespace=" + encodeURIComponent(ns)) : "") + (inc() ? "&include_distrusted=1" : "");
  var picker = "<label class='field' style='max-width:220px'><span>How far back</span><select id='chwin' onchange='WIN=this.value;loadChanges()'>" +
    ["24h","7d","30d"].map(function(w){ return "<option value='"+w+"'"+(w === WIN ? " selected" : "")+">Last "+WIN_TEXT[w]+"</option>"; }).join("") + "</select></label>";
  Promise.all([
    api(path),
    api("/tasks?limit=20" + nsQs("&", true)).catch(function(){ return { tasks: [] }; }),
    api("/handoffs?limit=1" + nsQs("&", true)).catch(function(){ return { handoffs: [] }; })
  ]).then(function(rs){
    var j = rs[0], c = j.counts || {};
    $("count").textContent = "Last " + winText + ": " + plural(c.created||0, "note added", "notes added") + ", " + (c.updated||0) + " changed, " + (c.deleted||0) + " removed" + (j.quarantined ? (", " + j.quarantined + " held") : "");
    // Per writer (the server-stamped app), not per claimed source: "Undo what it did" rolls back a writer.
    var byW = {};
    (j.changes || []).forEach(function(e){ var w = e.written_by; if(!w){ return; } var v = byW[w] || (byW[w] = { created: 0, updated: 0, deleted: 0 }); v[e.kind] = (v[e.kind] || 0) + 1; });
    var apps = Object.keys(byW).sort();
    var byApp = apps.length ? "<h3 class='section t-title'>By app</h3><div class='card'><div class='group' style='background:transparent;padding:0'>" + apps.map(function(k){
      var v = byW[k];
      return "<div class='item'><div>"+chip(k)+" <span class='muted t-foot'>"+v.created+" added, "+v.updated+" changed, "+v.deleted+" removed</span></div>"+
        (IS_ADMIN ? "<button data-w='"+esc(k)+"' onclick='rollbackPreview(this.getAttribute(&quot;data-w&quot;))'>Undo what it did&hellip;</button>" : "")+"</div>";
    }).join("") + "</div></div>" : "";
    var rows = (j.changes || []).slice().reverse().map(function(e){
      var verb = e.kind === "created" ? "Added" : (e.kind === "updated" ? "Changed" : "Removed");
      return "<article class='card'><h3 class='t-head'>"+esc(e.title)+"</h3><div class='meta'>"+verb+byLine(e.written_by)+" &middot; "+esc(e.namespace)+" &middot; "+esc(ago(e.at))+(e.distrusted ? " &middot; <span class='lbl danger'>Distrusted writer</span>" : "")+"</div></article>";
    }).join("");
    $("list").innerHTML = picker + byApp + tasksHtml(rs[1].tasks || []) + handoffHtml((rs[2].handoffs || [])[0]) +
      "<h3 class='section t-title'>What changed</h3>" + (rows || empty("Nothing changed", "Nothing changed in the last " + winText + ".")) +
      "<div class='acts'><button class='plain' onclick='loadSessions()'>App sessions &rsaquo;</button></div>";
  }).catch(function(e){ incRefused(e); failList(e); });
}
var TASK_WORDS = { open:"To do", claimed:"In progress", blocked:"Blocked", done:"Done", cancelled:"Cancelled" };
function tasksHtml(ts){
  var open = ts.filter(function(t){ return t.status !== "done" && t.status !== "cancelled"; });
  if(!open.length){ return ""; }
  return "<h3 class='section t-title'>Tasks</h3><div class='card'><div class='group' style='background:transparent;padding:0'>" + open.map(function(t){
    return "<div class='item'><div><b>"+esc(t.title)+"</b><div class='meta'>"+esc(TASK_WORDS[t.status] || t.status)+(t.owner ? " &middot; "+chip(t.owner) : "")+(t.next_step ? " &middot; next: "+esc(t.next_step) : "")+"</div></div><span class='muted t-foot'>#"+Number(t.id)+"</span></div>";
  }).join("") + "</div></div>";
}
function handoffHtml(h){
  if(!h){ return ""; }
  var list = function(title, xs){ return xs && xs.length ? "<p class='t-foot muted' style='margin:8px 0 0'>"+title+"</p><ul class='t-callout' style='margin:4px 0 0'>"+xs.map(function(x){ return "<li>"+esc(x)+"</li>"; }).join("")+"</ul>" : ""; };
  return "<h3 class='section t-title'>Last handoff</h3><article class='card'><div class='body'>"+esc(h.summary)+"</div>"+
    "<div class='meta'>"+byLine(h.written_by).replace(/^ &middot; /, "")+" &middot; "+esc(ago(h.at))+"</div>"+
    (h.next_step ? "<p class='t-callout' style='margin:8px 0 0'><b>Next:</b> "+esc(h.next_step)+"</p>" : "")+list("Still open", h.pending)+list("Decided", h.decisions)+"</article>";
}
// "Undo what this app did": the server's rollback plan, then one confirm. It also undoes the app's replacements, flags and claims.
function rollbackPreview(writer){
  api("/rollback/preview", { method:"POST", body: JSON.stringify({ writer: writer, since: WIN }) }).then(function(p){
    ask(p.warning || ("Undo what " + shownWriter(writer) + " did in the last " + (WIN_TEXT[WIN] || WIN) + "?"), "Undo it", function(){
      api("/rollback/confirm", { method:"POST", body: JSON.stringify({ token: p.token }) }).then(function(r){ loadChanges(); loadNeeds(); toast(r && r.message ? r.message : "Undone."); }).catch(fail);
    });
  }).catch(fail);
}

// ---- Sessions (from Activity) ----
function loadSessions(){
  setView("sessions", loadChanges);
  api("/sessions?limit=100" + nsQs("&")).then(function(j){
    var ss = j.sessions || [];
    $("count").textContent = plural(ss.length, "session", "sessions");
    $("list").innerHTML = ss.length ? ss.map(function(s){
      return "<article class='card'><h3 class='t-head'>"+esc(s.summary || "(no summary yet)")+"</h3>"+
        "<div class='meta'>"+when(s.started_at)+(s.ended_at ? " to "+when(s.ended_at) : " &middot; still open")+" &middot; "+esc(s.namespace)+" &middot; "+plural(s.prompt_count||0, "prompt", "prompts")+"</div>"+
        "<div class='meta'>"+(s.model ? "Model the app reported: "+esc(s.model) : "The app did not report its model")+"</div>"+
        acts("<button data-sid='"+esc(s.id)+"' onclick='loadSession(this.getAttribute(&quot;data-sid&quot;))'>Timeline</button>")+"</article>";
    }).join("") : empty("No sessions yet", "Sessions show up here once the session hooks are set up (Settings, Your apps).");
  }).catch(function(e){ incRefused(e); failList(e); });
}
function loadSession(id){
  setView("session", loadSessions);
  api("/sessions/" + encodeURIComponent(id) + nsQs("?")).then(function(j){
    var items = (j.prompts || []).map(function(p){ return { at: p.at, html: "<span class='lbl'>prompt</span> "+esc(p.text) }; })
      .concat((j.rows || []).filter(function(r){ return r.kind !== "summary"; }).map(function(r){
        return { at: r.date, html: "<span class='lbl'>"+esc(r.type)+"</span> "+esc(r.title)+(r.distrusted ? " <span class='lbl danger'>Distrusted writer</span>" : "")+
          ((r.files||[]).length ? "<div class='meta'>"+(r.files||[]).map(esc).join(", ")+"</div>" : "") };
      }));
    items.sort(function(a,b){ return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    var sum = j.summary;
    $("count").textContent = plural(items.length, "timeline entry", "timeline entries");
    $("list").innerHTML = (sum ? "<article class='card'><h3 class='t-head'>"+esc(sum.title)+"</h3><div class='body'>"+esc(sum.body)+"</div></article>" : "")+
      (items.length ? items.map(function(it){ return "<article class='card'><div class='meta' style='margin:0 0 4px'>"+when(it.at)+"</div>"+it.html+"</article>"; }).join("") : empty("Nothing recorded", "Nothing was recorded in this session yet."));
  }).catch(function(e){ incRefused(e); failList(e); });
}

// ---- Usage (Settings) ----
function loadMeter(){
  setView("meter", openSettings);
  var ns = String($("ns").value || "").trim();
  api("/stats" + (ns ? ("?namespace=" + encodeURIComponent(ns)) : "")).then(function(j){
    var m = j.meter || {}, t = m.totals || {};
    function num(v){ return Number(v||0).toLocaleString(); }
    $("count").textContent = plural(t.sessions || 0, "session measured", "sessions measured");
    var rows = (m.recent || []).map(function(r){
      return "<tr><td>"+when(r.updated_at)+"</td><td>"+(r.namespace ? esc(r.namespace) : "<span class='muted'>(none)</span>")+"</td><td class='n'>"+num(r.injected_tokens)+"</td><td class='n'>"+num(r.saved_tokens)+"</td></tr>";
    }).join("");
    function stat(big, text){ return "<div class='stat'><b>"+big+"</b><span>"+text+"</span></div>"; }
    $("list").innerHTML = "<article class='card'><div class='stats'>"+
      stat(num(t.injected_tokens), "tokens of notes added at session start (" + plural(t.injections || 0, "time", "times") + ")")+
      stat(num(t.saved_tokens), "tokens saved, an estimate: the full text of the notes shown, minus the tokens injected")+
      (Number(t.llm_tokens) ? stat(num(t.llm_tokens), "tokens used by your local summary model") : "")+
      stat((Number(m.db_bytes||0)/1048576).toFixed(1)+" MB", "your notes on disk")+"</div></article>"+
      (rows ? "<h3 class='section t-title'>Recent sessions</h3><article class='card'><table class='apps'><tr><th scope='col'>When</th><th scope='col'>Project</th><th scope='col' class='n'>Added</th><th scope='col' class='n'>Saved</th></tr>"+rows+"</table></article>"
        : empty("Nothing measured yet", "The numbers start with the next session an app opens."));
  }).catch(failList);
}

// ---- Apps and keys (Settings): which apps may connect and what each may see. Keys are never listed again. ----
function loadApps(){
  setView("apps", openSettings);
  api("/tokens").then(function(j){
    var apps = j.apps || [];
    $("count").textContent = plural(apps.length, "app can connect", "apps can connect");
    var rows = apps.map(function(a){
      var lim = a.max_sensitivity ? ("up to " + esc(a.max_sensitivity)) : "<b>NO LIMIT</b>" + (a.scope === "admin" ? " (sees everything)" : "");
      var rm = (a.source === "file") ? "<button class='destructive' data-label='"+esc(a.label)+"' aria-label='Remove app "+esc(a.label)+"' onclick='var x=this;arm(x,function(){removeApp(x.getAttribute(&quot;data-label&quot;))})'>Remove</button>" : "<span class='muted'>set outside the dashboard</span>";
      return "<tr><td>"+esc(shownWriter(a.label))+"</td><td>"+esc(a.scope === "read" ? "read only" : a.scope === "admin" ? "everything" : "read and write")+"</td><td>"+esc(a.namespace || "all")+"</td><td>"+lim+"</td><td>"+(a.last_used ? esc(ago(a.last_used)) : "not since Monomem started")+"</td><td>"+rm+"</td></tr>";
    }).join("");
    $("list").innerHTML =
      "<article class='card'><table class='apps'><tr><th>App</th><th>May</th><th>Project</th><th>Sees</th><th>Last used</th><th></th></tr>"+rows+"</table>"+
      "<p class='meta'>Removing an app cuts it off at once.</p></article>"+
      "<h3 class='section t-title'>Add an app</h3><article class='card'>"+
      "<label class='field'><span>Name</span><input id='ap_label' placeholder='For example: cursor'></label>"+
      "<label class='field'><span>It may</span><select id='ap_scope'><option value='write'>Read and write</option><option value='read'>Only read</option></select></label>"+
      "<label class='field'><span>It sees</span><select id='ap_max'><option value='internal'>Public and normal notes</option><option value='public'>Only public notes</option><option value='private'>Private notes too (still limited)</option><option value='none'>NO LIMIT (everything)</option></select></label>"+
      "<button class='primary' onclick='addApp()'>Add app</button><div id='ap_out'></div></article>";
  }).catch(failList);
}
function addApp(){
  var label = String($("ap_label").value || "").trim();
  var max = $("ap_max").value;
  if(!label){ say("Give the app a name first.", true); return; }
  var body = { label: label, scope: $("ap_scope").value };
  var go = function(){
    api("/tokens", { method:"POST", body: JSON.stringify(body) }).then(function(j){
      var out = $("ap_out");
      out.innerHTML = "<p><b>Copy this key now.</b> It is shown once.</p><pre class='out' id='ap_tok'></pre><button onclick='copyText(&quot;ap_tok&quot;)'>Copy key</button>"+
        "<p class='meta'>"+esc(j.access || "")+"</p><p>Paste this into the app's settings:</p><pre class='out' id='ap_snip'></pre><button onclick='copyText(&quot;ap_snip&quot;)'>Copy settings</button>";
      $("ap_tok").textContent = j.token;
      $("ap_snip").textContent = j.snippet || "";
      $("ap_label").value = "";
      toast("Added " + label + ".");
    }).catch(fail);
  };
  if(max === "none"){ body.no_limit = true; ask("NO LIMIT means this app can read every private note and change who can see any note. Only do this for an app you trust completely.", "Add it anyway", go); }
  else { body.max = max; go(); }
}
function copyText(id){
  var t = $(id).textContent;
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(function(){ toast("Copied."); }, function(){ say("Could not copy; select the text and copy it by hand.", true); }); }
  else { say("Select the text and copy it by hand.", true); }
}
function removeApp(label){ api("/tokens/" + encodeURIComponent(label), { method:"DELETE" }).then(function(){ loadApps(); toast("Removed " + label + "."); }).catch(fail); }

// ---- Activity log (Settings): who changed what. Metadata only. ----
function loadAudit(){
  setView("audit", openSettings);
  var op = ($("au_op") || {}).value || "", since = ($("au_since") || {}).value || "24h";
  api("/audit?since=" + encodeURIComponent(since) + (op ? "&op=" + encodeURIComponent(op) : "") + "&limit=200").then(function(j){
    var es = j.entries || [];
    $("count").textContent = plural(es.length, "entry", "entries");
    var rows = es.map(function(e){ return "<tr><td>" + when(e.ts) + "</td><td>" + esc(e.op) + "</td><td>" + esc(e.label ? shownWriter(e.label) : "terminal or server") + "</td><td>" + esc(e.namespace || "") + "</td><td>" + (e.id != null ? "#" + Number(e.id) : "") + "</td></tr>"; }).join("");
    var ops = ["", "create", "update", "delete"].map(function(o){ return "<option value='" + o + "'" + (o===op?" selected":"") + ">" + (o || "Every action") + "</option>"; }).join("");
    var wins = ["24h", "7d", "30d"].map(function(w){ return "<option value='" + w + "'" + (w===since?" selected":"") + ">Last " + WIN_TEXT[w] + "</option>"; }).join("");
    $("list").innerHTML = "<div class='row' style='margin-bottom:16px'><label class='field'><span>How far back</span><select id='au_since' onchange='loadAudit()'>" + wins + "</select></label><label class='field'><span>Action</span><select id='au_op' onchange='loadAudit()'>" + ops + "</select></label></div>" +
      (rows ? "<article class='card'><table class='apps'><tr><th>When</th><th>Action</th><th>App</th><th>Project</th><th>Note</th></tr>" + rows + "</table></article>" : empty("Nothing logged", "Nothing was logged in that time."));
  }).catch(failList);
}
`;
