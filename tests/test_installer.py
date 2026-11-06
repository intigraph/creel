"""Exercise the Python payload embedded in the actual curl|sh entrypoint."""
import contextlib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'install.sh'
code = SCRIPT.read_text().split("<<'CREEL_INSTALL_PY'\n", 1)[1].rsplit('\nCREEL_INSTALL_PY', 1)[0]
installer = types.ModuleType('creel_installer')
exec(compile(code, str(SCRIPT), 'exec'), installer.__dict__)
BASE = 'https://github.com/intigraph/creel/releases/download/v0.1.1/'
NAME = 'creel-v0.1.1'


def bundle(extra=None, version='0.1.1'):
    stream = io.BytesIO()
    files = {'app/index.html': b'<html>', 'app/wasm/pkg/creel_quipu_provider_bg.wasm': b'wasm',
             'extension/manifest.json': b'{}', 'LICENSE': b'Apache',
             'THIRD_PARTY_NOTICES.md': b'MIT', 'version.txt': version.encode()}
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(NAME + '/' + name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        if extra:
            info, data = extra
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data) if info.isfile() else None)
    return gzip.compress(stream.getvalue())


def responses(archive=None):
    archive = archive or bundle()
    digest = lambda data: hashlib.sha256(data).hexdigest()
    provenance = json.dumps({'schema': 'creel.release/v1', 'version': '0.1.1',
                             'source_revision': 'a' * 40, 'archive_sha256': digest(archive)}).encode()
    data = {NAME + '.tar.gz': archive, NAME + '.provenance.json': provenance}
    data['SHA256SUMS'] = ''.join(digest(value) + '  ' + name + '\n' for name, value in data.items()).encode()
    release = {'tag_name': 'v0.1.1', 'draft': False, 'prerelease': False,
               'assets': [{'name': name, 'browser_download_url': BASE + name} for name in data]}
    return data, release


class InstallerTests(unittest.TestCase):
    def run_install(self, root, data, release, args=None):
        calls = []
        def fetch(url, limit):
            calls.append(url)
            if url.startswith('https://api.github.com/repos/intigraph/creel/releases/'):
                return json.dumps(release).encode()
            self.assertTrue(url.startswith(BASE), url)
            return data[url[len(BASE):]]
        with patch.dict(os.environ, {'HOME': str(root), 'VERSION': '', 'PREFIX': str(root / 'private')}, clear=True), \
                patch.object(installer, 'fetch', fetch), contextlib.redirect_stdout(io.StringIO()) as output:
            installer.install(args or [])
        return calls, output.getvalue()

    def test_private_static_install_and_no_clobber(self):
        data, release = responses()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, output = self.run_install(root, data, release)
            target = root / 'private/releases/v0.1.1'
            self.assertEqual((target / 'version.txt').read_text(), '0.1.1')
            self.assertIn('static bundle', output)
            self.assertIn('--bind 127.0.0.1', output)
            with self.assertRaisesRegex(ValueError, 'already exists'):
                self.run_install(root, data, release)
            self.assertEqual((target / 'app/index.html').read_bytes(), b'<html>')

    def test_dry_run_has_no_files_and_no_payload_download(self):
        data, release = responses()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            calls, _ = self.run_install(root, data, release, ['--dry-run'])
            self.assertEqual(len(calls), 1)
            self.assertEqual(list(root.iterdir()), [])

    def test_checksum_failure_writes_nothing(self):
        data, release = responses()
        data[NAME + '.tar.gz'] += b'corrupt'
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'checksum'):
                self.run_install(root, data, release)
            self.assertEqual(list(root.iterdir()), [])

    def test_unsafe_members_and_duplicate_refuse(self):
        for name, kind in [(NAME + '/../escape', tarfile.REGTYPE),
                           (NAME + '/link', tarfile.SYMTYPE),
                           (NAME + '/app/index.html', tarfile.REGTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                info = tarfile.TarInfo(name)
                info.type = kind
                info.linkname = '/outside'
                data, release = responses(bundle((info, b'bad')))
                with self.assertRaises(ValueError):
                    self.run_install(root, data, release)
                self.assertFalse((root / 'private/releases/v0.1.1').exists())
                self.assertFalse((root / 'private/releases/escape').exists())

    def test_payload_version_must_match(self):
        data, release = responses(bundle(version='0.0.0'))
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, 'version mismatch'):
                self.run_install(Path(temporary), data, release)

    def test_asset_origin_and_prerelease_refuse(self):
        for change in ['url', 'prerelease']:
            data, release = responses()
            if change == 'url':
                release['assets'][0]['browser_download_url'] = 'https://example.org/evil'
            else:
                release['prerelease'] = True
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                with self.assertRaises(ValueError):
                    self.run_install(root, data, release)
                self.assertEqual(list(root.iterdir()), [])

    def test_pin_and_provenance_are_bound(self):
        data, release = responses()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.dict(os.environ, {'VERSION': '../bad'}, clear=True):
                with self.assertRaisesRegex(ValueError, 'VERSION'):
                    installer.install(['--prefix', str(root)])
            bad = json.loads(data[NAME + '.provenance.json'])
            bad['archive_sha256'] = '0' * 64
            data[NAME + '.provenance.json'] = json.dumps(bad).encode()
            data['SHA256SUMS'] = ''.join(hashlib.sha256(value).hexdigest() + '  ' + name + '\n'
                                       for name, value in data.items() if name != 'SHA256SUMS').encode()
            with self.assertRaisesRegex(ValueError, 'provenance'):
                self.run_install(root, data, release)
            self.assertEqual(list(root.iterdir()), [])

    def test_expansion_limit_is_enforced(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(installer, 'LIMIT', 32):
            with self.assertRaisesRegex(ValueError, 'expanded archive'):
                installer.extract(bundle(), Path(temporary), '0.1.1')


if __name__ == '__main__':
    unittest.main()
