#!/bin/sh
# Monomem launcher. Runs the bundled official Node runtime with Monomem's code in this folder.
# App settings and hooks name runtime/node and dist/src/cli.js here; this folder never moves.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
exec "$here/runtime/node" "$here/dist/src/cli.js" "$@"
