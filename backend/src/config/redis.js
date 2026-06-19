const { createClient } = require('redis');
const env = require('./env');

let redisClient;

function createRedisClient() {
  if (!redisClient) {
    redisClient = createClient({ url: env.REDIS_URL });
    redisClient.on('error', (error) => {
      console.error('Redis client error:', error);
    });
  }

  return redisClient;
}

async function connectRedis() {
  const client = createRedisClient();
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

module.exports = { connectRedis, createRedisClient };