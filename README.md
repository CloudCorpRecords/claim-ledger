# Claim Ledger

The public index for the [Greenlight Claim Protocol](https://github.com/CloudCorpRecords/greenlight/blob/main/protocol/SPEC.md):
timestamped, expiring claims on open-source issues, with a public queue.

**GitHub is the source of truth; this is only an index.** A claim is a comment
containing `<!-- greenlight-claim v1 -->`. Anyone can rebuild the full Ledger by
reading public comments — no lock-in, no single point of failure. This repo is a
scheduled indexer (every 15 minutes) plus a static JSON API and a claims board,
all served from GitHub Pages.

## The API

Base: `https://cloudcorprecords.github.io/claim-ledger/v1/`

- `issues/<owner>/<repo>/<n>/status.json` — the protocol status of one issue (the SPEC 5.1 shape): verdict, active claim and its expiry, the queue, competing PRs from the issue timeline, gates, and the repo's protocol policy. Gates are not indexed in Phase 2 (empty array); for the live check verdict with gates, use `greenlight check` on the issue.
- `claims/<owner>/<repo>/<n>.json` — the append-only claim chain for one issue: every claim, its state history, and the public evidence URL for each event.
- `repos/<owner>/<repo>/claims.json` — repo-level summary: honoring status, active claims with expiries and queues.
- `repos/<owner>/<repo>/friction.json` — Friction Index data for the repo when seeded, stamped with its own `checkedAt`; `{score: null}` with a note when not.
- `accounts/<login>.json` — the passport seed: one identity's active claims and queue positions across repos, plus the over-cap flag when they hold more than 5 active claims.
- `index.json` — generation metadata, per-repo counts, global totals, the over-cap account list, per-repo API call counts, and any errors.

Every response carries `generated_at` (or `checked_at`) so staleness is a fact, not a surprise.

## How a repo gets indexed

The seed list is `repos.json`: our campaign repos plus the Friction Index repos (48 today).
A repo opts in by adding `.greenlight/claims.json` (the protocol's policy file, see the spec section 4);
the indexer reads it, honors its lease and tenure settings, and lists the repo as
**honoring** in the Ledger and on the board. Repos without a policy file are still
indexed when protocol comments appear, but claims there are read as signals, not promises.

## Rebuild it yourself

```bash
npm install
npm run index:dry     # fixtures, no network: writes to /tmp/claim-ledger-dry
npm test              # node --test over the pure parts + the dry-mode end to end
GITHUB_TOKEN=... node indexer/index.mjs            # real run, writes to docs/
node indexer/index.mjs --only ComposioHQ/composio  # real run, one repo
```

The indexer (`indexer/index.mjs`, plain Node 20, no build step) uses the published
`@reneturcios/greenlight@0.4.0` package as a real dependency — the protocol engine
(`computeClaimState`, `parseClaimsPolicy`, `buildIssueStatus`) and link-strength
classification are imported from its compiled `dist/`, never reimplemented.

Budget discipline, documented in code and in `index.json`'s `caps`: open issues are
listed 2 pages at a time and only issues updated in the last 30 days are scanned;
comments are fetched for every issue with comments > 0 (the comment body *is* the
claim, so there is no cheaper way to detect protocol activity); reactions are fetched
only for comments carrying the claim marker; the issue timeline is fetched only for
issues with protocol activity.

## Limits, stated plainly

- **Cold start.** The protocol shipped 2026-10-16. Expect the board to be nearly
  empty until real protocol claims land; our own campaign's claims run on the
  protocol from day one.
- **Freshness.** The schedule is 15 minutes, but GitHub API rate limits and
  `checked_at` timestamps mean this is an index, not a live feed.
- **Writes are Phase 3.** Claiming happens by posting the comment with your own
  GitHub identity (by hand, or with `greenlight claim`). The Ledger never posts as you.
- **Over-cap is computed globally here.** The engine's cap is library-only; the
  Ledger is the first place with the cross-repo view, so over-cap accounts are
  listed in `index.json` and flagged on account pages.

Spec: `protocol/SPEC.md` in [CloudCorpRecords/greenlight](https://github.com/CloudCorpRecords/greenlight).
