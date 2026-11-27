# Extract prompt strings from garak probe classes WITHOUT any model or generator. Offline (HF/transformers offline flags set).
# Run: D:\security-lab\venv-garak\Scripts\python -X utf8 -I scripts/redteam-garak-gen.py out.jsonl summary.json
# Rule (fixed, not tuned): per probe class take up to PER_PROBE prompts at evenly spaced indexes; drop dupes; then round-robin
# across modules up to CAP so every module gets an even share. Probes that fail to build offline are listed as skipped.
import os, sys, json, importlib, inspect, signal, traceback, threading
os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1", "NO_PROXY": "*", "TOKENIZERS_PARALLELISM": "false"})
MODULES = ["encoding", "promptinject", "latentinjection", "dan", "goodside", "suffix", "smuggling", "exploitation", "ansiescape", "badchars",
           "leakreplay", "web_injection", "fileformats", "sysprompt_extraction", "apikey", "glitch", "grandma", "doctor", "phrasing", "misleading", "divergence", "continuation", "tap"]
PER_PROBE, CAP, TIMEOUT = 6, 1500, 60
from garak import _config
_config.load_base_config()
_config.plugins.probes = getattr(_config.plugins, "probes", {})
out, skipped, built = {}, {}, {}

def prompt_text(p):
    if isinstance(p, str): return p
    try:  # garak Conversation / Message objects
        return p.last_message().text
    except Exception:
        pass
    t = getattr(p, "text", None)
    return t if isinstance(t, str) else None

def build(cls, q):
    try:
        q.append(cls())
    except BaseException as e:
        q.append(e)

for m in MODULES:
    try:
        mod = importlib.import_module(f"garak.probes.{m}")
    except BaseException as e:
        skipped[m] = "import: " + repr(e)[:150]; continue
    for name, cls in inspect.getmembers(mod, inspect.isclass):
        if cls.__module__ != mod.__name__ or name.startswith("_"): continue
        if not hasattr(cls, "probe") or getattr(cls, "active", True) is False and False: continue
        key = f"{m}.{name}"
        q = []
        th = threading.Thread(target=build, args=(cls, q), daemon=True); th.start(); th.join(TIMEOUT)
        if not q or isinstance(q[0], BaseException):
            skipped[key] = ("timeout" if not q else repr(q[0])[:150]); continue
        pr = getattr(q[0], "prompts", None)
        if not pr: skipped[key] = "no .prompts"; continue
        texts = []
        for p in pr:
            t = prompt_text(p)
            if t and t.strip(): texts.append(t)
        texts = list(dict.fromkeys(texts))
        if not texts: skipped[key] = "no text prompts"; continue
        n = len(texts); step = max(1, n // PER_PROBE)
        pick = texts[::step][:PER_PROBE]
        built[key] = n
        for i, t in enumerate(pick):
            out.setdefault(m, []).append({"tool": "garak", "family": key, "text": t[:6000]})

chosen, idx = [], {k: 0 for k in out}
while len(chosen) < CAP and any(idx[k] < len(out[k]) for k in out):
    for k in out:
        if idx[k] < len(out[k]) and len(chosen) < CAP:
            chosen.append(out[k][idx[k]]); idx[k] += 1
for n, x in enumerate(chosen): x["id"] = f"garak-{n:04d}"
with open(sys.argv[1], "w", encoding="utf-8") as f:
    for x in chosen: f.write(json.dumps(x, ensure_ascii=False) + "\n")
json.dump({"built_probe_classes": built, "skipped": skipped, "modules_used": {k: idx[k] for k in out}, "total": len(chosen)}, open(sys.argv[2], "w"), indent=1)
print(len(chosen), "prompts;", len(built), "probe classes built;", len(skipped), "skipped")
os._exit(0)
