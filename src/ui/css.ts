// The dashboard's one design system (.panel-160/expert-design.md): colour roles from the brand (navy #0B2E45,
// ocean #155F87, gold #F0C171), one system font, a 28 -> 12 px type scale (nothing smaller), 4 px spacing, and one of each
// component (button, card, sheet, tab, badge, field, toast, menu). Dark and light only redefine tokens.
// Roles: --action (ocean) is the one button colour; --brand (gold) is the mark and the header rule only; --destructive
// (red) is for delete, failed and the held stamp only. Every text/background pair below passes WCAG AA (4.5:1 for text,
// 3:1 for control edges and focus rings), placeholders included; checked by test/ui-design.test.ts.
export const CSS = `
:root{color-scheme:dark;
  --navy:#0B2E45;--gold:#F0C171;
  --bg:#0B1A26;--surface:#102434;--surface-2:#183041;--separator:#2C4E66;--field:#6F90A6;
  --text:#EEF4F8;--text-2:#B4C4CF;--action:#4FA3D1;--on-action:#0B1A26;--focus:#7CC4EA;
  --positive:#6FD9A2;--caution:#F0C171;--caution-bg:#2E2A1C;--destructive:#FFA3A3;--destructive-fill:#B3261E;--on-destructive:#FFFFFF;
  --shadow:0 1px 0 rgba(255,255,255,.04) inset;--scrim:rgba(4,12,18,.6);
  --chip-s:45%;--chip-bg-l:24%;--chip-fg-l:86%;--chip-fg-s:80%;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  --mono:ui-monospace,"Cascadia Code",SFMono-Regular,Consolas,Menlo,monospace;
  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px;
  --r-card:12px;--r-ctl:8px;--r-pill:999px;--tap:36px}
@media (prefers-color-scheme:light){:root{color-scheme:light;
  --bg:#F5F8FA;--surface:#FFFFFF;--surface-2:#EEF3F6;--separator:#C9D6E0;--field:#66717B;
  --text:#12212C;--text-2:#4E5B66;--action:#155F87;--on-action:#FFFFFF;--focus:#155F87;
  --positive:#17794A;--caution:#8A5A12;--caution-bg:#FBF3E2;--destructive:#B3261E;--destructive-fill:#B3261E;
  --shadow:0 1px 2px rgba(11,46,69,.06),0 8px 20px -12px rgba(11,46,69,.25);--scrim:rgba(11,46,69,.35);
  --chip-s:60%;--chip-bg-l:90%;--chip-fg-l:20%;--chip-fg-s:70%}}
@media (max-width:600px){:root{--tap:44px}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:400 0.9375rem/1.4667 var(--font);-webkit-font-smoothing:antialiased;overflow-x:hidden}
/* Type scale (rem, so browser zoom and text size scale it): large title 28, title 20, headline 16, body 15, callout 14,
   footnote 13, caption 12. Nothing is smaller than 12 px. */
.t-large{font-size:1.75rem;line-height:1.2143;font-weight:700;letter-spacing:-.01em}
.t-title{font-size:1.25rem;line-height:1.3;font-weight:600}
.t-head{font-size:1rem;line-height:1.375;font-weight:600}
.t-callout{font-size:.875rem;line-height:1.4286}
.t-foot{font-size:.8125rem;line-height:1.3846}
.t-cap{font-size:.75rem;line-height:1.3333;font-weight:500}
h1,h2,h3{margin:0}
.muted{color:var(--text-2)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
code,.mono{font-family:var(--mono);font-size:.8125rem}
code{background:var(--surface-2);border-radius:4px;padding:0 var(--s1)}
a{color:var(--action)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}

/* Controls */
button,input,select,textarea{font:inherit;color:var(--text)}
button{min-height:var(--tap);padding:0 var(--s4);border-radius:var(--r-ctl);border:1px solid transparent;cursor:pointer;
  font-weight:600;background:var(--surface-2);color:var(--text);display:inline-flex;align-items:center;justify-content:center;gap:var(--s2);white-space:nowrap}
button.primary{background:var(--action);color:var(--on-action)}
button.plain{background:transparent;color:var(--action);padding:0 var(--s2);font-weight:500}
button.destructive{background:transparent;color:var(--destructive);padding:0 var(--s2)}
button.destructive.fill{background:var(--destructive-fill);color:var(--on-destructive);padding:0 var(--s4)}
button:disabled{opacity:.55;cursor:default}
button.icon{width:var(--tap);padding:0;font-size:1.25rem;line-height:1}
input,select,textarea{background:var(--surface);border:1px solid var(--field);border-radius:var(--r-ctl);min-height:var(--tap);
  padding:var(--s2) var(--s3);max-width:100%}
textarea{min-height:120px;resize:vertical;width:100%;line-height:1.4667}
::placeholder{color:var(--text-2);opacity:.85}
input[type=checkbox]{min-height:0;width:20px;height:20px;margin:0;accent-color:var(--action)}
.field{display:flex;flex-direction:column;gap:var(--s1);margin:0 0 var(--s3)}
.field>span{font-size:.8125rem;font-weight:600;color:var(--text-2)}
.field input,.field select{width:100%}
.help{font-size:.8125rem;color:var(--text-2)}
.err{color:var(--destructive)}
.row{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}
.acts{display:flex;flex-wrap:wrap;gap:var(--s2);margin-top:var(--s3)}

/* Switch: a checkbox drawn as an Apple-style toggle; the label is visible text. */
.switch{display:flex;align-items:center;justify-content:space-between;gap:var(--s4);min-height:var(--tap);padding:var(--s2) 0;border-top:1px solid var(--separator)}
.switch:first-child{border-top:0}
.switch .row{flex-wrap:nowrap}
.switch input{appearance:none;-webkit-appearance:none;width:44px;height:26px;border-radius:13px;background:var(--surface-2);border:1px solid var(--field);position:relative;flex:none;cursor:pointer}
.switch input::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--text-2)}
.switch input:checked{background:var(--action);border-color:var(--action)}
.switch input:checked::after{left:20px;background:var(--on-action)}

/* Header: the navy band with the gold rule looks the same in both themes. */
header.top{background:var(--navy);border-bottom:2px solid var(--gold);color-scheme:dark;
  --surface:#143C58;--text:#FFFFFF;--text-2:#A9BFCF;--field:#5D87A4;--focus:var(--gold)}
.bar{max-width:760px;margin:0 auto;padding:var(--s3) var(--s4);display:flex;gap:var(--s3);align-items:center}
.brand{display:flex;align-items:center;gap:var(--s2);color:#fff;font-weight:650;font-size:1rem;margin-right:auto;white-space:nowrap}
.brand img{width:28px;height:28px;border-radius:7px;display:block}
header.top #q{flex:1 1 200px;min-width:0;border-radius:var(--r-pill);padding-left:var(--s4);color:#fff;background:#143C58}
header.top button.icon{background:transparent;color:#fff}
@media (max-width:600px){.bar{flex-wrap:wrap}header.top #q{order:3;flex-basis:100%}}

/* Segmented tabs */
nav.tabs{max-width:760px;margin:0 auto;padding:var(--s4) var(--s4) 0}
.seg{display:flex;gap:2px;padding:3px;background:var(--surface-2);border-radius:10px}
.seg button{flex:1 1 0;background:transparent;font-weight:500;color:var(--text);border-radius:8px;min-width:0;padding:0 var(--s2)}
.seg button[aria-current=page]{background:var(--surface);box-shadow:var(--shadow);font-weight:650}
.badge{display:inline-block;min-width:20px;padding:0 6px;border-radius:var(--r-pill);background:var(--surface);border:1px solid var(--separator);
  color:var(--text);font-size:.75rem;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums;text-align:center}
.seg button[aria-current=page] .badge{background:var(--surface-2)}

main{max-width:760px;margin:0 auto;padding:var(--s5) var(--s4) var(--s7)}
.viewhead{margin:0 0 var(--s4)}
.viewhead p{margin:var(--s1) 0 0;max-width:62ch}
.back{margin:0 0 var(--s2) calc(-1 * var(--s2))}
.filters{margin:0 0 var(--s4)}
.filters summary{cursor:pointer;color:var(--action);font-weight:500;min-height:var(--tap);display:inline-flex;align-items:center;min-width:var(--tap)}
.filters .row{align-items:flex-end;gap:var(--s3);padding-top:var(--s2)}
.filters .field{margin:0}
.chk{display:flex;gap:var(--s2);align-items:center;min-height:var(--tap);font-size:.875rem}

/* Banner: at most one per view, caution colours for routine states. */
.banner{display:flex;gap:var(--s3);align-items:center;justify-content:space-between;flex-wrap:wrap;background:var(--caution-bg);
  border:1px solid var(--caution);border-radius:var(--r-card);padding:var(--s3) var(--s4);margin:0 0 var(--s4)}
.banner ul{margin:var(--s1) 0 0;padding-left:var(--s5)}

/* Cards */
.card{background:var(--surface);border:1px solid var(--separator);border-radius:var(--r-card);padding:var(--s4);margin:0 0 var(--s3);box-shadow:var(--shadow);min-width:0}
@media (min-width:900px){.card{padding:20px}}
.nhead{display:flex;gap:var(--s2);align-items:flex-start}
.nhead h3{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.meta{color:var(--text-2);font-size:.8125rem;margin-top:var(--s1);overflow-wrap:anywhere}
.body{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:var(--s2)}
.clamp{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.section{margin:var(--s6) 0 var(--s3)}
.section:first-child{margin-top:0}
.chips{display:flex;flex-wrap:wrap;gap:var(--s1);margin-top:var(--s2)}
.tag{display:inline-block;background:var(--surface-2);border-radius:var(--r-pill);padding:0 var(--s2);font-size:.75rem;line-height:22px;color:var(--text-2);font-weight:500}
.tag.fact{color:var(--text);box-shadow:inset 0 0 0 1px var(--action)}
.tag.why{color:var(--text);box-shadow:inset 0 0 0 1px var(--caution)}
.chip{display:inline-block;border-radius:6px;padding:0 6px;font-size:.75rem;line-height:20px;font-weight:600;
  background:hsl(var(--h) var(--chip-s) var(--chip-bg-l));color:hsl(var(--h) var(--chip-fg-s) var(--chip-fg-l))}
.lbl{display:inline-block;border-radius:6px;padding:0 6px;font-size:.75rem;line-height:20px;font-weight:600;white-space:nowrap;
  border:1px solid var(--separator);color:var(--text-2)}
.lbl.brand{border-color:var(--caution);color:var(--caution)}
.lbl.caution{border-color:var(--caution);color:var(--caution)}
.lbl.danger{border-color:var(--destructive);color:var(--destructive)}
.lbl.ok{border-color:var(--positive);color:var(--positive)}
.stamp{display:inline-block;border:2px solid var(--destructive);color:var(--destructive);border-radius:4px;padding:0 6px;
  font-size:.75rem;font-weight:700;letter-spacing:.06em;margin-bottom:var(--s2)}
.heldbody{font:.8125rem/1.45 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;border:1px dashed var(--separator);border-radius:var(--r-ctl);padding:var(--s2) var(--s3);margin-top:var(--s2)}
.empty{text-align:center;padding:var(--s6) var(--s5);border:1px dashed var(--separator);border-radius:var(--r-card)}
.empty h3{margin-bottom:var(--s1)}
.msg{margin:0 0 var(--s3);overflow-wrap:anywhere}
.msg:empty{display:none}
.msg button{margin:var(--s2) var(--s2) 0 0}
pre.out{white-space:pre-wrap;word-break:break-word;background:var(--surface-2);border-radius:var(--r-ctl);padding:var(--s3);font:.8125rem/1.45 var(--mono);max-height:260px;overflow:auto}
.diff{font:.8125rem/1.45 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-2);border-radius:var(--r-ctl);padding:var(--s2) var(--s3);margin:var(--s2) 0}
.diff .del{border-left:3px solid var(--destructive);padding-left:5px}
.diff .add{border-left:3px solid var(--positive);padding-left:5px}
.cf{border-top:1px solid var(--separator);padding:var(--s3) 0 var(--s1)}
.cf:first-of-type{border-top:0}
.cfval{margin:var(--s2) 0}
.cfdlg:empty{display:none}
.cfdlg{margin-top:var(--s2);padding:var(--s2) var(--s3);border:1px solid var(--separator);border-radius:var(--r-ctl)}
.cfmore summary{cursor:pointer;min-height:var(--tap);display:inline-flex;align-items:center}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:var(--s4) var(--s5);margin:var(--s3) 0 0;font-variant-numeric:tabular-nums}
.stat b{display:block;font-size:1.75rem;line-height:1.2;font-weight:700}
.stat span{color:var(--text-2);font-size:.8125rem}
table.apps{width:100%;font-size:.875rem;border-collapse:collapse;font-variant-numeric:tabular-nums}
table.apps td,table.apps th{text-align:left;padding:var(--s2);border-bottom:1px solid var(--separator);vertical-align:top}
table.apps th{color:var(--text-2);font-weight:600}
table.apps .n{text-align:right}
@media (max-width:600px){
  table.apps,table.apps tbody{display:block;width:100%}
  table.apps tr.hd{display:none}
  table.apps tr{display:block;padding:var(--s2) 0;border-bottom:1px solid var(--separator)}
  table.apps td{display:flex;justify-content:space-between;gap:var(--s3);border:0;padding:2px 0;text-align:right;overflow-wrap:anywhere}
  table.apps td::before{content:attr(data-l);color:var(--text-2);text-align:left;flex:0 0 38%}
  table.apps td:empty{display:none}
}

/* The note's "..." menu: a native disclosure, so it works with keyboard and screen readers without script. */
details.menu{position:relative;flex:none}
details.menu>summary{list-style:none;cursor:pointer;width:var(--tap);height:var(--tap);display:flex;align-items:center;justify-content:center;
  border-radius:var(--r-ctl);color:var(--text-2);font-weight:700;letter-spacing:.08em}
details.menu>summary::-webkit-details-marker{display:none}
details.menu>summary:hover,details.menu[open]>summary{background:var(--surface-2)}
.pop{position:absolute;right:0;top:calc(var(--tap) + 4px);z-index:5;min-width:240px;max-width:min(320px,calc(100vw - 32px));background:var(--surface);
  border:1px solid var(--separator);border-radius:var(--r-card);box-shadow:0 12px 32px -8px rgba(0,0,0,.45);padding:var(--s1)}
.pop button{width:100%;justify-content:flex-start;background:transparent;font-weight:500;text-align:left;padding:0 var(--s3)}
.pop button:hover{background:var(--surface-2)}
.pop button[aria-checked=true]::after{content:"\\2713";margin-left:auto;color:var(--action)}
.pop hr{border:0;border-top:1px solid var(--separator);margin:var(--s1) 0}
.pop .cap{padding:var(--s2) var(--s3) 0;font-size:.75rem;color:var(--text-2);font-weight:600}
.pop p{margin:0;padding:var(--s2) var(--s3);font-size:.8125rem;color:var(--text-2)}

/* Sheets (native dialog: Esc closes, focus is kept inside and goes back to the opener). */
dialog{border:0;padding:0;background:var(--surface);color:var(--text);border-radius:16px;width:min(560px,calc(100vw - 24px));
  max-height:calc(100vh - 48px);box-shadow:0 24px 64px -12px rgba(0,0,0,.5)}
dialog::backdrop{background:var(--scrim)}
.sheet{padding:var(--s5)}
.sheethead{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);margin-bottom:var(--s4)}
.sheet section{margin:0 0 var(--s5)}
.sheet section>h3{font-size:.8125rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-2);margin:0 0 var(--s2);font-weight:600}
.group{background:var(--bg);border-radius:var(--r-card);padding:var(--s1) var(--s4)}
.item{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);min-height:var(--tap);padding:var(--s2) 0;border-top:1px solid var(--separator)}
.item:first-child{border-top:0}
.item>div{min-width:0}
.list button.item{width:100%;background:transparent;border-radius:0;font-weight:500;padding:var(--s2) 0}
@media (max-width:600px){dialog{width:100vw;max-width:100vw;margin:auto 0 0;border-radius:16px 16px 0 0;max-height:92vh}}
#palette{margin-top:12vh}
#pal_list{list-style:none;margin:var(--s2) 0 0;padding:0;max-height:50vh;overflow:auto}
#pal_list li button{width:100%;justify-content:flex-start;background:transparent;font-weight:500}
#pal_list li button[aria-selected=true]{background:var(--surface-2)}
kbd{font:600 .75rem var(--mono);border:1px solid var(--separator);border-bottom-width:2px;border-radius:4px;padding:0 5px;background:var(--surface-2)}

/* Toast */
#toast{position:fixed;left:50%;bottom:var(--s5);transform:translateX(-50%);z-index:20;display:flex;gap:var(--s3);align-items:center;
  background:var(--text);color:var(--bg);border-radius:var(--r-card);padding:var(--s2) var(--s2) var(--s2) var(--s4);box-shadow:0 12px 32px -8px rgba(0,0,0,.5);max-width:calc(100vw - 32px)}
#toast:empty{display:none}
#toast button{background:transparent;color:var(--bg);text-decoration:underline;text-underline-offset:3px}

/* Sign-in and Welcome */
.gate,.welcome{max-width:520px;margin:8vh auto;padding:0 var(--s4)}
.gcard{background:var(--surface);border:1px solid var(--separator);border-radius:20px;overflow:hidden;box-shadow:var(--shadow)}
.ghead{background:var(--navy);border-bottom:2px solid var(--gold);color:#fff;text-align:center;padding:var(--s6) var(--s5) var(--s5)}
.ghead img{width:64px;height:64px;border-radius:14px}
.ghead h1{font-size:1.75rem;margin-top:var(--s2)}
.ghead p{margin:var(--s1) 0 0;color:#A9BFCF;font-size:.8125rem}
.gbody{padding:var(--s5)}
.gbody input:not([type=checkbox]){width:100%}
/* Disclosure links (More options, Use an app key instead): at least 24 px tall (WCAG 2.5.8). */
.gbody summary,.sheet summary{cursor:pointer;padding:var(--s2) 0}
.steps{display:flex;gap:var(--s2);justify-content:center;margin:0 0 var(--s4);padding:0;list-style:none}
.steps li{width:8px;height:8px;border-radius:50%;background:var(--separator)}
.steps li[aria-current=step]{background:var(--action);width:24px;border-radius:4px}
.app{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);padding:var(--s3) 0;border-top:1px solid var(--separator);flex-wrap:wrap}
.app:first-child{border-top:0}
.app>div{min-width:0}.app .help{overflow-wrap:anywhere}
.say{font:600 .9375rem var(--mono);background:var(--surface-2);border-radius:var(--r-ctl);padding:var(--s3);overflow-wrap:anywhere}
footer.foot{max-width:760px;margin:0 auto;padding:0 var(--s4) var(--s6);color:var(--text-2);font-size:.75rem}

/* Motion: short fades only, and none at all when reduced motion is asked for. */
@media (prefers-reduced-motion:no-preference){
  main>*,dialog[open],#toast{animation:fade .18s ease-out}
  @keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  #toast{animation-name:fadeToast}
  @keyframes fadeToast{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translateX(-50%)}}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
