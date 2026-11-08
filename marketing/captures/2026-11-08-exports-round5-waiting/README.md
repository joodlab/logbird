# Export progress: round 5

Built console before: master `5ad041f`. Built console and API after: `eadd29b72ba9b280962e7441839dafbc773343dc`.
Both consoles use that API. Fresh isolated bundled Playwright Chromium contexts, 1440×900 and 390×844, light and dark.
All users, workspace and events are fictional. No browser request/response mocks.

- `before-*-waiting.png`: actual master while a shared project writer delays admission.
- `after-*-waiting.png`: the same delayed admission, with the honest server-wait notice and 30-second explanation.
- `after-*-canceled.png`: real Sonner Cancel; confirmation remains visible after 700 ms. Releasing the writer afterward creates no export lease or audit rows.
- `after-*-downloading.png`: headers received, real CSV body transfer throttled to 800 bytes/s with Chromium network emulation. The notice says Downloading, with no write-wait claim.
- `after-*-failed.png`: a real failed fictional retention run refuses admission with the maintenance reason; the fixture run is then removed.
- `*-interactions.webm`: desktop and mobile sequences. Dark screenshots establish the themed variants.

Four CSV files match their completed records: three events, 1,622 bytes each, SHA-256
`6fa2b780a42bd6aae800e3c5fd51aeb7ff107e8ce653367b37324e93df05f4e2`.
`before-proof.json` and `after-proof.json` retain requests, expected cancellations/failures, record ids and digest comparisons.
No unexpected browser errors occurred in these accepted captures.

`fixture-cleanup.json` verifies all five ClickHouse tables and PostgreSQL users, organizations, projects, members, receipts, outbox and leases are zero for these fixtures.
One private queue key was removed; no shared prefix was flushed. The private session-cookie file was deleted.
The throwaway master worktree was clean, its junctions unlinked without following them, then removed.

Capture peak observed process tree: 1.040 GiB; minimum free RAM: 16.691 GiB; minimum C: free: 85.249 GiB.
`shutdown-proof.json` records zero listeners on 4600/4601, zero worktree process references and zero survivors among 39 recorded identities.
The API and console were killed from their outermost PIDs with `/T /F` before releasing both locks at 18:46:30 local.

Earlier setup attempts produced no accepted frames: a baseline dev-entry loader error, then a missing production proxy target (502).
Their failed artifacts are preserved privately. Initial process-registration JSON was corrected before the accepted capture;
RAM for that first setup launch was not measured. Its process trees were explicitly killed and both ports cleared.
