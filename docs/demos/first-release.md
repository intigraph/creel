# Static release bundle demonstration

The base snapshot `6ef91be8e330597358496e2524c4ed741361dad9` has no bundle
packager. At source `0c99af3c0d681ee2cc4d1eedfcdd8f5be1428dcb`, packaging a
clean checkout produces the versioned app/WASM/extension bundle, provenance
and SHA-256 manifest. Both checksums verify. The private publisher control
refuses a tampered archive before making any transport call.

This is a recording of a local source checkout and a private transport control.
It does not show a published release. Subsequent recording-only changes preserve
the demonstrated release code and payload; source revision and checksum values
naturally identify the exact commit packaged.

[Readable transcript](first-release.transcript.txt),
[recording timing](first-release.timing.txt).

Download both files into one directory and replay in a terminal:

~~~sh
scriptreplay --log-out first-release.transcript.txt --log-timing first-release.timing.txt
~~~

Playback was checked with util-linux scriptreplay. This is a terminal recording;
no inline video player is claimed. The small recording and this caption remain
versioned in `docs/demos/` with the source for review retention.

Repeat the core probe from a clean checkout:

~~~sh
output="$(mktemp -d)/release"
node tools/package-release.js "$output"
(cd "$output" && sha256sum -c SHA256SUMS)
node tests/test-release.js
~~~

The last command includes the private transport refusal controls. Browser tests
use an explicit Chrome for Testing binary through `CHROME_PATH`; the bundle's
extracted app also initialized successfully in that browser.
