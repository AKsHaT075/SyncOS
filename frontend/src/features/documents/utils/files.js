import { toast } from "sonner";
import { documentService } from "@/features/documents/services/documentService";
import { INLINE_PREVIEW_EXTENSIONS } from "@/features/documents/constants/documentOptions";
import { getFriendlyErrorMessage } from "@/lib/error-message";

// With responseType "blob" an error body arrives as a Blob; turn it back into
// JSON so getFriendlyErrorMessage can read the server's message.
async function unwrapBlobError(error) {
  const data = error?.response?.data;
  if (data instanceof Blob) {
    try {
      error.response.data = JSON.parse(await data.text());
    } catch {
      /* leave as is */
    }
  }
  return error;
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function downloadDocument(doc, { version } = {}) {
  try {
    const response = await documentService.fetchFile(doc.id, { version });
    const suffix = version ? ` (v${version})` : "";
    const name = version ? doc.name.replace(/(\.[^.]+)$/, `${suffix}$1`) : doc.name;
    saveBlob(response.data, name);
  } catch (error) {
    toast.error(getFriendlyErrorMessage(await unwrapBlobError(error)));
  }
}

export function canPreview(doc) {
  return INLINE_PREVIEW_EXTENSIONS.includes(doc.extension);
}

export async function previewDocument(doc) {
  // Open the tab synchronously (inside the click) so popup blockers allow it.
  const tab = window.open("", "_blank");
  try {
    const response = await documentService.fetchFile(doc.id, { disposition: "inline" });
    const url = URL.createObjectURL(response.data);
    if (tab) {
      tab.location.href = url;
    } else {
      window.location.href = url;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab?.close();
    toast.error(getFriendlyErrorMessage(await unwrapBlobError(error)));
  }
}
