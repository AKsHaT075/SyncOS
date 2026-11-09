import { api } from "@/lib/axios";

const base = "/analytics";
const unwrap = (promise) => promise.then((response) => response.data);
const clean = (params = {}) => Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== undefined && value !== null));

export const analyticsService = {
  view: (type, params) => unwrap(api.get(`${base}/${type}`, { params: clean(params) })),
  platform: (params) => unwrap(api.get(`${base}/platform`, { params: clean(params) })),
  report: (type, params) => unwrap(api.get(`${base}/reports/${type}`, { params: clean(params) })),
  // Goes through axios so the Bearer token is sent; the caller saves the blob.
  exportCsv: (type, params) => api.get(`${base}/reports/${type}/export`, { params: clean(params), responseType: "blob" }),
};
