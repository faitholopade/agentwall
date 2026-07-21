// ── AgentWall Dashboard ─────────────────────────────────────────────

(function () {
  "use strict";

  const API_BASE = "/api";
  let currentView = "dashboard";
  let selectedScanId = null;

  // ── DOM Ready ───────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", function () {
    // Nav tabs
    document.querySelectorAll(".nav-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        navigate(tab.getAttribute("data-view"));
      });
    });

    // Logo
    document.getElementById("logo-btn").addEventListener("click", function () {
      navigate("dashboard");
    });

    // Close detail panel
    document.getElementById("close-detail-btn").addEventListener("click", closeDetail);

    // Risk filter
    document.getElementById("filter-risk").addEventListener("change", loadScans);

    // Manual scan
    document.getElementById("scan-btn").addEventListener("click", runManualScan);
    document.getElementById("scan-username").addEventListener("keydown", function (e) {
      if (e.key === "Enter") runManualScan();
    });

    // Policy buttons
    document.getElementById("new-policy-btn").addEventListener("click", showNewPolicyForm);
    document.getElementById("cancel-policy-btn").addEventListener("click", hideNewPolicyForm);
    document.getElementById("create-policy-btn").addEventListener("click", createNewPolicy);

    // Verified contributors
    document.getElementById("verify-add-btn").addEventListener("click", addVerified);
    document.getElementById("verify-login").addEventListener("keydown", function (e) {
      if (e.key === "Enter") addVerified();
    });

    // Init
    loadMeta();
    navigate("dashboard");
  });

  // ── Deployment Meta (enforcement mode badge) ────────────────────

  function loadMeta() {
    api("/meta").then(function (meta) {
      if (meta.monitorOnly) {
        document.getElementById("status-badge").classList.add("monitor");
        document.getElementById("status-text").textContent = "Monitor Only";
      }
    }).catch(function () { /* badge keeps its default */ });
  }

  // ── Navigation ──────────────────────────────────────────────────

  function navigate(view) {
    currentView = view;
    document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
    document.querySelectorAll(".nav-tab").forEach(function (t) { t.classList.remove("active"); });

    var viewEl = document.getElementById("view-" + view);
    var tabEl = document.querySelector('.nav-tab[data-view="' + view + '"]');

    if (viewEl) viewEl.classList.add("active");
    if (tabEl) tabEl.classList.add("active");

    switch (view) {
      case "dashboard": loadStats(); loadScans(); break;
      case "policies": loadPolicies(); break;
      case "verified": loadVerified(); break;
    }
  }

  // ── API Helpers ─────────────────────────────────────────────────

  function api(path, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    if (options.headers) {
      for (var k in options.headers) headers[k] = options.headers[k];
    }
    options.headers = headers;

    return fetch(API_BASE + path, options).then(function (resp) {
      if (!resp.ok) {
        return resp.json().catch(function () { return { error: "Request failed" }; }).then(function (err) {
          throw new Error(err.error || "HTTP " + resp.status);
        });
      }
      return resp.json();
    });
  }

  // ── Dashboard: Stats ──────────────────────────────────────────

  function loadStats() {
    api("/stats").then(function (stats) {
      document.getElementById("stat-total").textContent = stats.total || 0;
      document.getElementById("stat-24h").textContent = stats.last24h || 0;
      document.getElementById("stat-blocked").textContent = stats.byLevel && stats.byLevel.critical || 0;
      document.getElementById("stat-flagged").textContent = ((stats.byLevel && stats.byLevel.high) || 0) + ((stats.byLevel && stats.byLevel.medium) || 0);
      document.getElementById("stat-clean").textContent = stats.byLevel && stats.byLevel.low || 0;
      renderTopSignals(stats.topSignals || []);
    }).catch(function (err) {
      console.error("Failed to load stats:", err);
    });
  }

  function renderTopSignals(topSignals) {
    var card = document.getElementById("top-signals-card");
    var el = document.getElementById("top-signals");
    if (!topSignals.length) {
      card.style.display = "none";
      return;
    }
    card.style.display = "block";
    var max = topSignals[0].count || 1;
    el.innerHTML = topSignals.map(function (s) {
      var pct = Math.max(4, Math.round((s.count / max) * 100));
      return '<div class="signal-bar-row">' +
        '<div class="signal-bar-name">' + escapeHtml(s.signal_name) + '</div>' +
        '<div class="signal-bar-track"><div class="signal-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="signal-bar-count">' + s.count + '</div>' +
        '</div>';
    }).join("");
  }

  // ── Dashboard: Scan List ──────────────────────────────────────

  function loadScans() {
    var listEl = document.getElementById("scan-list");
    var riskFilter = document.getElementById("filter-risk").value;

    var params = "limit=50";
    if (riskFilter) params += "&riskLevel=" + riskFilter;

    api("/scans?" + params).then(function (data) {
      if (!data.scans || data.scans.length === 0) {
        listEl.innerHTML =
          '<div class="empty-state">' +
          '<div class="empty-state-text">' +
          'No scans yet.<br>' +
          'PRs will appear here once they are scanned by AgentWall.<br><br>' +
          'Try the <strong>Manual Scan</strong> tab to test with a GitHub username.' +
          '</div></div>';
        return;
      }

      listEl.innerHTML = data.scans.map(function (scan) {
        return '<div class="scan-item' + (selectedScanId === scan.id ? ' selected' : '') + '" data-scan-id="' + scan.id + '">' +
          '<div class="scan-item-top">' +
          '<div class="scan-item-title">' + escapeHtml(scan.pr_title || "Untitled") + '</div>' +
          '<div class="risk-badge risk-' + scan.risk_level + '">' +
          '<span>' + scan.risk_score + '</span>' +
          '<span class="risk-label">' + scan.risk_level.toUpperCase() + '</span>' +
          '</div></div>' +
          '<div class="scan-item-meta">' +
          '<a href="https://github.com/' + escapeHtml(scan.contributor_login) + '" target="_blank">' + escapeHtml(scan.contributor_login) + '</a>' +
          ' → ' + escapeHtml(scan.repo_full_name) + '#' + scan.pr_number +
          ' · ' + timeAgo(scan.created_at) +
          (scan.action_taken ? ' · <span class="action-tag action-' + scan.action_taken + '">' + scan.action_taken + '</span>' : '') +
          '</div></div>';
      }).join("");

      // Attach click handlers
      listEl.querySelectorAll(".scan-item").forEach(function (el) {
        el.addEventListener("click", function () {
          showScanDetail(parseInt(el.getAttribute("data-scan-id"), 10));
        });
      });
    }).catch(function (err) {
      listEl.innerHTML = '<div class="loading">Failed to load scans: ' + escapeHtml(err.message) + '</div>';
    });
  }

  // ── Dashboard: Scan Detail ────────────────────────────────────

  function showScanDetail(scanId) {
    selectedScanId = scanId;
    var panel = document.getElementById("detail-panel");
    var content = document.getElementById("detail-content");
    var grid = document.querySelector(".dashboard-grid");

    panel.style.display = "block";
    grid.classList.add("with-detail");

    document.querySelectorAll(".scan-item").forEach(function (el) {
      el.classList.toggle("selected", parseInt(el.getAttribute("data-scan-id"), 10) === scanId);
    });

    api("/scans/" + scanId).then(function (scan) {
      var signals = scan.signals || [];
      var contData = scan.contributor_data || {};
      var scoreColor = scan.risk_level === "critical" ? "var(--red)" :
                       scan.risk_level === "high" ? "var(--amber)" :
                       scan.risk_level === "medium" ? "var(--blue)" : "var(--green)";

      var circumference = 2 * Math.PI * 42;
      var dashLen = (scan.risk_score / 100) * circumference;

      var signalsHtml = "";
      if (signals.length === 0) {
        signalsHtml = '<div class="no-signals">No suspicious signals detected</div>';
      } else {
        signalsHtml = signals.map(function (sig) {
          var sigColor = sig.severity === "critical" ? "var(--red)" :
                         sig.severity === "high" ? "var(--amber)" :
                         sig.severity === "medium" ? "var(--blue)" : "var(--text-sec)";
          return '<div class="signal-item severity-' + sig.severity + '">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">' +
            '<div class="signal-name" style="color:' + sigColor + '">' + escapeHtml(sig.name) + '</div>' +
            '<div class="signal-score">+' + sig.score + '</div>' +
            '</div>' +
            '<div class="signal-detail">' + escapeHtml(sig.detail) + '</div>' +
            '</div>';
        }).join("");
      }

      content.innerHTML =
        '<div class="detail-score-ring">' +
        '<svg width="100" height="100" viewBox="0 0 100 100">' +
        '<circle cx="50" cy="50" r="42" fill="none" stroke="var(--border)" stroke-width="6"/>' +
        '<circle cx="50" cy="50" r="42" fill="none" stroke="' + scoreColor + '" stroke-width="6"' +
        ' stroke-dasharray="' + dashLen + ' ' + (circumference - dashLen) + '"' +
        ' stroke-dashoffset="' + (circumference / 4) + '" stroke-linecap="round"' +
        ' style="transition:stroke-dasharray 0.8s ease-out"/>' +
        '</svg>' +
        '<div style="margin-top:-68px;text-align:center;">' +
        '<div style="font-size:28px;font-weight:700;color:' + scoreColor + ';font-family:JetBrains Mono,monospace;">' + scan.risk_score + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;">' + scan.risk_level + '</div>' +
        '</div><div style="height:30px;"></div></div>' +

        '<div class="detail-info">' +
        '<div style="font-size:13px;font-weight:600;color:var(--text-sec);margin-bottom:6px;">' + escapeHtml(scan.contributor_login) + '</div>' +
        '<div class="detail-info-grid">' +
        '<div>Account: ' + (contData.account_age_days != null ? contData.account_age_days + 'd old' : 'Unknown') + '</div>' +
        '<div>PRs (30d): ' + (contData.prs_last_30_days != null ? contData.prs_last_30_days : '?') + '</div>' +
        '<div>Repos: ' + (contData.repos_contributed_to != null ? contData.repos_contributed_to : '?') + '</div>' +
        '<div>Comments: ' + (contData.issue_comments != null ? contData.issue_comments : '?') + '</div>' +
        '<div>Reviews: ' + (contData.code_reviews != null ? contData.code_reviews : '?') + '</div>' +
        '<div>Followers: ' + (contData.followers != null ? contData.followers : '?') + '</div>' +
        '</div></div>' +

        '<div class="detail-section-title">Detection Signals (' + signals.length + ')</div>' +
        signalsHtml +
        '<div style="padding:12px 16px;">' +
        '<button class="btn btn-secondary" id="detail-verify-btn" style="width:100%;font-size:12px;">Mark ' + escapeHtml(scan.contributor_login) + ' as verified human</button>' +
        '</div>';

      var verifyBtn = document.getElementById("detail-verify-btn");
      if (verifyBtn) {
        verifyBtn.addEventListener("click", function () {
          addVerified(scan.contributor_login);
        });
      }
    }).catch(function () {
      content.innerHTML = '<div class="loading">Failed to load scan details</div>';
    });
  }

  function closeDetail() {
    selectedScanId = null;
    document.getElementById("detail-panel").style.display = "none";
    document.querySelector(".dashboard-grid").classList.remove("with-detail");
    document.querySelectorAll(".scan-item").forEach(function (el) { el.classList.remove("selected"); });
  }

  // ── Policies ──────────────────────────────────────────────────

  function loadPolicies() {
    var listEl = document.getElementById("policy-list");

    api("/policies").then(function (data) {
      if (!data.policies || data.policies.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><div class="empty-state-text">No policies configured.</div></div>';
        return;
      }

      listEl.innerHTML = data.policies.map(function (p) {
        return '<div class="policy-item ' + (p.enabled ? 'enabled' : '') + '">' +
          '<div class="policy-info">' +
          '<div class="policy-name">' + escapeHtml(p.name) +
          ' <span class="action-tag action-' + p.action + '">' + p.action + '</span>' +
          ' <span style="font-size:11px;color:var(--text-muted);font-weight:400;">Score ' + p.threshold_min + '-' + p.threshold_max + '</span>' +
          '</div>' +
          '<div class="policy-desc">' + escapeHtml(p.description || '') + '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
          '<button class="btn btn-danger policy-delete-btn" data-id="' + p.id + '" style="padding:4px 10px;font-size:11px;">Delete</button>' +
          '<button class="toggle ' + (p.enabled ? 'on' : '') + ' policy-toggle-btn" data-id="' + p.id + '" data-enabled="' + (p.enabled ? '1' : '0') + '">' +
          '<div class="toggle-knob"></div></button>' +
          '</div></div>';
      }).join("");

      // Attach toggle handlers
      listEl.querySelectorAll(".policy-toggle-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = parseInt(btn.getAttribute("data-id"), 10);
          var currentlyEnabled = btn.getAttribute("data-enabled") === "1";
          togglePolicy(id, !currentlyEnabled);
        });
      });

      // Attach delete handlers
      listEl.querySelectorAll(".policy-delete-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          deleteExistingPolicy(parseInt(btn.getAttribute("data-id"), 10));
        });
      });
    }).catch(function (err) {
      listEl.innerHTML = '<div class="loading">Failed to load policies: ' + escapeHtml(err.message) + '</div>';
    });
  }

  function togglePolicy(id, enabled) {
    api("/policies/" + id, {
      method: "PUT",
      body: JSON.stringify({ enabled: enabled }),
    }).then(function () {
      loadPolicies();
    }).catch(function (err) {
      alert("Failed to update policy: " + err.message);
    });
  }

  function deleteExistingPolicy(id) {
    if (!confirm("Delete this policy?")) return;
    api("/policies/" + id, { method: "DELETE" }).then(function () {
      loadPolicies();
    }).catch(function (err) {
      alert("Failed to delete policy: " + err.message);
    });
  }

  function showNewPolicyForm() {
    document.getElementById("new-policy-form").style.display = "block";
  }

  function hideNewPolicyForm() {
    document.getElementById("new-policy-form").style.display = "none";
  }

  function createNewPolicy() {
    var name = document.getElementById("policy-name").value.trim();
    var description = document.getElementById("policy-desc").value.trim();
    var threshold_min = parseInt(document.getElementById("policy-min").value, 10);
    var threshold_max = parseInt(document.getElementById("policy-max").value, 10);
    var action = document.getElementById("policy-action").value;
    var priority = parseInt(document.getElementById("policy-priority").value, 10);

    if (!name) { alert("Policy name is required"); return; }

    api("/policies", {
      method: "POST",
      body: JSON.stringify({
        name: name, description: description, rule_type: "score_range",
        threshold_min: threshold_min, threshold_max: threshold_max, action: action,
        enabled: true, priority: priority,
      }),
    }).then(function () {
      hideNewPolicyForm();
      loadPolicies();
    }).catch(function (err) {
      alert("Failed to create policy: " + err.message);
    });
  }

  // ── Verified Contributors ─────────────────────────────────────

  function loadVerified() {
    var listEl = document.getElementById("verified-list");

    api("/verified").then(function (data) {
      if (!data.verified || data.verified.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><div class="empty-state-text">No verified contributors yet.<br>Verify someone above and AgentWall will never scan or block them.</div></div>';
        return;
      }

      listEl.innerHTML = data.verified.map(function (v) {
        return '<div class="policy-item enabled">' +
          '<div class="policy-info">' +
          '<div class="policy-name"><a href="https://github.com/' + escapeHtml(v.github_login) + '" target="_blank" style="color:inherit;">' + escapeHtml(v.github_login) + '</a></div>' +
          '<div class="policy-desc">' + escapeHtml(v.note || "") + (v.note ? " · " : "") + 'verified ' + timeAgo(v.created_at) + '</div>' +
          '</div>' +
          '<button class="btn btn-danger verified-remove-btn" data-login="' + escapeHtml(v.github_login) + '" style="padding:4px 10px;font-size:11px;">Remove</button>' +
          '</div>';
      }).join("");

      listEl.querySelectorAll(".verified-remove-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          removeVerified(btn.getAttribute("data-login"));
        });
      });
    }).catch(function (err) {
      listEl.innerHTML = '<div class="loading">Failed to load: ' + escapeHtml(err.message) + '</div>';
    });
  }

  function addVerified(login) {
    var fromDetail = typeof login === "string" && login;
    var loginValue = fromDetail ? login : document.getElementById("verify-login").value.trim();
    var note = fromDetail ? "" : document.getElementById("verify-note").value.trim();
    if (!loginValue) return;

    api("/verified", {
      method: "POST",
      body: JSON.stringify({ login: loginValue, note: note }),
    }).then(function () {
      if (fromDetail) {
        alert(loginValue + " marked as verified — future PRs bypass scanning.");
      } else {
        document.getElementById("verify-login").value = "";
        document.getElementById("verify-note").value = "";
        loadVerified();
      }
    }).catch(function (err) {
      alert("Failed to verify: " + err.message);
    });
  }

  function removeVerified(login) {
    if (!confirm("Remove verified status for " + login + "?")) return;
    api("/verified/" + encodeURIComponent(login), { method: "DELETE" }).then(function () {
      loadVerified();
    }).catch(function (err) {
      alert("Failed to remove: " + err.message);
    });
  }

  // ── Manual Scan ───────────────────────────────────────────────

  function runManualScan() {
    var username = document.getElementById("scan-username").value.trim();
    if (!username) return;

    var btn = document.getElementById("scan-btn");
    var resultEl = document.getElementById("scan-result");

    btn.disabled = true;
    btn.textContent = "Scanning...";
    resultEl.style.display = "block";
    resultEl.innerHTML =
      '<div class="card scan-result-card">' +
      '<div style="padding:40px;text-align:center;color:var(--text-sec);">' +
      'Scanning <strong>' + escapeHtml(username) + '</strong>...<br>' +
      '<span style="font-size:13px;color:var(--text-muted);">Fetching profile and activity data from GitHub</span>' +
      '</div></div>';

    api("/contributors/" + encodeURIComponent(username) + "/scan", {
      method: "POST",
      body: JSON.stringify({ repo_full_name: "manual/scan", pr_number: 0 }),
    }).then(function (result) {
      var signals = result.signals || [];
      var scoreColor = result.risk_level === "critical" ? "var(--red)" :
                       result.risk_level === "high" ? "var(--amber)" :
                       result.risk_level === "medium" ? "var(--blue)" : "var(--green)";

      var signalsHtml = "";
      if (signals.length === 0) {
        signalsHtml = '<div class="no-signals">No suspicious signals detected. This contributor appears human.</div>';
      } else {
        signalsHtml = signals.map(function (sig) {
          var sigColor = sig.severity === "critical" ? "var(--red)" :
                         sig.severity === "high" ? "var(--amber)" :
                         sig.severity === "medium" ? "var(--blue)" : "var(--text-sec)";
          return '<div class="signal-item severity-' + sig.severity + '" style="margin:0 0 6px;">' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:3px;">' +
            '<div class="signal-name" style="color:' + sigColor + '">' + escapeHtml(sig.name) + '</div>' +
            '<div class="signal-score">+' + sig.score + '</div></div>' +
            '<div class="signal-detail">' + escapeHtml(sig.detail) + '</div></div>';
        }).join("");
      }

      resultEl.innerHTML =
        '<div class="card scan-result-card">' +
        '<div class="card-header"><span>Scan Result: ' + escapeHtml(username) + '</span>' +
        '<div class="risk-badge risk-' + result.risk_level + '">' +
        '<span>' + result.risk_score + '</span>' +
        '<span class="risk-label">' + result.risk_level.toUpperCase() + '</span></div></div>' +
        '<div style="padding:18px;">' +
        '<div class="detail-info" style="margin:0 0 14px;">' +
        '<div style="font-size:13px;font-weight:600;color:var(--text-sec);margin-bottom:6px;">' +
        '<a href="https://github.com/' + escapeHtml(username) + '" target="_blank" style="color:var(--text-sec);text-decoration:none;">' + escapeHtml(username) + '</a></div>' +
        '<div class="detail-info-grid">' +
        '<div>Repos: ' + (result.activity && result.activity.repos_contributed_to != null ? result.activity.repos_contributed_to : '?') + '</div>' +
        '<div>PRs (30d): ' + (result.activity && result.activity.prs_last_30_days != null ? result.activity.prs_last_30_days : '?') + '</div>' +
        '<div>Comments: ' + (result.activity && result.activity.issue_comments != null ? result.activity.issue_comments : '?') + '</div>' +
        '<div>Reviews: ' + (result.activity && result.activity.code_reviews != null ? result.activity.code_reviews : '?') + '</div>' +
        '<div>Public repos: ' + (result.profile && result.profile.public_repos != null ? result.profile.public_repos : '?') + '</div>' +
        '<div>Followers: ' + (result.profile && result.profile.followers != null ? result.profile.followers : '?') + '</div>' +
        '</div></div>' +
        '<div style="font-size:12px;font-weight:600;color:var(--text-sec);margin-bottom:8px;">Detection Signals (' + signals.length + ')</div>' +
        signalsHtml +
        '</div></div>';
    }).catch(function (err) {
      resultEl.innerHTML =
        '<div class="card scan-result-card">' +
        '<div style="padding:24px;text-align:center;color:var(--red);">' +
        'Scan failed: ' + escapeHtml(err.message) +
        '<br><span style="font-size:12px;color:var(--text-muted);">Make sure the GitHub App credentials are configured in .env</span>' +
        '</div></div>';
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = "Scan";
    });
  }

  // ── Utilities ─────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return "";
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    var date = new Date(dateStr + (dateStr.indexOf("Z") >= 0 ? "" : "Z"));
    var seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
    if (seconds < 604800) return Math.floor(seconds / 86400) + "d ago";
    return date.toLocaleDateString();
  }

})();
