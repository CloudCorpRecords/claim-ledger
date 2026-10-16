/**
 * claim-ledger indexer: plain Node 20, no build step.
 *
 * Reads repos.json, scans open issues for Greenlight Claim Protocol activity
 * (comments carrying the claim marker), and publishes a static JSON API
 * under docs/v1/ plus a claims board page at docs/index.html.
 *
 * Budget discipline (deliberate choices, documented):
 * - Issues: 2 pages x 100 of /issues?state=open&sort=updated, only issues
 *   updated in the last 30 days are scanned (cap stated in output metadata).
 * - Comments: fetched for EVERY issue with comments > 0 (per_page 100, one
 *   page; the cap is stated in output). The comment body IS the claim, so
 *   there is no cheaper way to detect protocol activity.
 * - Reactions: fetched ONLY for comments that carry the claim marker
 *   (rocket reactions are heartbeats). One page per marker comment.
 * - Timeline: fetched ONLY for issues with protocol activity, to find linked
 *   PRs; referenced PRs are fetched one by one (capped at 10 per issue) and
 *   classified with the engine's link-strength so only closing-strength PRs
 *   count as links.
 * - Repo policy (.greenlight/claims.json): one call per repo, cached.
 *
 * Engine route: @reneturcios/greenlight@0.4.0 is a real npm dependency and
 * its compiled dist/protocol.js and dist/linkstrength.js are imported via
 * createRequire (they are CommonJS). No vendoring.
 */

import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const protocol = require("@reneturcios/greenlight/dist/protocol.js");
const { classifyLinkStrength } = require("@reneturcios/greenlight/dist/linkstrength.js");
const {
  computeClaimState,
  parseClaimsPolicy,
  defaultClaimsPolicy,
  buildIssueStatus,
  CLAIM_MARKER,
  RELEASE_MARKER,
} = protocol;

const INDEXER_VERSION = "0.1.0";
const ENGINE_VERSION = "@reneturcios/greenlight@0.4.0";
const LOOKBACK_DAYS = 30;
const ISSUE_PAGES_CAP = 2;
const COMMENTS_PAGE_CAP = 1;
const PULL_FETCH_CAP = 10;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/* ---------------- API layer ---------------- */

export function createApi({ token } = {}) {
  const state = { calls: 0 };
  const headers = {
    "User-Agent": `claim-ledger-indexer/${INDEXER_VERSION}`,
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function get(url) {
    state.calls += 1;
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") throw new Error(`rate-limited on ${url}`);
      const body = await res.text();
      throw new Error(`forbidden ${url}: ${body.slice(0, 160)}`);
    }
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
  }
  return { get, state };
}

/* ---------------- per-repo policy ---------------- */

export async function fetchPolicy(api, owner, repo) {
  const data = await api.get(
    `https://api.github.com/repos/${owner}/${repo}/contents/.greenlight/claims.json`
  );
  if (!data || !data.content) {
    return { honored: false, policy: defaultClaimsPolicy(), invalid: false };
  }
  const text = Buffer.from(data.content, "base64").toString("utf8");
  const policy = parseClaimsPolicy(text);
  return { honored: true, policy, invalid: !!policy.invalid };
}

/* ---------------- linked PRs from the issue timeline ---------------- */

function timelinePrNumbers(timeline) {
  const out = [];
  for (const ev of timeline || []) {
    const src = ev && ev.source && ev.source.issue;
    if (ev.event === "cross-referenced" && src && src.pull_request) {
      if (!out.includes(src.number)) out.push(src.number);
    }
  }
  return out.slice(0, PULL_FETCH_CAP);
}

export async function fetchLinkedPrInputs(api, owner, repo, issueNumber) {
  const timeline = await api.get(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`
  );
  const inputs = [];
  const details = [];
  for (const prNumber of timelinePrNumbers(timeline)) {
    const pr = await api.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`);
    if (!pr) continue;
    const strength = classifyLinkStrength({
      title: pr.title || "",
      body: pr.body || "",
      branch: (pr.head && pr.head.ref) || "",
      issueNumber,
    });
    if (strength !== "closing") continue;
    const state = pr.merged_at ? "merged" : pr.state;
    inputs.push({ number: prNumber, state, createdAt: pr.created_at });
    details.push({
      number: prNumber,
      author: pr.user && pr.user.login,
      state,
      url: pr.html_url,
      createdAt: pr.created_at || null,
    });
  }
  return { inputs, details };
}

