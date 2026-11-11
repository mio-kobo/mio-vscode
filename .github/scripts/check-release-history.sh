#!/usr/bin/env bash
set -euo pipefail

# A manual retry must use trusted workflow code from main and an existing stable
# tag. Both routes require the exact tag commit in trusted main history.
case "${GITHUB_EVENT_NAME}" in
  push)
    test "${GITHUB_REF_TYPE}" = tag
    tag_ref="${GITHUB_REF}"
    ;;
  workflow_dispatch)
    test "${GITHUB_REF_TYPE}" = branch
    test "${GITHUB_REF}" = refs/heads/main
    if ! [[ "${RELEASE_TAG:-}" =~ ^vscode-V[0-9]+\.[0-9]+\.[0-9]+$ ]]; then exit 1; fi
    tag_ref="refs/tags/${RELEASE_TAG}"
    ;;
  *) exit 1 ;;
esac

git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
tag_commit=$(git rev-parse "${tag_ref}^{commit}")
git merge-base --is-ancestor "$tag_commit" refs/remotes/origin/main || {
  echo '::error::Tag commit is not in the trusted main history'
  exit 1
}
if [ "${GITHUB_EVENT_NAME}" = workflow_dispatch ]; then
  git checkout --detach "$tag_commit"
fi
test "$(git rev-parse HEAD)" = "$tag_commit"
