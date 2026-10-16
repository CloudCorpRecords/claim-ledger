/**
 * Dry-mode API: canned GitHub responses from fixture files, no network.
 * Used by `npm run index:dry` and the test suite.
 *
 * Fixture shape (indexer/fixtures/<repo>.json):
 * {
 *   "owner": "fixture-org", "repo": "widget",
 *   "now": "2026-10-16T21:00:00Z",
 *   "policy": { ...claims.json } | null,
 *   "issues": [ {number, title, comments, updated_at} ... ],
 *   "comments": { "<n>": [ {id, user:{login}, body, created_at, html_url} ] },
 *   "reactions": { "<commentId>": [ {user:{login}, content} ] },
 *   "timeline": { "<n>": [ {event:"cross-referenced", source:{issue:{number, pull_request:{}}}} ] },
 *   "pulls": { "<n>": {number, title, body, state, merged_at, created_at, user:{login}, head:{ref}, html_url} }
 * }
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function createDryApi(fixturesDir) {
  const fixtures = new Map();
  for (const f of await readdir(fixturesDir)) {
    if (!f.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(join(fixturesDir, f), "utf8"));
    fixtures.set(`${data.owner}/${data.repo}`, data);
  }
  const state = { calls: 0 };

  function byFull(owner, repo) {
    const fx = fixtures.get(`${owner}/${repo}`);
    if (!fx) throw new Error(`dry: no fixture for ${owner}/${repo}`);
    return fx;
  }

  async function get(url) {
    state.calls += 1;
    const m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) throw new Error(`dry: unexpected url ${url}`);
    const [, owner, repo, rest] = m;
    const fx = byFull(owner, repo);
    const path = rest || "";

    if (path.startsWith("/contents/.greenlight/claims.json")) {
      if (!fx.policy) return null;
      return { content: Buffer.from(JSON.stringify(fx.policy)).toString("base64") };
    }
    if (path.startsWith("/issues?")) {
      return (fx.issues || []).map((i) => ({
        number: i.number,
        title: i.title,
        comments: (fx.comments[String(i.number)] || []).length,
        updated_at: i.updated_at,
      }));
    }
    const issueComments = path.match(/^\/issues\/(\d+)\/comments/);
    if (issueComments) return fx.comments[issueComments[1]] || [];
    const reactions = path.match(/^\/issues\/comments\/(\d+)\/reactions/);
    if (reactions) return fx.reactions[reactions[1]] || [];
    const timeline = path.match(/^\/issues\/(\d+)\/timeline/);
    if (timeline) return fx.timeline[timeline[1]] || [];
    const pulls = path.match(/^\/pulls\/(\d+)/);
    if (pulls) return fx.pulls[pulls[1]] || null;
    throw new Error(`dry: unhandled path ${path}`);
  }

  return { get, state, nowOf: (owner, repo) => byFull(owner, repo).now };
}
