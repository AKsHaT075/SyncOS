const nodemailer = require('nodemailer');
const env = require('./env');

let transporter;

function getMailer() {
  if (transporter) {
    return transporter;
  }

  if (env.EMAIL_SERVICE) {
    transporter = nodemailer.createTransport({
      service: env.EMAIL_SERVICE,
      auth: {
        user: env.EMAIL_USER,
        pass: env.EMAIL_PASSWORD,
      },
    });

    return transporter;
  }

  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });

  return transporter;
}

module.exports = { getMailer };