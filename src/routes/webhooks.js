const express = require("express");
const { createLogger } = require("../utils/logger");

const log = createLogger("webhook-route");

/**
 * Small FIFO cache of processed delivery IDs so GitHub redeliveries
 * (retries, manual redelivers) don't re-run enforcement.
 */
function createDeliveryCache(maxSize = 1000) {
  const seen = new Set();
  const order = [];
  return {
    has(id) { return seen.has(id); },
    add(id) {
      if (!id || seen.has(id)) return;
      seen.add(id);
      order.push(id);
      if (order.length > maxSize) seen.delete(order.shift());
    },
  };
}

/**
 * Create the webhook route that receives GitHub's POST requests.
 * Delegates to the @octokit/webhooks handler for verification + dispatch.
 */
function createWebhookRoute(webhookHandler) {
  const router = express.Router();
  const deliveries = createDeliveryCache();

  // GitHub sends webhooks as POST with raw body
  router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
    const signature = req.headers["x-hub-signature-256"];
    const event = req.headers["x-github-event"];
    const deliveryId = req.headers["x-github-delivery"];

    if (!signature || !event) {
      log.warn("Received webhook without signature or event header");
      return res.status(400).json({ error: "Missing required headers" });
    }

    if (deliveries.has(deliveryId)) {
      log.info(`Ignoring duplicate delivery ${deliveryId}`);
      return res.status(200).json({ ok: true, duplicate: true });
    }

    log.debug(`Received webhook: event=${event}, delivery=${deliveryId}`);

    try {
      await webhookHandler.verifyAndReceive({
        id: deliveryId,
        name: event,
        signature,
        payload: req.body.toString("utf8"),
      });
      deliveries.add(deliveryId);
      res.status(200).json({ ok: true });
    } catch (err) {
      log.error("Webhook verification/processing failed", { error: err.message });
      if (err.message.includes("signature")) {
        return res.status(401).json({ error: "Invalid signature" });
      }
      res.status(500).json({ error: "Internal processing error" });
    }
  });

  return router;
}

module.exports = { createWebhookRoute, createDeliveryCache };
