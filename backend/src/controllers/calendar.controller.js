const asyncHandler = require('../utils/async-handler');
const calendar = require('../services/calendar.service');
const { getCalendar } = require('../services/calendarQuery.service');

const ok = (res, payload, status = 200) => res.status(status).json({ success: true, ...payload });

const list = asyncHandler(async (req, res) => ok(res, await getCalendar({ actor: req.user, query: req.query })));
const getById = asyncHandler(async (req, res) => ok(res, await calendar.getEvent({ actor: req.user, id: req.params.id })));
const create = asyncHandler(async (req, res) => ok(res, await calendar.createEvent({ actor: req.user, body: req.body, req }), 201));
const update = asyncHandler(async (req, res) => ok(res, await calendar.updateEvent({ actor: req.user, id: req.params.id, body: req.body, req })));
const remove = asyncHandler(async (req, res) =>
  ok(res, await calendar.deleteEvent({ actor: req.user, id: req.params.id, ...req.query, req })));
const rsvp = asyncHandler(async (req, res) =>
  ok(res, await calendar.rsvp({ actor: req.user, id: req.params.id, status: req.body.status, req })));
const getPreferences = asyncHandler(async (req, res) => ok(res, await calendar.getPreferences({ user: req.user })));
const updatePreferences = asyncHandler(async (req, res) => ok(res, await calendar.updatePreferences({ user: req.user, updates: req.body })));

module.exports = { create, getById, getPreferences, list, remove, rsvp, update, updatePreferences };
