import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(join(root, "package.json"));
const protocol = require("@reneturcios/greenlight/dist/protocol.js");

const {
  buildStatusPayload,
  buildChainPayload,
  buildRepoClaimsSummary,
  aggregateAccounts,
  buildFrictionPayload,
  hasProtocolMarker,
  runIndex,
} = await import("../indexer/index.mjs");
const { createDryApi } = await import("../indexer/dry.mjs");

const fixturesDir = join(root, "indexer", "fixtures");
const NOW = "2026-10-16T21:00:00Z";

async function dryApi() {
  const api = await createDryApi(fixturesDir);
  return api;
}

function fakeComputation({ active, queue = [], claims = [] }) {
  return { active, queue, claims };
}

describe("marker detection", () => {
  it("detects claim and release markers", () => {
    assert.equal(hasProtocolMarker([{ body: "hi" }]), false);
    assert.equal(hasProtocolMarker([{ body: "x\n<!-- greenlight-claim v1 -->" }]), true);
    assert.equal(hasProtocolMarker([{ body: "x\n<!-- greenlight-claim release -->" }]), true);
  });
});

describe("status payload", () => {
  it("builds the SPEC 5.1 shape with the ledger note", () => {
    const computation = protocol.computeClaimState({
      comments: [
        { author: "alice", body: "taking it\n<!-- greenlight-claim v1 -->", createdAt: "2026-10-14T10:00:00Z", id: 1, url: "u" },
      ],
      now: NOW, repo: "a/b", issue: 3,
    });
    const payload = buildStatusPayload({
      owner: "a", repo: "b", issueNumber: 3, issueTitle: "A title",
      computation, linkedPrDetails: [], policyHonored: true,
      policy: protocol.defaultClaimsPolicy(), checkedAt: NOW,
    });
    assert.equal(payload.issue, "https://github.com/a/b/issues/3");
    assert.equal(payload.verdict, "TAKEN");
    assert.equal(payload.claim.claimant, "alice");
    assert.deepEqual(payload.competing_prs, []);
    assert.deepEqual(payload.gates, []);
    assert.ok(payload._ledger_note.includes("gates are not indexed"));
    assert.equal(payload.repo_protocol.honored, true);
    assert.equal(payload.checked_at, NOW);
  });

  it("no protocol claims leaves the verdict to the caller", () => {
    const computation = protocol.computeClaimState({
      comments: [{ author: "x", body: "plain", createdAt: "2026-10-15T10:00:00Z", id: 2 }],
      now: NOW, repo: "a/b", issue: 4,
    });
    const payload = buildStatusPayload({
      owner: "a", repo: "b", issueNumber: 4, issueTitle: null,
      computation, linkedPrDetails: [], policyHonored: false,
      policy: protocol.defaultClaimsPolicy(), checkedAt: NOW,
    });
    assert.equal(payload.verdict, null);
    assert.equal(payload.claim, null);
  });
});

describe("repo claims summary (board data)", () => {
  it("shapes the active-claims table rows", () => {
    const computation = protocol.computeClaimState({
      comments: [
        { author: "alice", body: "mine\n<!-- greenlight-claim v1 -->", createdAt: "2026-10-14T10:00:00Z", id: 1 },
        { author: "bob", body: "next\n<!-- greenlight-claim v1 -->", createdAt: "2026-10-15T10:00:00Z", id: 2 },
      ],
      now: NOW, repo: "a/b", issue: 9,
    });
    const summary = buildRepoClaimsSummary({
      owner: "a", repo: "b", policyHonored: true, policy: protocol.defaultClaimsPolicy(),
      perIssue: [{ issueNumber: 9, computation }],
    });
    assert.equal(summary.active_claim_count, 1);
    assert.equal(summary.queued_claim_count, 1);
    const row = summary.active_claims[0];
    assert.equal(row.claimant, "alice");
    assert.equal(row.issue_url, "https://github.com/a/b/issues/9");
    assert.deepEqual(row.queue, [{ claimant: "bob", position: 2 }]);
  });
});

