#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { digest, VERSION } = require('./package-release.js');
const REPOSITORY = 'intigraph/creel';
const gh = (args) => execFileSync('gh', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024,
});

function publishRelease(output, identity, run = gh) {
  if (identity.repository !== REPOSITORY || !/^v\d+\.\d+\.\d+$/.test(identity.tag || '')
      || !/^[0-9a-f]{40}$/.test(identity.revision || '')) {
    throw new Error('canonical repository, stable tag and exact source revision required');
  }
  const version = identity.tag.slice(1);
  if (!VERSION.test(version)) throw new Error('invalid release tag');
  const stem = 'creel-' + identity.tag;
  const names = [stem + '.tar.gz', stem + '.provenance.json', 'SHA256SUMS'];
  if (fs.readdirSync(output).sort().join('\0') !== [...names].sort().join('\0')) {
    throw new Error('unexpected or missing release output');
  }
  const bytes = {};
  for (const name of names) {
    const file = path.join(output, name);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('unsafe output member');
    bytes[name] = fs.readFileSync(file);
  }
  const proof = JSON.parse(bytes[stem + '.provenance.json']);
  if (proof.schema !== 'creel.release/v1' || proof.version !== version
      || proof.source_revision !== identity.revision
      || proof.archive_sha256 !== digest(bytes[stem + '.tar.gz'])) {
    throw new Error('release source/version/archive provenance mismatch');
  }
  const sums = names.filter((name) => name !== 'SHA256SUMS').sort()
    .map((name) => digest(bytes[name]) + '  ' + name + '\n').join('');
  if (bytes.SHA256SUMS.toString() !== sums) throw new Error('release checksum manifest mismatch');
  const api = (route) => JSON.parse(run(['api', 'repos/' + REPOSITORY + '/' + route]));
  const checkCommit = () => {
    if (api('commits/' + identity.tag).sha !== identity.revision) throw new Error('remote release tag moved or names another source');
  };
  const view = () => {
    // releases/tags/<tag> never returns drafts, so find the draft in the full list.
    const found = run(['api', 'repos/' + REPOSITORY + '/releases', '--paginate',
      '--jq', '.[] | select(.tag_name == "' + identity.tag + '")']).trim();
    if (!found) throw new Error('no release found for ' + identity.tag);
    const release = JSON.parse(found);
    if (release.tag_name !== identity.tag || !Number.isInteger(release.id)
        || typeof release.draft !== 'boolean' || !Array.isArray(release.assets)
        || release.assets.length > names.length
        || new Set(release.assets.map((asset) => asset.name)).size !== release.assets.length
        || release.assets.some((asset) => !names.includes(asset.name))) {
      throw new Error('unrecognized release identity or assets');
    }
    return release;
  };
  const verifyAsset = (name, release) => {
    const asset = release.assets.find((item) => item.name === name);
    if (!asset || asset.size !== bytes[name].length) throw new Error('missing or conflicting release asset: ' + name);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'creel-release-readback-'));
    try {
      run(['release', 'download', identity.tag, '--repo', REPOSITORY, '--pattern', name, '--dir', folder]);
      if (digest(fs.readFileSync(path.join(folder, name))) !== digest(bytes[name])) {
        throw new Error('release asset readback mismatch: ' + name);
      }
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  };
  const verifiedPublished = (release) => {
    for (const name of names) verifyAsset(name, release);
    checkCommit();
    return { status: 'VERIFIED_PUBLISHED', tag: identity.tag, source_revision: identity.revision };
  };
  checkCommit();
  let release = view(); // A draft and its tag must already exist; this tool never creates either.
  if (!release.draft) return verifiedPublished(release);
  for (const name of names) {
    checkCommit();
    release = view();
    if (!release.draft) return verifiedPublished(release);
    if (!release.assets.some((asset) => asset.name === name)) {
      try { run(['release', 'upload', identity.tag, path.join(output, name), '--repo', REPOSITORY]); }
      catch (error) {
        // A lost response can follow a committed upload. Read back; never clobber or blindly retry.
        release = view();
        if (!release.assets.some((asset) => asset.name === name)) throw error;
      }
    }
    verifyAsset(name, view());
  }
  release = view();
  for (const name of names) verifyAsset(name, release);
  checkCommit();
  if (release.draft) {
    try { run(['release', 'edit', identity.tag, '--repo', REPOSITORY, '--draft=false', '--title', 'Creel ' + identity.tag]); }
    catch (error) { if (view().draft) throw error; }
  }
  release = view();
  if (release.draft) throw new Error('release publication remains unverified');
  return verifiedPublished(release);
}

module.exports = { publishRelease };
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node tools/publish-release.js <verified-output-directory>');
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    console.log(JSON.stringify(publishRelease(process.argv[2], {
      repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG, revision,
    })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
