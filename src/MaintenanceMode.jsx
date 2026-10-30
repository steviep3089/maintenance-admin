// src/MaintenanceMode.jsx - user-facing maintenance screen and admin controls for the Portal.
import React, { useState } from "react";
import {
  DEFAULT_MAINTENANCE_MESSAGE,
  MAINTENANCE_MESSAGE_MAX,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  describeMaintenanceCode,
  formatExpectedReturn,
  localInputToIso,
  passwordRequired,
  setMaintenanceMode,
  setMaintenancePassword,
  validateMaintenanceForm,
  validateNewPassword,
} from "./maintenanceStatus";

const cardStyle = {
  maxWidth: 520,
  margin: "12vh auto 0",
  padding: 32,
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  textAlign: "center",
};

const buttonStyle = {
  padding: "8px 16px",
  borderRadius: 6,
  border: "none",
  backgroundColor: "#1d4ed8",
  color: "#ffffff",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
};

export function MaintenanceScreen({ status, connectionError, onSignOut }) {
  const returnTime = formatExpectedReturn(status.expectedReturnAt);
  return (
    <div className="app-root">
      <div style={cardStyle} role="status">
        <h2 style={{ marginTop: 0 }}>Maintenance in progress</h2>
        <p style={{ whiteSpace: "pre-wrap" }}>{status.message || DEFAULT_MAINTENANCE_MESSAGE}</p>
        {returnTime && (
          <p>
            <strong>Expected back:</strong> {returnTime}
          </p>
        )}
        {connectionError && (
          <p style={{ color: "#6b7280", fontSize: 13 }}>
            Unable to refresh the status right now. This page will update when the connection returns.
          </p>
        )}
        {onSignOut && (
          <button onClick={onSignOut} style={{ ...buttonStyle, marginTop: 12 }}>
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}

// Shown above the login form while maintenance is on.
export function MaintenanceLoginNotice({ status }) {
  if (!status.enabled) return null;
  return (
    <div
      role="status"
      style={{ background: "#fef3c7", color: "#92400e", padding: "10px 16px", textAlign: "center", fontSize: 14 }}
    >
      Maintenance mode is on. Only the Super User account can use the portal right now.
    </div>
  );
}

function PasswordField({ label, value, onChange, autoComplete = "off" }) {
  return (
    <label style={{ fontSize: 13 }}>
      {label}
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        maxLength={PASSWORD_MAX_BYTES}
        style={{ display: "block", width: "100%", boxSizing: "border-box" }}
      />
    </label>
  );
}

// Visible only to admins who passed the maintenance gate (everyone when OFF, the Super User when ON).
export function MaintenanceAdminPanel({ client, status, connectionError, onChanged }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [returnLocal, setReturnLocal] = useState("");
  const [password, setPassword] = useState("");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!status.canManage) return null;

  function clearSecrets() {
    setPassword("");
    setCurPw("");
    setNewPw("");
    setConfirmPw("");
  }

  function toggleOpen() {
    if (!open) {
      setMessage(status.message || "");
      setReturnLocal("");
      setError("");
      setNotice("");
    }
    clearSecrets();
    setOpen(!open);
  }

  async function apply(enabled) {
    const expectedReturnAt = localInputToIso(returnLocal);
    const problem = validateMaintenanceForm({
      enabled,
      message,
      expectedReturnAt,
      password,
      isSuperUser: status.isSuperUser,
    });
    if (problem) {
      setError(problem);
      return;
    }
    if (
      enabled &&
      !window.confirm(
        status.isSuperUser
          ? "Turn maintenance mode ON? Everyone except the Super User will be blocked."
          : "Turn maintenance mode ON? Everyone except the Super User - including you - will be blocked immediately, and only the Super User (or the Supabase Dashboard emergency OFF) can restore access."
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const result = await setMaintenanceMode(client, {
      enabled,
      message,
      expectedReturnAt,
      password: passwordRequired({ enabled, isSuperUser: status.isSuperUser }) ? password : null,
    });
    setBusy(false);
    clearSecrets();
    if (!result.ok) {
      setError(describeMaintenanceCode(result.code));
      return;
    }
    await onChanged();
    setOpen(false);
  }

  async function changePassword() {
    const problem = validateNewPassword(newPw, confirmPw);
    if (problem) {
      setError(problem);
      return;
    }
    if (status.passwordConfigured && !curPw) {
      setError("Enter the current maintenance password.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const result = await setMaintenancePassword(client, {
      currentPassword: status.passwordConfigured ? curPw : null,
      newPassword: newPw,
    });
    setBusy(false);
    clearSecrets();
    if (!result.ok) {
      setError(describeMaintenanceCode(result.code));
      return;
    }
    setNotice("Maintenance password saved.");
    await onChanged();
  }

  return (
    <div style={{ padding: "8px 30px", background: status.enabled ? "#fef3c7" : "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, color: status.enabled ? "#92400e" : "#374151" }}>
          Maintenance mode: <strong>{status.enabled ? "ON (everyone except the Super User is blocked)" : "OFF"}</strong>
          {status.isSuperUser ? " - you are the Super User" : ""}
          {connectionError ? " - status may be out of date" : ""}
        </span>
        <button onClick={toggleOpen} style={buttonStyle}>
          {open ? "Close" : "Manage"}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 10, display: "grid", gap: 8, maxWidth: 560 }}>
          {!status.passwordConfigured && (
            <div style={{ fontSize: 13, color: "#92400e" }}>
              No maintenance password is set yet. The Super User must set one before maintenance can be started.
            </div>
          )}
          <label style={{ fontSize: 13 }}>
            Message shown to users ({message.length}/{MAINTENANCE_MESSAGE_MAX})
            <textarea
              value={message}
              maxLength={MAINTENANCE_MESSAGE_MAX}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              style={{ width: "100%", boxSizing: "border-box" }}
              placeholder={DEFAULT_MAINTENANCE_MESSAGE}
            />
          </label>
          <label style={{ fontSize: 13 }}>
            Expected return time (optional)
            <input
              type="datetime-local"
              value={returnLocal}
              onChange={(e) => setReturnLocal(e.target.value)}
              style={{ display: "block" }}
            />
          </label>
          <PasswordField label="Maintenance password" value={password} onChange={setPassword} />
          {status.isSuperUser && status.enabled && (
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              As Super User you can turn maintenance OFF without the password.
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={busy} onClick={() => apply(true)} style={{ ...buttonStyle, backgroundColor: "#b45309" }}>
              {status.enabled ? "Update message" : "Turn ON"}
            </button>
            {status.enabled && (
              <button disabled={busy} onClick={() => apply(false)} style={{ ...buttonStyle, backgroundColor: "#15803d" }}>
                Turn OFF
              </button>
            )}
          </div>
          {status.isSuperUser && (
            <fieldset style={{ border: "1px solid #d1d5db", padding: 10, display: "grid", gap: 6 }}>
              <legend style={{ fontSize: 13 }}>Maintenance password (Super User only)</legend>
              {status.passwordConfigured && (
                <PasswordField label="Current password" value={curPw} onChange={setCurPw} />
              )}
              <PasswordField
                label={`New password (${PASSWORD_MIN_LENGTH}+ characters)`}
                value={newPw}
                onChange={setNewPw}
                autoComplete="new-password"
              />
              <PasswordField label="Confirm new password" value={confirmPw} onChange={setConfirmPw} autoComplete="new-password" />
              <button disabled={busy} onClick={changePassword} style={buttonStyle}>
                {status.passwordConfigured ? "Change password" : "Set password"}
              </button>
            </fieldset>
          )}
          {error && (
            <div role="alert" style={{ color: "#b91c1c", fontSize: 13 }}>
              {error}
            </div>
          )}
          {notice && (
            <div role="status" style={{ color: "#15803d", fontSize: 13 }}>
              {notice}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
