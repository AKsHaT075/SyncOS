const express = require('express');
const env = require('../config/env');
const { verifyWebhookEvent } = require('../services/livekit.service');
const { syncFromWebhookEvent } = require('../services/meeting.service');

// Deliberately NOT behind `authenticate` — the caller is LiveKit's webhook
// dispatcher, not a logged-in user. Trust is established by verifying
// LiveKit's signature over the raw body instead (see verifyWebhookEvent).
// Mounted in app.js *before* the global express.json() so req.body here is
// the untouched raw buffer the signature was computed over.
const router = express.Router();

router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  if (!env.LIVEKIT_WEBHOOK_ENABLED) {
    return res.status(404).end();
  }

  try {
    const event = await verifyWebhookEvent(req.body.toString('utf8'), req.get('Authorization'));
    await syncFromWebhookEvent(event);
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
  }
});

module.exports = router;
