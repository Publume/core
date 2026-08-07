#!/usr/bin/env bash

set -euo pipefail

branch="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
token="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
authorization="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"

authenticated_git() {
  GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0='http.https://github.com/.extraHeader' \
    GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $authorization" \
    git "$@"
}

for attempt in 1 2 3; do
  authenticated_git fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  git rebase "refs/remotes/origin/$branch"
  if authenticated_git push origin "HEAD:refs/heads/$branch"; then
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "Push attempt $attempt failed after a concurrent update; retrying." >&2
  fi
done

echo 'Unable to push after three attempts.' >&2
exit 1
