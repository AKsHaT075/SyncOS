const asyncHandler = require('../utils/async-handler');
const analytics = require('../services/analytics');

const ok = (res, payload) => res.json({ success: true, ...payload });
const view = (type) => asyncHandler(async (req, res) => ok(res, await analytics.getAnalytics({ actor: req.user, type, query: req.query })));

const platform = asyncHandler(async (req, res) => ok(res, await analytics.getPlatformAnalytics({ actor: req.user, query: req.query })));
const report = asyncHandler(async (req, res) => ok(res, await analytics.getReport({ actor: req.user, type: req.params.type, query: req.query })));
const exportCsv = asyncHandler(async (req, res) => {
  const { filename, csv } = await analytics.exportReport({ actor: req.user, type: req.params.type, query: req.query });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
});

module.exports = { exportCsv, platform, report, view };
