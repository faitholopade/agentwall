const { test, describe } = require("node:test");
const assert = require("node:assert");

const {
  signalActivityRampup,
  signalCommitTiming,
  signalSprayPattern,
  signalCommunityEngagement,
  signalProfileCompleteness,
  signalPRUniformity,
  signalCommitMessageEntropy,
  signalAgentAttribution,
  signalNewbornAccount,
  signalNoSleepPattern,
  findMarathonDays,
  circularStandardDeviationHours,
  shannonEntropy,
} = require("../src/engine/signals");

// Helpers to build fixture data
function profile(overrides = {}) {
  return {
    github_login: "testuser",
    account_created_at: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(),
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    bio: "I write code",
    has_linked_socials: 1,
    public_repos: 10,
    followers: 25,
    ...overrides,
  };
}

function activity(overrides = {}) {
  return {
    github_login: "testuser",
    repos_contributed_to: 3,
    prs_last_30_days: 4,
    issue_comments_count: 10,
    code_reviews_count: 5,
    commit_hours_json: JSON.stringify([9, 14, 18, 22, 11, 20, 16]),
    pr_sizes_json: JSON.stringify([12, 300, 45, 800, 90]),
    commit_messages_json: JSON.stringify([
      "fix flaky retry logic in scheduler",
      "add pagination to the search endpoint",
      "refactor config loading",
      "bump deps and fix lint",
      "handle empty response from upstream API",
    ]),
    ...overrides,
  };
}

describe("circularStandardDeviationHours", () => {
  test("midnight-crossing cluster measures as tight", () => {
    const sd = circularStandardDeviationHours([23.97, 0.02, 23.98, 0.03, 0.0]);
    assert.ok(sd < 0.5, `expected < 0.5, got ${sd}`);
  });

  test("spread-out human schedule measures as loose", () => {
    const sd = circularStandardDeviationHours([9, 14, 18, 22, 11, 20, 16]);
    assert.ok(sd > 1.5, `expected > 1.5, got ${sd}`);
  });

  test("returns Infinity with insufficient data", () => {
    assert.strictEqual(circularStandardDeviationHours([12]), Infinity);
  });
});

describe("signalActivityRampup", () => {
  test("triggers critical for hyperactive new account", () => {
    const p = profile({ account_created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() });
    const a = activity({ prs_last_30_days: 60, issue_comments_count: 0, code_reviews_count: 0 });
    const r = signalActivityRampup(p, a);
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.severity, "critical");
  });

  test("does not trigger for established account", () => {
    const r = signalActivityRampup(profile(), activity());
    assert.strictEqual(r.triggered, false);
  });
});

describe("signalCommitTiming", () => {
  test("triggers on robotic midnight-crossing schedule", () => {
    const a = activity({ commit_hours_json: JSON.stringify([23.97, 0.02, 23.98, 0.03, 0.0]) });
    const r = signalCommitTiming(profile(), a);
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.severity, "critical");
  });

  test("does not trigger on varied human schedule", () => {
    const r = signalCommitTiming(profile(), activity());
    assert.strictEqual(r.triggered, false);
  });

  test("does not trigger with fewer than 5 samples", () => {
    const a = activity({ commit_hours_json: JSON.stringify([12, 12, 12]) });
    assert.strictEqual(signalCommitTiming(profile(), a).triggered, false);
  });
});

describe("signalSprayPattern", () => {
  test("triggers critical for many repos and PRs", () => {
    const a = activity({ repos_contributed_to: 20, prs_last_30_days: 25 });
    const r = signalSprayPattern(profile(), a);
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.severity, "critical");
  });

  test("does not trigger for focused contributor", () => {
    assert.strictEqual(signalSprayPattern(profile(), activity()).triggered, false);
  });
});

describe("signalCommunityEngagement", () => {
  test("triggers when many PRs but no discussion", () => {
    const a = activity({ prs_last_30_days: 10, issue_comments_count: 0, code_reviews_count: 0 });
    const r = signalCommunityEngagement(profile(), a);
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.severity, "high");
  });

  test("skips judgement with too few PRs", () => {
    const a = activity({ prs_last_30_days: 2, issue_comments_count: 0, code_reviews_count: 0 });
    assert.strictEqual(signalCommunityEngagement(profile(), a).triggered, false);
  });
});

describe("signalProfileCompleteness", () => {
  test("triggers on ghost profile", () => {
    const p = profile({ avatar_url: "https://identicons.github.com/x.png", bio: null, has_linked_socials: 0, followers: 0 });
    const r = signalProfileCompleteness(p, activity());
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.name, "Ghost Profile");
  });

  test("does not trigger on complete profile", () => {
    assert.strictEqual(signalProfileCompleteness(profile(), activity()).triggered, false);
  });
});

