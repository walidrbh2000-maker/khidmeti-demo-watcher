# khidmeti-demo-watcher

Stateless demo-commission watcher for Khidmeti. Runs on GitHub Actions
every 5 minutes (public repo = unlimited free minutes).

Each run: accept/reopen sweep over live bids + freshness refresh for
1 wilaya (rotation via minute-of-hour, full 58-wilaya sweep ≈ 5h).

Acceptance rule (mirrors the seed): `01` accepts · `02` never ·
`03–10` alternate accept/never/delayed (delayed = bid older than
`ACCEPT_DELAY_MIN`, read from the bid's own `createdAt` — no memory
between runs).

## Secrets (repo Settings → Secrets → Actions)

| Name | Value |
|---|---|
| `API_BASE` | Render API URL |
| `DEMO_CLIENT_UID` | Firebase UID of the demo client |
| `FIREBASE_WEB_API_KEY` | Firebase web API key (public by design) |
| `FIREBASE_PROJECT_ID` | Service account |
| `FIREBASE_CLIENT_EMAIL` | Service account |
| `FIREBASE_PRIVATE_KEY` | Service account |

## End of life

Delete `.github/workflows/watch.yml` (or this repo) when trials end.
Demo rows in Atlas are harmless (`seed-demo-*`, owned by the demo client).
