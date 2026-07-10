const { createRedisClient } = require('../config/redis');

const EMAIL_QUEUE_KEY = 'email:queue';
const QUEUE_RETRY_DELAY = 5000; // 5 sec between retries

async function enqueueEmail({ to, subject, text, html }) {
  try {
    const client = createRedisClient();
    await client.rPush(EMAIL_QUEUE_KEY, JSON.stringify({ to, subject, text, html, attempts: 0 }));
  } catch (error) {
    console.error('[email-queue] Failed to enqueue email:', error);
  }
}

async function processEmailQueue() {
  const client = createRedisClient();
  const { sendEmail } = require('./email.service');

  while (true) {
    try {
      const job = await client.lPop(EMAIL_QUEUE_KEY);
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1s before checking again
        continue;
      }

      const { to, subject, text, html, attempts = 0 } = JSON.parse(job);

      try {
        await sendEmail({ to, subject, text, html });
      } catch (error) {
        // Retry logic: re-queue if fewer than 3 attempts
        if (attempts < 3) {
          console.warn(`[email-queue] Retry attempt ${attempts + 1} for ${to}:`, error.message);
          await new Promise((resolve) => setTimeout(resolve, QUEUE_RETRY_DELAY));
          await client.rPush(EMAIL_QUEUE_KEY, JSON.stringify({ to, subject, text, html, attempts: attempts + 1 }));
        } else {
          console.error(`[email-queue] Failed to send email to ${to} after 3 attempts:`, error.message);
        }
      }
    } catch (error) {
      console.error('[email-queue] Queue processing error:', error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

module.exports = { enqueueEmail, processEmailQueue };
