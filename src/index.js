const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");

const { config, validate } = require("./config");
const { migrate } = require("./database/init");
const { createWebhookHandler } = require("./github/webhooks");
const { createWebhookRoute } = require("./routes/webhooks");
const { createAPIRoutes } = require("./routes/api");
const { createLogger } = require("./utils/logger");

const log = createLogger("server");

async function start() {
  // ── Validate config ─────────────────────────────────────────────
  validate();

  // ── Initialize database ─────────────────────────────────────────
  migrate();
  log.info("Database initialized");

  // ── Sync installations from GitHub (non-fatal if creds are absent) ──
  const { syncInstallations } = require("./github/api");
  syncInstallations().catch(() => {});

  // ── Create Express app ──────────────────────────────────────────
  const app = express();

  // Behind Railway/Render/Fly the client IP arrives via X-Forwarded-For;
  // required for accurate rate limiting in production
  if (config.env === "production") {
    app.set("trust proxy", 1);
  }

  // Security headers — disable CSP in dev (inline handlers need it)
  app.use(helmet({
    contentSecurityPolicy: config.env === "production" ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "https://avatars.githubusercontent.com", "data:"],
        connectSrc: ["'self'"],
      },
    } : false,
  }));

  app.use(cors());
  app.use(morgan("short", { skip: (req) => req.path === "/healthz" }));

  // Rate limiting for API
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, try again later" },
  });

  // ── Routes ──────────────────────────────────────────────────────

  // Health check for load balancers / uptime monitors
  app.get("/healthz", (req, res) => res.json({ ok: true }));

  // Webhook endpoint (no body parsing middleware — needs raw body)
  const webhookHandler = createWebhookHandler();
  app.use("/webhook", createWebhookRoute(webhookHandler));

  // API routes (with JSON parsing)
  app.use("/api", express.json(), apiLimiter, createAPIRoutes());

  // Dashboard static files
  app.use(express.static(path.join(__dirname, "..", "public")));

  // SPA fallback
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/webhook")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  // ── Start server ────────────────────────────────────────────────
  const server = app.listen(config.port, () => {
    log.info(`AgentWall server running on http://localhost:${config.port}`);
    log.info(`Environment: ${config.env}`);
    log.info(`Webhook URL: http://localhost:${config.port}/webhook`);
    log.info(`Dashboard: http://localhost:${config.port}`);
    log.info(`API: http://localhost:${config.port}/api`);

    if (config.env === "development") {
      log.info("");
      log.info("=== SETUP CHECKLIST ===");
      log.info("1. Create a GitHub App at https://github.com/settings/apps/new");
      log.info("2. Set Webhook URL to your public URL + /webhook");
      log.info("3. Subscribe to: Pull requests, Installation events");
      log.info("4. Set permissions: Pull requests (Read & Write), Issues (Read & Write), Metadata (Read)");
      log.info("5. Download the private key and save as private-key.pem");
      log.info("6. Copy .env.example to .env and fill in APP_ID and WEBHOOK_SECRET");
      log.info("7. Use ngrok or similar to expose your local server for testing");
      log.info("========================");
    }
  });

  // ── Graceful shutdown ───────────────────────────────────────────
  const shutdown = (signal) => {
    log.info(`Received ${signal}, shutting down`);
    server.close(() => {
      try {
        const { getDb } = require("./database/init");
        getDb().close();
      } catch (e) { /* db may not be open */ }
      process.exit(0);
    });
    // Force exit if connections refuse to drain
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  log.error("Failed to start server", { error: err.message, stack: err.stack });
  process.exit(1);
});
