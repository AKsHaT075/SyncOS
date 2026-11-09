import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { analyticsService } from "@/features/analytics/services/analyticsService";

const KEY = "analytics";
const STALE = 60 * 1000;

/** type: overview | me | tasks | projects | people | teams | meetings | assets */
export const useAnalytics = (type, params, { enabled = true } = {}) =>
  useQuery({ queryKey: [KEY, type, params], queryFn: () => analyticsService.view(type, params), enabled, placeholderData: keepPreviousData, staleTime: STALE, retry: false });

export const usePlatformAnalytics = (params, { enabled = true } = {}) =>
  useQuery({ queryKey: [KEY, "platform", params], queryFn: () => analyticsService.platform(params), enabled, placeholderData: keepPreviousData, staleTime: STALE, retry: false });

export const useReport = (type, params, { enabled = true } = {}) =>
  useQuery({ queryKey: [KEY, "report", type, params], queryFn: () => analyticsService.report(type, params), enabled, placeholderData: keepPreviousData, staleTime: STALE, retry: false });
