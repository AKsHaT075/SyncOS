import { api } from "@/lib/axios";

const base = "/documents";

function toFormData(file, fields = {}) {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      form.append(key, value);
    }
  });
  // Fields first, file last: the server validates the file after reading fields.
  form.append("file", file);
  return form;
}

export const documentService = {
  list: async (params) => (await api.get(base, { params })).data,
  get: async (id) => (await api.get(`${base}/${id}`)).data,

  upload: async ({ file, fields, onProgress }) =>
    (await api.post(base, toFormData(file, fields), {
      onUploadProgress: (event) => onProgress?.(event.total ? Math.round((event.loaded / event.total) * 100) : 0),
    })).data,

  update: async (id, updates) => (await api.patch(`${base}/${id}`, updates)).data,
  move: async (id, folderId) => (await api.post(`${base}/${id}/move`, { folderId })).data,
  remove: async (id) => (await api.delete(`${base}/${id}`)).data,
  activity: async (id, params) => (await api.get(`${base}/${id}/activity`, { params })).data,

  // Blob downloads go through axios so the auth header is sent and errors can be surfaced as toasts.
  fetchFile: (id, { version, disposition = "attachment" } = {}) =>
    api.get(version ? `${base}/${id}/versions/${version}/download` : `${base}/${id}/download`, {
      params: version ? undefined : { disposition },
      responseType: "blob",
    }),

  listShares: async (id) => (await api.get(`${base}/${id}/shares`)).data,
  addShare: async (id, payload) => (await api.post(`${base}/${id}/shares`, payload)).data,
  revokeShare: async (id, userId) => (await api.delete(`${base}/${id}/shares/${userId}`)).data,

  listVersions: async (id) => (await api.get(`${base}/${id}/versions`)).data,
  uploadVersion: async ({ id, file, changeNote, onProgress }) =>
    (await api.post(`${base}/${id}/versions`, toFormData(file, { changeNote }), {
      onUploadProgress: (event) => onProgress?.(event.total ? Math.round((event.loaded / event.total) * 100) : 0),
    })).data,
  restoreVersion: async (id, version) => (await api.post(`${base}/${id}/versions/${version}/restore`)).data,

  listFolders: async (params) => (await api.get(`${base}/folders`, { params })).data,
  createFolder: async (payload) => (await api.post(`${base}/folders`, payload)).data,
  updateFolder: async (id, updates) => (await api.patch(`${base}/folders/${id}`, updates)).data,
  deleteFolder: async (id) => (await api.delete(`${base}/folders/${id}`)).data,

  listTrash: async (params) => (await api.get(`${base}/trash`, { params })).data,
  restoreDocument: async (id) => (await api.post(`${base}/${id}/restore`)).data,
  purgeDocument: async (id) => (await api.delete(`${base}/${id}/permanent`)).data,
  restoreFolder: async (id) => (await api.post(`${base}/folders/${id}/restore`)).data,
  purgeFolder: async (id) => (await api.delete(`${base}/folders/${id}/permanent`)).data,
};
