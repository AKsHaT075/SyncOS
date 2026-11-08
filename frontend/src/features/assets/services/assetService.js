import { api } from "@/lib/axios";

const base = "/assets";
const unwrap = (promise) => promise.then((response) => response.data);

export const assetService = {
  list: (params) => unwrap(api.get(base, { params })),
  get: (id) => unwrap(api.get(`${base}/${id}`)),
  create: (payload) => unwrap(api.post(base, payload)),
  update: (id, payload) => unwrap(api.patch(`${base}/${id}`, payload)),
  archive: (id) => unwrap(api.delete(`${base}/${id}`)),
  restore: (id) => unwrap(api.post(`${base}/${id}/restore`)),
  options: () => unwrap(api.get(`${base}/options`)),
  summary: () => unwrap(api.get(`${base}/summary`)),
  mine: () => unwrap(api.get(`${base}/mine`)),
  offboarding: () => unwrap(api.get(`${base}/offboarding`)),

  // Export goes through axios so the Bearer token is sent; the caller saves the blob.
  exportCsv: (params) => api.get(`${base}/export`, { params, responseType: "blob" }),

  // lifecycle actions: assign | transfer | return | request-return | reserve | release | retire | dispose | lost | found
  act: (id, action, payload = {}) => unwrap(api.post(`${base}/${id}/${action}`, payload)),

  history: (id, params) => unwrap(api.get(`${base}/${id}/assignments`, { params })),
  activity: (id, params) => unwrap(api.get(`${base}/${id}/activity`, { params })),
  assignments: (params) => unwrap(api.get(`${base}/assignments`, { params })),

  maintenance: (params) => unwrap(api.get(`${base}/maintenance`, { params })),
  assetMaintenance: (id) => unwrap(api.get(`${base}/${id}/maintenance`)),
  createMaintenance: (id, payload) => unwrap(api.post(`${base}/${id}/maintenance`, payload)),
  updateMaintenance: (id, mid, payload) => unwrap(api.patch(`${base}/${id}/maintenance/${mid}`, payload)),
  maintenanceAction: (id, mid, action, payload = {}) => unwrap(api.post(`${base}/${id}/maintenance/${mid}/${action}`, payload)),
  reportIssue: (id, payload) => unwrap(api.post(`${base}/${id}/report-issue`, payload)),

  documents: (id) => unwrap(api.get(`${base}/${id}/documents`)),
  linkDocument: (id, payload) => unwrap(api.post(`${base}/${id}/documents`, payload)),
  unlinkDocument: (id, linkId) => unwrap(api.delete(`${base}/${id}/documents/${linkId}`)),

  categories: (params) => unwrap(api.get(`${base}/categories`, { params })),
  createCategory: (payload) => unwrap(api.post(`${base}/categories`, payload)),
  updateCategory: (id, payload) => unwrap(api.patch(`${base}/categories/${id}`, payload)),
  archiveCategory: (id, payload = {}) => unwrap(api.post(`${base}/categories/${id}/archive`, payload)),

  vendors: (params) => unwrap(api.get(`${base}/vendors`, { params })),
  createVendor: (payload) => unwrap(api.post(`${base}/vendors`, payload)),
  updateVendor: (id, payload) => unwrap(api.patch(`${base}/vendors/${id}`, payload)),
  removeVendor: (id) => unwrap(api.delete(`${base}/vendors/${id}`)),
};
