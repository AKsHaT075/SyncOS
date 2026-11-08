const env = require('./config/env');
const { connectMongo } = require('./config/db');
const { connectRedis } = require('./config/redis');
const { createApp } = require('./app');
const { processEmailQueue, stopEmailWorker } = require('./services/email-queue');
const notificationHub = require('./services/notificationHub');
const { startNotificationJobs } = require('./services/notificationJobs');
const { runMeetingAutoCleanup } = require('./services/meeting.service');

const MEETING_CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

async function start() {
  await connectMongo();
  await connectRedis();
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`Sync Os backend listening on port ${env.PORT}`);
  });

  // Start background email queue worker (non-blocking)
  setImmediate(() => {
    processEmailQueue().catch((error) => {
      console.error('Email queue worker crashed:', error);
      // Restart the worker after 5s delay
      setTimeout(() => processEmailQueue(), 5000);
    });
  });

  // Ends meetings whose room has sat empty too long, and cancels scheduled
  // meetings nobody ever joined — see runMeetingAutoCleanup for the rules.
  runMeetingAutoCleanup().catch((error) => console.error('Meeting auto-cleanup failed:', error));
  const cleanupInterval = setInterval(() => {
    runMeetingAutoCleanup().catch((error) => console.error('Meeting auto-cleanup failed:', error));
  }, MEETING_CLEANUP_INTERVAL_MS);

  // Meeting reminders + reconciliation of emails that never reached the queue.
  const stopNotificationJobs = startNotificationJobs();

  const shutdown = async () => {
    clearInterval(cleanupInterval);
    stopNotificationJobs();
    stopEmailWorker();
    await notificationHub.shutdown(); // ends open SSE streams so server.close() can finish
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Failed to start backend server:', error);
  process.exit(1);
});
