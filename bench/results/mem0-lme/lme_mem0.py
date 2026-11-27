"""Mem0 2.2.1 on LongMemEval-S (cleaned), session granularity, retrieval only. Same data file, same non-abstention question set as
`monomem bench --longmemeval --mode semantic --granularity session`. Local only: Ollama nomic-embed-text, Qdrant on disk, telemetry off.
infer=False (store the session text as given; the default infer=True would rewrite it through an LLM, see note in report).
usage: python lme_mem0.py DATA OUT.jsonl [LIMIT] [OFFSET]"""
import json, os, sys, shutil, tempfile, time
os.environ["MEM0_TELEMETRY"] = "False"
from mem0 import Memory
data_path, out_path = sys.argv[1], sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 10**9
offset = int(sys.argv[4]) if len(sys.argv) > 4 else 0
data = json.load(open(data_path, encoding="utf-8"))
qs = [q for q in data if not q["question_id"].endswith("_abs") and q.get("answer_session_ids")]
qs = qs[offset:offset + limit]
done = set()
if os.path.exists(out_path):
    done = {json.loads(l)["id"] for l in open(out_path, encoding="utf-8") if l.strip()}
turn = lambda t: f'{t.get("role","")}: {t.get("content","")}'
for qi, q in enumerate(qs):
    if q["question_id"] in done: continue
    t0 = time.time()
    folder = tempfile.mkdtemp(prefix="mem0lme-", dir="D:/mem0-bench/tmp") if os.path.isdir("D:/mem0-bench/tmp") else tempfile.mkdtemp(prefix="mem0lme-")
    try:
        mem = Memory.from_config({
            "llm": {"provider": "ollama", "config": {"model": "qwen2.5:7b", "temperature": 0, "ollama_base_url": "http://localhost:11434"}},
            "embedder": {"provider": "ollama", "config": {"model": "nomic-embed-text", "ollama_base_url": "http://localhost:11434"}},
            "vector_store": {"provider": "qdrant", "config": {"collection_name": "lme", "path": os.path.join(folder, "qdrant"), "embedding_model_dims": 768, "on_disk": True}},
            "history_db_path": os.path.join(folder, "history.db"),
        })
        ids = q["haystack_session_ids"]
        for sid, sess in zip(ids, q["haystack_sessions"]):
            mem.add("\n".join(turn(t) for t in sess), user_id="u", infer=False, metadata={"sid": sid})
        res = mem.search(q["question"], filters={"user_id": "u"}, top_k=20)
        hits = res["results"] if isinstance(res, dict) else res
        ranked = []
        for h in hits:
            s = (h.get("metadata") or {}).get("sid")
            if s and s not in ranked: ranked.append(s)
        gold = set(q["answer_session_ids"])
        rec = {"id": q["question_id"], "type": q.get("question_type"), "gold": sorted(gold), "ranked": ranked, "n_sessions": len(ids), "secs": round(time.time() - t0, 1)}
    except Exception as e:
        rec = {"id": q["question_id"], "error": repr(e)[:300]}
    finally:
        try: del mem
        except Exception: pass
        shutil.rmtree(folder, ignore_errors=True)
    open(out_path, "a", encoding="utf-8").write(json.dumps(rec) + "\n")
    print(qi, rec.get("secs"), rec.get("error", ""), flush=True)
