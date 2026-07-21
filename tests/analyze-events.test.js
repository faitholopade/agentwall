const { test, describe } = require("node:test");
const assert = require("node:assert");

const { analyzeEvents } = require("../src/github/api");

function daysAgo(n, hourUTC = 12) {
  const d = new Date(Date.now() - n * 24 * 3600 * 1000);
  d.setUTCHours(hourUTC, 0, 0, 0);
  return d.toISOString();
}

describe("analyzeEvents", () => {
  test("counts only opened PRs within 30 days", () => {
    const events = [
      { type: "PullRequestEvent", created_at: daysAgo(5), repo: { name: "a/x" }, payload: { action: "opened", pull_request: { number: 1, additions: 10, deletions: 2 } } },
      { type: "PullRequestEvent", created_at: daysAgo(6), repo: { name: "a/x" }, payload: { action: "closed", pull_request: { number: 1, additions: 10, deletions: 2 } } },
      { type: "PullRequestEvent", created_at: daysAgo(45), repo: { name: "a/y" }, payload: { action: "opened", pull_request: { number: 2, additions: 5, deletions: 5 } } },
    ];
    const result = analyzeEvents(events, "u");
    assert.strictEqual(result.prs_last_30_days, 1);
  });

  test("dedupes PR sizes across multiple events for the same PR", () => {
    const events = [
      { type: "PullRequestEvent", created_at: daysAgo(1), repo: { name: "a/x" }, payload: { action: "opened", pull_request: { number: 7, additions: 100, deletions: 50 } } },
      { type: "PullRequestEvent", created_at: daysAgo(1), repo: { name: "a/x" }, payload: { action: "closed", pull_request: { number: 7, additions: 100, deletions: 50 } } },
    ];
    const result = analyzeEvents(events, "u");
    assert.deepStrictEqual(JSON.parse(result.pr_sizes_json), [150]);
  });

  test("samples one timing point per push regardless of commit count", () => {
    const events = [
      {
        type: "PushEvent", created_at: daysAgo(2, 14), repo: { name: "a/x" },
        payload: { commits: [{ message: "one" }, { message: "two" }, { message: "three" }] },
      },
    ];
    const result = analyzeEvents(events, "u");
    const hours = JSON.parse(result.commit_hours_json);
    assert.strictEqual(hours.length, 1);
    assert.strictEqual(hours[0], 14);
    assert.deepStrictEqual(JSON.parse(result.commit_messages_json), ["one", "two", "three"]);
  });

  test("counts unique repos and engagement events", () => {
    const events = [
      { type: "IssueCommentEvent", created_at: daysAgo(1), repo: { name: "a/x" }, payload: {} },
      { type: "PullRequestReviewEvent", created_at: daysAgo(2), repo: { name: "b/y" }, payload: {} },
      { type: "CommitCommentEvent", created_at: daysAgo(3), repo: { name: "c/z" }, payload: {} },
    ];
    const result = analyzeEvents(events, "u");
    assert.strictEqual(result.repos_contributed_to, 3);
    assert.strictEqual(result.issue_comments_count, 2);
    assert.strictEqual(result.code_reviews_count, 1);
  });
});
