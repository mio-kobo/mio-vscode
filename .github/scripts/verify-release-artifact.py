#!/usr/bin/env python3
"""Validate the provenance of an existing tag build before downloading its VSIX."""
import argparse
import json
import os
import re
from pathlib import Path

REPOSITORY = 'mio-kobo/mio-vscode'
WORKFLOW = '.github/workflows/publish-vscode.yml'


def verify(run, jobs, artifacts, tag, sha, run_id):
    if not re.fullmatch(r'vscode-V(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', tag):
        raise ValueError('Expected a stable VS Code release tag')
    version = tag.removeprefix('vscode-V')
    expected = (run.get('id') == run_id and run.get('repository', {}).get('full_name') == REPOSITORY
                and run.get('path') == WORKFLOW and run.get('event') == 'push'
                and run.get('head_branch') == tag and run.get('head_sha') == sha
                and run.get('status') == 'completed')
    if not expected:
        raise ValueError('Artifact run does not match the trusted repository, workflow and immutable tag')
    builds = [job for job in jobs.get('jobs', []) if job.get('name') == 'build']
    if len(builds) != 1 or builds[0].get('conclusion') != 'success':
        raise ValueError('The original build job must have completed successfully')
    matches = [a for a in artifacts.get('artifacts', []) if a.get('name') == f'vscode-{version}']
    if len(matches) != 1:
        raise ValueError('Expected exactly one version-matching release artifact')
    artifact = matches[0]
    origin = artifact.get('workflow_run', {})
    if (artifact.get('expired') is not False or not isinstance(artifact.get('id'), int)
            or origin.get('id') != run_id or origin.get('head_sha') != sha
            or origin.get('repository_id') != run['repository'].get('id')):
        raise ValueError('Artifact is expired or belongs to another source run')
    return artifact['id']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--run-id', required=True, type=int)
    parser.add_argument('--metadata', required=True, type=Path)
    args = parser.parse_args()
    load = lambda name: json.loads((args.metadata / name).read_text())
    artifact_id = verify(load('run.json'), load('jobs.json'), load('artifacts.json'), args.tag, args.sha, args.run_id)
    print(f'Validated original build run {args.run_id}, tag {args.tag}, artifact {artifact_id}')
    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a') as stream:
            stream.write(f'artifact_id={artifact_id}\n')


if __name__ == '__main__':
    main()
