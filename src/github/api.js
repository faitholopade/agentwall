const { getInstallationOctokit, getAppOctokit, getPublicOctokit } = require("./app");
const { createLogger } = require("../utils/logger");

const log = createLogger("github-api");

/**
 * Sync installations from the GitHub API into the local database.
 * Run at startup so the app works even when it isn't subscribed to
 * installation webhook events.
 */
async function syncInstallations() {
  const { upsertInstallation } = require("../database/queries");
  try {
    const octokit = getAppOctokit();
    const { data } = await octokit.request("GET /app/installations", { per_page: 100 });
    for (const inst of data) {
      upsertInstallation(inst.id, inst.account.login, inst.account.type);
    }
    log.info(`Synced ${data.length} installation(s) from GitHub`);
    return data.length;
  } catch (err) {
    log.warn("Installation sync failed (check GitHub App credentials)", { error: err.message });
    return 0;
  }
}

/**
 * Fetch a user's public profile from GitHub.
 */
async function fetchUserProfile(username, installationId = null) {
  try {
    const octokit = installationId ? getInstallationOctokit(installationId) : getPublicOctokit();
    const { data } = await octokit.users.getByUsername({ username });

    return {
      github_login: data.login,
      github_id: data.id,
      account_created_at: data.created_at,
      avatar_url: data.avatar_url,
      bio: data.bio || null,
      has_linked_socials: (data.blog || data.twitter_username || data.company) ? 1 : 0,
      total_contributions: 0, // populated separately
      public_repos: data.public_repos,
      followers: data.followers,
      following: data.following,
    };
  } catch (err) {
    log.error(`Failed to fetch profile for ${username}`, { error: err.message });
    return null;
  }
}

/**
 * Fetch recent PR events across GitHub for a user.
 * Uses the Events API to get activity across all repos.
 */
async function fetchUserEvents(username, installationId = null) {
  try {
    const octokit = installationId ? getInstallationOctokit(installationId) : getPublicOctokit();

    // Get up to 10 pages of events (300 events, ~90 days usually)
    let allEvents = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await octokit.activity.listPublicEventsForUser({
        username,
        per_page: 30,
        page,
      });
      if (data.length === 0) break;
      allEvents = allEvents.concat(data);
    }

    return allEvents;
  } catch (err) {
    log.error(`Failed to fetch events for ${username}`, { error: err.message });
    return [];
  }
}

/**
 * Analyze events to extract behavioral signals.
 * Returns structured activity data for the scoring engine.
 */
function analyzeEvents(events, username) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Track unique repos
  const repos = new Set();
  const commitHours = [];
  const prSizesByKey = new Map(); // dedupe: multiple events fire for the same PR
  const commitMessages = [];
  const eventTimes = [];
  let prCount30d = 0;
  let issueCommentCount = 0;
  let reviewCount = 0;
  let pushEventCount = 0;

  for (const event of events) {
    const eventDate = new Date(event.created_at);
    const isRecent = eventDate >= thirtyDaysAgo;

    if (event.repo) {
      repos.add(event.repo.name);
    }
    if (event.created_at) {
      eventTimes.push(event.created_at);
    }

    switch (event.type) {
      case "PullRequestEvent": {
        if (isRecent && event.payload?.action === "opened") prCount30d++;
        const pr = event.payload?.pull_request;
        if (pr) {
          const key = `${event.repo?.name}#${pr.number}`;
          prSizesByKey.set(key, (pr.additions || 0) + (pr.deletions || 0));
        }
        break;
      }
      case "PullRequestReviewEvent": {
        reviewCount++;
        break;
      }
      case "IssueCommentEvent":
      case "CommitCommentEvent": {
        issueCommentCount++;
        break;
      }
      case "PushEvent": {
        pushEventCount++;
        // One timing sample per push: all commits in a push share the push
        // timestamp, so per-commit sampling would fake low variance.
        // UTC keeps results independent of the server's timezone.
        commitHours.push(eventDate.getUTCHours() + eventDate.getUTCMinutes() / 60);
        const commits = event.payload?.commits || [];
        for (const commit of commits) {
          if (commit.message) {
            commitMessages.push(commit.message);
          }
        }
        break;
      }
    }
  }
  const prSizes = Array.from(prSizesByKey.values());

  return {
    github_login: username,
    repos_contributed_to: repos.size,
    prs_last_30_days: prCount30d,
    issue_comments_count: issueCommentCount,
    code_reviews_count: reviewCount,
    commit_hours_json: JSON.stringify(commitHours),
    pr_sizes_json: JSON.stringify(prSizes),
    commit_messages_json: JSON.stringify(commitMessages.slice(0, 100)), // cap at 100
    event_times_json: JSON.stringify(eventTimes.slice(0, 300)),
  };
}

/**
 * Fetch a specific PR's details including files changed.
 */