/* ---------------- one issue ---------------- */

export function hasProtocolMarker(comments) {
  return (comments || []).some(
    (c) => c.body && (c.body.includes(CLAIM_MARKER) || c.body.includes(RELEASE_MARKER))
  );
}

function toEngineComments(comments) {
  return (comments || []).map((c) => ({
    id: c.id,
    author: c.user && c.user.login,
    body: c.body || "",
    createdAt: c.created_at,
    url: c.html_url,
  }));
}

export async function scanIssue(api, owner, repo, issueNumber, ctx) {
  // ctx: {policy, policyHonored, nowIso}
  const rawComments = await api.get(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`
  );
  if (!hasProtocolMarker(rawComments)) return null;

  const markerComments = (rawComments || []).filter((c) =>
    (c.body || "").includes(CLAIM_MARKER)
  );
  const reactions = [];
  for (const c of markerComments) {
    const rs = await api.get(
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${c.id}/reactions?per_page=100`
    );
    for (const r of rs || []) {
      reactions.push({ commentId: c.id, user: r.user && r.user.login, content: r.content });
    }
  }
  const { inputs: linkedPrs, details: linkedPrDetails } = await fetchLinkedPrInputs(
    api, owner, repo, issueNumber
  );
  const mergedPrNumber = linkedPrDetails.find((d) => d.state === "merged")?.number ?? null;

  const computation = computeClaimState({
    comments: toEngineComments(rawComments),
    reactions,
    linkedPrs,
    mergedPrNumber,
    policy: ctx.policy,
    now: ctx.nowIso,
    repo: `${owner}/${repo}`,
    issue: issueNumber,
  });

  return { computation, linkedPrDetails, commentCount: (rawComments || []).length };
}

/* ---------------- payload builders (pure, tested) ---------------- */

export function buildStatusPayload({ owner, repo, issueNumber, issueTitle, computation, linkedPrDetails, policyHonored, policy, checkedAt }) {
  const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
  const payload = buildIssueStatus({
    issueUrl,
    computation,
    competingPrs: linkedPrDetails.map((d) => ({
      number: d.number, author: d.author, state: d.state,
    })),
    gates: [],
    repoProtocol: policyHonored
      ? { honored: true, lease_days: policy.lease_days }
      : { honored: false, lease_days: policy.lease_days },
    checkedAt,
  });
  return {
    ...payload,
    issue_title: issueTitle || null,
    _ledger_note:
      "Ledger Phase 2: competing_prs come from the issue timeline only and gates are not indexed (empty). For the live check verdict with gates, use greenlight check on the issue.",
  };
}

export function buildChainPayload({ owner, repo, issueNumber, computation, checkedAt }) {
  return {
    v: 1,
    repo: `${owner}/${repo}`,
    issue: issueNumber,
    generated_at: checkedAt,
    active: computation.active,
    queue: computation.queue,
    claims: computation.claims,
    _ledger_note:
      "Append-only claim chain. GitHub comments are the source of truth; this index is rebuilt from public comments on a schedule.",
  };
}

export function buildRepoClaimsSummary({ owner, repo, policyHonored, policy, perIssue }) {
  const active = [];
  for (const { issueNumber, computation } of perIssue) {
    if (computation.active) {
      active.push({
        issue: issueNumber,
        issue_url: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
        claimant: computation.active.claimant,
        claimed_at: computation.active.claimed_at,
        expires_at: computation.active.expires_at,
        state: computation.active.state,
        queue: (computation.queue || []).map((q) => ({
          claimant: q.claimant, position: q.queue_position ?? q.position,
        })),
      });
    }
  }
  return {
    repo: `${owner}/${repo}`,
    generated_at: new Date().toISOString(),
    honored: policyHonored,
    policy_invalid: !!policy.invalid,
    active_claim_count: active.length,
    queued_claim_count: perIssue.reduce((n, p) => n + (p.computation.queue || []).length, 0),
    active_claims: active,
  };
}

/**
 * Global account aggregation: the passport seed. Every claimant that appears
 * in any chain gets a page with their active claims and queue positions.
 * The 5-active-claim cap is computed globally here (the engine's over-cap is
 * library-only in Phase 1; the Ledger is the first place with the global view).
 */
