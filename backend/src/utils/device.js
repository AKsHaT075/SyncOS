function parseUserAgent(userAgent = '') {
  const ua = String(userAgent);
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /Chrome\//i.test(ua)
      ? 'Chrome'
      : /Safari\//i.test(ua)
        ? 'Safari'
        : /Firefox\//i.test(ua)
          ? 'Firefox'
          : /Opera|OPR\//i.test(ua)
            ? 'Opera'
            : 'Unknown';

  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Mac OS X/i.test(ua)
      ? 'macOS'
      : /Linux/i.test(ua)
        ? 'Linux'
        : /Android/i.test(ua)
          ? 'Android'
          : /iPhone|iPad|iPod/i.test(ua)
            ? 'iOS'
            : 'Unknown';

  const deviceType = /Mobile|Android|iPhone|iPad|iPod/i.test(ua) ? 'mobile' : 'desktop';

  return {
    browser,
    deviceType,
    os,
    userAgent: ua,
  };
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

function getRequestContext(req) {
  return {
    ...parseUserAgent(req.get('user-agent') || ''),
    ipAddress: getClientIp(req),
  };
}

module.exports = {
  getClientIp,
  getRequestContext,
  parseUserAgent,
};