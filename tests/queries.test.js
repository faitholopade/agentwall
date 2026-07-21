process.env.DATABASE_PATH = ":memory:";

const { test, describe, before } = require("node:test");
const assert = require("node:assert");

const { migrate } = require("../src/database/init");
const {
  upsertContributor, getContributor,
  upsertContributorActivity, getLatestContributorActivity,
  insertScan, getScans, getScanStats,
  getPolicies, createPolicy, updatePolicy, deletePolicy,
  upsertInstallation, getAllInstallations, removeInstallation,
  addVerifiedContributor, removeVerifiedContributor, isVerifiedContributor, getVerifiedContributors,
} = require("../src/database/queries");

function contributor(login) {
  return {
    github_login: login,
    github_id: 12345,
    account_created_at: "2020-01-01T00:00:00Z",
    avatar_url: "https://example.com/a.png",
    bio: "hello",
    has_linked_socials: 1,
    total_contributions: 100,
    public_repos: 5,
    followers: 10,
    following: 3,
  };
}

function scanFor(login, score, level, signals) {
  return {
    pr_number: 1,
    repo_full_name: "org/repo",
    pr_title: "Test PR",
    pr_url: "https://github.com/org/repo/pull/1",
    contributor_login: login,
    risk_score: score,
    risk_level: level,
    action_taken: null,
    signals_json: JSON.stringify(signals),
    contributor_data_json: "{}",
  };
}

describe("database queries", () => {
  before(() => migrate());

  test("contributor upsert and fetch round-trips", () => {
    upsertContributor(contributor("alice"));
    const row = getContributor("alice");
    assert.strictEqual(row.github_login, "alice");
    assert.strictEqual(row.followers, 10);

    upsertContributor({ ...contributor("alice"), followers: 99 });
    assert.strictEqual(getContributor("alice").followers, 99);
  });

  test("activity round-trips with latest-first ordering", () => {
    upsertContributor(contributor("bob"));
    upsertContributorActivity({
      github_login: "bob",
      repos_contributed_to: 2,
      prs_last_30_days: 3,
      issue_comments_count: 4,
      code_reviews_count: 1,
      commit_hours_json: "[]",
      pr_sizes_json: "[]",
      commit_messages_json: "[]",
      event_times_json: "[\"2026-07-10T12:00:00Z\"]",
    });
    const row = getLatestContributorActivity("bob");
    assert.strictEqual(row.prs_last_30_days, 3);
    assert.strictEqual(row.event_times_json, "[\"2026-07-10T12:00:00Z\"]");
  });

  test("verified contributors round-trip, case-insensitively", () => {
    addVerifiedContributor("SomeUser", "dashboard", "longtime contributor");
    assert.strictEqual(isVerifiedContributor("someuser"), true);
    assert.strictEqual(isVerifiedContributor("SOMEUSER"), true);
    assert.strictEqual(isVerifiedContributor("other"), false);
    assert.ok(getVerifiedContributors().some((v) => v.github_login === "SomeUser"));

    removeVerifiedContributor("SomeUser");
    assert.strictEqual(isVerifiedContributor("someuser"), false);
  });

  test("scan stats aggregate levels and top signals", () => {
    upsertContributor(contributor("carol"));
    insertScan(scanFor("carol", 70, "critical", [{ name: "Spray Pattern" }, { name: "Ghost Profile" }]));
    insertScan(scanFor("carol", 45, "high", [{ name: "Ghost Profile" }]));
    insertScan(scanFor("carol", 5, "low", []));

    const stats = getScanStats(null);
    assert.ok(stats.total >= 3);
    assert.ok(stats.byLevel.critical >= 1);
    const ghost = stats.topSignals.find((s) => s.signal_name === "Ghost Profile");
    assert.ok(ghost && ghost.count >= 2, "top signals should count Ghost Profile twice");

    // Repo-filtered variant exercises the WHERE clause path
    const repoStats = getScanStats("org/repo");
    assert.ok(repoStats.total >= 3);
  });

  test("scans filter by risk level", () => {
    const critical = getScans({ riskLevel: "critical" });
    assert.ok(critical.length >= 1);
    assert.ok(critical.every((s) => s.risk_level === "critical"));
  });

  test("default policies are seeded and CRUD works", () => {
    const policies = getPolicies(null);
    assert.ok(policies.length >= 4, "default policies should be seeded");

    const created = createPolicy({
      installation_id: null,
      name: "Test Policy",
      description: "",
      rule_type: "score_range",
      threshold_min: 0,
      threshold_max: 10,
      action: "allow",
      enabled: 1,
      priority: 5,
      config_json: "{}",
    });
    const id = created.lastInsertRowid;

    updatePolicy(id, { enabled: 0, priority: 7 });
    const updated = getPolicies(null).find((p) => p.id === id);
    assert.strictEqual(updated.enabled, 0);
    assert.strictEqual(updated.priority, 7);

    deletePolicy(id);
    assert.strictEqual(getPolicies(null).find((p) => p.id === id), undefined);
  });

  test("installations round-trip", () => {
    upsertInstallation(555, "some-org", "Organization");
    assert.ok(getAllInstallations().some((i) => i.installation_id === 555));
    removeInstallation(555);
    assert.ok(!getAllInstallations().some((i) => i.installation_id === 555));
  });
});