describe("account aggregation and over-cap", () => {
  it("marks accounts past 5 active claims over-cap", () => {
    const records = [];
    for (let i = 1; i <= 6; i++) {
      const computation = protocol.computeClaimState({
        comments: [{ author: "squatter", body: "mine\n<!-- greenlight-claim v1 -->", createdAt: "2026-10-14T10:00:00Z", id: i }],
        now: NOW, repo: `org/r${i}`, issue: i,
      });
      records.push({ repo: `org/r${i}`, issue: i, computation });
    }
    const { pages, overCapLogins } = aggregateAccounts(records);
    assert.equal(pages.squatter.over_cap, true);
    assert.equal(pages.squatter.total_active, 6);
    assert.ok(overCapLogins.includes("squatter"));
    assert.ok(pages.squatter._ledger_note.includes("more than 5"));
  });

  it("five active claims is not over-cap", () => {
    const records = [];
    for (let i = 1; i <= 5; i++) {
      const computation = protocol.computeClaimState({
        comments: [{ author: "steady", body: "mine\n<!-- greenlight-claim v1 -->", createdAt: "2026-10-14T10:00:00Z", id: i }],
        now: NOW, repo: `org/r${i}`, issue: i,
      });
      records.push({ repo: `org/r${i}`, issue: i, computation });
    }
    const { pages, overCapLogins } = aggregateAccounts(records);
    assert.equal(pages.steady.over_cap, false);
    assert.deepEqual(overCapLogins, []);
  });

  it("expired claims do not count toward the cap", () => {
    const computation = protocol.computeClaimState({
      comments: [{ author: "gone", body: "mine\n<!-- greenlight-claim v1 -->", createdAt: "2026-08-01T10:00:00Z", id: 1 }],
      now: NOW, repo: "org/r", issue: 1,
    });
    const { pages } = aggregateAccounts([{ repo: "org/r", issue: 1, computation }]);
    assert.equal(pages.gone.total_active, 0);
  });
});

describe("friction payload", () => {
  it("copies seeded friction data with its checkedAt", () => {
    const rows = [{
      repo: "a/b", url: "https://github.com/a/b", friction: 90,
      reasons: ["x"], gates: [], mergeVelocity: {}, starterIssues: 2,
      checkedAt: "2026-10-16T08:00:00Z", source: "live",
    }];
    const p = buildFrictionPayload("a/b", rows, NOW);
    assert.equal(p.score, 90);
    assert.equal(p.source, "friction-index");
    assert.equal(p.checked_at, "2026-10-16T08:00:00Z");
  });
  it("returns a null score with a note when the repo is not seeded", () => {
    const p = buildFrictionPayload("x/y", [], NOW);
    assert.equal(p.score, null);
    assert.ok(p.note.includes("No friction data"));
  });
});

describe("dry-mode end to end", () => {
  it("indexes the fixture repos into well-formed JSON", async () => {
    const api = await dryApi();
    const outDir = await mkdtemp(join(tmpdir(), "ledger-test-"));
    const repos = [
      { owner: "fixture-org", repo: "widget", note: "dry fixture" },
      { owner: "fixture-org", repo: "gadget", note: "dry fixture" },
    ];
    const index = await runIndex({ repos, outDir, api, nowIso: NOW, frictionRows: [] });

    assert.equal(index.totals.active_claims, 1);
    assert.equal(index.totals.queued_claims, 1);
    assert.equal(index.totals.issues_with_protocol_activity, 3);
    assert.equal(index.engine, "@reneturcios/greenlight@0.4.0");

    const status = JSON.parse(await readFile(join(outDir, "v1/issues/fixture-org/widget/3/status.json"), "utf8"));
    assert.equal(status.verdict, "TAKEN");
    assert.equal(status.claim.queue[0].claimant, "bob");

    const chain = JSON.parse(await readFile(join(outDir, "v1/claims/fixture-org/widget/3.json"), "utf8"));
    assert.deepEqual(chain.claims.map((c) => [c.claimant, c.state]), [["alice", "active"], ["bob", "queued"]]);

    const alice = JSON.parse(await readFile(join(outDir, "v1/accounts/alice.json"), "utf8"));
    assert.equal(alice.total_active, 1);

    // expired claims produce protocol activity but no active claim
    const carol = JSON.parse(await readFile(join(outDir, "v1/accounts/carol.json"), "utf8"));
    assert.equal(carol.total_active, 0);

    const gadgetStatus = JSON.parse(await readFile(join(outDir, "v1/issues/fixture-org/gadget/1/status.json"), "utf8"));
    assert.equal(gadgetStatus.verdict, "GO");
    assert.equal(gadgetStatus.repo_protocol.honored, false);
  });
});