async function fetchPRDetails(owner, repo, prNumber, installationId) {
  try {
    const octokit = getInstallationOctokit(installationId);
    const [prResp, filesResp] = await Promise.all([
      octokit.pulls.get({ owner, repo, pull_number: prNumber }),
      octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 }),
    ]);

    return {
      pr: prResp.data,
      files: filesResp.data,
    };
  } catch (err) {
    log.error(`Failed to fetch PR #${prNumber} from ${owner}/${repo}`, { error: err.message });
    return null;
  }
}

/**
 * Fetch the commit messages of a specific PR (for PR-level signals).
 */
async function fetchPRCommitMessages(owner, repo, prNumber, installationId) {
  try {
    const octokit = getInstallationOctokit(installationId);
    const { data } = await octokit.pulls.listCommits({
      owner, repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return data.map((c) => c.commit?.message).filter(Boolean);
  } catch (err) {
    log.error(`Failed to fetch commits for ${owner}/${repo}#${prNumber}`, { error: err.message });
    return [];
  }
}

/**
 * Post a comment on a PR.
 */
async function commentOnPR(owner, repo, prNumber, body, installationId) {
  try {
    const octokit = getInstallationOctokit(installationId);
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    log.info(`Commented on ${owner}/${repo}#${prNumber}`);
  } catch (err) {
    log.error(`Failed to comment on PR`, { error: err.message });
  }
}

/**
 * Add labels to a PR.
 */
async function labelPR(owner, repo, prNumber, labels, installationId) {
  try {
    const octokit = getInstallationOctokit(installationId);

    // Ensure labels exist
    for (const label of labels) {
      try {
        await octokit.issues.createLabel({
          owner, repo,
          name: label.name,
          color: label.color || "e11d48",
          description: label.description || "Added by AgentWall",
        });
      } catch (e) {
        // Label already exists, that's fine
      }
    }

    await octokit.issues.addLabels({
      owner, repo,
      issue_number: prNumber,
      labels: labels.map(l => l.name),
    });
    log.info(`Labeled ${owner}/${repo}#${prNumber} with ${labels.map(l => l.name).join(", ")}`);
  } catch (err) {
    log.error(`Failed to label PR`, { error: err.message });
  }
}

/**
 * Post a check run on the PR's head commit summarizing the scan. Lets
 * maintainers gate merges via branch protection ("require AgentWall").
 * Degrades gracefully when the app lacks the Checks permission.
 */
async function postScanCheckRun(owner, repo, headSha, scanResult, enforcement, installationId) {
  try {
    const octokit = getInstallationOctokit(installationId);
    const { risk_score, risk_level, signals } = scanResult;

    const conclusion =
      risk_level === "critical" || risk_level === "high" ? "failure" :
      risk_level === "medium" ? "neutral" : "success";

    const signalRows = signals.length
      ? signals.map((s) => `| ${s.name} | ${s.severity} | +${s.score} | ${s.detail} |`).join("\n")
      : "| _None triggered_ | | | |";

    const actionLine = enforcement && enforcement.action !== "none"
      ? `**Policy action:** ${enforcement.enforced ? "" : "(monitor-only, simulated) "}\`${enforcement.action}\` via "${enforcement.policy}"`
      : "**Policy action:** none";

    await octokit.checks.create({
      owner, repo,
      head_sha: headSha,
      name: "AgentWall",
      status: "completed",
      conclusion,
      output: {
        title: `Risk ${risk_score}/100 (${risk_level})`,
        summary: `## AgentWall Contributor Analysis

**Risk Score:** ${risk_score}/100 — **${risk_level.toUpperCase()}**
${actionLine}

| Signal | Severity | Score | Detail |
|--------|----------|-------|--------|
${signalRows}
`,
      },
    });
    log.info(`Posted check run on ${owner}/${repo}@${headSha.slice(0, 7)}: ${conclusion}`);
  } catch (err) {
    if (err.status === 403) {
      log.warn("Check run rejected — grant the app 'Checks: Read & write' permission to enable merge gating");
    } else {
      log.error("Failed to post check run", { error: err.message });
    }
  }
}

/**
 * Close a PR with a comment explaining why.
 */
async function closePR(owner, repo, prNumber, reason, installationId) {
  try {
    const octokit = getInstallationOctokit(installationId);
    await octokit.issues.createComment({
      owner, repo,
      issue_number: prNumber,
      body: reason,
    });
    await octokit.pulls.update({
      owner, repo,
      pull_number: prNumber,
      state: "closed",
    });
    log.info(`Closed ${owner}/${repo}#${prNumber}`);
  } catch (err) {
    log.error(`Failed to close PR`, { error: err.message });
  }
}

module.exports = {
  syncInstallations,
  fetchUserProfile,
  fetchUserEvents,
  analyzeEvents,
  fetchPRDetails,
  fetchPRCommitMessages,
  postScanCheckRun,
  commentOnPR,
  labelPR,
  closePR,
};