export function aggregateAccounts(allRecords) {
  // allRecords: [{repo, issue, computation}]
  const byLogin = new Map();
  const activeCount = new Map();
  for (const { repo, issue, computation } of allRecords) {
    for (const claim of computation.claims || []) {
      const login = claim.claimant;
      if (!login) continue;
      if (!byLogin.has(login)) byLogin.set(login, { active: [], queued: [] });
      const entry = { repo, issue, state: claim.state };
      if (claim.state === "active" || claim.state === "linked") {
        byLogin.get(login).active.push({
          ...entry,
          expires_at: claim.expires_at,
          queue_position: claim.queue_position,
        });
        activeCount.set(login, (activeCount.get(login) || 0) + 1);
      } else if (claim.state === "queued") {
        byLogin.get(login).queued.push({ ...entry, queue_position: claim.queue_position });
      }
    }
  }
  const pages = {};
  for (const [login, data] of byLogin) {
    const overCap = (activeCount.get(login) || 0) > 5;
    pages[login] = {
      login,
      active_claims: data.active,
      queued_claims: data.queued,
      total_active: data.active.length,
      over_cap: overCap,
      _ledger_note: overCap
        ? "This account holds more than 5 active claims across indexed repos; readers treat claims past the cap as soft (SPEC 3.4)."
        : undefined,
    };
  }
  return { pages, overCapLogins: [...activeCount].filter(([, n]) => n > 5).map(([l]) => l) };
}

/* ---------------- main run ---------------- */

export async function runIndex({ repos, outDir, only, api, nowIso, frictionRows }) {
  const checkedAt = nowIso || new Date().toISOString();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  const repoSummaries = [];
  const errors = [];
  const allRecords = [];
  let issuesScanned = 0;

  for (const { owner, repo, note } of repos) {
    const full = `${owner}/${repo}`;
    if (only && full.toLowerCase() !== only.toLowerCase()) continue;
    const callsBefore = api.state.calls;
    try {
      const policyRes = await fetchPolicy(api, owner, repo);
      const issues = [];
      for (let page = 1; page <= ISSUE_PAGES_CAP; page++) {
        const batch = await api.get(
          `https://api.github.com/repos/${owner}/${repo}/issues?state=open&sort=updated&direction=desc&per_page=100&page=${page}`
        );
        if (!batch || batch.length === 0) break;
        issues.push(...batch);
        if (batch.length < 100) break;
      }
      const candidates = issues.filter(
        (i) => !i.pull_request && i.updated_at && i.updated_at.slice(0, 10) >= since
      );

      const perIssue = [];
      for (const issue of candidates) {
        if (!issue.comments) continue;
        const scanned = await scanIssue(api, owner, repo, issue.number, {
          policy: policyRes.policy,
          policyHonored: policyRes.honored,
          nowIso: checkedAt,
        });
        if (!scanned) continue;
        const { computation, linkedPrDetails } = scanned;
        allRecords.push({ repo: full, issue: issue.number, computation });

        const status = buildStatusPayload({
          owner, repo, issueNumber: issue.number, issueTitle: issue.title,
          computation, linkedPrDetails,
          policyHonored: policyRes.honored, policy: policyRes.policy,
          checkedAt,
        });
        await writeJson(outDir, `v1/issues/${owner}/${repo}/${issue.number}/status.json`, status);
        await writeJson(outDir, `v1/claims/${owner}/${repo}/${issue.number}.json`,
          buildChainPayload({ owner, repo, issueNumber: issue.number, computation, checkedAt }));
        perIssue.push({ issueNumber: issue.number, computation });
      }

      const summary = buildRepoClaimsSummary({
        owner, repo, policyHonored: policyRes.honored, policy: policyRes.policy, perIssue,
      });
      await writeJson(outDir, `v1/repos/${owner}/${repo}/claims.json`, summary);
      await writeJson(outDir, `v1/repos/${owner}/${repo}/friction.json`,
        buildFrictionPayload(full, frictionRows, checkedAt));

      repoSummaries.push({
        owner, repo, note: note || null,
        honored: policyRes.honored,
        policy_invalid: !!policyRes.policy.invalid,
        issues_scanned: candidates.length,
        issues_with_protocol: perIssue.length,
        active_claims: summary.active_claim_count,
        queued_claims: summary.queued_claim_count,
        api_calls: api.state.calls - callsBefore,
      });
      issuesScanned += candidates.length;
    } catch (err) {
      errors.push({ repo: full, error: String(err && err.message || err) });
    }
  }

  const { pages: accountPages, overCapLogins } = aggregateAccounts(allRecords);
  for (const [login, page] of Object.entries(accountPages)) {
    await writeJson(outDir, `v1/accounts/${login}.json`, page);
  }

  const totals = {
    repos_scanned: repoSummaries.length,
    issues_scanned: issuesScanned,
    active_claims: repoSummaries.reduce((n, r) => n + r.active_claims, 0),
    queued_claims: repoSummaries.reduce((n, r) => n + r.queued_claims, 0),
    issues_with_protocol_activity: repoSummaries.reduce((n, r) => n + r.issues_with_protocol, 0),
    over_cap_accounts: overCapLogins,
    accounts_indexed: Object.keys(accountPages).length,
  };
  const index = {
    generated_at: checkedAt,
    indexer: `claim-ledger/${INDEXER_VERSION}`,
    engine: ENGINE_VERSION,
    freshness_target: "15 minutes for opted-in repos (Phase 2); current schedule: every 15 minutes",
    caps: {
      issue_pages: ISSUE_PAGES_CAP,
      issue_lookback_days: LOOKBACK_DAYS,
      comments_pages_per_issue: COMMENTS_PAGE_CAP,
      pull_fetch_cap_per_issue: PULL_FETCH_CAP,
      note: "Comments are fetched for every issue with comments > 0 (the comment body is the claim). Reactions are fetched only for comments carrying the claim marker. Timeline is fetched only for issues with protocol activity.",
    },
    totals,
    repos: repoSummaries,
    errors,
    api_calls: api.state.calls,
  };
  await writeJson(outDir, "v1/index.json", index);
  return index;
}

