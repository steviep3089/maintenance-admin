// Existing Maintenance App scheme (maintenance-app app.json "scheme"); no credentials in the URL.
export const MAINTENANCE_APP_URL = "maintenanceapp://login";
export const OPEN_APP_LABEL = "Open Maintenance App";
export const DESKTOP_FALLBACK_MESSAGE =
  "Standard Maintenance users: open the Maintenance App on your phone and sign in with your new password.";
export const PASSWORD_SAVED_MESSAGE =
  "Your password has been saved. Use it to sign in to the Maintenance App.";
export const ADMIN_PORTAL_NOTE = "Administrators only:";
export const ADMIN_PORTAL_LOGIN_LABEL = "Admin Portal Login";

export function isMobileDevice(nav) {
  const n = nav ?? (typeof navigator !== "undefined" ? navigator : {});
  return /Android|iPhone|iPad|iPod/i.test(n.userAgent || "");
}
