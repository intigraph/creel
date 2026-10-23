#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const PAYLOAD = ['app', 'extension', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'RELEASE.md', 'version.txt'];
const REQUIRED = [
  'app/index.html', 'app/thread.html', 'app/sw.js', 'app/manifest.webmanifest',
  'app/wasm/pkg/creel_quipu_provider.js', 'app/wasm/pkg/creel_quipu_provider_bg.wasm',
  'extension/manifest.json', 'extension/background.js', 'extension/creel-connector.js',
  'extension/creel-locator.js', 'extension/popup.html', 'extension/popup.js',
  'extension/popup.css', 'extension/icons/icon-128.png',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'RELEASE.md', 'version.txt',
];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (root, args, encoding = 'utf8', input) => execFileSync('git', ['-C', root, ...args], {
  encoding, input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
});

function packageRelease(root, output) {
  root = fs.realpathSync(root);
  output = path.resolve(output);
  output = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  if (output === root || output.startsWith(root + path.sep)) {
    throw new Error('release output must be outside the source tree');
  }
  if (fs.existsSync(output)) throw new Error('retained output exists; reconcile it before rebuilding');
  if (git(root, ['status', '--porcelain', '--untracked-files=all']).trim()) {
    throw new Error('release source must be a clean committed checkout');
  }
  const revision = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('invalid source revision');
  const entries = git(root, ['ls-tree', '-r', '-z', revision, '--', ...PAYLOAD])
    .split('\0').filter(Boolean).map((line) => {
      const match = /^(100644|100755) blob [0-9a-f]{40}\t([^\n\r]+)$/.exec(line);
      if (!match) throw new Error('release payload contains a link or non-regular member');
      return match[2];
    });
  for (const name of REQUIRED) {
    if (!entries.includes(name)) throw new Error('missing tracked release member: ' + name);
  }
  const attributes = git(root, ['check-attr', '--cached', '-z', '--stdin', 'export-ignore', 'export-subst'],
    'utf8', entries.join('\0') + '\0').split('\0').filter(Boolean);
  if (attributes.length !== entries.length * 6
      || attributes.some((value, index) => index % 3 === 2 && !['unspecified', 'unset'].includes(value))) {
    throw new Error('archive attributes may omit or rewrite release members');
  }
  const version = git(root, ['show', revision + ':version.txt']).trim();
  if (!VERSION.test(version)) throw new Error('release version must be an exact stable semver');
  const extension = JSON.parse(git(root, ['show', revision + ':extension/manifest.json']));
  if (!VERSION.test(extension.version)) throw new Error('invalid extension version');
  const name = 'creel-v' + version;
  const archiveName = name + '.tar.gz';
  const tar = git(root, ['archive', '--format=tar', '--prefix=' + name + '/', revision, '--', ...PAYLOAD], null);
  const archive = zlib.gzipSync(tar, { level: 9 });
  const provenance = Buffer.from(JSON.stringify({
    schema: 'creel.release/v1', version, source_revision: revision,
    extension_version: extension.version, archive_sha256: digest(archive), file_count: entries.length,
  }, null, 2) + '\n');
  const files = { [archiveName]: archive, [name + '.provenance.json']: provenance };
  const checksums = Object.keys(files).sort().map((file) => digest(files[file]) + '  ' + file + '\n').join('');
  fs.mkdirSync(output, { recursive: true });
  for (const [file, bytes] of Object.entries(files)) fs.writeFileSync(path.join(output, file), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), checksums, { flag: 'wx' });
  return { version, source_revision: revision, archive: archiveName, output };
}

module.exports = { packageRelease, digest, VERSION, REQUIRED };
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node tools/package-release.js <new-output-directory>');
    console.log(JSON.stringify(packageRelease(path.join(__dirname, '..'), process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
