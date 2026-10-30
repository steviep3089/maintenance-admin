// Maintenance Mode status logic shared by the Portal and the mobile app (keep all copies identical).
// Pure functions only, so it can be tested offline with `node --test`.

export const MAINTENANCE_POLL_MS = 30000;
export const MAINTENANCE_FETCH_TIMEOUT_MS = 8000;
export const MAINTENANCE_MESSAGE_MAX = 500;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 72;
export const DEFAULT_MAINTENANCE_MESSAGE =
  "The system is undergoing scheduled maintenance. Please try again later.";

export const INITIAL_MAINTENANCE_STATE = Object.freeze({
  loaded: false,
  checked: false,
  connectionError: false,
  status: Object.freeze({
    enabled: false,
    message: null,
    expectedReturnAt: null,
    updatedAt: null,
    isSuperUser: false,
    canManage: false,
    passwordConfigured: false,
  }),
});

// get_maintenance_status() returns a one-row table; tolerate an object or an array.
export function normalizeMaintenanceStatus(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return { ...INITIAL_MAINTENANCE_STATE.status };
  }
  const message = typeof row.message === "string" ? row.message.trim() : "";
  return {
    enabled: row.enabled === true,
    message: message ? message.slice(0, MAINTENANCE_MESSAGE_MAX) : null,
    expectedReturnAt: row.expected_return_at || null,
    updatedAt: row.updated_at || null,
    isSuperUser: row.is_super_user === true,
    canManage: row.can_manage === true,
    passwordConfigured: row.password_configured === true,
  };
}

// A network failure carries no PostgREST/Postgres error code; server-side errors do.
export function classifyError(error) {
  if (!error) return null;
  if (error.code) return "server";
  const text = String(error.message || error).toLowerCase();
  return /fetch|network|timeout|timed out|abort|offline|connection/.test(text) ? "network" : "server";
}

export async function fetchMaintenanceStatus(client, timeoutMs = MAINTENANCE_FETCH_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "network" }), timeoutMs);
  });
  const request = (async () => {
    try {
      const { data, error } = await client.rpc("get_maintenance_status");
      if (error) return { ok: false, reason: classifyError(error) };
      return { ok: true, status: normalizeMaintenanceStatus(data) };
    } catch {
      return { ok: false, reason: "network" };
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// A failed check never flips maintenance on or off: the last known status is kept. Only a genuine
// network failure raises connectionError, so "can't reach the server" is never shown as maintenance.
// A server-side failure (for example the RPC is not installed yet) is treated as "no maintenance"
// when nothing is known, because the server enforces writes itself. `checked` becomes true after any
// result so the UI never waits forever on an unreachable server.
export function reduceMaintenanceState(previous, result) {
  if (result && result.ok) {
    return { loaded: true, checked: true, connectionError: false, status: result.status };
  }
  return {
    loaded: previous.loaded,
    checked: true,
    connectionError: result?.reason === "network",
    status: previous.status,
  };
}

// Only the Super User bypasses. Admin role and knowledge of the maintenance password never do.
export function shouldShowMaintenance(state) {
  return state.status.enabled === true && state.status.isSuperUser !== true;
}

// Signing out or switching accounts must not leave stale privileges in place.
export function clearPrivileges(state) {
  if (!state.status.isSuperUser && !state.status.canManage && !state.status.passwordConfigured) {
    return state;
  }
  return {
    ...state,
    status: { ...state.status, isSuperUser: false, canManage: false, passwordConfigured: false },
  };
}

export function formatExpectedReturn(iso, locale) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

// Converts a <input type="datetime-local"> value to an ISO string, or null when blank/invalid.
export function localInputToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// The Super User may turn maintenance OFF without the password; every other change needs it.
export function passwordRequired({ enabled, isSuperUser }) {
  return enabled === true || isSuperUser !== true;
}

export function validateMaintenanceForm({
  enabled,
  message,
  expectedReturnAt,
  password,
  isSuperUser = false,
  now = Date.now(),
}) {
  const trimmed = (message || "").trim();
  if (trimmed.length > MAINTENANCE_MESSAGE_MAX) {
    return `Message must be ${MAINTENANCE_MESSAGE_MAX} characters or fewer.`;
  }
  if (enabled && expectedReturnAt) {
    const t = new Date(expectedReturnAt).getTime();
    if (Number.isNaN(t) || t <= now) return "Expected return time must be in the future.";
    if (t > now + 90 * 24 * 60 * 60 * 1000) return "Expected return time must be within 90 days.";
  }
  if (passwordRequired({ enabled, isSuperUser }) && !password) {
    return "Enter the maintenance password.";
  }
  return null;
}

export function validateNewPassword(newPassword, confirmation) {
  const value = newPassword || "";
  if ([...value].length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (new TextEncoder().encode(value).length > PASSWORD_MAX_BYTES) {
    return `Password must be at most ${PASSWORD_MAX_BYTES} bytes.`;
  }
  if (value !== confirmation) return "Passwords do not match.";
  return null;
}

// User-facing text for server result codes. Never includes server details.
export function describeMaintenanceCode(code) {
  switch (code) {
    case "bad_password":
      return "Incorrect maintenance password.";
    case "rate_limited":
      return "Too many incorrect attempts. Wait 15 minutes and try again.";
    case "password_not_configured":
      return "No maintenance password has been set. The Super User must set one first.";
    case "no_super_user":
      return "Maintenance cannot be started because no Super User account is designated.";
    case "weak_password":
      return `The new password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_BYTES} characters.`;
    case "42501":
      return "You are not allowed to do that.";
    default:
      return "Could not complete the request. Try again.";
  }
}

// RPC helpers return { ok, code } only; server error text never reaches the UI and the password is
// never stored, logged or returned.
async function callResultRpc(client, name, args) {
  try {
    const { data, error } = await client.rpc(name, args);
    if (error) return { ok: false, code: error.code || "unknown" };
    const row = Array.isArray(data) ? data[0] : data;
    if (row && row.ok === true) return { ok: true, code: "ok" };
    return { ok: false, code: (row && typeof row.code === "string" && row.code) || "unknown" };
  } catch {
    return { ok: false, code: "network" };
  }
}

export function setMaintenanceMode(client, { enabled, message, expectedReturnAt, password }) {
  return callResultRpc(client, "set_maintenance_mode", {
    p_enabled: enabled,
    p_message: enabled ? (message || "").trim() || null : null,
    p_expected_return_at: enabled ? expectedReturnAt || null : null,
    p_password: password || null,
  });
}

export function setMaintenancePassword(client, { currentPassword, newPassword }) {
  return callResultRpc(client, "set_maintenance_password", {
    p_new_password: newPassword,
    p_current_password: currentPassword || null,
  });
}
