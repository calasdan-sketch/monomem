#!/bin/sh
# Full run: adaptive (<=70 min), blind (<=30 min), owner terminal (<=10 min). One LLM request at a time. Results cached in bench/results/.
M=${1:-qwen2.5:7b}
C=bench/results/adaptive-cache.json
node scripts/adaptive-attacker.mjs --model "$M" --mode adaptive --budget 25 --deadline-min 70 --cache $C
node scripts/adaptive-attacker.mjs --model "$M" --mode blind --deadline-min 30 --cache $C
node scripts/adaptive-attacker.mjs --model "$M" --mode owner --budget 2 --deadline-min 10 --cache $C
