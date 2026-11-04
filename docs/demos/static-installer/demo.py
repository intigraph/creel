"""Actual private fixture installation, with in-memory HTTPS responses."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

root = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('installer_fixtures', root / 'tests/test_installer.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
installer = fixtures.installer
data, release = fixtures.responses()


def fetch(url, limit):
    import json
    if url.startswith('https://api.github.com/repos/intigraph/creel/releases/'):
        return json.dumps(release).encode()
    if not url.startswith(fixtures.BASE):
        raise ValueError('unexpected fixture URL')
    return data[url[len(fixtures.BASE):]]


print('Target: private fixture; HTTPS responses in memory; no network, server or browser action')
with tempfile.TemporaryDirectory() as directory:
    private = Path(directory)
    with patch.dict(os.environ, {'HOME': str(private), 'PREFIX': str(private / 'creel'), 'VERSION': '0.1.1'}, clear=True), \
            patch.object(installer, 'fetch', fetch):
        print('$ VERSION=0.1.1 sh install.sh --prefix <private-root>/creel')
        with contextlib.redirect_stdout(io.StringIO()) as output:
            installer.install([])
        print(output.getvalue().replace(directory, '<private-root>'), end='')
        print('$ repeat installation into the same retained release')
        try:
            installer.install([])
        except ValueError as error:
            print('REFUSED: ' + str(error))
        else:
            raise AssertionError('existing release overwritten')
        assert (private / 'creel/releases/v0.1.1/version.txt').read_text() == '0.1.1'
        print('Retained version unchanged: 0.1.1')
        print('$ install with a changed archive into a new destination')
        data[fixtures.NAME + '.tar.gz'] += b'corrupt'
        try:
            installer.install(['--prefix', str(private / 'other')])
        except ValueError as error:
            print('REFUSED: ' + str(error))
        else:
            raise AssertionError('corrupt archive accepted')
        assert not (private / 'other').exists()
        print('No destination written for the corrupt archive')
