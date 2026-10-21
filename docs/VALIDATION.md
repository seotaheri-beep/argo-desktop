# Validation status — 0.3.0-preview

The published Windows installer and source archive were prepared on 2026-10-20
from local source revision `3cd2f110578e2d72ea52088a5452c3c2e2c76f8d`.
The public repository adds publication documentation; the application source is
unchanged from that snapshot.

## Recorded checks for the installer

The same 174 isolated Node.js tests were re-run from the publication source tree
on 2026-10-21 with Node.js v24.19.0: 174 passed, zero failures or skips. This
publication check did not repeat live VPN or Administrator acceptance tests.

- 174 automated Node.js checks: zero failures, errors, or skips, using bundled
  Node.js v24.19.0.
- 15 baseline C# runtime guard checks passed; one supplementary file-symlink
  scenario was not run because Windows did not grant the required privilege.
- 49 isolated C# UI lifecycle checks passed. These do not constitute interactive
  click-through testing of the interface.
- Local real-engine start/stop and port-conflict checks passed, including
  preservation of the existing listener and deletion of temporary files.
- A live proxy connection and three controlled connection failures recovered
  successfully, with at most one engine running at once and no leftover engine
  process or connection directory after cleanup.
- Installer extraction, payload hash comparison, launch from an isolated
  installation directory, and removal passed. This did not cover an ordinary
  system-wide installation or upgrade.
- A short Administrator TUN-mode check covered TCP, non-DNS UDP with NTP,
  system DNS, and IPv6. Route/DNS restoration and adapter removal were verified.
  Some direct UDP DNS requests to public resolvers did not receive a response;
  this compatibility scenario remains unresolved.

## Outstanding acceptance

- Two-hour proxy connection soak.
- Two-hour system-wide connection soak.
- Ordinary Administrator installation and upgrade.
- Comprehensive DNS and IPv6 leak checks.

This is a **preview**, not a fully accepted stable release. Configuration flags
alone are not evidence of leak prevention. The application has no kill switch.

For build requirements and reproducible local test commands, see [REBUILD.md](../REBUILD.md).
