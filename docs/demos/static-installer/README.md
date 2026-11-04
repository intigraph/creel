# Static installer demonstration

Base `77d3896c7aedc94114c2c370fcdc4a43315e923a` has no `install.sh` entrypoint.
Installer source `4e07a825da54af19bf2d5a0968bcd5164b9ee100` adds that entrypoint.
The recording calls the candidate installer against an in-memory release fixture:
it installs the checksummed static bundle in a fresh private directory, prints its
manual serving command, refuses a repeated install without changing retained data,
and rejects a changed archive before writing its new destination.

This is an actual synthetic fixture run. It reads the Python payload from the real
entrypoint; only HTTPS responses are mocked. Temporary paths are redacted as
`<private-root>`. No network request, server, browser extension or credentials are
activated. It is not a clean-OS real-release installation receipt; the separate
hosted installer workflow checks the actual v0.1.1 bundle.

Download `output.log` and `timing.log`, then run:

```sh
scriptreplay --log-out output.log --log-timing timing.log
```

Reproduce the visible behavior:

```sh
python3 docs/demos/static-installer/demo.py
```

The base cannot run the same call because the entrypoint does not exist. The
installer and fixture SHA-256 values in `source.json` bind the demonstrated code.
`fixture-output.txt` separately retains the real eight-test qualification output.
The small recording and caption are retained with this source proposal.
