const env = require('./config/env');
const { connectMongo } = require('./config/db');
const { connectRedis } = require('./config/redis');
const { createApp } = require('./app');

async function start() {
  await connectMongo();
  const redisClient = await connectRedis();
  const app = createApp({ redisClient });

  const server = app.listen(env.PORT, () => {
    console.log(`Sync Os backend listening on port ${env.PORT}`);
  });

  const shutdown = async () => {
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Failed to start backend server:', error);
  process.exit(1);
});
