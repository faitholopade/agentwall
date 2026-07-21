/**
 * AgentWall Detection Signals
 *
 * Each signal is a function that takes a contributor profile + activity data
 * and returns { triggered: boolean, name, severity, score, detail }.
 *
 * Severity levels: critical (20-25pts), high (12-18pts), medium (8-10pts), low (3-5pts)
 */

// ── Helper: statistical functions ───────────────────────────────────

function variance(arr) {
  if (arr.length < 2) return Infinity; // not enough data, don't trigger
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (arr.length - 1);
}

function standardDeviation(arr) {
  return Math.sqrt(variance(arr));
}

/**
 * Standard deviation for hour-of-day values (0-24), treating the day as a
 * circle so a schedule spanning midnight (23:50, 00:10, ...) measures as
 * tightly clustered instead of wildly variable. Returns hours.
 */
function circularStandardDeviationHours(hours) {
  if (hours.length < 2) return Infinity; // not enough data, don't trigger
  let sumSin = 0;
  let sumCos = 0;
  for (const h of hours) {
    const angle = (h / 24) * 2 * Math.PI;
    sumSin += Math.sin(angle);
    sumCos += Math.cos(angle);
  }
  const R = Math.sqrt(sumSin ** 2 + sumCos ** 2) / hours.length;
  if (R <= 0) return 12; // uniformly spread — maximum dispersion
  const sdRadians = Math.sqrt(-2 * Math.log(Math.min(R, 1)));
  return sdRadians * (24 / (2 * Math.PI));
}

