const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const url of ["http://localhost:11434/v1/embeddings", "http://127.0.0.1:11434/v1/embeddings"]) {
  const a = [];
  for (let i = 0; i < 25; i++) { const t = performance.now(); const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "nomic-embed-text", input: "query number " + i + " about databases" }) }); await r.json(); a.push(performance.now() - t); }
  console.log(url, "median", med(a).toFixed(1), "min", Math.min(...a).toFixed(1), "max", Math.max(...a).toFixed(1), "first", a[0].toFixed(1));
}
