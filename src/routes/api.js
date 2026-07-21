const express = require("express");
const { config } = require("../config");
const { createLogger } = require("../utils/logger");
const {
  getScans, getScan, getScanStats,
  getPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy,
  getAllInstallations, getContributor, getLatestContributorActivity,
  addVerifiedContributor, removeVerifiedContributor, getVerifiedContributors,
} = require("../database/queries");
const { analyzeContribution } = require("../engine/analyzer");

const log = createLogger("api");

function createAPIRoutes() {
  const router = express.Router();

  // Simple auth middleware for dashboard
  router.use((req, res, next) => {
    // Allow unauthenticated access in dev mode
    if (config.env === "development") return next();

    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== config.dashboard.secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  /**
   * GET /api/meta
   * Deployment metadata for the dashboard (enforcement mode, env).
   */
  router.get("/meta", (req, res) => {
    res.json({
      monitorOnly: config.enforcement.monitorOnly,
      env: config.env,
    });
  });

  // ── Scans ───────────────────────────────────────────────────────

  /**
   * GET /api/scans
   * List scans with optional filters.
   * Query params: repo, riskLevel, limit, offset
   */
  router.get("/scans", (req, res) => {
    try {
      const { repo, riskLevel, limit = 50, offset = 0 } = req.query;
      const scans = getScans({
        repo,
        riskLevel,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      });

      // Parse JSON fields for the response
      const parsed = scans.map(s => ({
        ...s,
        signals: JSON.parse(s.signals_json),
        contributor_data: JSON.parse(s.contributor_data_json || "{}"),
      }));

      res.json({ scans: parsed });
    } catch (err) {
      log.error("Failed to fetch scans", { error: err.message });
      res.status(500).json({ error: "Failed to fetch scans" });
    }
  });

  /**
   * GET /api/scans/:id
   * Get a specific scan with full details.
   */
  router.get("/scans/:id", (req, res) => {
    try {
      const scan = getScan(parseInt(req.params.id, 10));
      if (!scan) return res.status(404).json({ error: "Scan not found" });

      res.json({
        ...scan,
        signals: JSON.parse(scan.signals_json),
        contributor_data: JSON.parse(scan.contributor_data_json || "{}"),
      });
    } catch (err) {
      log.error("Failed to fetch scan", { error: err.message });
      res.status(500).json({ error: "Failed to fetch scan" });
    }
  });

  /**
   * GET /api/stats
   * Dashboard statistics.
   * Query params: repo (optional)
   */
  router.get("/stats", (req, res) => {
    try {
      const stats = getScanStats(req.query.repo || null);
      res.json(stats);
    } catch (err) {
      log.error("Failed to fetch stats", { error: err.message });
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // ── Contributors ────────────────────────────────────────────────

  /**
   * GET /api/contributors/:login
   * Get contributor profile + latest activity.
   */
  router.get("/contributors/:login", (req, res) => {
    try {
      const profile = getContributor(req.params.login);
      if (!profile) return res.status(404).json({ error: "Contributor not found" });

      const activity = getLatestContributorActivity(req.params.login);

      res.json({
        profile,
        activity: activity ? {
          repos_contributed_to: activity.repos_contributed_to,
          prs_last_30_days: activity.prs_last_30_days,
          issue_comments_count: activity.issue_comments_count,
          code_reviews_count: activity.code_reviews_count,
          fetched_at: activity.fetched_at,
        } : null,
      });
    } catch (err) {
      log.error("Failed to fetch contributor", { error: err.message });
      res.status(500).json({ error: "Failed to fetch contributor" });
    }
  });

  /**
   * POST /api/contributors/:login/scan
   * Manually trigger a scan for a contributor (for testing/demo).
   */
  router.post("/contributors/:login/scan", async (req, res) => {
    try {
      const { login } = req.params;
      const { repo_full_name = "manual/scan", pr_number = 0 } = req.body;

      // Use an installation token when one exists — 5000 req/hr instead of
      // the 60 req/hr unauthenticated limit
      const installations = getAllInstallations();
      const installationId = installations.length ? installations[0].installation_id : null;

      const result = await analyzeContribution({
        contributor_login: login,
        pr_number,
        repo_full_name,
        pr_title: "Manual scan",
        pr_url: `https://github.com/${login}`,
      }, installationId);

      res.json(result);
    } catch (err) {
      log.error("Manual scan failed", { error: err.message });
      res.status(500).json({ error: "Scan failed", detail: err.message });
    }
  });

  // ── Verified Contributors ───────────────────────────────────────

  /**
   * GET /api/verified
   * List verified contributors (bypass scanning).
   */
  router.get("/verified", (req, res) => {
    try {
      res.json({ verified: getVerifiedContributors() });
    } catch (err) {
      log.error("Failed to fetch verified contributors", { error: err.message });
      res.status(500).json({ error: "Failed to fetch verified contributors" });
    }
  });

  /**
   * POST /api/verified
   * Mark a contributor as a verified human. Body: { login, note? }
   */
  router.post("/verified", (req, res) => {
    try {
      const { login, note } = req.body;
      if (!login || typeof login !== "string" || !login.trim()) {
        return res.status(400).json({ error: "login is required" });
      }
      addVerifiedContributor(login.trim(), "dashboard", note || null);
      res.status(201).json({ message: `${login.trim()} marked as verified` });
    } catch (err) {
      log.error("Failed to add verified contributor", { error: err.message });
      res.status(500).json({ error: "Failed to add verified contributor" });
    }
  });

  /**
   * DELETE /api/verified/:login
   * Remove a contributor's verified status.
   */
  router.delete("/verified/:login", (req, res) => {
    try {
      removeVerifiedContributor(req.params.login);
      res.json({ message: "Verified status removed" });
    } catch (err) {
      log.error("Failed to remove verified contributor", { error: err.message });
      res.status(500).json({ error: "Failed to remove verified contributor" });
    }
  });

  // ── Policies ────────────────────────────────────────────────────

  /**
   * GET /api/policies
   * List all policies.
   */
  router.get("/policies", (req, res) => {
    try {
      const policies = getPolicies(req.query.installation_id || null);
      const parsed = policies.map(p => ({
        ...p,
        config: JSON.parse(p.config_json || "{}"),
        enabled: !!p.enabled,
      }));
      res.json({ policies: parsed });
    } catch (err) {
      log.error("Failed to fetch policies", { error: err.message });
      res.status(500).json({ error: "Failed to fetch policies" });
    }
  });

  /**
   * POST /api/policies
   * Create a new policy.
   */
  router.post("/policies", (req, res) => {
    try {
      const { name, description, rule_type, threshold_min, threshold_max, action, enabled, priority, config: pConfig, installation_id } = req.body;

      if (!name || !rule_type || !action) {
        return res.status(400).json({ error: "name, rule_type, and action are required" });
      }

      const result = createPolicy({
        installation_id: installation_id || null,
        name,
        description: description || "",
        rule_type,
        threshold_min: threshold_min || 0,
        threshold_max: threshold_max || 100,
        action,
        enabled: enabled !== false ? 1 : 0,
        priority: priority || 0,
        config_json: JSON.stringify(pConfig || {}),
      });

      res.status(201).json({ id: result.lastInsertRowid, message: "Policy created" });
    } catch (err) {
      log.error("Failed to create policy", { error: err.message });
      res.status(500).json({ error: "Failed to create policy" });
    }
  });

  /**
   * PUT /api/policies/:id
   * Update a policy.
   */
  router.put("/policies/:id", (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const policy = getPolicy(id);
      if (!policy) return res.status(404).json({ error: "Policy not found" });

      const updates = {};
      const allowed = ["name", "description", "rule_type", "threshold_min", "threshold_max", "action", "enabled", "priority"];
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates[key] = key === "enabled" ? (req.body[key] ? 1 : 0) : req.body[key];
        }
      }
      if (req.body.config !== undefined) {
        updates.config_json = JSON.stringify(req.body.config);
      }

      updatePolicy(id, updates);
      res.json({ message: "Policy updated" });
    } catch (err) {
      log.error("Failed to update policy", { error: err.message });
      res.status(500).json({ error: "Failed to update policy" });
    }
  });

  /**
   * DELETE /api/policies/:id
   * Delete a policy.
   */
  router.delete("/policies/:id", (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      deletePolicy(id);
      res.json({ message: "Policy deleted" });
    } catch (err) {
      log.error("Failed to delete policy", { error: err.message });
      res.status(500).json({ error: "Failed to delete policy" });
    }
  });

  // ── Installations ───────────────────────────────────────────────

  /**
   * GET /api/installations
   * List all app installations.
   */
  router.get("/installations", (req, res) => {
    try {
      const installations = getAllInstallations();
      res.json({ installations });
    } catch (err) {
      log.error("Failed to fetch installations", { error: err.message });
      res.status(500).json({ error: "Failed to fetch installations" });
    }
  });

  return router;
}

module.exports = { createAPIRoutes };