export function buildFrictionPayload(full, rows, checkedAt) {
  const row = (rows || []).find((r) => r.repo === full);
  if (!row) {
    return {
      repo: full,
      score: null,
      source: "friction-index",
      note: "No friction data for this repo yet.",
      checked_at: checkedAt,
    };
  }
  return {
    repo: full,
    url: row.url,
    score: row.friction,
    reasons: row.reasons,
    gates: row.gates,
    merge_velocity: row.mergeVelocity,
    starter_issues: row.starterIssues,
    field_note: row.fieldNote || null,
    checked_at: row.checkedAt,
    source: "friction-index",
  };
}

export async function writeJson(outDir, relPath, data) {
  const full = join(outDir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(data, null, 2) + "\n");
}

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const out = { outDir: join(root, "docs"), dry: false, only: null, reposPath: join(root, "repos.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry") out.dry = true;
    else if (argv[i] === "--out") out.outDir = resolve(argv[++i]);
    else if (argv[i] === "--only") out.only = argv[++i];
    else if (argv[i] === "--repos") out.reposPath = resolve(argv[++i]);
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  let repos = JSON.parse(await readFile(opts.reposPath, "utf8"));
  const frictionRows = JSON.parse(
    await readFile(join(root, "indexer", "friction-data.json"), "utf8").catch(() => "[]")
  );

  let api;
  let nowIso;
  if (opts.dry) {
    const { createDryApi } = await import("./dry.mjs");
    const fixturesDir = join(here, "fixtures");
    api = await createDryApi(fixturesDir);
    await rm(opts.outDir, { recursive: true, force: true });
    const { readdir, readFile: rf } = await import("node:fs/promises");
    const first = JSON.parse(await rf(join(fixturesDir, (await readdir(fixturesDir)).find((f) => f.endsWith(".json"))), "utf8"));
    nowIso = first.now;
    repos = [
      { owner: "fixture-org", repo: "widget", note: "dry fixture" },
      { owner: "fixture-org", repo: "gadget", note: "dry fixture" },
    ];
  } else {
    api = createApi({ token: process.env.GITHUB_TOKEN });
  }

  const index = await runIndex({ repos, outDir: opts.outDir, only: opts.only, api, nowIso, frictionRows });
  console.log(`ledger: ${index.totals.repos_scanned} repos, ${index.totals.issues_scanned} issues scanned, ` +
    `${index.totals.active_claims} active claims, ${index.totals.queued_claims} queued, ` +
    `${index.totals.over_cap_accounts.length} over-cap accounts, ${index.api_calls} API calls, ` +
    `${index.errors.length} errors`);
  if (index.errors.length) {
    for (const e of index.errors) console.log(`  error: ${e.repo}: ${e.error}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
