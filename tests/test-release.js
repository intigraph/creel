/* Real Git/archive fixtures and a private release transport; never calls GitHub. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { packageRelease, REQUIRED } = require('../tools/package-release.js');
const { publishRelease } = require('../tools/publish-release.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'creel-release-tests-'));
let sequence = 0;
let passed = 0;

function fixture() {
  const folder = path.join(temporary, String(++sequence));
  const root = path.join(folder, 'source');
  fs.mkdirSync(root, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  git('init', '-q');
  git('config', 'user.name', 'Release fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  for (const name of REQUIRED) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), 'committed fixture: ' + name + '\n');
  }
  fs.writeFileSync(path.join(root, 'version.txt'), '0.1.0\n');
  fs.writeFileSync(path.join(root, 'extension/manifest.json'), JSON.stringify({ version: '0.4.0' }));
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); };
  commit();
  const output = path.join(folder, 'output');
  return { folder, root, output, git, commit, build: () => packageRelease(root, output) };
}

function transport(output, revision, options = {}) {
  const assets = new Map();
  const state = { draft: true, revision, uploads: [], edits: 0, reads: 0, calls: 0 };
  const snapshot = () => ({
    id: 42, tag_name: 'v0.1.0', draft: state.draft,
    assets: [...assets].map(([name, bytes]) => ({ name, size: bytes.length })),
  });
  const run = (args) => {
    state.calls++;
    if (args[0] === 'api') {
      assert(args[1].startsWith('repos/intigraph/creel/'));
      if (args[1].includes('/commits/')) return JSON.stringify({ sha: state.revision });
      if (options.missingRelease) throw new Error('no existing draft');
      return JSON.stringify(snapshot());
    }
    assert.equal(args[0], 'release');
    assert.equal(args[args.indexOf('--repo') + 1], 'intigraph/creel');
    if (args[1] === 'upload') {
      const name = path.basename(args[3]);
      assert(!args.includes('--clobber'));
      assert(state.draft);
      assert(!assets.has(name));
      state.uploads.push(name);
      if (options.missingUpload) throw new Error('upload absent');
      assets.set(name, fs.readFileSync(args[3]));
      if (options.moveTag) state.revision = 'f'.repeat(40);
      if (options.loseUpload && state.uploads.length === 1) throw new Error('upload response lost');
      return '';
    }
    if (args[1] === 'download') {
      const name = args[args.indexOf('--pattern') + 1];
      let bytes = Buffer.from(assets.get(name));
      if (options.corruptDownload && name.endsWith('.tar.gz')) bytes[0] ^= 1;
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], name), bytes);
      state.reads++;
      return '';
    }
    assert.equal(args[1], 'edit');
    assert.equal(assets.size, 3);
    assert(state.reads >= 3);
    assert(args.includes('--draft=false'));
    state.edits++;
    state.draft = false;
    if (options.loseEdit) throw new Error('publication response lost');
    return '';
  };
  return { state, assets, run, preload: () => {
    for (const name of fs.readdirSync(output)) assets.set(name, fs.readFileSync(path.join(output, name)));
  } };
}

function test(name, run) { run(); passed++; console.log('  ok ' + name); }
function prepared() {
  const f = fixture();
  const built = f.build();
  const identity = { repository: 'intigraph/creel', tag: 'v0.1.0', revision: built.source_revision };
  return { ...f, built, identity };
}

try {
  test('archive is repeatable and carries app, WASM, extension and both license files', () => {
    const f = prepared();
    const second = path.join(f.folder, 'second');
    packageRelease(f.root, second);
    for (const name of fs.readdirSync(f.output)) {
      assert.deepEqual(fs.readFileSync(path.join(f.output, name)), fs.readFileSync(path.join(second, name)));
    }
    const archive = path.join(f.output, f.built.archive);
    const listed = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n');
    for (const name of REQUIRED) {
      const member = 'creel-v0.1.0/' + name;
      assert(listed.includes(member));
      assert.deepEqual(execFileSync('tar', ['-xOf', archive, member]), fs.readFileSync(path.join(f.root, name)));
    }
    assert.throws(f.build, /retained output/);
  });
  test('dirty and untracked source refuse before creating output', () => {
    for (const name of ['app/index.html', 'local-private-state.json']) {
      const f = fixture();
      fs.writeFileSync(path.join(f.root, name), 'changed\n');
      assert.throws(f.build, /clean committed/);
      assert(!fs.existsSync(f.output));
    }
  });
  test('missing license, tracked links and invalid versions refuse', () => {
    for (const mode of ['license', 'link', 'version']) {
      const f = fixture();
      if (mode === 'license') fs.unlinkSync(path.join(f.root, 'LICENSE'));
      if (mode === 'link') fs.symlinkSync('../version.txt', path.join(f.root, 'app/link'));
      if (mode === 'version') fs.writeFileSync(path.join(f.root, 'version.txt'), '01.2.3\n');
      f.commit();
      assert.throws(f.build, /missing tracked|link or non-regular|exact stable semver/);
      assert(!fs.existsSync(f.output));
    }
  });
  test('a linked output parent cannot redirect an archive into source', () => {
    const f = fixture();
    const link = path.join(f.folder, 'source-alias');
    fs.symlinkSync(f.root, link);
    assert.throws(() => packageRelease(f.root, path.join(link, 'output')), /outside/);
  });
  test('Git archive filters cannot silently omit or rewrite a payload member', () => {
    for (const attribute of ['export-ignore', 'export-subst']) {
      const f = fixture();
      fs.writeFileSync(path.join(f.root, '.gitattributes'), 'LICENSE ' + attribute + '\n');
      f.commit();
      assert.throws(f.build, /archive attributes/);
      assert(!fs.existsSync(f.output));
    }
  });
  test('complete readback precedes publication; an exact published retry writes nothing', () => {
    const f = prepared(), t = transport(f.output, f.identity.revision);
    assert.equal(publishRelease(f.output, f.identity, t.run).status, 'VERIFIED_PUBLISHED');
    assert.equal(t.state.uploads.length, 3);
    assert.equal(t.state.edits, 1);
    assert.equal(t.state.draft, false);
    const writes = t.state.uploads.length + t.state.edits;
    publishRelease(f.output, f.identity, t.run);
    assert.equal(t.state.uploads.length + t.state.edits, writes);
  });
  test('fork, missing repository, wrong tag and wrong source refuse before GitHub', () => {
    const f = prepared();
    for (const change of [
      { repository: 'fork/creel' }, { repository: undefined },
      { tag: 'v0.2.0' }, { tag: 'v01.1.0' }, { revision: 'e'.repeat(40) },
    ]) {
      const t = transport(f.output, f.identity.revision);
      assert.throws(() => publishRelease(f.output, { ...f.identity, ...change }, t.run));
      assert.equal(t.state.calls, 0);
    }
  });
  test('local checksum corruption and unexpected files refuse before GitHub', () => {
    for (const mode of ['checksum', 'extra']) {
      const f = prepared(), t = transport(f.output, f.identity.revision);
      fs.writeFileSync(path.join(f.output, mode === 'checksum' ? 'SHA256SUMS' : 'foreign.txt'), 'wrong');
      assert.throws(() => publishRelease(f.output, f.identity, t.run));
      assert.equal(t.state.calls, 0);
    }
  });
  test('conflicting draft or published bytes and incomplete published releases never write', () => {
    for (const mode of ['draft', 'published', 'missing']) {
      const f = prepared(), t = transport(f.output, f.identity.revision);
      t.preload();
      t.state.draft = mode === 'draft';
      const name = f.built.archive;
      if (mode === 'missing') t.assets.delete(name);
      else { const bytes = Buffer.from(t.assets.get(name)); bytes[0] ^= 1; t.assets.set(name, bytes); }
      assert.throws(() => publishRelease(f.output, f.identity, t.run));
      assert.equal(t.state.uploads.length + t.state.edits, 0);
    }
  });
  test('lost upload and publication responses are read back without duplicate writes', () => {
    for (const options of [{ loseUpload: true }, { loseEdit: true }]) {
      const f = prepared(), t = transport(f.output, f.identity.revision, options);
      assert.equal(publishRelease(f.output, f.identity, t.run).status, 'VERIFIED_PUBLISHED');
      assert.equal(t.state.uploads.length, 3);
      assert.equal(new Set(t.state.uploads).size, 3);
      assert.equal(t.state.edits, 1);
    }
  });
  test('missing uploads, corrupt readback, moved tags and missing drafts stay unpublisheable', () => {
    for (const options of [
      { missingUpload: true }, { corruptDownload: true }, { moveTag: true }, { missingRelease: true },
    ]) {
      const f = prepared(), t = transport(f.output, f.identity.revision, options);
      assert.throws(() => publishRelease(f.output, f.identity, t.run));
      assert.equal(t.state.edits, 0);
      assert.equal(t.state.draft, true);
    }
  });
  test('actual workflow guards refuse forks and malformed tags; guard-removal mutant is detected', () => {
    const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
    const match = /        run: \|\n((?:          .*\n)+)/.exec(workflow);
    assert(match);
    const script = match[1].split('\n').map((line) => line.slice(10)).join('\n');
    const run = (body, repository, tag) => spawnSync('bash', ['-c', body], {
      env: { ...process.env, GITHUB_REPOSITORY: repository, RELEASE_TAG: tag },
    }).status;
    const check = (body) => {
      assert.equal(run(body, 'intigraph/creel', 'v0.1.0'), 0);
      assert.notEqual(run(body, 'fork/creel', 'v0.1.0'), 0);
      for (const tag of ['v01.1.0', 'v0.1.0/other', 'main', '']) assert.notEqual(run(body, 'intigraph/creel', tag), 0);
    };
    check(script);
    assert.throws(() => check(script.replace('test "$GITHUB_REPOSITORY" = intigraph/creel', ':')));
    const releasePR = fs.readFileSync(path.join(__dirname, '../.github/workflows/release-pr.yml'), 'utf8');
    const guard = /run: (test "\$GITHUB_REPOSITORY" = intigraph\/creel)/.exec(releasePR);
    assert(guard);
    assert.notEqual(run(guard[1], 'fork/creel', 'v0.1.0'), 0);
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../release-please-config.json')));
    assert.equal(config.draft, true);
    assert.equal(config['force-tag-creation'], true);
    assert(releasePR.includes("needs.release-please.outputs.release_created == 'true'"));
  });
  console.log('release controls: ' + passed + ' passed; no network or release performed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
