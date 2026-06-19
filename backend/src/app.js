const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const env = require('./config/env');
const { createSessionMiddleware } = require('./config/session');
const { apiLimiter } = require('./middlewares/rate-limit.middleware');
const csrfProtection = require('./middlewares/csrf.middleware');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middlewares/error.middleware');

function createApp({ redisClient }) {
  const app = express();
  const allowedOrigins = new Set(env.CLIENT_ORIGINS);
  const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
  const allowedHeaders = ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-XSRF-Token'];
  const allowedMethods = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'];
  const isAllowedOrigin = (origin) => {
    if (!origin) {
      return true;
    }

    return allowedOrigins.has(origin) || (env.NODE_ENV !== 'production' && localhostPattern.test(origin));
  };
  const corsOptions = {
    credentials: true,
    methods: allowedMethods,
    allowedHeaders,
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    optionsSuccessStatus: 204,
  };

  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : 0);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const origin = req.get('origin');

    if (isAllowedOrigin(origin)) {
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Allow-Headers', allowedHeaders.join(','));
      res.header('Access-Control-Allow-Methods', allowedMethods.join(','));
      res.header('Vary', 'Origin');

      if (origin) {
        res.header('Access-Control-Allow-Origin', origin);
      }
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    return next();
  });
  app.use(helmet());
  app.use(cors(corsOptions));
  app.options('/{*cors}', cors(corsOptions));
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(createSessionMiddleware(redisClient));
  app.use(apiLimiter);
  app.use(csrfProtection);

  app.get('/health', (req, res) => {
    res.status(200).json({ success: true, status: 'ok' });
  });

  app.use('/api/v1', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
