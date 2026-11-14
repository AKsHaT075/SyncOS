const env = require('./config/env');
const { connectMongo } = require('./config/db');
const { connectRedis } = require('./config/redis');
const { createApp } = require('./app');
const { createInternalApp } = require('./internalApp');
const { processEmailQueue, stopEmailWorker } = require('./services/email-queue');
const notificationHub = require('./services/notificationHub');
const { startNotificationJobs } = require('./services/notificationJobs');
const { startAiJobs } = require('./services/ai/aiJobs');
const { registerLiveDataTools } = require('./services/ai/tools/liveDataTools');
const { assertLiveToolsConfig } = require('./services/ai/tools/toolLimits');
const { runMeetingAutoCleanup } = require('./services/meeting.service');

const MEETING_CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

async function start() {
  registerLiveDataTools(); // the eight read-only live-data tools; they run only through the callback gate, only with an open tool budget, and only when live tools are activated (AI_LIVE_TOOLS_ENABLED, default off) and the organization enables live data
  assertLiveToolsConfig(); // fail fast on inconsistent tool limits, but only when live tools are activated
  await connectMongo();
  await connectRedis();
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`Sync Os backend listening on port ${env.PORT}`);
  });

  // Callbacks from the Python AI service: separate host:port (loopback by default), never the public listener.
  const internalServer = createInternalApp().listen(env.AI_INTERNAL_PORT, env.AI_INTERNAL_HOST, () => {
    console.log(`Sync Os internal AI callbacks on ${env.AI_INTERNAL_HOST}:${env.AI_INTERNAL_PORT}`);
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
  const stopAiJobs = startAiJobs(); // recovers AI usage events parked in Redis when MongoDB was unavailable

  const shutdown = async () => {
    clearInterval(cleanupInterval);
    stopNotificationJobs();
    stopAiJobs();
    stopEmailWorker();
    await notificationHub.shutdown(); // ends open SSE streams so server.close() can finish
    internalServer.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Failed to start backend server:', error);
  process.exit(1);
});
