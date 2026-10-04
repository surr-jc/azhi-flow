#!/usr/bin/env bash
# Spike 1: time a fresh team install (PostgreSQL + Temporal) from nothing to healthy.
# Uses a throwaway compose project and volumes so it measures a cold start.
# Image pulls are timed separately: on a fresh host they dominate.
set -euo pipefail
cd "$(dirname "$0")/.."
export AZHI_PG_PORT=${AZHI_PG_PORT:-55432} AZHI_TEMPORAL_PORT=${AZHI_TEMPORAL_PORT:-57233}
project="azhi-install-spike-$$"
compose=(docker compose -p "$project" -f deploy/docker-compose.yml)
trap '"${compose[@]}" down -v >/dev/null 2>&1 || true' EXIT

t0=$(date +%s)
"${compose[@]}" pull -q
t1=$(date +%s)
"${compose[@]}" up -d --wait >/dev/null
t2=$(date +%s)
echo "image pull:            $((t1 - t0))s"
echo "cold start to healthy: $((t2 - t1))s"
echo "total:                 $((t2 - t0))s (budget 900s)"
echo "host: $(nproc) CPU, $(free -g | awk '/Mem:/{print $2}') GiB RAM, $(uname -sr)"
