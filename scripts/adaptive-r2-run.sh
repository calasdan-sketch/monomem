#!/bin/sh
# Round 2: same experiment as adaptive-run-all.sh, fresh cache, seeded (seed + call counter). Usage: sh scripts/adaptive-r2-run.sh <model> [cache]
M=${1:-qwen2.5:7b}
C=${2:-bench/results/adaptive-r2-cache.json}
node scripts/adaptive-attacker-r2.mjs --model "$M" --mode adaptive --budget 25 --deadline-min 70 --cache $C
node scripts/adaptive-attacker-r2.mjs --model "$M" --mode blind --deadline-min 40 --cache $C
