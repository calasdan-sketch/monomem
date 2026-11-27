#!/bin/bash
cd /c/Users/danie/new-repos/onememory-wt/hardening; cd bench/results/obedience; cd ../../..
until grep -q "^done" bench/results/obedience/qwen.log; do sleep 10; done
node scripts/obedience-run.mjs bench/results/obedience/served.json bench/results/obedience/gemma.jsonl gemma4:12b 2 > bench/results/obedience/gemma.log 2>&1
node scripts/obedience-run.mjs bench/results/obedience/served.json bench/results/obedience/gptoss.jsonl gpt-oss-20b-parked:latest 1 > bench/results/obedience/gptoss.log 2>&1
