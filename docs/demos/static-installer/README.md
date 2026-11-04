# Static installer demonstration

The base has no `install.sh` entrypoint. The candidate adds a static release installer.
The recorded fixture test installs a private checksummed bundle, prints a manual
localhost serving command, then refuses to overwrite that same release. Refusal
controls cover changed checksums, paths/links/duplicates, version/provenance and
expanded-size bounds. They run the Python payload read from the actual entrypoint,
with HTTPS responses replaced by in-memory release fixtures. No service, browser
extension, credential or live release is activated.

The recording replays the retained real fixture-test output. It is not a second
qualification run or a clean-OS installation receipt. Hosted installer jobs test
the real v0.1.1 bundle separately.

Download `output.log` and `timing.log`, then run:

```sh
scriptreplay --log-out output.log --log-timing timing.log
```

Reproduce the fixture behavior with:

```sh
python3 -m unittest discover -s tests -p test_installer.py -v
```

Demonstrated source is identified by the installer and fixture SHA-256 values in
`source.json`. The caption and recording are retained with the source proposal.
