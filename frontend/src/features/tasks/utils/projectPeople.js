// A task's assignees/approvers must be project members (or the project
// owner) — this is the single place that turns a Project doc into the flat
// "who can be picked" list used by the task create form and the task
// Members tab, so both stay in sync with backend/src/services/task.service.js
// #assertUsersInProject.
export function getProjectPeople(project) {
  if (!project) return [];
  const people = [{ id: project.owner?.id, fullName: project.owner?.fullName, email: project.owner?.email, role: "Owner" }];
  project.members.forEach((member) => {
    if (member.user?.id !== project.owner?.id) {
      people.push({ id: member.user?.id, fullName: member.user?.fullName, email: member.user?.email, role: member.role });
    }
  });
  return people.filter((person) => person.id);
}
