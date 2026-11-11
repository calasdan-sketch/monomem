#!/usr/bin/env node
// Writes docs/monomem-architecture.svg: the README "How it works" diagram, animated with SMIL + CSS only
// (no scripts, fonts or images, so GitHub's image proxy keeps it). Light by default, dark via
// prefers-color-scheme, static under prefers-reduced-motion. The PNG/GIF are rendered from this file
// (see the end of this comment). Run: node scripts/make-architecture-svg.mjs
// Static PNG + GIF: open the SVG in headless Chrome, pauseAnimations()/setCurrentTime(t), screenshot, ffmpeg.
import { writeFileSync } from "node:fs";

const T = 12; // seconds per loop
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const txt = (x, y, s, cls = "", anchor = "start") => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`;
const kt = (...v) => v.map((n) => +(n / T).toFixed(4)).join(";");

// A dot that moves along `d` (straight segments; len = total length), reaching keyPoints at the given seconds.
function pulse(cls, d, len, stops, visible) {
  const [on, off] = visible;
  return `<circle r="7" class="dot ${cls}" opacity="0">
    <animateMotion dur="${T}s" repeatCount="indefinite" path="${d}" calcMode="linear"
      keyTimes="${kt(0, ...stops.map((s) => s[0]), T)}" keyPoints="0;${stops.map((s) => +(s[1] / len).toFixed(4)).join(";")};1"/>
    <animate attributeName="opacity" dur="${T}s" repeatCount="indefinite" calcMode="discrete"
      keyTimes="${kt(0, on, off)}" values="0;1;0"/>
  </circle>`;
}
// An overlay that is shown between two times (for highlights and captions).
const showBetween = (on, off) => `<animate attributeName="opacity" dur="${T}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${kt(0, on, off)}" values="0;1;0"/>`;

// Paths: straight lines along the visible edges; "M" jumps across a box (a moveto adds no length),
// so the dots ride on top without crossing any text. Lengths are summed by hand.
const P_CLEAN = "M220,290 H273 M390,290 H428 M620,290 H663 M845,290 H905 M1030,175 V108 H125 V175"; // save, check, SQLite, reads, recall
const L_CLEAN = 53 + 38 + 43 + 60 + 67 + 905 + 67;
const P_HELD = "M220,290 H273 M390,290 H428 M525,350 V398 M620,445 H755 V357"; // save, check, Held (waits), you approve, SQLite
const L_HELD_WAIT = 53 + 38 + 48, L_HELD = L_HELD_WAIT + 135 + 88;
const P_SECRET = "M220,290 H273 M390,290 H428 M525,230 V196"; // save, check, refused
const L_SECRET = 53 + 38 + 34;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="670" viewBox="0 0 1200 670" role="img" aria-labelledby="t d">
<title id="t">How Monomem works</title>
<desc id="d">Your AI agents (Claude Code, Codex, Cursor, Copilot, Gemini CLI, Zed) save through MCP or REST. A write check refuses secrets, and writes that match a known attack pattern are held for your review; only your approval stores them. Everything else goes into one SQLite file where each note keeps its writer, its history and its privacy label. Reads show pinned notes first at session start, hide private notes from limited apps, leave out distrusted writers, and show new notes' titles on your next message, so every agent's next session recalls what the others saved.</desc>
<style>
  svg{--bg:#F1F6F9;--panel:#FFFFFF;--ink:#12212C;--muted:#4A5D6B;--rule:#D9E3EA;--navy:#0B2E45;--ocean:#155F87;--gold:#F0C171;--goldt:#8A5A12;--held:#A23B2E;--heldbg:#FBEDEA;--dbbg:#E6F0F6;--onnavy:#FFFFFF}
  @media (prefers-color-scheme: dark){svg{--bg:#0B1A26;--panel:#102434;--ink:#EEF4F8;--muted:#A9BCCA;--rule:#2A4559;--navy:#0B2E45;--ocean:#4FA3D1;--goldt:#F0C171;--held:#E58A7E;--heldbg:#2E1C1E;--dbbg:#13304A}}
  .serif{font-family:'Libre Baskerville',Georgia,'Times New Roman',serif}
  text{font-family:'IBM Plex Sans','Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif;fill:var(--ink);font-size:14px}
  .h1{font-size:26px;font-weight:700}.sub{fill:var(--muted);font-size:14.5px}
  .h{font-size:17px;font-weight:700}.m{fill:var(--muted);font-size:13px}.s{font-size:13.5px}
  .lbl{font-size:12.5px;fill:var(--muted)}.gl{fill:var(--goldt);font-weight:700;font-size:13px}
  .w{fill:var(--onnavy)}.wm{fill:#C9DCE8;font-size:13.5px}.hr{fill:var(--held);font-weight:700}
  .box{fill:var(--panel);stroke:var(--rule);stroke-width:1.5}
  .edge{fill:none;stroke:var(--muted);stroke-width:2}.dash{stroke-dasharray:4 5}
  .dot{stroke:var(--bg);stroke-width:2.5}.ok{fill:var(--ocean)}.bad{fill:var(--held)}.sec{fill:var(--goldt)}
  .cap{font-size:14px;font-weight:600}
  .still{display:none}
  @media (prefers-reduced-motion: reduce){.anim{display:none}.still{display:inline}}
</style>
<defs>
  <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>
</defs>
<rect width="1200" height="670" fill="var(--bg)"/>
${txt(40, 52, "How Monomem works", "serif h1")}
${txt(40, 76, "One small Node process on your machine. Every note keeps who wrote it.", "sub")}

<!-- Monomem frame -->
<rect x="250" y="130" width="925" height="400" rx="18" fill="none" stroke="var(--rule)" stroke-width="1.5" stroke-dasharray="6 6"/>
${txt(270, 516, "MONOMEM · ONE SQLITE FILE, NO CLOUD", "lbl")}

<!-- edges -->
<path class="edge" d="M220,290 H273" marker-end="url(#a)"/>${txt(246, 280, "save", "lbl", "middle")}
<path class="edge" d="M390,290 H428" marker-end="url(#a)"/>
<path class="edge" d="M620,290 H663" marker-end="url(#a)"/>${txt(642, 280, "clean", "lbl", "middle")}
<path class="edge" d="M525,230 V196" marker-end="url(#a)"/>
<path class="edge" d="M525,350 V398" marker-end="url(#a)"/>${txt(535, 381, "matches a known attack pattern", "lbl")}
<path class="edge" d="M620,445 H755 V359" marker-end="url(#a)"/>${txt(686, 437, "you approve", "gl", "middle")}
<path class="edge" d="M845,290 H903" marker-end="url(#a)"/>
<path class="edge" d="M1030,175 V108 H125 V173" marker-end="url(#a)"/>
<path class="edge dash" d="M525,490 V573"/>



<!-- agents -->
<rect x="30" y="175" width="190" height="230" rx="14" fill="var(--navy)"/>
${txt(50, 207, "Your AI agents", "serif h w")}
${["Claude Code", "Codex", "Cursor", "Copilot", "Gemini CLI", "Zed and others"].map((s, i) => txt(50, 238 + i * 26, s, "wm")).join("\n")}

<!-- MCP / REST -->
<rect class="box" x="275" y="265" width="115" height="50" rx="25"/>
${txt(332, 295, "MCP · REST", "s", "middle")}

<!-- write check -->
<rect x="430" y="230" width="190" height="120" rx="12" fill="var(--panel)" stroke="var(--gold)" stroke-width="3"/>
${txt(525, 262, "Write check", "serif h", "middle")}
${txt(525, 290, "secrets: refused", "s", "middle")}
${txt(525, 312, "known attack patterns:", "s", "middle")}
${txt(525, 330, "held for your review", "s", "middle")}

<!-- refused -->
<rect x="440" y="158" width="170" height="36" rx="18" fill="var(--heldbg)" stroke="var(--held)" stroke-width="1.5"/>
${txt(525, 181, "Refused, not stored", "s hr", "middle")}
<rect class="anim" x="436" y="154" width="178" height="44" rx="22" fill="none" stroke="var(--held)" stroke-width="3" opacity="0">${showBetween(5.3, 6.3)}</rect>

<!-- held -->
<rect x="430" y="400" width="190" height="90" rx="12" fill="var(--heldbg)" stroke="var(--held)" stroke-width="2"/>
${txt(525, 430, "Held", "serif h", "middle")}
${txt(525, 452, "not readable by agents", "m", "middle")}
${txt(525, 472, "waits for your OK", "m", "middle")}
<rect class="anim" x="425" y="395" width="200" height="100" rx="15" fill="none" stroke="var(--held)" stroke-width="3" opacity="0">${showBetween(7.6, 10.0)}<animate attributeName="stroke-opacity" dur="1.2s" repeatCount="indefinite" values="1;0.25;1"/></rect>
<rect class="anim" x="640" y="422" width="92" height="22" rx="11" fill="var(--gold)" opacity="0">${showBetween(9.4, 10.6)}</rect>
<text class="anim" x="686" y="437" text-anchor="middle" style="font-size:13px;font-weight:700;fill:#12212C" opacity="0">you approve${showBetween(9.4, 10.6)}</text>

<!-- SQLite -->
<path d="M665,235 V345 A90,14 0 0 0 845,345 V235" fill="var(--dbbg)" stroke="var(--ocean)" stroke-width="2"/>
<ellipse cx="755" cy="235" rx="90" ry="14" fill="var(--dbbg)" stroke="var(--ocean)" stroke-width="2"/>
${txt(755, 278, "One SQLite file", "serif h", "middle")}
${txt(755, 302, "each note keeps its", "m", "middle")}
${txt(755, 320, "writer · history", "s", "middle")}
${txt(755, 338, "privacy label", "s", "middle")}

<!-- reads -->
<rect class="box" x="905" y="175" width="250" height="230" rx="14"/>
${txt(925, 205, "Reads", "serif h")}
${[["Pinned notes first", "at session start"], ["Private notes hidden", "from limited apps"], ["Distrusted writers", "left out"], ["New notes' titles", "on your next message"]]
  .map(([a, b], i) => `<circle cx="931" cy="${229 + i * 44}" r="3.5" fill="var(--ocean)"/>${txt(943, 234 + i * 44, a, "s")}${txt(943, 252 + i * 44, b, "m")}`).join("\n")}

<!-- you -->
<rect x="400" y="575" width="250" height="66" rx="14" fill="var(--panel)" stroke="var(--gold)" stroke-width="2"/>
${txt(525, 602, "You: dashboard and CLI", "serif h", "middle")}
${txt(525, 625, "approve · reject · distrust · roll back", "m", "middle")}
<rect class="anim" x="395" y="570" width="260" height="76" rx="17" fill="none" stroke="var(--gold)" stroke-width="3" opacity="0">${showBetween(9.4, 10.6)}</rect>

<!-- moving dots (on top; they jump across boxes) -->
<g class="anim">
  ${pulse("ok", P_CLEAN, L_CLEAN, [[4.2, L_CLEAN]], [0.01, 4.2])}
  ${pulse("sec", P_SECRET, L_SECRET, [[4.3, 0], [5.3, L_SECRET]], [4.3, 5.35])}
  ${pulse("bad", P_HELD, L_HELD, [[6.4, 0], [7.6, L_HELD_WAIT - 0.5], [10.0, L_HELD_WAIT - 0.5], [11.0, L_HELD]], [6.4, 11.0])}
</g>

<!-- recall label on the return path -->
<rect x="420" y="96" width="420" height="24" rx="12" fill="var(--bg)"/>
${txt(630, 113, "recall: every agent's next session knows what the others saved", "lbl", "middle")}

<!-- captions: one per loop step; a static legend replaces them under reduced motion -->
<g class="anim">
  <text x="690" y="600" class="cap" opacity="0"><tspan fill="var(--ocean)">●</tspan> A clean note is saved, then recalled by every agent${showBetween(0, 4.3)}</text>
  <text x="690" y="600" class="cap" opacity="0"><tspan fill="var(--goldt)">●</tspan> A write containing a secret is refused${showBetween(4.3, 6.4)}</text>
  <text x="690" y="600" class="cap" opacity="0"><tspan fill="var(--held)">●</tspan> A known attack pattern waits in Held${showBetween(6.4, 9.4)}</text>
  <text x="690" y="600" class="cap" opacity="0"><tspan fill="var(--held)">●</tspan> Stored only after you approve it${showBetween(9.4, 12)}</text>
</g>
<g class="still">${txt(690, 600, "Clean writes are stored; secrets refused; known attack patterns held until you approve.", "m")}</g>
${txt(690, 626, "The pattern check does not catch everything (see Known limits).", "m")}
</svg>
`;
writeFileSync("docs/monomem-architecture.svg", svg);
console.log("wrote docs/monomem-architecture.svg", svg.length, "bytes");
