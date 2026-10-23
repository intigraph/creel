# Versioned static releases

Pages is the live demo. A release is the immutable bundle, provenance record and
SHA-256 manifest attached to a reviewed release tag.

For a downloaded release, verify SHA256SUMS before extracting the archive:

~~~sh
sha256sum -c SHA256SUMS
tar -xzf creel-v0.1.0.tar.gz
python3 -m http.server 8420 --directory creel-v0.1.0/app
~~~

Open http://localhost:8420. Load the extracted extension/ directory as an
unpacked Chrome extension to use the bridge. Its existing version and origin
permissions are retained. LICENSE and THIRD_PARTY_NOTICES.md travel with both
the app and extension; the vendored OnePagent portions retain their MIT notice.

The bundle contains committed app/ and extension/ assets, including the
prebuilt WASM provider. It does not rebuild WASM or export browser state.

## Release path

Release-please opens a version/changelog PR from conventional commits. The
bootstrap manifest starts at 0.0.0 because no earlier release exists; the first
candidate is 0.1.0. Release PRs use the normal CI and independent review route.
GitHub may mark a workflow-token-created PR's CI as awaiting approval. An
authorized maintainer approves those workflows; CI must finish before review
and merge. This lane uses the repository workflow token.
Merging one creates a draft and its tag, then calls the publisher in the same
workflow run. No hand-created tag or separate publication credential is needed.

The publisher binds the canonical repository, tag, source commit, archive and
checksums. It reads every asset back before publishing the draft. Conflicting
assets refuse; published assets are never overwritten. After a transient
failure, dispatch the release workflow with the existing tag: matching uploads
are reused and uncertain or mismatching content remains an error.

Local packaging uses a clean committed checkout and a new directory outside it:

~~~sh
node tools/package-release.js /path/to/new-release-output
~~~
