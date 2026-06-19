const env = require('../config/env');
const { getMailer } = require('../config/mailer');

async function sendEmail({ to, subject, text, html }) {
  const transporter = getMailer();
  const fromName = env.EMAIL_FROM_NAME || 'SynapseOS';

  if (!transporter) {
    if (env.NODE_ENV !== 'production') {
      console.info('[email:dev]', { to, subject, text });
    }
    return { preview: true };
  }

  return transporter.sendMail({
    from: `${fromName} <${env.EMAIL_USER || env.SMTP_USER || 'no-reply@synapseos.local'}>`,
    html,
    subject,
    text,
    to,
  });
}

async function sendOtpEmail({ to, otp, firstName }) {
  const subject = 'Verify your SynapseOS account';
  const text = `Hi ${firstName || 'there'}, your SynapseOS verification code is ${otp}. It expires in 5 minutes.`;
  const html = `<p>Hi ${firstName || 'there'},</p><p>Your SynapseOS verification code is <strong>${otp}</strong>.</p><p>This code expires in 5 minutes.</p>`;
  return sendEmail({ to, subject, text, html });
}

async function sendPasswordResetEmail({ to, firstName, resetUrl }) {
  const subject = 'Reset your SynapseOS password';
  const text = `Hi ${firstName || 'there'}, reset your password using this link: ${resetUrl}`;
  const html = `<p>Hi ${firstName || 'there'},</p><p>Reset your password using this link:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 15 minutes.</p>`;
  return sendEmail({ to, subject, text, html });
}

module.exports = {
  sendEmail,
  sendOtpEmail,
  sendPasswordResetEmail,
};