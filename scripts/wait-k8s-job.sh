#!/bin/sh
# Report failed Jobs immediately instead of waiting only for Complete.
set -eu
: "${1:?Usage: wait-k8s-job.sh JOB_NAME}"
job_name=$1
elapsed=0
while [ "$elapsed" -lt 1250 ]; do
  conditions=$(kubectl --request-timeout=10s -n logbird get job "$job_name" -o 'jsonpath={range .status.conditions[*]}{.type}={.status}{"\n"}{end}')
  case "$conditions" in
    *Failed=True*) printf '%s\n' "Migration failed: $job_name; keep traffic fenced and preserve evidence." >&2; exit 1 ;;
    *Complete=True*) printf '%s\n' "Migration complete: $job_name"; exit 0 ;;
  esac
  sleep 5
  elapsed=$((elapsed + 5))
done
printf '%s\n' "Migration timed out: $job_name; keep traffic fenced." >&2
exit 1
