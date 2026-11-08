function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Existing transactional emails (wording unchanged) -------------------
// Extracted from email.service so notification emails can reuse the exact
// same copy without going through the (test-mocked) email.service module.

function buildMeetingInvitationEmail({ meetingTopic, projectName, startTime, joinUrl }) {
  const when = startTime ? new Date(startTime).toUTCString() : 'right now';
  return {
    subject: `Meeting invite: ${meetingTopic}`,
    text: `You've been invited to "${meetingTopic}" on the ${projectName} project, scheduled for ${when}. Join here: ${joinUrl}`,
    html: `<p>You've been invited to <strong>${escapeHtml(meetingTopic)}</strong> on the <strong>${escapeHtml(projectName)}</strong> project, scheduled for <strong>${escapeHtml(when)}</strong>.</p><p><a href="${escapeHtml(joinUrl)}">${escapeHtml(joinUrl)}</a></p>`,
  };
}

function buildMeetingRequestDecisionEmail({ topic, status, remarks }) {
  const remarksLine = remarks ? ` Remarks: ${remarks}` : '';
  return {
    subject: `Your meeting request "${topic}" was ${status.toLowerCase()}`,
    text: `Your meeting request "${topic}" has been ${status.toLowerCase()}.${remarksLine}`,
    html: `<p>Your meeting request <strong>${escapeHtml(topic)}</strong> has been <strong>${escapeHtml(status)}</strong>.</p>${remarks ? `<p>${escapeHtml(remarks)}</p>` : ''}`,
  };
}

// ---- Generic notification email -------------------------------------------

function buildNotificationEmail({ title, message, url, firstName }) {
  const greeting = `Hi ${firstName || 'there'},`;
  const text = [greeting, '', `${title}${message ? ` — ${message}` : ''}`, url ? `\nOpen in Sync OS: ${url}` : '', '\nYou can change which emails you receive in Notification settings.']
    .filter((line) => line !== '')
    .join('\n');
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#18181b">
  <p>${escapeHtml(greeting)}</p>
  <h2 style="font-size:18px;margin:16px 0 8px">${escapeHtml(title)}</h2>
  ${message ? `<p style="margin:0 0 16px;color:#3f3f46">${escapeHtml(message)}</p>` : ''}
  ${url ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open in Sync OS</a></p>` : ''}
  <p style="margin-top:24px;font-size:12px;color:#71717a">You can change which emails you receive in Notification settings.</p>
</div>`.trim();
  return { subject: message ? `${title}: ${message}`.slice(0, 150) : title, text, html };
}

// Account-security emails carry NO organization data beyond its name: the
// recipient may no longer be allowed to see anything else.
function buildAccountEmail({ heading, body, firstName }) {
  const greeting = `Hi ${firstName || 'there'},`;
  return {
    subject: heading,
    text: `${greeting}\n\n${body}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#18181b"><p>${escapeHtml(greeting)}</p><h2 style="font-size:18px">${escapeHtml(heading)}</h2><p>${escapeHtml(body)}</p></div>`,
  };
}

module.exports = {
  buildAccountEmail,
  buildMeetingInvitationEmail,
  buildMeetingRequestDecisionEmail,
  buildNotificationEmail,
  escapeHtml,
};
