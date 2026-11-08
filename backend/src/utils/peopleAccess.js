const { ROLES } = require('../constants/roles');
const canManageUsers = require('./canManageUsers');

/**
 * People visibility model (matches the product decision):
 *  - ORG_ADMIN / ADMIN / HR      -> whole directory, including inactive members.
 *  - MANAGER / EMPLOYEE          -> full directory of ACTIVE members only.
 *  - GUEST                       -> limited directory of ACTIVE members only,
 *                                   and the serializer drops email/skills.
 */

const PEOPLE_ADMIN_ROLES = [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR];

// `organization`/`team` may arrive populated (full doc) or as a bare
// ObjectId — always resolve through `_id` first.
function idOf(value) {
  if (!value) return null;
  return value._id ? value._id.toString() : value.toString();
}

function isSameId(a, b) {
  const idA = idOf(a);
  const idB = idOf(b);
  return Boolean(idA) && Boolean(idB) && idA === idB;
}

/**
 * Mongo filter fragment (ANDed with { organization } by the caller) that
 * scopes the people directory to what this user is allowed to see.
 */
function buildPeopleDirectoryFilter(user) {
  if (PEOPLE_ADMIN_ROLES.includes(user.role)) {
    return {};
  }
  return { isActive: true };
}

function canViewPerson(user, target) {
  if (!isSameId(user.organization, target.organization)) {
    return false;
  }

  if (PEOPLE_ADMIN_ROLES.includes(user.role)) {
    return true;
  }

  return target.isActive === true;
}

/**
 * Whitelist serializer: never emits auth/security fields (no emailVerified,
 * hasCreatedOrganization, tokenVersion, lockout counters, etc.). Field set
 * varies by viewer role so a GUEST is never handed more than they need.
 */
function serializePerson(person, viewer) {
  const team = person.team
    ? person.team._id
      ? { id: person.team._id.toString(), name: person.team.name || null }
      : { id: person.team.toString(), name: null }
    : null;

  const base = {
    id: person._id.toString(),
    firstName: person.firstName,
    lastName: person.lastName,
    fullName: `${person.firstName} ${person.lastName}`.trim(),
    role: person.role,
    team,
    isActive: person.isActive,
    orgBlocked: person.orgBlocked,
    // Convenience flag used only to decide what the UI renders. The backend
    // re-checks canManageUsers authoritatively on every mutation.
    canManage: canManageUsers(viewer, person),
  };

  if (PEOPLE_ADMIN_ROLES.includes(viewer.role)) {
    return {
      ...base,
      email: person.email,
      skills: person.skills,
      presenceStatus: person.presenceStatus,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    };
  }

  if (viewer.role === ROLES.GUEST) {
    return base;
  }

  // MANAGER / EMPLOYEE — full active directory fields, still no presence or
  // account timestamps.
  return {
    ...base,
    email: person.email,
    skills: person.skills,
  };
}

module.exports = {
  PEOPLE_ADMIN_ROLES,
  buildPeopleDirectoryFilter,
  canManageUsers,
  canViewPerson,
  serializePerson,
};