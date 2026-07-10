// Mirrors backend PRESENCE.STATUS — "offline" is derived server-side from
// session activity and is never a settable option here.
export const PRESENCE_STATUS = Object.freeze({
  ONLINE: "online",
  DND: "dnd",
  OFFLINE: "offline",
});

export const PRESENCE_OPTIONS = [
  { value: PRESENCE_STATUS.ONLINE, label: "Online", dotClassName: "bg-emerald-500" },
  { value: PRESENCE_STATUS.DND, label: "Do not disturb", dotClassName: "bg-red-500" },
];

export const PRESENCE_META = {
  [PRESENCE_STATUS.ONLINE]: { label: "Online", dotClassName: "bg-emerald-500" },
  [PRESENCE_STATUS.DND]: { label: "Do not disturb", dotClassName: "bg-red-500" },
  [PRESENCE_STATUS.OFFLINE]: { label: "Offline", dotClassName: "bg-zinc-400" },
};
