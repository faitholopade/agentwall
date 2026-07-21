const { test, describe } = require("node:test");
const assert = require("node:assert");

const { evaluatePolicy } = require("../src/engine/policies");

function scan(overrides = {}) {
  return {
    contributor_login: "someuser",
    risk_score: 65,
    risk_level: "critical",
    signals: [{ name: "Spray Pattern", severity: "critical", score: 22, detail: "" }],
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  test("score_range matches inclusive bounds", () => {
    const policy = { rule_type: "score_range", threshold_min: 60, threshold_max: 100 };
    assert.strictEqual(evaluatePolicy(policy, scan({ risk_score: 60 })), true);
    assert.strictEqual(evaluatePolicy(policy, scan({ risk_score: 100 })), true);
    assert.strictEqual(evaluatePolicy(policy, scan({ risk_score: 59 })), false);
  });

  test("risk_level matches configured levels", () => {
    const policy = { rule_type: "risk_level", config_json: JSON.stringify({ levels: ["critical", "high"] }) };
    assert.strictEqual(evaluatePolicy(policy, scan({ risk_level: "critical" })), true);
    assert.strictEqual(evaluatePolicy(policy, scan({ risk_level: "low" })), false);
  });

  test("signal_present matches by signal name", () => {
    const policy = { rule_type: "signal_present", config_json: JSON.stringify({ signal_names: ["Spray Pattern"] }) };
    assert.strictEqual(evaluatePolicy(policy, scan()), true);
    assert.strictEqual(evaluatePolicy(policy, scan({ signals: [] })), false);
  });

  test("contributor_match matches by login", () => {
    const policy = { rule_type: "contributor_match", config_json: JSON.stringify({ logins: ["someuser"] }) };
    assert.strictEqual(evaluatePolicy(policy, scan()), true);
    assert.strictEqual(evaluatePolicy(policy, scan({ contributor_login: "other" })), false);
  });

  test("unknown rule type never matches", () => {
    assert.strictEqual(evaluatePolicy({ rule_type: "nonsense" }, scan()), false);
  });
});
