const AssetAssignment = require('../models/AssetAssignment');
const Team = require('../models/Team');
const { ASSIGNMENT_STATUS } = require('../constants/asset.constants');
const { buildAssetContext, idOf } = require('../utils/assetAccess');

/** The viewer's current team membership, the teams they lead, and the assets they hold — read fresh on every request. */
async function loadAssetContext(user) {
  const organization = user.organization;
  const teams = await Team.find({ organization, $or: [{ members: user._id }, { lead: user._id }] })
    .select('_id lead members')
    .lean();
  const myTeamIds = teams.map((team) => idOf(team._id));
  const led = teams.filter((team) => idOf(team.lead) === idOf(user._id));

  const held = await AssetAssignment.find({
    organization,
    status: ASSIGNMENT_STATUS.ACTIVE,
    $or: [{ user: user._id }, ...(myTeamIds.length ? [{ team: { $in: myTeamIds } }] : [])],
  })
    .select('asset')
    .lean();

  return buildAssetContext(user, {
    teamIds: myTeamIds,
    ledTeamIds: led.map((team) => idOf(team._id)),
    ledMemberIds: led.flatMap((team) => [...team.members.map(idOf), idOf(team.lead)]).filter(Boolean),
    heldAssetIds: held.map((entry) => idOf(entry.asset)),
  });
}

module.exports = { loadAssetContext };
