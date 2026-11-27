#!/bin/bash
cd /c/Users/danie/new-repos/onememory-wt/hardening
until grep -q "^done" bench/results/obedience/gptoss.log 2>/dev/null; do sleep 15; done
mv bench/results/obedience/drip-qwen.jsonl bench/results/obedience/drip-qwen-OLD-bare-bug.jsonl
node scripts/obedience-run.mjs bench/results/obedience/drip-served.json bench/results/obedience/drip-qwen.jsonl qwen2.5:7b 3 > bench/results/obedience/drip-qwen.log 2>&1
node scripts/obedience-run.mjs bench/results/obedience/drip-served.json bench/results/obedience/drip-gemma.jsonl gemma4:12b 3 > bench/results/obedience/drip-gemma.log 2>&1
echo ALLDONE > bench/results/obedience/alldone.flag
