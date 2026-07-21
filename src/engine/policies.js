const { getPolicies } = require("../database/queries");
const { commentOnPR, labelPR, closePR } = require("../github/api");
const { config } = require("../config");
const { createLogger } = require("../utils/logger");

const log = createLogger("policy-engine");

/**
 * Evaluate policies against a scan result and execute the matching action.
 *
 * Policies are evaluated in priority order (highest first).
 * The first matching policy wins.
 */
async function evaluateAndEnforce(scanResult, prData, installationId) {
  const { risk_score, risk_level, signals } = scanResult;
  const { owner, repo, pr_number } = prData;

  // Get policies for this installation + global defaults
  const policies = getPolicies(installationId);
  const enabledPolicies = policies.filter(p => p.enabled);

  log.debug(`Evaluating ${enabledPolicies.length} policies for score=${risk_score} level=${risk_level}`);

  for (const policy of enabledPolicies) {
    const matches = evaluatePolicy(policy, scanResult);
    if (!matches) continue;

    log.info(`Policy "${policy.name}" matched for ${owner}/${repo}#${pr_number} (action: ${policy.action})`);

    if (config.enforcement.monitorOnly && policy.action !== "allow") {
      log.info(`[monitor-only] Would execute "${policy.action}" on ${owner}/${repo}#${pr_number} — no action taken`);
      return { policy: policy.name, action: policy.action, enforced: false };
    }

    try {
      await executeAction(policy.action, {
        owner, repo, pr_number, installationId,
        scanResult, policy,
      });
    } catch (err) {
      log.error(`Failed to execute policy action "${policy.action}"`, { error: err.message });
    }

    return { policy: policy.name, action: policy.action, enforced: true };
  }

  log.debug(`No policy matched for score=${risk_score}`);
  return { policy: null, action: "none", enforced: false };
}

/**
 * Check if a policy matches the scan result.
 */
function evaluatePolicy(policy, scanResult) {
  const { risk_score, risk_level, signals } = scanResult;

  switch (policy.rule_type) {
    case "score_range":
      return risk_score >= policy.threshold_min && risk_score <= policy.threshold_max;

    case "risk_level": {
      const config = JSON.parse(policy.config_json || "{}");
      return config.levels && config.levels.includes(risk_level);
    }

    case "signal_present": {
      const config = JSON.parse(policy.config_json || "{}");
      if (!config.signal_names) return false;
      return signals.some(s => config.signal_names.includes(s.name));
    }

    case "contributor_match": {
      const config = JSON.parse(policy.config_json || "{}");
      if (!config.logins) return false;
      return config.logins.includes(scanResult.contributor_login);
    }

    default:
      log.warn(`Unknown policy rule_type: ${policy.rule_type}`);
      return false;
  }
}

/**
 * Execute the enforcement action.
 */
async function executeAction(action, ctx) {
  const { owner, repo, pr_number, installationId, scanResult, policy } = ctx;

  switch (action) {
    case "close": {
      const body = formatCloseComment(scanResult, policy);
      await closePR(owner, repo, pr_number, body, installationId);
      break;
    }

    case "label": {
      const labels = [
        {
          name: `agentwall:${scanResult.risk_level}`,
          color: scanResult.risk_level === "critical" ? "e11d48" :
                 scanResult.risk_level === "high" ? "f59e0b" : "3b82f6",
          description: `AgentWall: ${scanResult.risk_level} risk (score: ${scanResult.risk_score})`,
        },
        {
          name: "agentwall:needs-review",
          color: "8b5cf6",
          description: "Flagged by AgentWall for maintainer review",
        },
      ];
      await labelPR(owner, repo, pr_number, labels, installationId);
      // Also add an informational comment
      const body = formatLabelComment(scanResult);
      await commentOnPR(owner, repo, pr_number, body, installationId);
      break;
    }

    case "comment": {
      const body = formatWarningComment(scanResult);
      await commentOnPR(owner, repo, pr_number, body, installationId);
      break;
    }

    case "require": {
      const body = formatRequireHumanComment(scanResult);
      await commentOnPR(owner, repo, pr_number, body, installationId);
      await labelPR(owner, repo, pr_number, [{
        name: "agentwall:human-required",
        color: "f59e0b",
        description: "AgentWall requires verified human operator",
      }], installationId);
      break;
    }

    case "allow":
      // Explicitly allowed, no action needed
      log.debug(`PR ${owner}/${repo}#${pr_number} explicitly allowed by policy`);
      break;

    default:
      log.warn(`Unknown action: ${action}`);
  }
}

// ── Comment Templates ───────────────────────────────────────────────

function formatCloseComment(scan, policy) {
  const signalList = scan.signals
    .map(s => `| ${s.name} | ${s.severity} | +${s.score} | ${s.detail} |`)
    .join("\n");

  return `## AgentWall: Contribution Blocked

This pull request has been automatically closed because the contributor's behavioral profile triggered AgentWall's protection system.

**Risk Score:** ${scan.risk_score}/100 (${scan.risk_level.toUpperCase()})
**Policy:** ${policy.name}

### Detection Signals

| Signal | Severity | Score | Detail |
|--------|----------|-------|--------|
${signalList}

### What does this mean?

AgentWall detected behavioral patterns consistent with an autonomous AI agent rather than a human contributor. This is not a judgment on the code quality — it's a policy enforcement measure to protect the integrity of this project's contribution process.

### If you're a human contributor

If you believe this is a false positive, please:
1. Complete your GitHub profile (avatar, bio, linked accounts)
2. Engage with the project community (issues, discussions, reviews)
3. Re-submit your contribution

### If you're an agent operator

Please register your agent with a verified human operator identity. Contact the maintainers to discuss agent contribution policies for this project.

---
*Posted by [AgentWall](https://github.com/apps/agentwall), an agent firewall for open source repositories.*`;
}

function formatLabelComment(scan) {
  const topSignals = scan.signals.slice(0, 3).map(s => `- **${s.name}** (${s.severity}): ${s.detail}`).join("\n");

  return `## AgentWall: Flagged for Review

This PR has been flagged by AgentWall for maintainer review.

**Risk Score:** ${scan.risk_score}/100 (${scan.risk_level.toUpperCase()})

**Top Signals:**
${topSignals}

This PR has not been auto-closed but has been labeled for prioritized review. Maintainers: please verify this contribution before merging.

---
*Posted by [AgentWall](https://github.com/apps/agentwall).*`;
}

function formatWarningComment(scan) {
  return `## AgentWall: Notice

AgentWall has detected some behavioral patterns worth noting for this contribution (score: ${scan.risk_score}/100).

This is informational only; no action has been taken. Maintainers may want to review this contributor's profile.

---
*Posted by [AgentWall](https://github.com/apps/agentwall).*`;
}

function formatRequireHumanComment(scan) {
  return `## AgentWall: Human Attribution Required

This project requires contributions from flagged accounts to include verified human operator attribution.

**Risk Score:** ${scan.risk_score}/100 (${scan.risk_level.toUpperCase()})

Please respond to this comment with:
1. The name and GitHub handle of the human operator responsible for this contribution
2. Confirmation that a human reviewed and approved this code before submission

This PR will remain on hold until human attribution is provided.

---
*Posted by [AgentWall](https://github.com/apps/agentwall).*`;
}

module.exports = { evaluateAndEnforce, evaluatePolicy };