describe("signalPRUniformity", () => {
  test("triggers on suspiciously uniform PR sizes", () => {
    const a = activity({ pr_sizes_json: JSON.stringify([100, 102, 98, 101, 99, 100]) });
    const r = signalPRUniformity(profile(), a);
    assert.strictEqual(r.triggered, true);
  });

  test("does not trigger on varied sizes", () => {
    assert.strictEqual(signalPRUniformity(profile(), activity()).triggered, false);
  });
});

describe("signalCommitMessageEntropy", () => {
  test("triggers on templated messages", () => {
    const a = activity({
      commit_messages_json: JSON.stringify([
        "update file", "update file", "update file", "update file", "update file",
      ]),
    });
    const r = signalCommitMessageEntropy(profile(), a);
    assert.strictEqual(r.triggered, true);
  });

  test("does not trigger on varied messages", () => {
    assert.strictEqual(signalCommitMessageEntropy(profile(), activity()).triggered, false);
  });
});

describe("signalAgentAttribution", () => {
  test("does not run without PR context", () => {
    assert.strictEqual(signalAgentAttribution(profile(), activity()).triggered, false);
    assert.strictEqual(signalAgentAttribution(profile(), activity(), null).triggered, false);
  });

  test("detects Claude co-author trailer in commit messages", () => {
    const ctx = {
      pr_title: "Fix bug",
      pr_body: null,
      commit_messages: ["Fix bug\n\nCo-Authored-By: Claude <noreply@anthropic.com>"],
    };
    const r = signalAgentAttribution(profile(), activity(), ctx);
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.name, "Explicit Agent Attribution");
  });

  test("detects generation marker in PR body", () => {
    const ctx = {
      pr_title: "Add feature",
      pr_body: "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      commit_messages: [],
    };
    assert.strictEqual(signalAgentAttribution(profile(), activity(), ctx).triggered, true);
  });

  test("does not flag a human co-author", () => {
    const ctx = {
      pr_title: "Add feature",
      pr_body: "Pair-programmed this.",
      commit_messages: ["Add feature\n\nCo-Authored-By: Jane Doe <jane@example.com>"],
    };
    assert.strictEqual(signalAgentAttribution(profile(), activity(), ctx).triggered, false);
  });
});

describe("signalNewbornAccount", () => {
  test("triggers high for a day-old account", () => {
    const p = profile({ account_created_at: new Date(Date.now() - 12 * 3600 * 1000).toISOString() });
    const r = signalNewbornAccount(p);
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.name, "Newborn Account");
    assert.strictEqual(r.severity, "high");
  });

  test("triggers medium for a 5-day-old account", () => {
    const p = profile({ account_created_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString() });
    const r = signalNewbornAccount(p);
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.name, "Fresh Account");
  });

  test("does not trigger for established or unknown accounts", () => {
    assert.strictEqual(signalNewbornAccount(profile()).triggered, false);
    assert.strictEqual(signalNewbornAccount(profile({ account_created_at: null })).triggered, false);
  });
});

describe("signalNoSleepPattern / findMarathonDays", () => {
  // Build ISO timestamps on a given day at the given decimal hours
  function day(dateStr, hours) {
    return hours.map((h) => {
      const hh = Math.floor(h);
      const mm = Math.round((h - hh) * 60);
      return `${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`;
    });
  }

  const marathonHours = [0, 1.5, 3, 4.5, 6, 8, 10, 12, 14, 16, 18, 20, 21.5, 23]; // 23h span, max gap 2h
  const humanHours = [9, 10, 11.5, 13, 15, 16, 17.5, 19, 20, 21]; // sleeps overnight

  test("flags days with 18h+ activity and no 3h rest gap", () => {
    const days = findMarathonDays(day("2026-07-10", marathonHours));
    assert.deepStrictEqual(days, ["2026-07-10"]);
  });

  test("does not flag a normal human workday", () => {
    assert.deepStrictEqual(findMarathonDays(day("2026-07-10", humanHours)), []);
  });

  test("two marathon days trigger critical", () => {
    const times = [...day("2026-07-10", marathonHours), ...day("2026-07-12", marathonHours)];
    const r = signalNoSleepPattern(profile(), activity({ event_times_json: JSON.stringify(times) }));
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.severity, "critical");
  });

  test("one marathon day triggers medium only", () => {
    const times = [...day("2026-07-10", marathonHours), ...day("2026-07-11", humanHours)];
    const r = signalNoSleepPattern(profile(), activity({ event_times_json: JSON.stringify(times) }));
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.severity, "medium");
  });

  test("does not trigger without stored event times", () => {
    const r = signalNoSleepPattern(profile(), activity());
    assert.strictEqual(r.triggered, false);
  });
});

describe("shannonEntropy", () => {
  test("identical messages have zero entropy", () => {
    assert.strictEqual(shannonEntropy(["update", "update", "update"]), 0);
  });

  test("varied messages have higher entropy", () => {
    const varied = shannonEntropy(["fix parser edge case", "add streaming support", "remove dead code"]);
    assert.ok(varied > 2);
  });
});