function shannonEntropy(strings) {
  if (strings.length === 0) return Infinity;

  // Tokenize: split all messages into words, count frequencies
  const wordCounts = {};
  let totalWords = 0;
  for (const s of strings) {
    const words = s.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    for (const w of words) {
      wordCounts[w] = (wordCounts[w] || 0) + 1;
      totalWords++;
    }
  }

  if (totalWords === 0) return 0;

  let entropy = 0;
  for (const count of Object.values(wordCounts)) {
    const p = count / totalWords;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ── Signal 1: Account Age vs Activity Volume ────────────────────────

function signalActivityRampup(profile, activity) {
  const accountCreated = new Date(profile.account_created_at);
  const accountAgeDays = Math.max(1, (Date.now() - accountCreated.getTime()) / (1000 * 60 * 60 * 24));
  const totalContributions = activity.prs_last_30_days + activity.issue_comments_count + activity.code_reviews_count;
  const dailyRate = totalContributions / Math.min(accountAgeDays, 30);

  if (dailyRate > 5 && accountAgeDays < 90) {
    return {
      triggered: true,
      name: "Hyperspeed Ramp-up",
      severity: "critical",
      score: 25,
      detail: `${totalContributions} activities in ${Math.floor(accountAgeDays)} day-old account (${dailyRate.toFixed(1)}/day)`,
    };
  }
  if (dailyRate > 2 && accountAgeDays < 180) {
    return {
      triggered: true,
      name: "Rapid Activity Growth",
      severity: "high",
      score: 15,
      detail: `${dailyRate.toFixed(1)} activities/day is unusually high for a ${Math.floor(accountAgeDays)}-day account`,
    };
  }
  return { triggered: false };
}

// ── Signal 2: Commit Timing Regularity ──────────────────────────────

function signalCommitTiming(profile, activity) {
  const hours = JSON.parse(activity.commit_hours_json || "[]");
  if (hours.length < 5) return { triggered: false }; // not enough data

  const sd = circularStandardDeviationHours(hours);

  if (sd < 0.5) {
    return {
      triggered: true,
      name: "Robotic Timing",
      severity: "critical",
      score: 20,
      detail: `Commits show near-zero variance in timing (σ=${sd.toFixed(2)}h). Humans vary by 4-6 hours typically.`,
    };
  }
  if (sd < 1.5) {
    return {
      triggered: true,
      name: "Suspicious Timing Regularity",
      severity: "medium",
      score: 8,
      detail: `Commit timing variance (σ=${sd.toFixed(2)}h) is lower than typical human patterns`,
    };
  }
  return { triggered: false };
}

// ── Signal 3: Multi-Repo Spray Pattern ──────────────────────────────

function signalSprayPattern(profile, activity) {
  const repos = activity.repos_contributed_to;
  const prs = activity.prs_last_30_days;

  if (repos > 15 && prs > 20) {
    return {
      triggered: true,
      name: "Spray Pattern",
      severity: "critical",
      score: 22,
      detail: `${prs} PRs across ${repos} repos in 30 days. Typical human contributors focus on 1-5 repos.`,
    };
  }
  if (repos > 8 && prs > 10) {
    return {
      triggered: true,
      name: "Wide Distribution",
      severity: "high",
      score: 12,
      detail: `Contributing to ${repos} repos with ${prs} PRs in 30 days`,
    };
  }
  return { triggered: false };
}

// ── Signal 4: Community Engagement Ratio ────────────────────────────

function signalCommunityEngagement(profile, activity) {
  const engagement = activity.issue_comments_count + activity.code_reviews_count;
  const contributions = activity.prs_last_30_days;
  if (contributions < 3) return { triggered: false }; // too few PRs to judge

  const ratio = engagement / Math.max(contributions, 1);

  if (ratio < 0.05 && contributions > 5) {
    return {
      triggered: true,
      name: "Zero Community Engagement",
      severity: "high",
      score: 18,
      detail: `${engagement} comments/reviews vs ${contributions} PRs (ratio: ${ratio.toFixed(2)}). Agents submit code without participating in discussions.`,
    };
  }
  if (ratio < 0.15) {
    return {
      triggered: true,
      name: "Low Community Engagement",
      severity: "medium",
      score: 8,
      detail: `Engagement ratio of ${ratio.toFixed(2)} is below typical contributor patterns`,
    };
  }
  return { triggered: false };
}

// ── Signal 5: Profile Completeness ──────────────────────────────────

function signalProfileCompleteness(profile, activity) {
  const hasAvatar = profile.avatar_url && !profile.avatar_url.includes("identicons");
  const hasBio = !!profile.bio && profile.bio.length > 0;
  const hasSocials = profile.has_linked_socials === 1;
  const hasFollowers = profile.followers > 2;

  const completeness = [hasAvatar, hasBio, hasSocials, hasFollowers].filter(Boolean).length;

  if (completeness === 0) {
    return {
      triggered: true,
      name: "Ghost Profile",
      severity: "high",
      score: 15,
      detail: "No custom avatar, bio, linked accounts, or followers. Default GitHub profile.",
    };
  }
  if (completeness === 1) {
    return {
      triggered: true,
      name: "Sparse Profile",
      severity: "low",
      score: 5,
      detail: `Only ${completeness}/4 profile signals present`,
    };
  }
  return { triggered: false };
}

// ── Signal 6: PR Size Uniformity ────────────────────────────────────

function signalPRUniformity(profile, activity) {
  const sizes = JSON.parse(activity.pr_sizes_json || "[]");
  if (sizes.length < 4) return { triggered: false };

  const sd = standardDeviation(sizes);
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const cv = mean > 0 ? sd / mean : 0; // coefficient of variation

  if (cv < 0.15 && sizes.length >= 5) {
    return {
      triggered: true,
      name: "Template Code Pattern",
      severity: "high",
      score: 16,
      detail: `PRs are suspiciously uniform in size (mean=${mean.toFixed(0)} lines, CV=${cv.toFixed(2)}). Suggests automated generation.`,
    };
  }
  if (cv < 0.25 && sizes.length >= 5) {
    return {
      triggered: true,
      name: "Low Size Variance",
      severity: "medium",
      score: 8,
      detail: `PR sizes show lower variance than typical human work patterns`,
    };
  }
  return { triggered: false };
}

// ── Signal 7: Commit Message Entropy ────────────────────────────────

function signalCommitMessageEntropy(profile, activity) {
  const messages = JSON.parse(activity.commit_messages_json || "[]");
  if (messages.length < 5) return { triggered: false };

  const entropy = shannonEntropy(messages);

  if (entropy < 2) {
    return {
      triggered: true,
      name: "Formulaic Messages",
      severity: "medium",
      score: 10,
      detail: `Commit messages have very low entropy (${entropy.toFixed(2)} bits). Suggests templated or auto-generated messages.`,
    };
  }
  if (entropy < 3) {
    return {
      triggered: true,
      name: "Repetitive Messages",
      severity: "low",
      score: 5,
      detail: `Commit message entropy (${entropy.toFixed(2)} bits) is below typical human variation`,
    };
  }
  return { triggered: false };
}

// ── Signal 8: Newborn Account ───────────────────────────────────────

function signalNewbornAccount(profile) {
  if (!profile.account_created_at) return { triggered: false };
  const ageDays = (Date.now() - new Date(profile.account_created_at).getTime()) / (1000 * 60 * 60 * 24);

  if (ageDays >= 0 && ageDays < 2) {
    return {
      triggered: true,
      name: "Newborn Account",
      severity: "high",
      score: 18,
      detail: `Account created ${ageDays < 1 ? "today" : "yesterday"} and already submitting code. Agents spin up fresh accounts; humans rarely contribute on day one.`,
    };
  }
  if (ageDays >= 0 && ageDays < 7) {
    return {
      triggered: true,
      name: "Fresh Account",
      severity: "medium",
      score: 10,
      detail: `Account is only ${Math.floor(ageDays)} days old`,
    };
  }
  return { triggered: false };
}

// ── Signal 9: No-Sleep Marathon ─────────────────────────────────────

/**
 * Detects days where activity spans 18+ hours with no break longer than
 * 3 hours. Humans sleep; agents grinding through a queue don't. Complements
 * Robotic Timing — a bot active around the clock has HIGH timing variance
 * and evades that signal, but cannot fake a rest gap.
 */
function findMarathonDays(eventTimes) {
  const byDay = new Map();
  for (const t of eventTimes) {
    const d = new Date(t);
    if (isNaN(d.getTime())) continue;
    const day = d.toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(d.getTime());
  }

  const marathonDays = [];
  for (const [day, times] of byDay) {
    if (times.length < 10) continue; // need enough events to establish coverage
    times.sort((a, b) => a - b);
    const spanHours = (times[times.length - 1] - times[0]) / 3600000;
    if (spanHours < 18) continue;
    let maxGapHours = 0;
    for (let i = 1; i < times.length; i++) {
      maxGapHours = Math.max(maxGapHours, (times[i] - times[i - 1]) / 3600000);
    }
    if (maxGapHours <= 3) marathonDays.push(day);
  }
  return marathonDays;
}

function signalNoSleepPattern(profile, activity) {
  const eventTimes = JSON.parse(activity.event_times_json || "[]");
  if (eventTimes.length < 10) return { triggered: false };

  const marathonDays = findMarathonDays(eventTimes);

  if (marathonDays.length >= 2) {
    return {
      triggered: true,
      name: "No-Sleep Marathon",
      severity: "critical",
      score: 22,
      detail: `${marathonDays.length} days with 18+ hours of continuous activity and no rest gap over 3h (${marathonDays.slice(0, 3).join(", ")}). Humans sleep.`,
    };
  }
  if (marathonDays.length === 1) {
    return {
      triggered: true,
      name: "Marathon Session",
      severity: "medium",
      score: 8,
      detail: `18+ hours of continuous activity on ${marathonDays[0]} with no rest gap over 3h`,
    };
  }
  return { triggered: false };
}

// ── Signal 10: Explicit Agent Attribution (PR-level) ────────────────

const AGENT_ATTRIBUTION_PATTERNS = [
  { re: /co-authored-by:[^\n]*\b(claude|copilot|chatgpt|openai|codex|cursor|devin|aider|windsurf|gemini|sweep[- ]?ai|goose)\b/i, label: "AI co-author trailer" },
  { re: /generated (with|by) \[?(claude|claude code|github copilot|copilot workspace|chatgpt|codex|cursor|devin|aider|openhands|sweep)/i, label: "generation marker" },
  { re: /🤖 generated with/i, label: "generation marker" },
  { re: /noreply@anthropic\.com|copilot@github\.com/i, label: "AI author email" },
  { re: /this (pr|pull request|patch|change) was (created|generated|written|authored) (by|using) an? (ai|llm|autonomous agent|agent)/i, label: "self-disclosure" },
];

/**
 * Unlike the behavioral signals, this one inspects the PR being analyzed
 * (title, body, commit messages). Only runs when PR context is available.
 */
function signalAgentAttribution(profile, activity, prContext) {
  if (!prContext) return { triggered: false };

  const texts = [
    prContext.pr_title,
    prContext.pr_body,
    ...(prContext.commit_messages || []),
  ].filter(Boolean);

  for (const text of texts) {
    for (const { re, label } of AGENT_ATTRIBUTION_PATTERNS) {
      const match = text.match(re);
      if (match) {
        return {
          triggered: true,
          name: "Explicit Agent Attribution",
          severity: "high",
          score: 20,
          detail: `PR content contains an AI ${label}: "${match[0].slice(0, 80).trim()}"`,
        };
      }
    }
  }
  return { triggered: false };
}

// ── All Signals ─────────────────────────────────────────────────────

const ALL_SIGNALS = [
  signalActivityRampup,
  signalCommitTiming,
  signalSprayPattern,
  signalCommunityEngagement,
  signalProfileCompleteness,
  signalPRUniformity,
  signalCommitMessageEntropy,
  signalNewbornAccount,
  signalNoSleepPattern,
  signalAgentAttribution,
];

module.exports = {
  ALL_SIGNALS,
  signalActivityRampup,
  signalCommitTiming,
  signalSprayPattern,
  signalCommunityEngagement,
  signalProfileCompleteness,
  signalPRUniformity,
  signalCommitMessageEntropy,
  signalNewbornAccount,
  signalNoSleepPattern,
  signalAgentAttribution,
  findMarathonDays,
  // Exported for testing
  variance,
  standardDeviation,
  circularStandardDeviationHours,
  shannonEntropy,
};
