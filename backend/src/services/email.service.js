const env = require('../config/env');
const { getMailer } = require('../config/mailer');
const { enqueueEmail } = require('./email-queue');
const { buildMeetingInvitationEmail, buildMeetingRequestDecisionEmail } = require('../utils/emailTemplates');

async function sendEmail({ to, subject, text, html }) {
  const transporter = getMailer();
  const fromName = env.EMAIL_FROM_NAME || 'Sync Os';

  if (!transporter) {
    if (env.NODE_ENV !== 'production') {
      console.info('[email:dev]', { to, subject, text });
    }
    return { preview: true };
  }

  return transporter.sendMail({
    from: `${fromName} <${env.EMAIL_USER || env.SMTP_USER || 'no-reply@syncos.local'}>`,
    html,
    subject,
    text,
    to,
  });
}

async function sendOtpEmail({ to, otp, firstName }) {
  const subject = 'Verify your Sync Os account';
  const text = `Hi ${firstName || 'there'}, your Sync Os verification code is ${otp}. It expires in 5 minutes.`;
  const html = `<p>Hi ${firstName || 'there'},</p><p>Your Sync Os verification code is <strong>${otp}</strong>.</p><p>This code expires in 5 minutes.</p>`;
  return enqueueEmail({ to, subject, text, html });
}

async function sendPasswordResetEmail({ to, firstName, resetUrl }) {
  const subject = 'Reset your Sync Os password';
  const text = `Hi ${firstName || 'there'}, reset your password using this link: ${resetUrl}`;
  const html = `<p>Hi ${firstName || 'there'},</p><p>Reset your password using this link:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 15 minutes.</p>`;
  return enqueueEmail({ to, subject, text, html });
}

async function sendInvitationEmail({ to, organizationName, role, inviteUrl }) {
  const subject = `You've been invited to join ${organizationName} on Sync Os`;
  const text = `You've been invited to join ${organizationName} as ${role}. Accept your invitation here: ${inviteUrl}`;
  const html = `<p>You've been invited to join <strong>${organizationName}</strong> as <strong>${role}</strong>.</p><p><a href="${inviteUrl}">${inviteUrl}</a></p><p>This invitation expires in 7 days.</p>`;
  return enqueueEmail({ to, subject, text, html });
}

async function sendMeetingInvitationEmail({ to, meetingTopic, projectName, startTime, joinUrl }) {
  return enqueueEmail({ to, ...buildMeetingInvitationEmail({ meetingTopic, projectName, startTime, joinUrl }) });
}

async function sendMeetingRequestDecisionEmail({ to, topic, status, remarks }) {
  return enqueueEmail({ to, ...buildMeetingRequestDecisionEmail({ topic, status, remarks }) });
}

module.exports = {
  sendEmail,
  sendInvitationEmail,
  sendMeetingInvitationEmail,
  sendMeetingRequestDecisionEmail,
  sendOtpEmail,
  sendPasswordResetEmail,
};
