const session = require('express-session');
const { RedisStore } = require('connect-redis');
const env = require('./env');

function createSessionMiddleware(redisClient) {
  const store = new RedisStore({
    client: redisClient,
    prefix: 'synapseos:session:',
  });

  return session({
    name: 'synapse.sid',
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: env.NODE_ENV === 'production',
    store,
    cookie: {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

module.exports = { createSessionMiddleware };