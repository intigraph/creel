#!/bin/sh
# A static bundle installer: no services, browser state or extension enrollment.
set -eu
command -v python3 >/dev/null 2>&1 || { echo 'creel: Python 3.9+ is required' >&2; exit 1; }
exec python3 - "$@" <<'CREEL_INSTALL_PY'
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import sys
import tarfile
import tempfile
import urllib.request

REPO = 'intigraph/creel'
SEMVER = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
LIMIT = 64 * 1024 * 1024


def fetch(url, limit):
    request = urllib.request.Request(url, headers={'User-Agent': 'creel-installer'})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('download exceeds size limit')
    return data


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checksum(manifest, name, data):
    matches = []
    for line in manifest.decode('ascii').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        if not match:
            raise ValueError('invalid SHA256SUMS line')
        if match[2] == name:
            matches.append(match[1])
    if matches != [digest(data)]:
        raise ValueError('missing, duplicate or mismatched checksum: ' + name)


def extract(archive, stage, version):
    root = 'creel-v' + version
    seen = set()
    total = 0
    # Decompress into a bounded buffer before tar parsing, including PAX headers.
    import gzip
    with gzip.GzipFile(fileobj=io.BytesIO(archive)) as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError('expanded archive exceeds size limit')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as bundle:
        for member in bundle:
            parts = PurePosixPath(member.name).parts
            if (not parts or parts[0] != root or '..' in parts
                    or member.name.startswith('/') or '\\' in member.name
                    or any(ord(c) < 32 for c in member.name)
                    or not (member.isfile() or member.isdir())):
                raise ValueError('unsafe archive member')
            relative = Path(*parts[1:])
            key = relative.as_posix()
            if key in seen or len(seen) >= 10000:
                raise ValueError('duplicate member or too many members')
            seen.add(key)
            total += member.size
            if total > LIMIT:
                raise ValueError('archive payload exceeds size limit')
            destination = stage / relative
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = bundle.extractfile(member)
                with source, destination.open('xb') as output:
                    shutil.copyfileobj(source, output)
    required = ['app/index.html', 'app/wasm/pkg/creel_quipu_provider_bg.wasm',
                'extension/manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'version.txt']
    if not all((stage / name).is_file() for name in required):
        raise ValueError('release payload is incomplete')
    if (stage / 'version.txt').read_text().strip() != version:
        raise ValueError('release payload version mismatch')


def install(argv=None):
    if sys.version_info < (3, 9):
        raise ValueError('Python 3.9+ is required')
    parser = argparse.ArgumentParser(description='Install a verified creel static release; never starts it')
    parser.add_argument('--prefix', default=os.environ.get('PREFIX', str(Path.home() / '.local/share/creel')))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    version = os.environ.get('VERSION', '')
    if version and not re.fullmatch(SEMVER, version):
        raise ValueError('VERSION must be a stable version such as 0.1.1 (no v prefix)')
    endpoint = 'tags/v' + version if version else 'latest'
    release = json.loads(fetch('https://api.github.com/repos/' + REPO + '/releases/' + endpoint, 1024 * 1024))
    tag = release['tag_name']
    if release.get('draft') or release.get('prerelease') or not re.fullmatch('v' + SEMVER, tag):
        raise ValueError('a published stable release is required')
    if version and tag != 'v' + version:
        raise ValueError('release tag mismatch')
    version = tag[1:]
    name = 'creel-v' + version
    base = 'https://github.com/' + REPO + '/releases/download/' + tag + '/'
    names = [name + '.tar.gz', name + '.provenance.json', 'SHA256SUMS']
    for asset in names:
        matches = [a for a in release['assets'] if a['name'] == asset]
        if len(matches) != 1 or matches[0]['browser_download_url'] != base + asset:
            raise ValueError('missing or unexpected release asset: ' + asset)
    target = Path(args.prefix).expanduser().absolute() / 'releases' / tag
    if args.dry_run:
        print('Would verify SHA256SUMS and install creel ' + version + ' to ' + str(target))
        return
    os.umask(0o077)
    manifest = fetch(base + 'SHA256SUMS', 65536)
    provenance_bytes = fetch(base + name + '.provenance.json', 65536)
    archive = fetch(base + name + '.tar.gz', LIMIT)
    checksum(manifest, name + '.provenance.json', provenance_bytes)
    checksum(manifest, name + '.tar.gz', archive)
    provenance = json.loads(provenance_bytes)
    if (provenance.get('schema') != 'creel.release/v1'
            or provenance.get('version') != version
            or provenance.get('archive_sha256') != digest(archive)
            or not re.fullmatch(r'[0-9a-f]{40}', provenance.get('source_revision', ''))):
        raise ValueError('provenance does not bind this release')
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        raise ValueError('destination already exists; retained releases are never overwritten')
    stage = Path(tempfile.mkdtemp(prefix='.creel-', dir=target.parent))
    try:
        extract(archive, stage, version)
        # mkdir is the no-clobber claim; a concurrent installer must not replace it.
        target.mkdir()
        try:
            for child in stage.iterdir():
                child.rename(target / child.name)
        except BaseException:
            shutil.rmtree(target)
            raise
    finally:
        shutil.rmtree(stage)
    print('Installed creel ' + version + ' (static bundle, source ' + provenance['source_revision'] + ')')
    print('Serve explicitly: python3 -m http.server 8420 --bind 127.0.0.1 --directory '
          + shlex.quote(str(target / 'app')))
    print('Extension (manual browser opt-in): ' + str(target / 'extension'))


if __name__ == '__main__':
    try:
        install()
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print('creel install failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
CREEL_INSTALL_PY
