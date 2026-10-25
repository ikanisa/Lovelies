#!/usr/bin/env python3
"""Stage only Lovelies' public-information files; never deploy or replace a host."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile


def prepare(root: Path, output: Path) -> None:
    sources = {
        name: root / 'web' / name for name in (
            'index.html', 'privacy/index.html', 'terms/index.html',
            'account-deletion/index.html', 'support/index.html', 'site.css',
            'assets/wordmark.png', 'assets/photo-heart.png',
            '_headers', '_redirects', 'robots.txt',
        )
    }
    for name in ('apple-app-site-association', 'assetlinks.json'):
        source = root / 'docs/release/website-associations' / name
        json.loads(source.read_text())
        sources['.well-known/' + name] = source
    if any(not source.is_file() or source.is_symlink() for source in sources.values()):
        raise ValueError('Expected regular public source files are missing')
    if output.exists() or output.is_symlink():
        raise ValueError('Choose a new output directory; existing artifacts are preserved')
    output.mkdir(parents=True)
    public = output / 'public'
    manifest = {}
    for name, source in sources.items():
        target = public / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        content = target.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if digest != hashlib.sha256(source.read_bytes()).hexdigest():
            raise ValueError('Public source changed during staging: ' + name)
        manifest[name] = {'source': str(source), 'sha256': digest, 'bytes': len(content)}
    archive = output / 'lovelies-public-information.zip'
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as package:
        for name in sorted(manifest):
            package.write(public / name, name)
    with zipfile.ZipFile(archive) as package:
        if set(package.namelist()) != set(manifest):
            raise ValueError('Unexpected file in public archive')
        for name, item in manifest.items():
            if hashlib.sha256(package.read(name)).hexdigest() != item['sha256']:
                raise ValueError('Archive differs from staged file: ' + name)
    result = {
        'status': 'public_allowlist_staged_no_deployment',
        'content_status': json.loads((root / 'web/site.config.json').read_text())['content_status'],
        'files': manifest,
        'archive': str(archive),
        'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'excluded': ['repository', 'credentials', 'verification', 'README', 'site.config.json', 'local-checks.json'],
        'limits': 'Staging does not publish policy, prove a mailbox, configure associations or authorize app access.',
    }
    (output / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'archive': str(archive), 'files': len(manifest), 'sha256': result['archive_sha256']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    prepare(Path(__file__).resolve().parents[1], arguments.output.resolve())
