#!/bin/bash
cd /c/Users/danie/new-repos/onememory-wt/hardening
M=$1; T=$2
node scripts/obedience-claude.mjs bench/results/obedience/served.json bench/results/obedience/claude-$T.jsonl $M 1 > bench/results/obedience/claude-$T.log 2>&1
node scripts/obedience-claude.mjs bench/results/obedience/drip-served.json bench/results/obedience/claude-drip-$T.jsonl $M 1 > bench/results/obedience/claude-drip-$T.log 2>&1
echo done > bench/results/obedience/claude-$T.flag
