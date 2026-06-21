const AppError = require('../utils/app-error');
const asyncHandler = require('../utils/async-handler');

/**
 * Loads the resource scoped to the caller's organization and verifies the
 * caller either owns it (via `ownerField`) or holds a role in `bypassRoles`.
 * Attaches the loaded document to req.resource for the controller to reuse.
 */
function checkOwnership(Model, { ownerField = 'owner', resourceName = 'Resource', bypassRoles = [] } = {}) {
  return asyncHandler(async function checkOwnershipMiddleware(req, res, next) {
    const resourceId = req.params.id;

    const resource = await Model.findOne({
      _id: resourceId,
      organization: req.user.organization,
    });

    if (!resource) {
      throw new AppError(`${resourceName} not found`, 404, 'NOT_FOUND');
    }

    const ownerValue = resource[ownerField];
    const isOwner = Boolean(ownerValue) && ownerValue.toString() === req.user._id.toString();
    const isBypassed = bypassRoles.includes(req.user.role);

    if (!isOwner && !isBypassed) {
      throw new AppError('You do not have access to this resource', 403, 'FORBIDDEN');
    }

    req.resource = resource;
    return next();
  });
}

module.exports = checkOwnership;
