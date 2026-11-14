import { getFriendlyErrorMessage } from "@/lib/error-message";

/** Message for a failed AI Studio request (axios error). Server-side failures (5xx) never show server-provided text. */
export function aiErrorMessage(error) {
  const status = error?.response?.status;
  if (status >= 500) return "Something went wrong on our side. Please try again.";
  return getFriendlyErrorMessage(error);
}
