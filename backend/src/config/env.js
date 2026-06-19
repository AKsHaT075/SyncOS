require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function asList(value, fallback = []) {
  if (!value) {
    return fallback;
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  CLIENT_ORIGINS: asList(process.env.CLIENT_URL, ['http://localhost:3000', 'http://127.0.0.1:3000']),
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
  AUTH_ACCESS_COOKIE_NAME: process.env.AUTH_ACCESS_COOKIE_NAME || 'sync_access_token',
  AUTH_CSRF_COOKIE_NAME: process.env.AUTH_CSRF_COOKIE_NAME || 'sync_csrf_token',
  AUTH_REFRESH_COOKIE_NAME: process.env.AUTH_REFRESH_COOKIE_NAME || 'sync_refresh_token',
  AUTH_SESSION_COOKIE_NAME: process.env.AUTH_SESSION_COOKIE_NAME || 'sync.sid',
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  JWT_SECRET: required('JWT_SECRET'),
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'Sync Os',
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD || process.env.SMTP_PASS || '',
  EMAIL_SERVICE: process.env.EMAIL_SERVICE || 'gmail',
  EMAIL_USER: process.env.EMAIL_USER || process.env.SMTP_USER || '',
  MONGO_URI: required('MONGO_URI'),
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 5000),
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  SESSION_SECRET: process.env.SESSION_SECRET || process.env.JWT_SECRET,
  SMTP_FROM: process.env.SMTP_FROM || 'Sync Os <no-reply@syncos.local>',
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_PORT: Number(process.env.SMTP_PORT || 587),
  SMTP_SECURE: asBoolean(process.env.SMTP_SECURE, false),
  SMTP_USER: process.env.SMTP_USER || '',
};
