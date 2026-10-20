#!/usr/bin/env bash
set -euo pipefail

# checkout must use fetch-depth: 0. Fetch the branch again after approval, too.
test "${GITHUB_EVENT_NAME}" = push
test "${GITHUB_REF_TYPE}" = tag
git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
tag_commit=$(git rev-parse "${GITHUB_REF}^{commit}")
test "$(git rev-parse HEAD)" = "$tag_commit"
git merge-base --is-ancestor "$tag_commit" refs/remotes/origin/main || {
  echo '::error::Tag commit is not in the trusted main history'
  exit 1
}
