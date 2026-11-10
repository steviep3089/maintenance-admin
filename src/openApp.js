// Existing Maintenance App scheme (maintenance-app app.json "scheme"); no credentials in the URL.
export const MAINTENANCE_APP_URL = "maintenanceapp://login";
export const OPEN_APP_LABEL = "Open Maintenance App";
export const DESKTOP_FALLBACK_MESSAGE =
  "To use the Maintenance App, open it on your phone and sign in with your new password.";

export function isMobileDevice(nav) {
  const n = nav ?? (typeof navigator !== "undefined" ? navigator : {});
  return /Android|iPhone|iPad|iPod/i.test(n.userAgent || "");
}
