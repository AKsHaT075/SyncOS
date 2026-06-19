export function getFriendlyErrorMessage(error) {
  const status = error?.response?.status;
  const data = error?.response?.data;

  if (!error?.response) {
    return "Network error. Check your connection and try again.";
  }

  if (typeof data?.message === "string" && data.message.trim()) {
    if (status === 401) {
      return "Your session expired. Please sign in again.";
    }

    if (status === 403) {
      return "You do not have permission to perform this action.";
    }

    if (status === 429) {
      return "Too many requests. Please wait and try again.";
    }

    return data.message;
  }

  if (status === 401) {
    return "Your session expired. Please sign in again.";
  }

  if (status === 403) {
    return "You do not have permission to perform this action.";
  }

  if (status === 429) {
    return "Too many requests. Please wait and try again.";
  }

  return error?.message || "Something went wrong. Please try again.";
}
