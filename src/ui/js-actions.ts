// Dashboard script, the click dispatcher. The page has no inline event handlers (onclick='...'), so its Content-Security-Policy
// needs no 'unsafe-inline' for scripts. Buttons carry data-do="name" (click), data-chg="name" (change), data-enter="name"
// (Enter key) or data-sub="name" (form submit) plus an optional data-args='[...]' (JSON); ONE listener per event type on the
// document looks the name up in ACTS, a fixed table, and runs it. Only names in ACTS run: text from the store can never
// choose a function. Plain ES5 in a string; no backticks inside.
export const ACTIONS_JS = `
// Markup helpers: the attributes for a button (actA, click) or a field (actC, change).
function actA(n, a){ return " data-do='"+n+"'" + (a === undefined ? "" : " data-args='"+esc(JSON.stringify(a))+"'"); }
function actC(n, a){ return " data-chg='"+n+"'" + (a === undefined ? "" : " data-args='"+esc(JSON.stringify(a))+"'"); }
function actArgs(el){ try { var j = JSON.parse(el.getAttribute("data-args") || "[]"); return j instanceof Array ? j : []; } catch(e){ return []; } }
var ACTS = {
  // views and sheets
  load: function(){ load(); }, loadReview: function(){ loadReview(); }, loadHeld: function(){ loadHeld(); },
  loadChanges: function(){ loadChanges(); }, loadSessions: function(){ loadSessions(); },
  loadSession: function(el){ loadSession(el.getAttribute("data-sid")); },
  loadAudit: function(){ loadAudit(); }, applyFilter: function(){ applyFilter(); },
  setWin: function(el){ WIN = el.value; loadChanges(); },
  toggleNew: function(){ toggleNew(); }, openSettings: function(){ openSettings(); }, goBack: function(){ goBack(); },
  closeSheet: function(el, a){ closeSheet(a[0]); },
  helpFromSettings: function(){ closeSheet("settings"); openSheet("helpsheet"); },
  welcomeFromSettings: function(){ closeSheet("settings"); showWelcome(0); },
  fromSettings: function(el, a){ var v = { loadMeter: loadMeter, loadQuality: loadQuality, loadApps: loadApps, loadAudit: loadAudit, loadArchived: loadArchived }[a[0]]; if(v){ fromSettings(v)(); } },
  palRun: function(el, a){ palRun(a[0]); },
  undoLast: function(){ undoLast(); },
  saveTok: function(){ saveTok(); }, addNote: function(){ addNote(); },
  signOut: function(){ closeSheet("settings"); logout(); },
  // notes
  confirmNote: function(el, a){ confirmNote(a[0]); }, setPin: function(el, a){ setPin(a[0], a[1]); },
  neverShow: function(el, a){ neverShow(a[0], a[1]); }, setLabel: function(el, a){ setLabel(a[0], a[1]); },
  touchedNote: function(el, a){ touchedNote(a[0]); }, archiveNote: function(el, a){ archiveNote(a[0]); },
  restoreNote: function(el, a){ restoreNote(a[0]); },
  armDel: function(el, a){ arm(el, function(){ del(a[0]); }); },
  rollbackPreview: function(el){ rollbackPreview(el.getAttribute("data-w")); },
  // review and held
  reviewConfirm: function(el, a){ reviewConfirm(a[0]); }, reviewKeep: function(el, a){ reviewKeep(a[0]); },
  armHeld: function(el, a){ arm(el, function(){ qHeld(a[0], a[1]); }); },
  qReplace: function(el, a){ qReplace(a[0], a[1]); }, qPrivate: function(el, a){ qPrivate(a[0]); },
  armPin: function(el, a){ arm(el, function(){ qPin(a[0]); }); },
  armDistrust: function(el){ arm(el, function(){ qDistrust(el); }); },
  cfKeep: function(el, a){ cfKeep(a[0], a[1]); }, cfAct: function(el, a){ cfAct(a[0], a[1]); }, cfClose: function(el, a){ cfClose(a[0]); },
  // apps, settings, backups, sync, welcome
  addApp: function(){ addApp(); }, removeApp: function(el){ arm(el, function(){ removeApp(el.getAttribute("data-label")); }); },
  copyText: function(el, a){ copyText(a[0]); },
  connectApp: function(el, a){ connectApp(a[0]); }, declineApp: function(el, a){ declineApp(a[0]); },
  bringIn: function(el, a){ bringIn(a[0], a[1]); },
  setSetting: function(el, a){ setSetting(a[0], el.checked); }, setService: function(el, a){ setService(a[0]); },
  checkUpdate: function(){ checkUpdate(); }, doUpdate: function(){ doUpdate(); },
  undoConnect: function(){ undoConnect(); }, backupNow: function(){ backupNow(); }, doExport: function(){ doExport(); },
  pickImport: function(){ $("imp").click(); }, doImport: function(el){ doImport(el); },
  removeMonomem: function(){ removeMonomem(); }, syncSetup: function(){ syncSetup(); }, syncNow: function(){ syncNow(); },
  finishWelcome: function(){ finishWelcome(); }, showWelcome: function(el, a){ showWelcome(a[0]); }, installApp: function(){ installApp(); }
};
function runAct(attr, e, key){
  var t = e && e.target, el = t && t.closest ? t.closest("[" + attr + "]") : null;
  if(!el){ return false; }
  var name = el.getAttribute(attr);
  if(key && e.key !== key){ return false; }
  if(!Object.prototype.hasOwnProperty.call(ACTS, name)){ return false; }
  if(attr === "data-sub"){ e.preventDefault(); }
  ACTS[name](el, actArgs(el));
  return true;
}
try {
  document.addEventListener("click", function(e){ runAct("data-do", e); });
  document.addEventListener("change", function(e){ runAct("data-chg", e); });
  document.addEventListener("keydown", function(e){ runAct("data-enter", e, "Enter"); });
  document.addEventListener("submit", function(e){ runAct("data-sub", e); });
  $("newsheet").addEventListener("close", newClosed);
} catch(e){}
`;
