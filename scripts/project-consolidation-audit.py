#!/usr/bin/env python3
"""Preserve pinned source histories and report merge conflicts without changing them.

Only a disposable bare repository is written. The source checkout, its refs and
its index are not modified. A clean textual merge is not application acceptance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any


def run(args: list[str], *, cwd: Path, env: dict[str, str] | None = None,
        allowed: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, timeout=600)
    if result.returncode not in allowed:
        raise RuntimeError(f"Command failed ({result.returncode}): {args[0]} "
                           f"{result.stderr.decode('utf-8', 'replace').strip()}")
    return result


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n', encoding='utf-8')


def audit(repo: Path, output: Path, commits: dict[str, str]) -> dict[str, Any]:
    repo, output = repo.resolve(), output.resolve()
    if output == repo or repo in output.parents:
        raise ValueError('Use an output directory outside the source checkout.')
    if output.exists() and any(output.iterdir()):
        raise ValueError('Output directory must be empty; existing evidence is never overwritten.')
    for label, sha in commits.items():
        if not re.fullmatch(r'[0-9a-f]{40}', sha):
            raise ValueError(f'{label} must be a complete lowercase 40-character commit SHA.')
        if run(['git', 'cat-file', '-t', sha], cwd=repo).stdout.strip() != b'commit':
            raise ValueError(f'{label} is not a commit.')
    object_dir = Path(run(['git', 'rev-parse', '--git-path', 'objects'], cwd=repo)
                      .stdout.decode().strip())
    if not object_dir.is_absolute():
        object_dir = (repo / object_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Isolate merge configuration and object writes from the user's repository.
    with tempfile.TemporaryDirectory(prefix='lovelies-source-audit-') as temporary:
        bare = Path(temporary) / 'audit.git'
        run(['git', 'init', '--bare', str(bare)], cwd=Path(temporary))
        env = os.environ.copy()
        for key in list(env):
            if key.startswith('GIT_'):
                env.pop(key)
        env.update({'GIT_ALTERNATE_OBJECT_DIRECTORIES': str(object_dir),
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                    'GIT_TERMINAL_PROMPT': '0'})

        def git(*args: str, allowed: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[bytes]:
            return run(['git', '--git-dir', str(bare), '-c', 'core.hooksPath=' + os.devnull,
                        *args], cwd=Path(temporary), env=env, allowed=allowed)

        for label, sha in commits.items():
            git('update-ref', 'refs/heads/audit-' + label, sha)
        main, candidate, base = commits['main'], commits['candidate'], commits['base']
        actual_bases = git('merge-base', '--all', main, candidate, allowed=(0, 1)).stdout.decode().split()
        if actual_bases != [base]:
            raise ValueError(f'Unexpected merge base(s): {actual_bases}; expected {base}.')
        merge = git('merge-tree', '--write-tree', '--name-only', '--no-messages', '-z',
                    main, candidate, allowed=(0, 1))
        fields = merge.stdout.split(b'\0')
        tree = fields[0].decode('ascii').strip()
        if not re.fullmatch(r'[0-9a-f]{40}', tree):
            raise RuntimeError('Unexpected merge-tree output; no mergeability claim made.')
        conflicts = [p.decode('utf-8') for p in fields[1:] if p]
        def changes(sha: str) -> set[str]:
            return {p.decode('utf-8') for p in git('diff', '--name-only', '--no-renames',
                                                  '-z', base, sha).stdout.split(b'\0') if p}
        inventory: dict[str, Any] = {}
        for label, sha in commits.items():
            entries = []
            for entry in git('ls-tree', '-r', '-z', '--full-tree', sha).stdout.split(b'\0'):
                if not entry:
                    continue
                header, path = entry.split(b'\t', 1)
                mode, kind, oid = header.decode('ascii').split()
                entries.append({'path': path.decode('utf-8'), 'mode': mode,
                                'type': kind, 'git_object_sha1': oid})
            inventory[label] = {'commit': sha, 'entry_count': len(entries), 'entries': entries}
        manifest = output / 'source-manifest.json'
        write_json(manifest, inventory)
        bundle = output / 'Lovelies-project-history.bundle'
        git('bundle', 'create', str(bundle), *['refs/heads/audit-' + label for label in commits])
        git('bundle', 'verify', str(bundle))
        integrated = git('merge-base', '--is-ancestor', candidate, main, allowed=(0, 1)).returncode == 0
        report = {
            'schema_version': 1, 'repository': 'ikanisa/Lovelies', 'commits': commits,
            'merge_base': base, 'candidate_ancestor_of_main': integrated,
            'textual_merge_clean': merge.returncode == 0, 'conflict_paths': sorted(conflicts),
            'overlapping_changed_paths': sorted(changes(main) & changes(candidate)),
            'source_manifest_sha256': digest(manifest), 'history_bundle_sha256': digest(bundle),
            'application_tests_run': False, 'production_acceptance': False,
            'scope': 'Pinned Git histories only. Not an inventory of inaccessible chat attachments or owner-local files.',
            'limits': ['Textual mergeability does not establish semantic compatibility.',
                       'LFS payloads and submodule repositories are not fetched; the Git object history is preserved.',
                       'No branch, checkout, application, database, provider or deployment is changed.'],
        }
        write_json(output / 'consolidation-report.json', report)
        return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path('.'))
    parser.add_argument('--output', type=Path, required=True)
    for name in ('base', 'main', 'candidate'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--export', dest='export_commit')
    args = parser.parse_args()
    commits = {'base': args.base, 'main': args.main, 'candidate': args.candidate}
    if args.export_commit:
        commits['export'] = args.export_commit
    try:
        report = audit(args.repo, args.output, commits)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        parser.exit(2, f'Audit failed: {error}\n')
    print(json.dumps({key: report[key] for key in ('commits', 'textual_merge_clean',
                     'candidate_ancestor_of_main', 'conflict_paths', 'overlapping_changed_paths',
                     'history_bundle_sha256', 'application_tests_run', 'production_acceptance')}, indent=2))
    # Successful reporting is not a successful merge. The JSON fields carry that distinction.
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
