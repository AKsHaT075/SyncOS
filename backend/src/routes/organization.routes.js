const express = require('express');
const { validateBody } = require('../middlewares/validate.middleware');
const { authenticate } = require('../middlewares/authenticate');
const { create, listMine } = require('../controllers/organization.controller');
const { createOrganizationSchema } = require('../validations/organization.validation');

const router = express.Router();

router.get('/me', authenticate, listMine);
router.post('/', authenticate, validateBody(createOrganizationSchema), create);

module.exports = router;
