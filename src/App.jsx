// src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import { supabase, SUPABASE_STORAGE_KEY } from "./supabaseClient";
import "./App.css";
import html2pdf from 'html2pdf.js';

/* ===========================
   HELPERS
   =========================== */

const STATUS_COLOURS = {
  Reported: "#ef4444",
  "In Progress": "#f59e0b",
  Completed: "#22c55e",
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_KEYS = {
  users: "maintenance-admin.users.v1",
  userRoles: "maintenance-admin.userRoles.v1",
  adminUsers: "maintenance-admin.adminUsers.v1",
  defects: "maintenance-admin.defects.v1",
  divisions: "maintenance-admin.divisions.v1",
  plantAssets: "maintenance-admin.plantAssets.v1",
};

const DEFAULT_DIVISIONS = ["Sitebatch", "South", "Midlands", "North"];

function addResumeListeners(onResume, onSuspend) {
  let lastRunAt = 0;
  const run = () => {
    const now = Date.now();
    if (now - lastRunAt < 1000) {
      return;
    }
    lastRunAt = now;
    if (onSuspend) {
      onSuspend();
    }
    onResume();
  };
  const handleVisibility = () => {
    if (document.hidden) {
      if (onSuspend) {
        onSuspend();
      }
      return;
    }
    run();
  };

  handleVisibility();
  window.addEventListener("focus", handleVisibility);
  document.addEventListener("visibilitychange", handleVisibility);
  if (onSuspend) {
    window.addEventListener("blur", onSuspend);
  }
  return () => {
    window.removeEventListener("focus", handleVisibility);
    document.removeEventListener("visibilitychange", handleVisibility);
    if (onSuspend) {
      window.removeEventListener("blur", onSuspend);
    }
  };
}

const sessionResumeState = {
  inFlight: null,
  lastAttemptAt: 0,
};

function normalizeStoredSession(value) {
  if (!value) return null;
  if (value.currentSession) return value.currentSession;
  if (value.session) return value.session;
  if (value.access_token) return value;
  return null;
}

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SUPABASE_STORAGE_KEY);
    if (!raw) return null;
    return normalizeStoredSession(JSON.parse(raw));
  } catch (err) {
    console.warn("Session storage read failed:", err);
    return null;
  }
}

function getSessionWithTimeout(timeoutMs = 1500) {
  const getSessionPromise = supabase.auth.getSession();
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      resolve({ data: { session: readStoredSession() }, error: null });
    }, timeoutMs);
  });
  return Promise.race([getSessionPromise, timeoutPromise]);
}

function refreshSessionWithTimeout(timeoutMs = 1500) {
  const refreshPromise = supabase.auth.refreshSession();
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ data: null, error: null }), timeoutMs);
  });
  return Promise.race([refreshPromise, timeoutPromise]);
}

async function resumeSessionIfNeeded() {
  try {
    if (document.hidden) {
      return;
    }
    if (sessionResumeState.inFlight) {
      return sessionResumeState.inFlight.catch(() => null);
    }
    const now = Date.now();
    if (now - sessionResumeState.lastAttemptAt < 5000) {
      return;
    }
    sessionResumeState.lastAttemptAt = now;

    sessionResumeState.inFlight = (async () => {
      const { data, error } = await getSessionWithTimeout();
      if (error || !data?.session) {
        return;
      }
      const expiresAtMs = (data.session.expires_at || 0) * 1000;
      if (expiresAtMs && expiresAtMs - Date.now() < 60000) {
        await refreshSessionWithTimeout();
      }
    })();

    return sessionResumeState.inFlight.catch(() => null);
  } catch (err) {
    console.warn("Session resume failed:", err);
  } finally {
    if (sessionResumeState.inFlight) {
      await sessionResumeState.inFlight.catch(() => null);
      sessionResumeState.inFlight = null;
    }
  }
}

function isAuthError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 401 || status === 403) {
    return true;
  }
  const message = `${err.message || ""}`.toLowerCase();
  return message.includes("jwt");
}

async function withAuthRetry(requestFn) {
  const result = await requestFn();
  if (!result?.error || !isAuthError(result.error)) {
    return result;
  }
  const refresh = await refreshSessionWithTimeout();
  if (refresh?.error) {
    return result;
  }
  return requestFn();
}

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

const DIVISION_BADGE_STYLES = {
  sitebatch: {
    backgroundColor: "#e0f2fe",
    color: "#0c4a6e",
    border: "1px solid #7dd3fc",
  },
  south: {
    backgroundColor: "#ecfdf5",
    color: "#065f46",
    border: "1px solid #6ee7b7",
  },
  midlands: {
    backgroundColor: "#fef3c7",
    color: "#92400e",
    border: "1px solid #fcd34d",
  },
  north: {
    backgroundColor: "#ede9fe",
    color: "#5b21b6",
    border: "1px solid #c4b5fd",
  },
};

const DIVISION_BADGE_FALLBACK_PALETTE = [
  { backgroundColor: "#ffe4e6", color: "#9f1239", border: "1px solid #fda4af" },
  { backgroundColor: "#fef9c3", color: "#854d0e", border: "1px solid #fde047" },
  { backgroundColor: "#dcfce7", color: "#166534", border: "1px solid #86efac" },
  { backgroundColor: "#e0e7ff", color: "#3730a3", border: "1px solid #a5b4fc" },
  { backgroundColor: "#fae8ff", color: "#86198f", border: "1px solid #e879f9" },
  { backgroundColor: "#fef2f2", color: "#991b1b", border: "1px solid #fca5a5" },
];

function getDivisionBadgeStyle(divisionName) {
  const normalized = (divisionName || "").trim().toLowerCase();
  if (DIVISION_BADGE_STYLES[normalized]) {
    return DIVISION_BADGE_STYLES[normalized];
  }

  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  const idx = hash % DIVISION_BADGE_FALLBACK_PALETTE.length;
  return DIVISION_BADGE_FALLBACK_PALETTE[idx];
}

function arraysOverlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    return false;
  }
  const bSet = new Set(b);
  return a.some((item) => bSet.has(item));
}

async function loadDivisionScopeForUser(userId) {
  if (!userId) {
    return {
      divisionIds: [],
      visibleAssetCodes: [],
      assetDivisionIdsByCode: {},
    };
  }

  const { data: userDivisionRows, error: userDivisionError } = await withAuthRetry(() =>
    supabase
      .from("user_divisions")
      .select("division_id")
      .eq("user_id", userId)
  );

  if (userDivisionError) {
    throw userDivisionError;
  }

  const divisionIds = Array.from(
    new Set((userDivisionRows || []).map((row) => row.division_id).filter(Boolean))
  );

  if (divisionIds.length === 0) {
    return {
      divisionIds,
      visibleAssetCodes: [],
      assetDivisionIdsByCode: {},
    };
  }

  const visibleAssetCodesSet = new Set();
  const assetDivisionIdsByCode = {};

  const { data: assetDivisionRows, error: assetDivisionError } = await withAuthRetry(() =>
    supabase
      .from("plant_asset_divisions")
      .select("division_id, plant_assets(asset_code)")
      .in("division_id", divisionIds)
  );

  if (!assetDivisionError) {
    (assetDivisionRows || []).forEach((row) => {
      const assetCode = row?.plant_assets?.asset_code;
      const divisionId = row?.division_id;
      if (!assetCode || !divisionId) {
        return;
      }
      visibleAssetCodesSet.add(assetCode);
      if (!assetDivisionIdsByCode[assetCode]) {
        assetDivisionIdsByCode[assetCode] = [];
      }
      if (!assetDivisionIdsByCode[assetCode].includes(divisionId)) {
        assetDivisionIdsByCode[assetCode].push(divisionId);
      }
    });
  } else {
    const { data: legacyAssetRows, error: legacyAssetError } = await withAuthRetry(() =>
      supabase
        .from("plant_assets")
        .select("asset_code, division_id")
        .in("division_id", divisionIds)
        .eq("is_active", true)
    );

    if (legacyAssetError) {
      throw legacyAssetError;
    }

    (legacyAssetRows || []).forEach((row) => {
      const assetCode = row?.asset_code;
      const divisionId = row?.division_id;
      if (!assetCode || !divisionId) {
        return;
      }
      visibleAssetCodesSet.add(assetCode);
      if (!assetDivisionIdsByCode[assetCode]) {
        assetDivisionIdsByCode[assetCode] = [];
      }
      if (!assetDivisionIdsByCode[assetCode].includes(divisionId)) {
        assetDivisionIdsByCode[assetCode].push(divisionId);
      }
    });
  }

  return {
    divisionIds,
    visibleAssetCodes: Array.from(visibleAssetCodesSet),
    assetDivisionIdsByCode,
  };
}

function canViewDefectWithScope(defect, scope) {
  if (!defect || !scope) {
    return false;
  }

  const divisionIds = scope.divisionIds || [];
  const visibleAssetCodes = scope.visibleAssetCodes || [];

  const hasDivisionAccess =
    !!defect.division_id && Array.isArray(divisionIds) && divisionIds.includes(defect.division_id);
  const hasAssetAccess =
    !!defect.asset && Array.isArray(visibleAssetCodes) && visibleAssetCodes.includes(defect.asset);

  return hasDivisionAccess || hasAssetAccess;
}

function getDefectDivisionIdsForScope(defect, scope) {
  if (!defect || !scope) {
    return [];
  }

  if (defect.division_id) {
    return [defect.division_id];
  }

  const fromAsset = scope.assetDivisionIdsByCode?.[defect.asset];
  return Array.isArray(fromAsset) ? fromAsset : [];
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (!result || typeof result !== "string") {
        reject(new Error("Failed to read file"));
        return;
      }
      const base64 = result.split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(blob);
  });
}

function readCache(key, ttlMs = CACHE_TTL_MS) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.ts || Date.now() - parsed.ts > ttlMs) {
      return null;
    }
    return parsed.value;
  } catch (err) {
    console.warn("Cache read failed:", err);
    return null;
  }
}

function readCacheTimestamp(key, ttlMs = CACHE_TTL_MS) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.ts || Date.now() - parsed.ts > ttlMs) {
      return null;
    }
    return parsed.ts;
  } catch (err) {
    console.warn("Cache timestamp read failed:", err);
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ ts: Date.now(), value })
    );
  } catch (err) {
    console.warn("Cache write failed:", err);
  }
}

function getAuthFlowFromUrl() {
  if (typeof window === "undefined") {
    return { type: null, from: null, pathname: "" };
  }
  const url = new URL(window.location.href);
  const searchType = url.searchParams.get("type");
  const from = url.searchParams.get("from");
  let hashType = null;
  if (url.hash) {
    const hashParams = new URLSearchParams(
      url.hash.startsWith("#") ? url.hash.substring(1) : url.hash
    );
    hashType = hashParams.get("type");
  }
  return {
    type: searchType || hashType,
    from,
    pathname: url.pathname,
  };
}

// detect if URL contains a Supabase recovery link
function isRecoveryUrl() {
  const { type, from, pathname } = getAuthFlowFromUrl();
  return type === "recovery" || from === "recovery" || pathname === "/reset";
}

function isPasswordSetupUrl() {
  const { type, from } = getAuthFlowFromUrl();
  return (
    type === "signup" ||
    type === "invite" ||
    from === "signup" ||
    from === "invite"
  );
}

function needsPasswordSetup(currentSession) {
  const user = currentSession?.user;
  const invited = user?.invited_at || user?.user_metadata?.invited;
  return !!(invited && user?.user_metadata?.password_set !== true);
}

/* ===========================
   RESET PASSWORD PAGE
   =========================== */

function ResetPasswordPage({ onDone, allowNonAdmin }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [linkError, setLinkError] = useState("");
  const [userRole, setUserRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showPostReset, setShowPostReset] = useState(false);
  const buildOrigin =
    typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    async function checkRole() {
      const url = new URL(window.location.href);
      const hashParams = new URLSearchParams(
        url.hash.startsWith("#") ? url.hash.substring(1) : url.hash
      );
      const searchParams = url.searchParams;
      const errorCode =
        hashParams.get("error_code") || searchParams.get("error_code");
      const errorDescription =
        hashParams.get("error_description") ||
        searchParams.get("error_description");
      if (errorCode === "otp_expired" || /expired/i.test(errorDescription || "")) {
        setLinkError("This invite link has expired. Please request a new invite.");
        setLoading(false);
        return;
      }

      const { data: { session } } = await getSessionWithTimeout();
      
      if (session?.user) {
        const { data } = await withAuthRetry(() =>
          supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", session.user.id)
            .single()
        );
        
        setUserRole(data?.role || null);
      }
      setLoading(false);
    }
    checkRole();
  }, []);

  async function handleReset(e) {
    e.preventDefault();
    setError("");
    setInfo("");

    if (!password || !confirm) {
      setError("Please fill in both password fields.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    const { error } = await supabase.auth.updateUser({
      password,
      data: { password_set: true },
    });

    if (error) {
      setError(error.message);
    } else {
      setInfo("Password updated successfully. You can now log in.");
      try {
        if (typeof window !== "undefined") {
          // clear hash so we don't keep thinking it's a recovery URL
          window.location.hash = "";
          window.history.replaceState({}, "", "/");
        }
      } catch (_) {}

      await supabase.auth.signOut();
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("force_password_change");
      }
      setShowPostReset(true);
    }
  }

  if (loading) {
    return (
      <div className="app-root">
        <div style={{ maxWidth: 420, margin: "80px auto", padding: 24, textAlign: "center" }}>
          Loading...
        </div>
      </div>
    );
  }

  if (linkError) {
    return (
      <div className="app-root">
        <div
          style={{
            maxWidth: 420,
            margin: "80px auto",
            padding: 24,
            background: "#ffffff",
            borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
          }}
        >
          <h1 style={{ marginBottom: 8 }}>Link Expired</h1>
          <p style={{ marginTop: 0, marginBottom: 20, color: "#6b7280" }}>
            {linkError}
          </p>
          <button
            onClick={() => {
              supabase.auth.signOut();
              if (typeof window !== "undefined") {
                window.close();
              }
            }}
            style={{
              width: "100%",
              padding: 10,
              borderRadius: 999,
              border: "none",
              backgroundColor: "#1d4ed8",
              color: "#ffffff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // Non-admin users can't reset password via portal
  if (!allowNonAdmin && userRole !== "admin") {
    return (
      <div className="app-root">
        <div
          style={{
            maxWidth: 420,
            margin: "80px auto",
            padding: 24,
            background: "#ffffff",
            borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
          }}
        >
          <h1 style={{ marginBottom: 8 }}>Access Restricted</h1>
          <p style={{ marginTop: 0, marginBottom: 20, color: "#6b7280" }}>
            This portal is for admin users only. If you're a regular user, please use the mobile app to reset your password.
          </p>
          <button
            onClick={() => {
              supabase.auth.signOut();
              window.close();
            }}
            style={{
              width: "100%",
              padding: 10,
              borderRadius: 999,
              border: "none",
              backgroundColor: "#1d4ed8",
              color: "#ffffff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  if (showPostReset) {
    const portalLoginUrl =
      typeof window !== "undefined" ? window.location.origin : "/";
    const appLoginUrl = "maintenanceapp://login";
    return (
      <div className="app-root">
        <div
          style={{
            maxWidth: 420,
            margin: "80px auto",
            padding: 24,
            background: "#ffffff",
            borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
          }}
        >
          <h1 style={{ marginBottom: 8 }}>Password Updated</h1>
          <p style={{ marginTop: 0, marginBottom: 20, color: "#6b7280" }}>
            Your password is set. You can now sign in to the Maintenance App.
          </p>
          <p style={{ marginTop: -8, marginBottom: 16, color: "#9ca3af", fontSize: 12 }}>
            Build source: {buildOrigin}
          </p>
          <a
            href={appLoginUrl}
            style={{
              display: "inline-block",
              width: "100%",
              textAlign: "center",
              padding: 10,
              borderRadius: 999,
              border: "none",
              backgroundColor: "#1d4ed8",
              color: "#ffffff",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Open the Maintenance App
          </a>
          <button
            type="button"
            onClick={() => {
              if (onDone) onDone();
              if (typeof window !== "undefined") {
                window.location.href = portalLoginUrl;
              }
            }}
            style={{
              width: "100%",
              marginTop: 12,
              padding: 10,
              borderRadius: 999,
              border: "1px solid #1d4ed8",
              backgroundColor: "#ffffff",
              color: "#1d4ed8",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Back to Portal Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-root">
      <div
        style={{
          maxWidth: 420,
          margin: "80px auto",
          padding: 24,
          background: "#ffffff",
          borderRadius: 12,
          boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
        }}
      >
        <h1 style={{ marginBottom: 8 }}>Reset your password</h1>
        <p style={{ marginTop: 0, marginBottom: 20, color: "#6b7280" }}>
          Please enter a new password for your account.
        </p>
        <p style={{ marginTop: -8, marginBottom: 16, color: "#9ca3af", fontSize: 12 }}>
          Build source: {buildOrigin}
        </p>

        <form onSubmit={handleReset}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", marginBottom: 4 }}>
              New password
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 72px 8px 8px",
                  borderRadius: 6,
                  border: "1px solid #d1d5db",
                }}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  border: "none",
                  background: "transparent",
                  color: "#1d4ed8",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", marginBottom: 4 }}>
              Confirm password
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showConfirm ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 72px 8px 8px",
                  borderRadius: 6,
                  border: "1px solid #d1d5db",
                }}
                required
              />
              <button
                type="button"
                onClick={() => setShowConfirm((prev) => !prev)}
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  border: "none",
                  background: "transparent",
                  color: "#1d4ed8",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {showConfirm ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {error && (
            <div
              style={{
                marginBottom: 10,
                color: "#b91c1c",
                fontSize: 14,
              }}
            >
              {error}
            </div>
          )}

          {info && (
            <div
              style={{
                marginBottom: 10,
                color: "#166534",
                fontSize: 14,
              }}
            >
              {info}
            </div>
          )}

          <button
            type="submit"
            style={{
              width: "100%",
              padding: 10,
              borderRadius: 999,
              border: "none",
              backgroundColor: "#1d4ed8",
              color: "#ffffff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Save new password
          </button>
        </form>
      </div>
    </div>
  );
}

/* ===========================
   ACTION TASK PAGE
   =========================== */

function ActionTaskPage({ activeTab }) {
  const [defects, setDefects] = useState([]);
  const [users, setUsers] = useState([]);
  const [filteredUsers, setFilteredUsers] = useState([]);
  const [scope, setScope] = useState({
    divisionIds: [],
    visibleAssetCodes: [],
    assetDivisionIdsByCode: {},
  });
  const [userDivisionIdsByUserId, setUserDivisionIdsByUserId] = useState({});
  const [userSearchText, setUserSearchText] = useState("");
  const [selectedDefectId, setSelectedDefectId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [usersStale, setUsersStale] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [lastUsersSync, setLastUsersSync] = useState(null);
  const [lastDefectsSync, setLastDefectsSync] = useState(null);
  const loadingDefectsRef = useRef(false);
  const usersRequestIdRef = useRef(0);
  const usersTimeoutRef = useRef(null);

  const openDefects = defects.filter(
    (defect) => (defect.status || "Reported") !== "Completed"
  );

  useEffect(() => {
    if (selectedDefectId && !openDefects.some((defect) => defect.id === selectedDefectId)) {
      setSelectedDefectId("");
      setSelectedUserId("");
    }
  }, [selectedDefectId, openDefects]);

  useEffect(() => {
    if (activeTab !== "tasks") {
      return;
    }

    const cleanup = addResumeListeners(
      () => {
        void (async () => {
          await resumeSessionIfNeeded();
          const nextScope = await loadAccessScope();
          await Promise.all([loadDefects(nextScope), loadUsers()]);
        })();
      },
      () => {
        usersRequestIdRef.current += 1;
        setLoadingUsers(false);
        loadingDefectsRef.current = false;
      }
    );

    return cleanup;
  }, [activeTab]);

  useEffect(() => {
    const selectedDefect = defects.find((defect) => defect.id === selectedDefectId);
    const selectedDefectDivisionIds = selectedDefect
      ? getDefectDivisionIdsForScope(selectedDefect, scope)
      : [];

    let nextUsers = users;
    if (selectedDefect) {
      if (selectedDefectDivisionIds.length === 0) {
        nextUsers = [];
      } else {
        nextUsers = users.filter((user) =>
          arraysOverlap(userDivisionIdsByUserId[user.id] || [], selectedDefectDivisionIds)
        );
      }
    }

    if (userSearchText.trim()) {
      const search = userSearchText.toLowerCase();
      nextUsers = nextUsers.filter((user) =>
        (user.email || "").toLowerCase().includes(search)
      );
    }

    if (selectedUserId && !nextUsers.some((user) => user.id === selectedUserId)) {
      setSelectedUserId("");
    }

    setFilteredUsers(nextUsers);
  }, [
    userSearchText,
    users,
    selectedDefectId,
    selectedUserId,
    defects,
    scope,
    userDivisionIdsByUserId,
  ]);

  async function loadAccessScope() {
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError) {
      throw userError;
    }

    const nextScope = await loadDivisionScopeForUser(user?.id);
    setScope(nextScope);
    return nextScope;
  }

  async function loadDefects(scopeOverride = null) {
    if (loadingDefectsRef.current) {
      return;
    }
    loadingDefectsRef.current = true;
    try {
      const activeScope = scopeOverride || scope;
      const divisionIds = activeScope.divisionIds || [];
      const visibleAssetCodes = activeScope.visibleAssetCodes || [];

      if (divisionIds.length === 0 && visibleAssetCodes.length === 0) {
        setDefects([]);
        setLastDefectsSync(Date.now());
        return;
      }

      const makeBaseQuery = () =>
        supabase
          .from("defects")
          .select("*")
          .order("created_at", { ascending: false });

      const fetchByDivision = async () => {
        if (divisionIds.length === 0) {
          return { data: [], error: null };
        }
        return withAuthRetry(() => makeBaseQuery().in("division_id", divisionIds));
      };

      const fetchByAsset = async () => {
        if (visibleAssetCodes.length === 0) {
          return { data: [], error: null };
        }
        return withAuthRetry(() => makeBaseQuery().in("asset", visibleAssetCodes));
      };

      const [divisionResult, assetResult] = await Promise.all([
        fetchByDivision(),
        fetchByAsset(),
      ]);

      const error = divisionResult.error || assetResult.error;
      const mergedMap = new Map();

      [...(divisionResult.data || []), ...(assetResult.data || [])].forEach((defect) => {
        if (defect?.id) {
          mergedMap.set(defect.id, defect);
        }
      });

      const data = Array.from(mergedMap.values()).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      if (error) throw error;
      setDefects(data || []);
      setLastDefectsSync(Date.now());
    } catch (err) {
      console.error("Error loading defects:", err);
      setMessage("Error loading defects: " + err.message);
    } finally {
      loadingDefectsRef.current = false;
    }
  }

  async function loadUsers() {
    try {
      setLoadingUsers(true);
      let hadCache = false;
      const cachedUsers = readCache(CACHE_KEYS.users);
      const cachedUsersTs = readCacheTimestamp(CACHE_KEYS.users);
      if (cachedUsers) {
        setUsers(cachedUsers);
        setFilteredUsers(cachedUsers);
        setUsersStale(false);
        if (cachedUsersTs) {
          setLastUsersSync(cachedUsersTs);
        }
        hadCache = true;
      }

      const requestId = usersRequestIdRef.current + 1;
      usersRequestIdRef.current = requestId;

      // Call edge function to get all users
      const { data, error } = await withAuthRetry(() =>
        supabase.functions.invoke('list-users')
      );

      if (usersRequestIdRef.current !== requestId) {
        return;
      }
      if (error) throw error;
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to load users');
      }

      const allUsers = data.users || [];

      const userIds = allUsers.map((user) => user.id).filter(Boolean);
      const userDivisionMap = {};

      if (userIds.length > 0) {
        const { data: userDivisionRows, error: userDivisionError } = await withAuthRetry(() =>
          supabase
            .from("user_divisions")
            .select("user_id, division_id")
            .in("user_id", userIds)
        );

        if (userDivisionError) {
          throw userDivisionError;
        }

        (userDivisionRows || []).forEach((row) => {
          if (!userDivisionMap[row.user_id]) {
            userDivisionMap[row.user_id] = [];
          }
          userDivisionMap[row.user_id].push(row.division_id);
        });
      }

      setUsers(allUsers);
      setFilteredUsers(allUsers);
      setUserDivisionIdsByUserId(userDivisionMap);
      setUsersStale(false);
      setLastUsersSync(Date.now());
      writeCache(CACHE_KEYS.users, allUsers);
      
      if (allUsers.length === 0) {
        setMessage("No users found in the system.");
      }
    } catch (err) {
      if (!usersStale) {
        console.error("Error loading users:", err);
      }
      if (!usersStale) {
        setMessage("Error loading users: " + err.message);
      }
      setUsersStale(true);
    } finally {
      if (usersTimeoutRef.current) {
        clearTimeout(usersTimeoutRef.current);
      }
      setLoadingUsers(false);
    }
  }

  async function assignTask() {
    if (!selectedDefectId || !selectedUserId || !dueDate) {
      setMessage("Please fill in all fields");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      console.log("Selected Defect ID:", selectedDefectId);
      console.log("Selected User ID:", selectedUserId);
      console.log("Available defects:", defects.map(d => d.id));
      console.log("Available users:", users.map(u => u.email));

      const selectedDefect = defects.find(d => d.id === selectedDefectId);
      const selectedUser = users.find(u => u.id === selectedUserId);
      
      console.log("Found defect:", selectedDefect);
      console.log("Found user:", selectedUser);
      
      if (!selectedDefect) {
        throw new Error("Defect not found. Please refresh and try again.");
      }
      
      if (!selectedUser) {
        throw new Error("User not found. Please refresh and try again.");
      }

      if ((selectedDefect.status || "Reported") === "Completed") {
        throw new Error("Completed defects cannot be assigned.");
      }

      const selectedDefectDivisionIds = getDefectDivisionIdsForScope(selectedDefect, scope);
      const selectedUserDivisionIds = userDivisionIdsByUserId[selectedUser.id] || [];
      if (
        selectedDefectDivisionIds.length === 0 ||
        !arraysOverlap(selectedDefectDivisionIds, selectedUserDivisionIds)
      ) {
        throw new Error("Selected user is not assigned to this defect region.");
      }

      // Log task assignment in defect_activity
      const { data: auth } = await supabase.auth.getUser();
      const performer = auth?.user?.email ?? "Admin Portal";
      
      const { error: activityError } = await supabase
        .from("defect_activity")
        .insert({
          defect_id: selectedDefect.id,
          message: `Task assigned to ${selectedUser.email} - Due: ${dueDate}`,
          performed_by: performer
        });

      if (activityError) throw activityError;

      // Send email notification
      const emailBody = `
        <h2>Task Assignment Notification</h2>
        <p>You have been assigned a maintenance task:</p>
        <hr>
        <p><strong>Asset:</strong> ${selectedDefect.asset}</p>
        <p><strong>Title:</strong> ${selectedDefect.title}</p>
        <p><strong>Category:</strong> ${selectedDefect.category}</p>
        <p><strong>Priority:</strong> ${selectedDefect.priority}</p>
        <p><strong>Status:</strong> ${selectedDefect.status}</p>
        <p><strong>Description:</strong></p>
        <p>${selectedDefect.description || 'N/A'}</p>
        <hr>
        <p><strong>Due Date:</strong> ${new Date(dueDate).toLocaleDateString()}</p>
        <p>Please complete this task by the due date.</p>
      `;

      const { error: emailError } = await supabase.functions.invoke('send-report-email', {
        body: {
          to: selectedUser.email,
          subject: `Task Assigned: ${selectedDefect.asset} - ${selectedDefect.title}`,
          html: emailBody
        }
      });

      console.log('Email error:', emailError);

      if (emailError) {
        console.error('Failed to send email:', emailError);
        throw new Error(`Failed to send email: ${emailError.message}`);
      }

      setMessage(`✓ Task assigned successfully to ${selectedUser.email}`);
      setSelectedDefectId("");
      setSelectedUserId("");
      setDueDate("");
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 30, maxWidth: 800, margin: "0 auto" }}>
      <h2 style={{ marginBottom: 20 }}>Action Task Assignment</h2>
      <p style={{ color: "#666", marginBottom: 30 }}>
        Assign a defect to a user and send them an email notification.
      </p>
      {(lastDefectsSync || lastUsersSync) && (
        <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 18 }}>
          {lastDefectsSync && (
            <span>Defects synced: {formatDateTime(lastDefectsSync)}</span>
          )}
          {lastDefectsSync && lastUsersSync && <span> | </span>}
          {lastUsersSync && (
            <span>Users synced: {formatDateTime(lastUsersSync)}</span>
          )}
        </div>
      )}

      <div style={{ marginBottom: 15 }}>
        <label style={{ display: "block", marginBottom: 5, fontWeight: 600 }}>
          Select Defect
        </label>
        <select
          value={selectedDefectId}
          onChange={(e) => setSelectedDefectId(e.target.value)}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 6,
            border: "1px solid #ddd",
            fontSize: 16
          }}
        >
          <option value="">-- Choose a defect --</option>
          {openDefects.map((defect) => (
            <option key={defect.id} value={defect.id}>
              {defect.asset} - {defect.title} ({defect.status})
            </option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 15 }}>
        <label style={{ display: "block", marginBottom: 5, fontWeight: 600 }}>
          Assign To
        </label>
        {usersStale && (
          <div
            style={{
              background: "#fff7ed",
              color: "#9a3412",
              padding: "6px 8px",
              borderRadius: 6,
              marginBottom: 8,
              fontSize: 13
            }}
          >
            User list may be out of date.
          </div>
        )}
        <input
          type="text"
          placeholder="Search users..."
          value={userSearchText}
          onChange={(e) => setUserSearchText(e.target.value)}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 6,
            border: "1px solid #ddd",
            fontSize: 16,
            marginBottom: 8
          }}
        />
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 6,
            border: "1px solid #ddd",
            fontSize: 16,
            maxHeight: 200
          }}
          size={5}
        >
          <option value="">-- Choose a user --</option>
          {filteredUsers.map((user) => (
            <option key={user.id} value={user.id}>
              {user.email}
            </option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 25 }}>
        <label style={{ display: "block", marginBottom: 5, fontWeight: 600 }}>
          Due Date
        </label>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          min={new Date().toISOString().split('T')[0]}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 6,
            border: "1px solid #ddd",
            fontSize: 16
          }}
        />
      </div>

      <button
        onClick={assignTask}
        disabled={loading || loadingUsers}
        style={{
          backgroundColor: "#3b82f6",
          color: "white",
          padding: "12px 24px",
          borderRadius: 6,
          border: "none",
          fontSize: 16,
          fontWeight: 600,
          cursor: loading ? "not-allowed" : "pointer",
          opacity: loading ? 0.6 : 1,
          width: "100%"
        }}
      >
        {loading ? "Assigning..." : "Assign Task"}
      </button>

      {message && (
        <div
          style={{
            marginTop: 20,
            padding: 12,
            borderRadius: 6,
            backgroundColor: message.startsWith("User created") ? "#dcfce7" : "#fee2e2",
            color: message.startsWith("User created") ? "#166534" : "#991b1b",
          }}
        >
          {message}
        </div>
      )}
    </div>
  );
}

/* ===========================
   USER MANAGEMENT PAGE
   =========================== */

function UserManagementPage() {
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState("user");
  const [availableDivisions, setAvailableDivisions] = useState(DEFAULT_DIVISIONS);
  const [selectedDivisions, setSelectedDivisions] = useState(["Sitebatch"]);
  const [includeOtherDivision, setIncludeOtherDivision] = useState(false);
  const [otherDivisionName, setOtherDivisionName] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  
  // For viewing current users
  const [allUsers, setAllUsers] = useState([]);
  const [userRoles, setUserRoles] = useState({});
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userLoadError, setUserLoadError] = useState("");
  const [searchText, setSearchText] = useState("");
  const [deletingUserId, setDeletingUserId] = useState(null);
  const [resendingInviteUserId, setResendingInviteUserId] = useState(null);
  const [invitingContractsUserId, setInvitingContractsUserId] = useState(null);
  const [editingUserId, setEditingUserId] = useState(null);
  const [editSelectedDivisions, setEditSelectedDivisions] = useState([]);
  const [editIncludeOtherDivision, setEditIncludeOtherDivision] = useState(false);
  const [editOtherDivisionName, setEditOtherDivisionName] = useState("");
  const [savingUserDivisionsId, setSavingUserDivisionsId] = useState(null);
  const [lastUsersSync, setLastUsersSync] = useState(null);
  const loadingUsersRef = useRef(false);
  const usersRequestIdRef = useRef(0);
  const usersTimeoutRef = useRef(null);
  const [usersStale, setUsersStale] = useState(false);
  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const adminRedirectBase = isLocalhost
    ? "http://localhost:5173"
    : window.location.origin;
  const inviteRedirectTo = `${adminRedirectBase}/reset?from=invite`;

  async function loadAvailableDivisions({ force = false } = {}) {
    try {
      if (!force) {
        const cachedDivisions = readCache(CACHE_KEYS.divisions);
        if (cachedDivisions && cachedDivisions.length > 0) {
          setAvailableDivisions(cachedDivisions);
        }
      }

      const { data, error } = await withAuthRetry(() =>
        supabase
          .from("divisions")
          .select("name")
          .order("name", { ascending: true })
      );

      if (error) {
        throw error;
      }

      const dbDivisionNames = (data || [])
        .map((row) => (row.name || "").trim())
        .filter((name) => name.length > 0);

      const merged = Array.from(
        new Set([...DEFAULT_DIVISIONS, ...dbDivisionNames])
      ).sort((a, b) => a.localeCompare(b));

      setAvailableDivisions(merged);
      writeCache(CACHE_KEYS.divisions, merged);
    } catch (err) {
      console.warn("Could not load divisions, using defaults:", err?.message || err);
      setAvailableDivisions((prev) =>
        prev && prev.length > 0
          ? prev
          : DEFAULT_DIVISIONS
      );
    }
  }

  function toggleDivision(divisionName) {
    setSelectedDivisions((prev) => {
      if (prev.includes(divisionName)) {
        return prev.filter((name) => name !== divisionName);
      }
      return [...prev, divisionName];
    });
  }

  function toggleEditDivision(divisionName) {
    setEditSelectedDivisions((prev) => {
      if (prev.includes(divisionName)) {
        return prev.filter((name) => name !== divisionName);
      }
      return [...prev, divisionName];
    });
  }

  function startEditUserDivisions(user) {
    const divisions = Array.isArray(user?.divisions) ? user.divisions : [];
    setEditingUserId(user.id);
    setEditSelectedDivisions(divisions);
    setEditIncludeOtherDivision(false);
    setEditOtherDivisionName("");
    setMessage("");
  }

  function cancelEditUserDivisions() {
    setEditingUserId(null);
    setEditSelectedDivisions([]);
    setEditIncludeOtherDivision(false);
    setEditOtherDivisionName("");
  }

  async function resolveDivisionIdsByNames(divisionNames) {
    const normalizedDivisionNames = Array.from(
      new Set(
        (divisionNames || [])
          .map((name) => (name || "").trim())
          .filter((name) => name.length > 0)
      )
    );

    if (normalizedDivisionNames.length === 0) {
      return [];
    }

    const { data: existingRows, error: existingError } = await withAuthRetry(() =>
      supabase.from("divisions").select("id, name")
    );

    if (existingError) {
      throw existingError;
    }

    const existingByLowerName = new Map(
      (existingRows || []).map((row) => [String(row.name).toLowerCase(), row])
    );

    const divisionIds = [];

    for (const divisionName of normalizedDivisionNames) {
      const key = divisionName.toLowerCase();
      const existing = existingByLowerName.get(key);
      if (existing?.id) {
        divisionIds.push(existing.id);
        continue;
      }

      const { data: inserted, error: insertError } = await withAuthRetry(() =>
        supabase
          .from("divisions")
          .insert({ name: divisionName })
          .select("id, name")
          .single()
      );

      if (insertError) {
        throw insertError;
      }

      if (inserted?.id) {
        existingByLowerName.set(key, inserted);
        divisionIds.push(inserted.id);
      }
    }

    return divisionIds;
  }

  async function saveUserDivisions(user) {
    if (!user?.id) {
      return;
    }

    setSavingUserDivisionsId(user.id);
    setMessage("");

    try {
      const trimmedOther = editOtherDivisionName.trim();
      const selectedNames = editSelectedDivisions
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      const combinedNames = editIncludeOtherDivision && trimmedOther
        ? [...selectedNames, trimmedOther]
        : selectedNames;

      if (combinedNames.length === 0) {
        throw new Error("Select at least one division or enter an Other division.");
      }

      if (editIncludeOtherDivision && !trimmedOther) {
        throw new Error("Please enter a name for Other division.");
      }

      const divisionIds = await resolveDivisionIdsByNames(combinedNames);

      const { error: deleteError } = await withAuthRetry(() =>
        supabase
          .from("user_divisions")
          .delete()
          .eq("user_id", user.id)
      );

      if (deleteError) {
        throw deleteError;
      }

      const { error: insertError } = await withAuthRetry(() =>
        supabase
          .from("user_divisions")
          .insert(
            divisionIds.map((divisionId) => ({
              user_id: user.id,
              division_id: divisionId,
            }))
          )
      );

      if (insertError) {
        throw insertError;
      }

      let contractsSyncWarning = "";
      if (user?.contracts_linked && user?.email) {
        const authority = userRoles[user.id] === "admin" ? "admin" : "user";
        const { data: syncData, error: syncError } = await withAuthRetry(() =>
          supabase.functions.invoke("invite-contracts-portal", {
            body: {
              email: user.email,
              displayName: user.email,
              authority,
              regions: combinedNames,
            },
          })
        );

        if (syncError) {
          contractsSyncWarning = ` Contracts sync failed: ${syncError.message}`;
        } else if (!syncData?.success) {
          const warningText = Array.isArray(syncData?.warnings) && syncData.warnings.length
            ? syncData.warnings.join(" | ")
            : syncData?.error || "unknown sync error";
          contractsSyncWarning = ` Contracts sync failed: ${warningText}`;
        }
      }

      setMessage(`Updated divisions for ${user.email}.${contractsSyncWarning}`);
      cancelEditUserDivisions();
      await loadAvailableDivisions({ force: true });
      await loadAllUsers({ force: true });
    } catch (err) {
      setMessage(`Error updating divisions: ${err.message}`);
    } finally {
      setSavingUserDivisionsId(null);
    }
  }

  async function loadAllUsers({ force = false } = {}) {
    if (loadingUsersRef.current && !force) {
      return;
    }
    loadingUsersRef.current = true;
    setLoadingUsers(true);
    setUserLoadError("");
    let hadCache = false;

    if (!force) {
      const cachedUsers = readCache(CACHE_KEYS.users);
      const cachedRoles = readCache(CACHE_KEYS.userRoles);
      const cachedUsersTs = readCacheTimestamp(CACHE_KEYS.users);
      if (cachedUsers) {
        setAllUsers(cachedUsers);
        setUserRoles(cachedRoles || {});
        setUsersStale(false);
        setLoadingUsers(false);
        if (cachedUsersTs) {
          setLastUsersSync(cachedUsersTs);
        }
        hadCache = true;
      }
    }

    const requestId = usersRequestIdRef.current + 1;
    usersRequestIdRef.current = requestId;
    try {
      const { data: usersData, error: usersError } = await withAuthRetry(() =>
        supabase.functions.invoke('list-users')
      );
      if (usersRequestIdRef.current !== requestId) {
        return;
      }
      if (usersError) throw usersError;
      if (!usersData.success) throw new Error(usersData.error);

      const rolesMap = {};
      (usersData.users || []).forEach((user) => {
        rolesMap[user.id] = user.role || "user";
      });

      setAllUsers(usersData.users || []);
      setUserRoles(rolesMap);
      setUserLoadError("");
      setUsersStale(false);
      setLastUsersSync(Date.now());
      writeCache(CACHE_KEYS.users, usersData.users || []);
      writeCache(CACHE_KEYS.userRoles, rolesMap);
    } catch (err) {
      if (usersRequestIdRef.current !== requestId) {
        return;
      }
      console.error('Error loading users:', err);
      if (!hadCache) {
        setUserLoadError(`Error loading users: ${err.message}`);
      }
      setUsersStale(true);
    } finally {
      if (usersRequestIdRef.current !== requestId) {
        return;
      }
      setLoadingUsers(false);
      loadingUsersRef.current = false;
    }
  }

  useEffect(() => {
    const cleanup = addResumeListeners(
      () => {
        void resumeSessionIfNeeded();
        loadAvailableDivisions({ force: true });
        loadAllUsers({ force: true });
      },
      () => {
        usersRequestIdRef.current += 1;
        setLoadingUsers(false);
        loadingUsersRef.current = false;
      }
    );

    return cleanup;
  }, []);

  const filteredUsers = allUsers.filter(user => 
    user.email.toLowerCase().includes(searchText.toLowerCase())
  );

  async function handleDeleteUser(user) {
    if (!user?.id) return;
    if (!window.confirm(`Delete user ${user.email}?`)) return;

    setDeletingUserId(user.id);
    try {
      const { data, error } = await supabase.functions.invoke("delete-user", {
        body: { userId: user.id }
      });
      if (error) throw error;
      if (!data?.success) {
        throw new Error(data?.error || "Failed to delete user");
      }
      await loadAllUsers();
    } catch (err) {
      console.error("Delete user error:", err);
      setMessage(`Error deleting user: ${err.message}`);
    } finally {
      setDeletingUserId(null);
    }
  }

  async function createUser() {
    if (!newUserEmail.trim()) {
      setMessage("Email is required");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const trimmedOtherDivision = otherDivisionName.trim();
      const divisionNames = selectedDivisions
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

      if (divisionNames.length === 0 && !trimmedOtherDivision) {
        throw new Error("Select at least one division or enter an Other division.");
      }

      if (includeOtherDivision && !trimmedOtherDivision) {
        throw new Error("Please enter a name for Other division.");
      }

      // Call Supabase Edge Function to create user with proper permissions
      const redirectTo = inviteRedirectTo;
      const { data, error } = await supabase.functions.invoke("create-user", {
        body: {
          email: newUserEmail,
          role: newUserRole,
          redirectTo,
          divisions: divisionNames,
          otherDivisionName: includeOtherDivision ? trimmedOtherDivision : "",
        },
      });

      console.log('Create user response:', data, error);

      if (error) throw error;
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to create user');
      }

      setMessage(`User created successfully. An email invite was sent to ${newUserEmail}.`);
      await loadAllUsers();
      setTimeout(() => setMessage(""), 3000);
      setNewUserEmail("");
      setNewUserRole("user");
      setSelectedDivisions(["Sitebatch"]);
      setIncludeOtherDivision(false);
      setOtherDivisionName("");
      await loadAvailableDivisions({ force: true });
    } catch (err) {
      console.error('Create user error:', err);
      setMessage(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function resendInvite(user) {
    if (!user?.id) {
      return;
    }

    setResendingInviteUserId(user.id);
    setMessage("");

    try {
      const { data, error } = await withAuthRetry(() =>
        supabase.functions.invoke("resend-invite", {
          body: {
            userId: user.id,
            redirectTo: inviteRedirectTo,
          },
        })
      );

      if (error) {
        throw error;
      }

      if (!data?.success) {
        throw new Error(data?.error || "Failed to resend invite");
      }

      setMessage(`Invite re-sent to ${user.email}.`);
      await loadAllUsers({ force: true });
    } catch (err) {
      setMessage(`Error re-sending invite: ${err.message}`);
    } finally {
      setResendingInviteUserId(null);
    }
  }

  async function inviteToContractsPortal(user) {
    if (!user?.email) {
      setMessage("Invite to contracts failed: missing user email.");
      return;
    }

    setInvitingContractsUserId(user.id);
    setMessage("");

    try {
      const authority = userRoles[user.id] === "admin" ? "admin" : "user";
      const { data, error } = await withAuthRetry(() =>
        supabase.functions.invoke("invite-contracts-portal", {
          body: {
            email: user.email,
            displayName: user.email,
            authority,
            regions: Array.isArray(user.divisions) ? user.divisions : [],
          },
        })
      );

      if (error) {
        throw error;
      }

      if (!data?.success) {
        throw new Error(data?.error || "Failed to invite user to contracts portal");
      }

      const warnings = Array.isArray(data?.warnings) && data.warnings.length
        ? ` Warnings: ${data.warnings.join(" | ")}`
        : "";

      setMessage(
        data?.alreadyLinked
          ? `User already linked in contracts portal: ${user.email}.${warnings}`
          : `Contracts portal invite sent to ${user.email}.${warnings}`
      );

      await loadAllUsers({ force: true });
    } catch (err) {
      setMessage(`Error inviting to contracts portal: ${err.message}`);
    } finally {
      setInvitingContractsUserId(null);
    }
  }

  return (
    <div style={{ padding: 30, maxWidth: 1400, margin: "0 auto" }}>
      <h2 style={{ marginBottom: 20 }}>User Management</h2>
      <p style={{ color: "#666", marginBottom: 30 }}>
        Create new user accounts for the mobile app. Users receive an email to set their password.
      </p>

      <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
        {/* Left Column - Create User Form */}
        <div style={{ flex: "0 0 500px" }}>
          <div style={{ marginBottom: 15 }}>
            <label style={{ display: "block", marginBottom: 5, fontWeight: 600 }}>
              Email
            </label>
            <input
              type="email"
              value={newUserEmail}
              onChange={(e) => setNewUserEmail(e.target.value)}
              placeholder="user@company.com"
              name="new-user-email"
              id="new-user-email"
              autoComplete="email"
              list="user-email-suggestions"
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 6,
                border: "1px solid #ddd",
                fontSize: 16
              }}
            />
            <datalist id="user-email-suggestions">
              {allUsers.map((user) => (
                <option key={user.id} value={user.email} />
              ))}
            </datalist>
          </div>

          <div style={{ marginBottom: 25 }}>
            <label style={{ display: "block", marginBottom: 5, fontWeight: 600 }}>
              Role
            </label>
            <select
              value={newUserRole}
              onChange={(e) => setNewUserRole(e.target.value)}
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 6,
                border: "1px solid #ddd",
                fontSize: 16
              }}
            >
              <option value="user">User (Mobile App Only)</option>
              <option value="admin">Admin (Full Access)</option>
            </select>
          </div>

          <div style={{ marginBottom: 25 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>
              Divisions
            </label>
            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                padding: 12,
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 8,
              }}
            >
              {availableDivisions.map((divisionName) => (
                <label
                  key={divisionName}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}
                >
                  <input
                    type="checkbox"
                    checked={selectedDivisions.includes(divisionName)}
                    onChange={() => toggleDivision(divisionName)}
                  />
                  <span>{divisionName}</span>
                </label>
              ))}
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={includeOtherDivision}
                  onChange={(e) => setIncludeOtherDivision(e.target.checked)}
                />
                <span>Other</span>
              </label>
            </div>
            {includeOtherDivision && (
              <input
                type="text"
                value={otherDivisionName}
                onChange={(e) => setOtherDivisionName(e.target.value)}
                placeholder="Enter new division name"
                style={{
                  width: "100%",
                  marginTop: 10,
                  padding: 10,
                  borderRadius: 6,
                  border: "1px solid #ddd",
                  fontSize: 14,
                }}
              />
            )}
          </div>

          <div
            style={{
              marginBottom: 12,
              fontSize: 12,
              color: "#6b7280",
              wordBreak: "break-all",
            }}
          >
            Invite redirect: {inviteRedirectTo}
          </div>

          <button
            onClick={createUser}
            disabled={loading}
            style={{
              backgroundColor: "#22c55e",
              color: "white",
              padding: "12px 24px",
              borderRadius: 6,
              border: "none",
              fontSize: 16,
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1,
              width: "100%"
            }}
          >
            {loading ? "Creating..." : "Create User"}
          </button>

          {message && (
            <div
              style={{
                marginTop: 20,
                padding: 12,
                borderRadius: 6,
                backgroundColor: message.startsWith("User created") ? "#dcfce7" : "#fee2e2",
                color: message.startsWith("User created") ? "#166534" : "#991b1b",
              }}
            >
              {message}
            </div>
          )}
        </div>

        {/* Right Column - Current Users and Roles */}
        <div style={{ flex: 1 }}>
          <div
            style={{
              width: "100%",
              padding: "12px 16px",
              backgroundColor: "#f3f4f6",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: 16,
              fontWeight: 600,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>Current Users and Roles ({allUsers.length})</span>
            {lastUsersSync && (
              <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 500 }}>
                Last synced: {formatDateTime(lastUsersSync)}
              </span>
            )}
          </div>

          <div style={{ marginTop: 20 }}>
            {loadingUsers ? (
              <p style={{ textAlign: "center", color: "#666" }}>
                {allUsers.length ? "Refreshing users..." : "Loading users..."}
              </p>
            ) : (
              <>
                {usersStale && !userLoadError && (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: 10,
                      borderRadius: 6,
                      backgroundColor: "#fff7ed",
                      color: "#9a3412",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <span>List may be out of date. Refresh to sync.</span>
                    <button
                      onClick={loadAllUsers}
                      style={{
                        border: "none",
                        backgroundColor: "#9a3412",
                        color: "#fff",
                        padding: "6px 10px",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                )}
                {userLoadError && (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: 10,
                      borderRadius: 6,
                      backgroundColor: "#fee2e2",
                      color: "#991b1b",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <span>{userLoadError}</span>
                    <button
                      onClick={loadAllUsers}
                      style={{
                        border: "none",
                        backgroundColor: "#991b1b",
                        color: "#fff",
                        padding: "6px 10px",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {/* Search Box */}
                <div style={{ marginBottom: 15 }}>
                  <input
                    type="text"
                    placeholder="Search users by email..."
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    name="user-search-email"
                    id="user-search-email"
                    autoComplete="email"
                    list="user-email-suggestions"
                    style={{
                      width: "100%",
                      padding: 10,
                      borderRadius: 6,
                      border: "1px solid #ddd",
                      fontSize: 14
                    }}
                  />
                </div>

                {/* Users List */}
                {filteredUsers.length === 0 ? (
                  <p style={{ textAlign: "center", color: "#666" }}>No users found</p>
                ) : (
                  <div style={{ 
                    border: "1px solid #e5e7eb", 
                    borderRadius: 6,
                    maxHeight: 500,
                    overflowY: "auto"
                  }}>
                    {filteredUsers.map((user, index) => {
                      const role = userRoles[user.id] || "user";
                      const status = user.status || "pending_setup";
                      const divisions = Array.isArray(user.divisions)
                        ? user.divisions
                        : [];
                      const statusLabel =
                        status === "live"
                          ? "LIVE"
                          : status === "inactive"
                            ? "INACTIVE"
                          : status === "invite_expired"
                            ? "INVITE EXPIRED"
                            : "PENDING SETUP";
                      const statusColors =
                        status === "live"
                          ? { background: "#dcfce7", color: "#166534" }
                          : status === "inactive"
                            ? { background: "#e5e7eb", color: "#374151" }
                          : status === "invite_expired"
                            ? { background: "#fee2e2", color: "#991b1b" }
                            : { background: "#fff7ed", color: "#9a3412" };
                      const statusInfo =
                        status === "live"
                          ? (user.last_sign_in_at
                              ? `Last sign in: ${formatDateTime(user.last_sign_in_at)}`
                              : "Password set")
                          : status === "inactive"
                            ? (user.inactive_marked_at
                                ? `Deactivated: ${formatDateTime(user.inactive_marked_at)}`
                                : "Deactivated for inactivity")
                          : status === "invite_expired"
                            ? (user.invite_expires_at
                                ? `Invite expired: ${formatDateTime(user.invite_expires_at)}`
                                : "Invite expired")
                            : (user.invite_expires_at
                                ? `Invite expires: ${formatDateTime(user.invite_expires_at)}`
                                : "Awaiting password setup");
                      const canDelete = role !== "admin" && role !== "manager";
                      const isDeleting = deletingUserId === user.id;
                      const isResending = resendingInviteUserId === user.id;
                      const isInvitingContracts = invitingContractsUserId === user.id;
                      const isEditing = editingUserId === user.id;
                      const isSavingDivisions = savingUserDivisionsId === user.id;
                      const canResendInvite = status === "pending_setup" || status === "invite_expired";
                      const contractsLookupConfigured = user.contracts_lookup_configured !== false;
                      const contractsLinked = !!user.contracts_linked;
                      const contractsPendingSetup = !!user.contracts_pending_setup;
                      const canInviteContracts = contractsLookupConfigured && !!user.email && !contractsLinked;
                      return (
                        <React.Fragment key={user.id}>
                        <div
                          style={{
                            padding: "12px 16px",
                            borderBottom: index < filteredUsers.length - 1 ? "1px solid #e5e7eb" : "none",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            backgroundColor: index % 2 === 0 ? "#fff" : "#f9fafb"
                          }}
                        >
                          <div>
                            <div style={{ fontSize: 14, color: "#111827" }}>{user.email}</div>
                            <div style={{ marginTop: 4, fontSize: 12, color: "#6b7280" }}>Divisions:</div>
                            <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {divisions.length > 0 ? (
                                divisions.map((divisionName) => {
                                  const badgeStyle = getDivisionBadgeStyle(divisionName);
                                  return (
                                    <span
                                      key={`${user.id}-${divisionName}`}
                                      style={{
                                        fontSize: 11,
                                        fontWeight: 600,
                                        padding: "2px 8px",
                                        borderRadius: 999,
                                        backgroundColor: badgeStyle.backgroundColor,
                                        color: badgeStyle.color,
                                        border: badgeStyle.border,
                                      }}
                                    >
                                      {divisionName}
                                    </span>
                                  );
                                })
                              ) : (
                                <span style={{ fontSize: 12, color: "#6b7280" }}>None assigned</span>
                              )}
                            </div>
                            <div style={{ marginTop: 2, fontSize: 12, color: "#6b7280" }}>
                              {statusInfo}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 700,
                                padding: "4px 10px",
                                borderRadius: 12,
                                backgroundColor: statusColors.background,
                                color: statusColors.color,
                              }}
                            >
                              {statusLabel}
                            </span>
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 600,
                                padding: "4px 12px",
                                borderRadius: 12,
                                backgroundColor: role === "admin" ? "#dbeafe" : "#f3f4f6",
                                color: role === "admin" ? "#1e40af" : "#6b7280"
                              }}
                            >
                              {role.toUpperCase()}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                padding: "4px 10px",
                                borderRadius: 12,
                                backgroundColor: !contractsLookupConfigured
                                  ? "#e5e7eb"
                                  : contractsPendingSetup
                                    ? "#fef3c7"
                                    : contractsLinked
                                    ? "#dcfce7"
                                    : "#fef3c7",
                                color: !contractsLookupConfigured
                                  ? "#374151"
                                  : contractsPendingSetup
                                    ? "#92400e"
                                    : contractsLinked
                                    ? "#166534"
                                    : "#92400e",
                              }}
                            >
                              {!contractsLookupConfigured
                                ? "CONTRACTS OFF"
                                : contractsPendingSetup
                                  ? "CONTRACTS PENDING"
                                  : contractsLinked
                                  ? "CONTRACTS LINKED"
                                  : "NOT LINKED"}
                            </span>
                            {canResendInvite && (
                              <button
                                onClick={() => resendInvite(user)}
                                disabled={isResending}
                                style={{
                                  border: "none",
                                  background: "#f59e0b",
                                  color: "#fff",
                                  borderRadius: 6,
                                  padding: "4px 8px",
                                  cursor: isResending ? "not-allowed" : "pointer",
                                  fontSize: 12,
                                  fontWeight: 600,
                                }}
                              >
                                {isResending ? "Sending..." : "Resend Invite"}
                              </button>
                            )}
                            {canInviteContracts && (
                              <button
                                onClick={() => inviteToContractsPortal(user)}
                                disabled={isInvitingContracts}
                                style={{
                                  border: "none",
                                  background: "#2563eb",
                                  color: "#fff",
                                  borderRadius: 6,
                                  padding: "4px 8px",
                                  cursor: isInvitingContracts ? "not-allowed" : "pointer",
                                  fontSize: 12,
                                  fontWeight: 600,
                                }}
                              >
                                {isInvitingContracts ? "Inviting..." : "Invite to Contracts"}
                              </button>
                            )}
                            <button
                              onClick={() =>
                                isEditing
                                  ? cancelEditUserDivisions()
                                  : startEditUserDivisions(user)
                              }
                              disabled={isSavingDivisions}
                              style={{
                                border: "1px solid #2563eb",
                                background: "#fff",
                                color: "#2563eb",
                                borderRadius: 6,
                                padding: "4px 8px",
                                cursor: isSavingDivisions ? "not-allowed" : "pointer",
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              {isEditing ? "Cancel" : "Edit"}
                            </button>
                            {isEditing && (
                              <button
                                onClick={() => saveUserDivisions(user)}
                                disabled={isSavingDivisions}
                                style={{
                                  border: "none",
                                  background: "#22c55e",
                                  color: "#fff",
                                  borderRadius: 6,
                                  padding: "4px 8px",
                                  cursor: isSavingDivisions ? "not-allowed" : "pointer",
                                  fontSize: 12,
                                  fontWeight: 600,
                                }}
                              >
                                {isSavingDivisions ? "Saving..." : "Save"}
                              </button>
                            )}
                            {canDelete && (
                              <button
                                onClick={() => handleDeleteUser(user)}
                                disabled={isDeleting}
                                aria-label={`Delete ${user.email}`}
                                title="Delete user"
                                style={{
                                  border: "none",
                                  background: "transparent",
                                  color: "#b91c1c",
                                  fontWeight: 700,
                                  cursor: isDeleting ? "not-allowed" : "pointer",
                                  padding: 0,
                                  width: 18,
                                  height: 18,
                                  lineHeight: "18px",
                                  textAlign: "center"
                                }}
                              >
                                {isDeleting ? "…" : "x"}
                              </button>
                            )}
                          </div>
                        </div>
                        {isEditing && (
                          <div
                            style={{
                              padding: "12px 16px",
                              borderTop: "1px dashed #d1d5db",
                              backgroundColor: "#f8fafc",
                            }}
                          >
                            <div
                              style={{
                                marginBottom: 8,
                                fontSize: 13,
                                color: "#334155",
                                fontWeight: 600,
                              }}
                            >
                              Edit divisions for {user.email}
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                                gap: 8,
                              }}
                            >
                              {availableDivisions.map((divisionName) => (
                                <label
                                  key={`${user.id}-${divisionName}`}
                                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={editSelectedDivisions.includes(divisionName)}
                                    onChange={() => toggleEditDivision(divisionName)}
                                  />
                                  <span>{divisionName}</span>
                                </label>
                              ))}
                              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                                <input
                                  type="checkbox"
                                  checked={editIncludeOtherDivision}
                                  onChange={(e) => setEditIncludeOtherDivision(e.target.checked)}
                                />
                                <span>Other</span>
                              </label>
                            </div>
                            {editIncludeOtherDivision && (
                              <input
                                type="text"
                                value={editOtherDivisionName}
                                onChange={(e) => setEditOtherDivisionName(e.target.value)}
                                placeholder="Enter new division name"
                                style={{
                                  width: "100%",
                                  marginTop: 10,
                                  padding: 8,
                                  borderRadius: 6,
                                  border: "1px solid #cbd5e1",
                                  fontSize: 13,
                                }}
                              />
                            )}
                          </div>
                        )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===========================
   PLANT MANAGEMENT PAGE
   =========================== */

function PlantManagementPage() {
  const [divisions, setDivisions] = useState([]);
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [divisionFilter, setDivisionFilter] = useState("all");
  const [newAssetCode, setNewAssetCode] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newSerialNumber, setNewSerialNumber] = useState("");
  const [newMachineReg, setNewMachineReg] = useState("");
  const [newSelectedDivisionIds, setNewSelectedDivisionIds] = useState([]);
  const [includeOtherDivision, setIncludeOtherDivision] = useState(false);
  const [otherDivisionName, setOtherDivisionName] = useState("");
  const [editingAssetId, setEditingAssetId] = useState(null);
  const [editAssetCode, setEditAssetCode] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editSerialNumber, setEditSerialNumber] = useState("");
  const [editMachineReg, setEditMachineReg] = useState("");
  const [editSelectedDivisionIds, setEditSelectedDivisionIds] = useState([]);
  const [editIncludeOtherDivision, setEditIncludeOtherDivision] = useState(false);
  const [editOtherDivisionName, setEditOtherDivisionName] = useState("");
  const [savingAssetId, setSavingAssetId] = useState(null);

  function hasMissingPlantIdentifierColumns(error) {
    const message = String(error?.message || "").toLowerCase();
    return message.includes("serial_number") || message.includes("machine_reg");
  }

  async function loadPlantData() {
    setLoading(true);
    setMessage("");
    try {
      const { data: divisionRows, error: divisionError } = await withAuthRetry(() =>
        supabase
          .from("divisions")
          .select("id, name")
          .order("name", { ascending: true })
      );
      if (divisionError) {
        throw divisionError;
      }

      let assetRows = [];
      const { data: primaryAssetRows, error: primaryAssetError } = await withAuthRetry(() =>
        supabase
          .from("plant_assets")
          .select("id, asset_code, display_name, serial_number, machine_reg, division_id, is_active, created_at")
          .order("asset_code", { ascending: true })
      );

      if (primaryAssetError) {
        if (!hasMissingPlantIdentifierColumns(primaryAssetError)) {
          throw primaryAssetError;
        }

        const { data: legacyAssetRows, error: legacyAssetError } = await withAuthRetry(() =>
          supabase
            .from("plant_assets")
            .select("id, asset_code, display_name, division_id, is_active, created_at")
            .order("asset_code", { ascending: true })
        );

        if (legacyAssetError) {
          throw legacyAssetError;
        }

        assetRows = (legacyAssetRows || []).map((row) => ({
          ...row,
          serial_number: null,
          machine_reg: null,
        }));
      } else {
        assetRows = primaryAssetRows || [];
      }

      const { data: mappingRows, error: mappingError } = await withAuthRetry(() =>
        supabase
          .from("plant_asset_divisions")
          .select("asset_id, division_id, divisions(id, name)")
      );

      if (mappingError) {
        throw mappingError;
      }

      const divisionsById = new Map((divisionRows || []).map((d) => [d.id, d.name]));
      const mappingsByAssetId = new Map();

      (mappingRows || []).forEach((row) => {
        if (!mappingsByAssetId.has(row.asset_id)) {
          mappingsByAssetId.set(row.asset_id, []);
        }
        mappingsByAssetId.get(row.asset_id).push({
          id: row.division_id,
          name: row.divisions?.name || divisionsById.get(row.division_id) || "",
        });
      });

      const normalizedAssets = (assetRows || []).map((assetRow) => {
        const mappedDivisions = mappingsByAssetId.get(assetRow.id) || [];
        if (mappedDivisions.length === 0 && assetRow.division_id) {
          mappedDivisions.push({
            id: assetRow.division_id,
            name: divisionsById.get(assetRow.division_id) || "",
          });
        }

        return {
          ...assetRow,
          division_ids: mappedDivisions.map((d) => d.id),
          division_names: mappedDivisions
            .map((d) => d.name)
            .filter((name) => name)
            .sort((a, b) => a.localeCompare(b)),
        };
      });

      setDivisions(divisionRows || []);
      setAssets(normalizedAssets);

      if (newSelectedDivisionIds.length === 0 && (divisionRows || []).length > 0) {
        setNewSelectedDivisionIds([divisionRows[0].id]);
      }
    } catch (err) {
      setMessage(`Error loading plant data: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPlantData();
  }, []);

  function toggleNewDivisionId(divisionId) {
    setNewSelectedDivisionIds((prev) => {
      if (prev.includes(divisionId)) {
        return prev.filter((id) => id !== divisionId);
      }
      return [...prev, divisionId];
    });
  }

  function toggleEditDivisionId(divisionId) {
    setEditSelectedDivisionIds((prev) => {
      if (prev.includes(divisionId)) {
        return prev.filter((id) => id !== divisionId);
      }
      return [...prev, divisionId];
    });
  }

  async function resolveDivisionIdByName(rawName) {
    const divisionName = (rawName || "").trim();
    if (!divisionName) {
      return null;
    }

    const existing = divisions.find(
      (division) => String(division.name || "").toLowerCase() === divisionName.toLowerCase()
    );
    if (existing?.id) {
      return existing.id;
    }

    const { data: insertedDivision, error: insertDivisionError } = await withAuthRetry(() =>
      supabase
        .from("divisions")
        .insert({ name: divisionName })
        .select("id, name")
        .single()
    );

    if (insertDivisionError) {
      throw insertDivisionError;
    }

    return insertedDivision.id;
  }

  async function resolveDivisionIdsForSave({ selectedDivisionIds, includeOther, otherName }) {
    const ids = Array.from(new Set((selectedDivisionIds || []).filter(Boolean)));
    if (includeOther) {
      const otherId = await resolveDivisionIdByName(otherName);
      if (otherId) {
        ids.push(otherId);
      }
    }
    return Array.from(new Set(ids));
  }

  async function addPlantAsset() {
    const assetCode = newAssetCode.trim();
    const displayName = newDisplayName.trim();
    const serialNumber = newSerialNumber.trim();
    const machineReg = newMachineReg.trim();
    const trimmedOtherDivision = otherDivisionName.trim();

    if (!assetCode) {
      setMessage("Asset ID is required.");
      return;
    }
    if (newSelectedDivisionIds.length === 0 && !trimmedOtherDivision) {
      setMessage("Please select at least one division.");
      return;
    }
    if (includeOtherDivision && !trimmedOtherDivision) {
      setMessage("Please enter a name for Other division.");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const divisionIdsForInsert = await resolveDivisionIdsForSave({
        selectedDivisionIds: newSelectedDivisionIds,
        includeOther: includeOtherDivision,
        otherName: trimmedOtherDivision,
      });

      if (divisionIdsForInsert.length === 0) {
        throw new Error("Please select at least one division.");
      }

      const primaryDivisionId = divisionIdsForInsert[0];

      let insertedAsset = null;
      const { data: insertedAssetPrimary, error: insertAssetPrimaryError } = await withAuthRetry(() =>
        supabase
          .from("plant_assets")
          .insert({
            asset_code: assetCode,
            display_name: displayName || assetCode,
            serial_number: serialNumber || null,
            machine_reg: machineReg || null,
            division_id: primaryDivisionId,
            is_active: true,
          })
          .select("id")
          .single()
      );

      if (insertAssetPrimaryError) {
        if (!hasMissingPlantIdentifierColumns(insertAssetPrimaryError)) {
          throw insertAssetPrimaryError;
        }

        const { data: insertedAssetLegacy, error: insertAssetLegacyError } = await withAuthRetry(() =>
          supabase
            .from("plant_assets")
            .insert({
              asset_code: assetCode,
              display_name: displayName || assetCode,
              division_id: primaryDivisionId,
              is_active: true,
            })
            .select("id")
            .single()
        );

        if (insertAssetLegacyError) {
          throw insertAssetLegacyError;
        }

        insertedAsset = insertedAssetLegacy;
      } else {
        insertedAsset = insertedAssetPrimary;
      }

      const { error: mapInsertError } = await withAuthRetry(() =>
        supabase
          .from("plant_asset_divisions")
          .insert(
            divisionIdsForInsert.map((divisionId) => ({
              asset_id: insertedAsset.id,
              division_id: divisionId,
            }))
          )
      );

      if (mapInsertError) {
        throw mapInsertError;
      }

      setNewAssetCode("");
      setNewDisplayName("");
      setNewSerialNumber("");
      setNewMachineReg("");
      setNewSelectedDivisionIds([]);
      setIncludeOtherDivision(false);
      setOtherDivisionName("");
      setMessage("Plant item added.");
      await loadPlantData();
    } catch (err) {
      setMessage(`Error adding plant item: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  function startEditAsset(assetRow) {
    setEditingAssetId(assetRow.id);
    setEditAssetCode(assetRow.asset_code || "");
    setEditDisplayName(assetRow.display_name || "");
    setEditSerialNumber(assetRow.serial_number || "");
    setEditMachineReg(assetRow.machine_reg || "");
    setEditSelectedDivisionIds(Array.isArray(assetRow.division_ids) ? assetRow.division_ids : []);
    setEditIncludeOtherDivision(false);
    setEditOtherDivisionName("");
    setMessage("");
  }

  function cancelEditAsset() {
    setEditingAssetId(null);
    setEditAssetCode("");
    setEditDisplayName("");
    setEditSerialNumber("");
    setEditMachineReg("");
    setEditSelectedDivisionIds([]);
    setEditIncludeOtherDivision(false);
    setEditOtherDivisionName("");
  }

  async function saveAssetEdits(assetRow) {
    const assetCode = editAssetCode.trim();
    const displayName = editDisplayName.trim();
    const serialNumber = editSerialNumber.trim();
    const machineReg = editMachineReg.trim();
    const trimmedOtherDivision = editOtherDivisionName.trim();

    if (!assetCode) {
      setMessage("Asset ID is required.");
      return;
    }
    if (editSelectedDivisionIds.length === 0 && !trimmedOtherDivision) {
      setMessage("Please select at least one division.");
      return;
    }
    if (editIncludeOtherDivision && !trimmedOtherDivision) {
      setMessage("Please enter a name for Other division.");
      return;
    }

    setSavingAssetId(assetRow.id);
    setMessage("");
    try {
      const divisionIdsForUpdate = await resolveDivisionIdsForSave({
        selectedDivisionIds: editSelectedDivisionIds,
        includeOther: editIncludeOtherDivision,
        otherName: trimmedOtherDivision,
      });

      if (divisionIdsForUpdate.length === 0) {
        throw new Error("Please select at least one division.");
      }

      const primaryDivisionId = divisionIdsForUpdate[0];

      const { error: updatePrimaryError } = await withAuthRetry(() =>
        supabase
          .from("plant_assets")
          .update({
            asset_code: assetCode,
            display_name: displayName || assetCode,
            serial_number: serialNumber || null,
            machine_reg: machineReg || null,
            division_id: primaryDivisionId,
          })
          .eq("id", assetRow.id)
      );

      if (updatePrimaryError) {
        if (!hasMissingPlantIdentifierColumns(updatePrimaryError)) {
          throw updatePrimaryError;
        }

        const { error: updateLegacyError } = await withAuthRetry(() =>
          supabase
            .from("plant_assets")
            .update({
              asset_code: assetCode,
              display_name: displayName || assetCode,
              division_id: primaryDivisionId,
            })
            .eq("id", assetRow.id)
        );

        if (updateLegacyError) {
          throw updateLegacyError;
        }
      }

      const { error: deleteMappingsError } = await withAuthRetry(() =>
        supabase
          .from("plant_asset_divisions")
          .delete()
          .eq("asset_id", assetRow.id)
      );

      if (deleteMappingsError) {
        throw deleteMappingsError;
      }

      const { error: insertMappingsError } = await withAuthRetry(() =>
        supabase
          .from("plant_asset_divisions")
          .insert(
            divisionIdsForUpdate.map((divisionId) => ({
              asset_id: assetRow.id,
              division_id: divisionId,
            }))
          )
      );

      if (insertMappingsError) {
        throw insertMappingsError;
      }

      setMessage("Plant item updated.");
      cancelEditAsset();
      await loadPlantData();
    } catch (err) {
      setMessage(`Error updating plant item: ${err.message}`);
    } finally {
      setSavingAssetId(null);
    }
  }

  async function deletePlantAsset(assetId, assetCode) {
    if (!window.confirm(`Delete plant item ${assetCode}?`)) {
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const { error } = await withAuthRetry(() =>
        supabase
          .from("plant_assets")
          .delete()
          .eq("id", assetId)
      );

      if (error) {
        throw error;
      }

      setMessage("Plant item deleted.");
      await loadPlantData();
    } catch (err) {
      setMessage(`Error deleting plant item: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  const filteredAssets = assets.filter((item) => {
    if (divisionFilter === "all") {
      return true;
    }
    return Array.isArray(item.division_ids) && item.division_ids.includes(divisionFilter);
  });

  return (
    <div style={{ padding: 30, maxWidth: 1200, margin: "0 auto" }}>
      <h2 style={{ marginBottom: 20 }}>Plant Management</h2>
      <p style={{ color: "#666", marginBottom: 20 }}>
        Add and remove plant items and assign each one to a division.
      </p>

      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 16,
          marginBottom: 20,
          backgroundColor: "#fff",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Add Plant Item</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 10 }}>
          <input
            type="text"
            placeholder="Asset ID"
            value={newAssetCode}
            onChange={(e) => setNewAssetCode(e.target.value)}
            style={{ padding: 10, borderRadius: 6, border: "1px solid #ddd" }}
          />
          <input
            type="text"
            placeholder="Plant description (optional)"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
            style={{ padding: 10, borderRadius: 6, border: "1px solid #ddd" }}
          />
          <input
            type="text"
            placeholder="Serial number (optional)"
            value={newSerialNumber}
            onChange={(e) => setNewSerialNumber(e.target.value)}
            style={{ padding: 10, borderRadius: 6, border: "1px solid #ddd" }}
          />
          <input
            type="text"
            placeholder="Machine reg (optional)"
            value={newMachineReg}
            onChange={(e) => setNewMachineReg(e.target.value)}
            style={{ padding: 10, borderRadius: 6, border: "1px solid #ddd" }}
          />
          <button
            onClick={addPlantAsset}
            disabled={loading}
            style={{
              border: "none",
              borderRadius: 6,
              backgroundColor: "#22c55e",
              color: "#fff",
              padding: "10px 14px",
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            Add
          </button>
        </div>
        <div
          style={{
            marginTop: 10,
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: 10,
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 8,
          }}
        >
          {divisions.map((division) => (
            <label key={`new-${division.id}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={newSelectedDivisionIds.includes(division.id)}
                onChange={() => toggleNewDivisionId(division.id)}
              />
              <span>{division.name}</span>
            </label>
          ))}
        </div>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={includeOtherDivision}
              onChange={(e) => setIncludeOtherDivision(e.target.checked)}
            />
            <span>Other division</span>
          </label>
          {includeOtherDivision && (
            <input
              type="text"
              value={otherDivisionName}
              onChange={(e) => setOtherDivisionName(e.target.value)}
              placeholder="Enter new division name"
              style={{ padding: 8, borderRadius: 6, border: "1px solid #ddd", minWidth: 260 }}
            />
          )}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ marginRight: 8, fontWeight: 600 }}>Division:</label>
        <select
          value={divisionFilter}
          onChange={(e) => setDivisionFilter(e.target.value)}
          style={{ padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
        >
          <option value="all">All Divisions</option>
          {divisions.map((division) => (
            <option key={division.id} value={division.id}>
              {division.name}
            </option>
          ))}
        </select>
      </div>

      {message && (
        <div
          style={{
            marginBottom: 12,
            padding: 10,
            borderRadius: 6,
            backgroundColor: message.startsWith("Error") ? "#fee2e2" : "#dcfce7",
            color: message.startsWith("Error") ? "#991b1b" : "#166534",
          }}
        >
          {message}
        </div>
      )}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ backgroundColor: "#f9fafb" }}>
              <th style={{ textAlign: "left", padding: 10 }}>Asset ID</th>
              <th style={{ textAlign: "left", padding: 10 }}>Plant Description</th>
              <th style={{ textAlign: "left", padding: 10 }}>Serial Number</th>
              <th style={{ textAlign: "left", padding: 10 }}>Machine Reg</th>
              <th style={{ textAlign: "left", padding: 10 }}>Divisions</th>
              <th style={{ textAlign: "left", padding: 10 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredAssets.map((assetRow) => {
              const isEditing = editingAssetId === assetRow.id;
              const isSaving = savingAssetId === assetRow.id;
              return (
                <tr key={assetRow.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={{ padding: 10 }}>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editAssetCode}
                        onChange={(e) => setEditAssetCode(e.target.value)}
                        style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
                      />
                    ) : (
                      assetRow.asset_code
                    )}
                  </td>
                  <td style={{ padding: 10 }}>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editDisplayName}
                        onChange={(e) => setEditDisplayName(e.target.value)}
                        style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
                      />
                    ) : (
                      assetRow.display_name || "-"
                    )}
                  </td>
                  <td style={{ padding: 10 }}>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editSerialNumber}
                        onChange={(e) => setEditSerialNumber(e.target.value)}
                        style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
                      />
                    ) : (
                      assetRow.serial_number || "-"
                    )}
                  </td>
                  <td style={{ padding: 10 }}>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editMachineReg}
                        onChange={(e) => setEditMachineReg(e.target.value)}
                        style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
                      />
                    ) : (
                      assetRow.machine_reg || "-"
                    )}
                  </td>
                  <td style={{ padding: 10 }}>
                    {isEditing ? (
                      <div>
                        <div
                          style={{
                            border: "1px solid #e5e7eb",
                            borderRadius: 8,
                            padding: 8,
                            display: "grid",
                            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                            gap: 6,
                          }}
                        >
                          {divisions.map((division) => (
                            <label key={`edit-${assetRow.id}-${division.id}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                              <input
                                type="checkbox"
                                checked={editSelectedDivisionIds.includes(division.id)}
                                onChange={() => toggleEditDivisionId(division.id)}
                              />
                              <span>{division.name}</span>
                            </label>
                          ))}
                        </div>
                        <label style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={editIncludeOtherDivision}
                            onChange={(e) => setEditIncludeOtherDivision(e.target.checked)}
                          />
                          <span>Other division</span>
                        </label>
                        {editIncludeOtherDivision && (
                          <input
                            type="text"
                            value={editOtherDivisionName}
                            onChange={(e) => setEditOtherDivisionName(e.target.value)}
                            placeholder="Enter new division name"
                            style={{ width: "100%", marginTop: 6, padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
                          />
                        )}
                      </div>
                    ) : (
                      (assetRow.division_names && assetRow.division_names.length > 0)
                        ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {assetRow.division_names.map((divisionName) => {
                              const badgeStyle = getDivisionBadgeStyle(divisionName);
                              return (
                                <span
                                  key={`${assetRow.id}-${divisionName}`}
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 600,
                                    padding: "2px 8px",
                                    borderRadius: 999,
                                    backgroundColor: badgeStyle.backgroundColor,
                                    color: badgeStyle.color,
                                    border: badgeStyle.border,
                                  }}
                                >
                                  {divisionName}
                                </span>
                              );
                            })}
                          </div>
                        )
                        : "-"
                    )}
                  </td>
                  <td style={{ padding: 10 }}>
                    {isEditing ? (
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => saveAssetEdits(assetRow)}
                          disabled={isSaving}
                          style={{
                            border: "none",
                            backgroundColor: "#22c55e",
                            color: "#fff",
                            borderRadius: 6,
                            padding: "6px 10px",
                            cursor: isSaving ? "not-allowed" : "pointer",
                          }}
                        >
                          {isSaving ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={cancelEditAsset}
                          disabled={isSaving}
                          style={{
                            border: "1px solid #94a3b8",
                            backgroundColor: "#fff",
                            color: "#334155",
                            borderRadius: 6,
                            padding: "6px 10px",
                            cursor: isSaving ? "not-allowed" : "pointer",
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => startEditAsset(assetRow)}
                          disabled={loading}
                          style={{
                            border: "1px solid #2563eb",
                            backgroundColor: "#fff",
                            color: "#2563eb",
                            borderRadius: 6,
                            padding: "6px 10px",
                            cursor: loading ? "not-allowed" : "pointer",
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => deletePlantAsset(assetRow.id, assetRow.asset_code)}
                          disabled={loading}
                          style={{
                            border: "none",
                            backgroundColor: "#ef4444",
                            color: "#fff",
                            borderRadius: 6,
                            padding: "6px 10px",
                            cursor: loading ? "not-allowed" : "pointer",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && filteredAssets.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: 14, color: "#6b7280" }}>
                  No plant items found for this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ===========================
   DEFECTS PAGE (ADMIN PORTAL)
   =========================== */

function DefectsPage({ activeTab }) {
  const [defects, setDefects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [statusFilter, setStatusFilter] = useState("All");
  const [searchText, setSearchText] = useState("");

  const [expandedIds, setExpandedIds] = useState([]);
  const [editState, setEditState] = useState({});
  const [activityLogs, setActivityLogs] = useState({});
  const [selectedDefectForReport, setSelectedDefectForReport] = useState(null);
  const [adminUsers, setAdminUsers] = useState([]);
  const [selectedRecipientEmail, setSelectedRecipientEmail] = useState("");
  const loadingDefectsRef = useRef(false);
  const defectsRequestIdRef = useRef(0);
  const defectsTimeoutRef = useRef(null);
  const adminUsersRequestIdRef = useRef(0);
  const adminUsersTimeoutRef = useRef(null);
  const loadingAdminUsersRef = useRef(false);
  const adminUsersRetryRef = useRef(0);
  const [defectsStale, setDefectsStale] = useState(false);
  const [adminUsersStale, setAdminUsersStale] = useState(false);
  const [lastDefectsSync, setLastDefectsSync] = useState(null);
  const [lastAdminUsersSync, setLastAdminUsersSync] = useState(null);

  async function loadAdminUsers() {
    let hadCache = false;
    try {
      if (loadingAdminUsersRef.current) {
        return;
      }
      loadingAdminUsersRef.current = true;
      const cachedAdmins = readCache(CACHE_KEYS.adminUsers);
      const cachedAdminsTs = readCacheTimestamp(CACHE_KEYS.adminUsers);
      if (cachedAdmins) {
        setAdminUsers(cachedAdmins);
        setAdminUsersStale(false);
        if (cachedAdminsTs) {
          setLastAdminUsersSync(cachedAdminsTs);
        }
        hadCache = true;
      }
      const requestId = adminUsersRequestIdRef.current + 1;
      adminUsersRequestIdRef.current = requestId;

      // Get admin user IDs (using service_role via edge function to bypass RLS)
      const { data: rolesData, error: roleError } = await withAuthRetry(() =>
        supabase.functions.invoke('get-admin-users')
      );

      if (adminUsersRequestIdRef.current !== requestId) {
        return;
      }
      if (roleError) throw roleError;

      console.log("Admin users response:", rolesData);

      const adminEmails = rolesData.adminEmails || [];

      console.log("Admin emails for dropdown:", adminEmails);
      setAdminUsers(adminEmails);
      setAdminUsersStale(false);
      adminUsersRetryRef.current = 0;
      setLastAdminUsersSync(Date.now());
      writeCache(CACHE_KEYS.adminUsers, adminEmails);
    } catch (err) {
      if (!hadCache) {
        console.error("Error loading admin users:", err);
      }
      if (!hadCache) {
        setAdminUsersStale(true);
      }
      if (!document.hidden && adminUsersRetryRef.current < 1) {
        adminUsersRetryRef.current += 1;
        setTimeout(() => {
          if (!document.hidden) {
            loadAdminUsers();
          }
        }, 1500);
      }
    } finally {
      loadingAdminUsersRef.current = false;
    }
  }

  async function loadDefects() {
    if (loadingDefectsRef.current) {
      return;
    }
    loadingDefectsRef.current = true;
    setLoading(true);
    setError("");
    let hadCache = false;

    let scope;
    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError) {
        throw userError;
      }
      scope = await loadDivisionScopeForUser(user?.id);
    } catch (scopeErr) {
      console.error(scopeErr);
      setDefects([]);
      setError("Failed to load your regional access scope.");
      setLoading(false);
      loadingDefectsRef.current = false;
      return;
    }

    if ((scope.divisionIds || []).length === 0 && (scope.visibleAssetCodes || []).length === 0) {
      setDefects([]);
      setDefectsStale(false);
      setLoading(false);
      setLastDefectsSync(Date.now());
      loadingDefectsRef.current = false;
      return;
    }

    const cachedDefects = readCache(CACHE_KEYS.defects);
    const cachedDefectsTs = readCacheTimestamp(CACHE_KEYS.defects);
    if (cachedDefects) {
      const scopedCached = (cachedDefects || []).filter((defect) =>
        canViewDefectWithScope(defect, scope)
      );
      setDefects(scopedCached);
      setDefectsStale(false);
      setLoading(false);
      if (cachedDefectsTs) {
        setLastDefectsSync(cachedDefectsTs);
      }
      hadCache = true;
    }
    
    const requestId = defectsRequestIdRef.current + 1;
    defectsRequestIdRef.current = requestId;
    
    try {
      const makeBaseQuery = () =>
        supabase
          .from("defects")
          .select("*")
          .order("created_at", { ascending: false });

      const fetchByDivision = async () => {
        if ((scope.divisionIds || []).length === 0) {
          return { data: [], error: null };
        }
        return withAuthRetry(() => makeBaseQuery().in("division_id", scope.divisionIds));
      };

      const fetchByAsset = async () => {
        if ((scope.visibleAssetCodes || []).length === 0) {
          return { data: [], error: null };
        }
        return withAuthRetry(() =>
          makeBaseQuery().in("asset", scope.visibleAssetCodes)
        );
      };

      const [divisionResult, assetResult] = await Promise.all([
        fetchByDivision(),
        fetchByAsset(),
      ]);

      const error = divisionResult.error || assetResult.error;
      const mergedMap = new Map();

      [...(divisionResult.data || []), ...(assetResult.data || [])].forEach((defect) => {
        if (defect?.id) {
          mergedMap.set(defect.id, defect);
        }
      });

      const data = Array.from(mergedMap.values()).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      if (defectsRequestIdRef.current !== requestId) {
        return;
      }
      if (error) {
        console.error(error);
        if (!hadCache) {
          setError(error.message);
        }
        setDefectsStale(true);
      } else {
        setDefects(data || []);
        setDefectsStale(false);
        setLastDefectsSync(Date.now());
        writeCache(CACHE_KEYS.defects, data || []);
      }
    } catch (err) {
      console.error(err);
      if (defectsRequestIdRef.current !== requestId) {
        return;
      }
      if (!hadCache) {
        setError("Unexpected error while loading defects.");
      }
      setDefectsStale(true);
    } finally {
      if (defectsRequestIdRef.current !== requestId) {
        return;
      }
      setLoading(false);
      loadingDefectsRef.current = false;
    }
  }

  useEffect(() => {
    if (activeTab !== "defects") {
      return;
    }

    const cleanup = addResumeListeners(
      () => {
        void resumeSessionIfNeeded();
        loadDefects();
        loadAdminUsers();
      },
      () => {
        defectsRequestIdRef.current += 1;
        loadingDefectsRef.current = false;
        setLoading(false);
        adminUsersRequestIdRef.current += 1;
        loadingAdminUsersRef.current = false;
      }
    );

    return cleanup;
  }, [activeTab]);

  // Reset selected recipient when modal opens/closes
  useEffect(() => {
    setSelectedRecipientEmail("");
  }, [selectedDefectForReport]);

  async function uploadToDriveViaFunction(pdfBase64, filename) {
    const { data, error } = await supabase.functions.invoke("upload-drive", {
      body: { filename, pdfBase64 },
    });

    if (error) {
      throw error;
    }

    if (!data?.success) {
      throw new Error(data?.error || "Drive upload failed");
    }

    return data;
  }

  async function sendReportEmail(defect) {
    console.log("=== sendReportEmail called ===");
    console.log("Defect:", defect);
    try {
      // Require recipient selection
      if (!selectedRecipientEmail) {
        alert("Please select an administrator to send the report to.");
        return;
      }
      
      const recipientEmail = selectedRecipientEmail;

      // Log the email activity BEFORE generating PDF so it appears in the PDF
      const { data: auth } = await supabase.auth.getUser();
      const performer = auth?.user?.email ?? "Admin Portal";
      
      await supabase.from("defect_activity").insert({
        defect_id: defect.id,
        message: `PDF report emailed to ${recipientEmail}`,
        performed_by: performer
      });
      
      // Reload activity to show in the PDF
      await loadActivity(defect.id);

      console.log("Starting PDF generation...");
      alert("Generating PDF... This may take a moment.");

      // Get the report content element
      const reportElement = document.getElementById('report-content');
      if (!reportElement) {
        alert("Report content not found");
        return;
      }

      console.log("Cloning element...");
      // Clone the report element to avoid modifying the original
      const clonedElement = reportElement.cloneNode(true);
      
      console.log("Converting images...");
      // Convert all images to base64 data URLs
      const images = clonedElement.getElementsByTagName('img');
      const imagePromises = [];
      
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const src = img.src;
        
        // Skip if already a data URL
        if (src.startsWith('data:')) continue;
        
        // Fetch and convert to base64
        const promise = fetch(src)
          .then(response => response.blob())
          .then(blob => {
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                img.src = reader.result;
                resolve();
              };
              reader.readAsDataURL(blob);
            });
          })
          .catch(err => {
            console.error('Error loading image:', src, err);
          });
        
        imagePromises.push(promise);
      }
      
      // Wait for all images to be converted
      await Promise.all(imagePromises);

      console.log("Generating PDF blob...");
      // Generate PDF as blob
      const opt = {
        margin: 12,
        filename: `defect-report-${defect.asset}-${Date.now()}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { 
          scale: 2,
          useCORS: true,
          logging: false
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      };

      // Generate PDF from cloned element with embedded images
      const pdfBlob = await html2pdf().set(opt).from(clonedElement).outputPdf('blob');
      
      console.log("Converting to base64...");
      // Convert blob to base64
      const reader = new FileReader();
      const base64Promise = new Promise((resolve) => {
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          resolve(base64);
        };
        reader.readAsDataURL(pdfBlob);
      });

      const pdfBase64 = await base64Promise;
      const dateStr = new Date().toISOString().split('T')[0];
      const shortDesc = (defect.title || 'Report').substring(0, 30).replace(/[^a-zA-Z0-9]/g, '-');
      const filename = `Defect-Report-${defect.asset}-${shortDesc}-${dateStr}.pdf`;

      console.log("Sending email with PDF to:", recipientEmail);

      // Call Supabase function to send email with PDF attachment
      const { data, error } = await supabase.functions.invoke('send-report-email', {
        body: {
          to: recipientEmail,
          subject: `Defect Report: ${defect.asset} - ${defect.title}`,
          html: '<p>Please find attached the defect report PDF.</p>',
          pdfBase64: pdfBase64,
          filename: filename
        }
      });

      console.log("Response data:", data);
      console.log("Response error:", error);

      if (error) {
        console.error("Email send error:", error);
        alert(`Failed to send email:\n\n${error.message || JSON.stringify(error)}\n\nCheck browser console for details.`);
      } else {
        alert(`Report PDF emailed successfully to ${recipientEmail}`);      }
    } catch (err) {
      console.error("Email error:", err);
      alert(`Error: ${err.message}\n\nCheck browser console for details.`);
    }
  }

  async function saveToDrive(defect) {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const performer = auth?.user?.email ?? "Admin Portal";
      const dateStr = new Date().toISOString().split('T')[0];
      const shortDesc = (defect.title || 'Report').substring(0, 30).replace(/[^a-zA-Z0-9]/g, '-');
      const filename = `Defect-Report-${defect.asset}-${shortDesc}-${dateStr}.pdf`;
      
      alert("Generating PDF for Google Drive... This may take a moment.");

      // Get the report content element
      const reportElement = document.getElementById('report-content');
      if (!reportElement) {
        alert("Report content not found");
        return;
      }

      // Clone the report element to avoid modifying the original
      const clonedElement = reportElement.cloneNode(true);
      
      // Convert all images to base64 data URLs
      const images = clonedElement.getElementsByTagName('img');
      const imagePromises = [];
      
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const src = img.src;
        
        // Skip if already a data URL
        if (src.startsWith('data:')) continue;
        
        // Fetch and convert to base64
        const promise = fetch(src)
          .then(response => response.blob())
          .then(blob => {
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                img.src = reader.result;
                resolve();
              };
              reader.readAsDataURL(blob);
            });
          })
          .catch(err => {
            console.error('Error loading image:', src, err);
          });
        
        imagePromises.push(promise);
      }
      
      // Wait for all images to be converted
      await Promise.all(imagePromises);

      // Generate PDF as blob (using filename defined at start)
      const opt = {
        margin: 12,
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { 
          scale: 2,
          useCORS: true,
          logging: false
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      };

      // Generate PDF from cloned element with embedded images
      const pdfBlob = await html2pdf().set(opt).from(clonedElement).outputPdf('blob');

      const pdfBase64 = await blobToBase64(pdfBlob);

      console.log("Uploading PDF to Google Drive...");
      const driveResult = await uploadToDriveViaFunction(pdfBase64, filename);
      const driveFileId = driveResult?.id || "";
      const driveFileUrl =
        driveResult?.webViewLink ||
        (driveFileId ? `https://drive.google.com/file/d/${driveFileId}/view` : "");

      const { error: driveUpdateError } = await supabase
        .from("defects")
        .update({
          drive_file_id: driveFileId || null,
          drive_file_url: driveFileUrl || null,
        })
        .eq("id", defect.id);

      if (driveUpdateError) {
        throw driveUpdateError;
      }

      await supabase.from("defect_activity").insert({
        defect_id: defect.id,
        message: `PDF report saved to Google Drive: ${filename}`,
        performed_by: performer
      });

      setDefects((prev) => {
        const next = prev.map((row) =>
          row.id === defect.id
            ? { ...row, drive_file_id: driveFileId, drive_file_url: driveFileUrl }
            : row
        );
        writeCache(CACHE_KEYS.defects, next);
        return next;
      });

      await loadActivity(defect.id);
      
      alert(`Report PDF saved to Google Drive successfully!`);
    } catch (err) {
      console.error("Google Drive save error:", err);
      alert(`Error saving to Google Drive: ${err.message}\n\nCheck browser console for details.`);
    }
  }

  async function loadActivity(defectId) {
    try {
      const { data, error } = await withAuthRetry(() =>
        supabase
          .from("defect_activity")
          .select("*")
          .eq("defect_id", defectId)
          .order("created_at", { ascending: false })
      );

      if (!error) {
        setActivityLogs((prev) => ({ ...prev, [defectId]: data || [] }));
      } else {
        console.error("Activity load error:", error);
      }
    } catch (err) {
      console.error("Activity load error:", err);
    }
  }

  function handleRowClick(defect) {
    const id = defect.id;
    const isOpen = expandedIds.includes(id);

    if (isOpen) {
      setExpandedIds([]);
      return;
    }

    // Close all other defects and open only this one
    setExpandedIds([id]);

    setEditState((prev) => {
      if (prev[id]) return prev;
      return {
        ...prev,
        [id]: {
          status: defect.status || "Reported",
          actionsTaken: defect.actions_taken || "",
          repairCompany: defect.repair_company || "",
          newFiles: [],
          saving: false,
          error: "",
        },
      };
    });

    if (!activityLogs[id]) {
      loadActivity(id);
    }
  }

  function updateEditField(defectId, field, value) {
    setEditState((prev) => ({
      ...prev,
      [defectId]: {
        ...(prev[defectId] || {}),
        [field]: value,
      },
    }));
  }

  function handleFilesChange(defectId, fileList) {
    const filesArray = Array.from(fileList || []);
    updateEditField(defectId, "newFiles", filesArray);
  }

  function handleDefectPhotosChange(defectId, fileList) {
    const filesArray = Array.from(fileList || []);
    updateEditField(defectId, "newDefectFiles", filesArray);
  }

  async function handleDeleteDefectPhoto(defectId, photoUrl) {
    if (!window.confirm("Delete this photo?")) return;
    setEditState((prev) => ({
      ...prev,
      [defectId]: {
        ...prev[defectId],
        saving: true,
        error: "",
      },
    }));
    try {
      const defect = defects.find((d) => d.id === defectId);
      const updatedPhotos = (defect.photo_urls || []).filter(
        (url) => url !== photoUrl
      );
      await supabase
        .from("defects")
        .update({ photo_urls: updatedPhotos })
        .eq("id", defectId);
      const photoPath = photoUrl.split("/defect-photos/")[1]?.split("?")[0];
      if (photoPath) {
        await supabase.storage.from("defect-photos").remove([photoPath]);
      }
      const { data: auth } = await supabase.auth.getUser();
      const performer = auth?.user?.email ?? "Admin Portal";
      await supabase.from("defect_activity").insert({
        defect_id: defectId,
        message: "Defect photo deleted via Admin Portal",
        performed_by: performer,
      });
      await loadDefects();
      setEditState((prev) => ({
        ...prev,
        [defectId]: {
          ...prev[defectId],
          saving: false,
          error: "",
        },
      }));
    } catch (err) {
      setEditState((prev) => ({
        ...prev,
        [defectId]: {
          ...prev[defectId],
          saving: false,
          error: "Failed to delete photo.",
        },
      }));
      console.error("Delete defect photo error:", err);
    }
  }

  async function handleDeleteRepairPhoto(defectId, photoUrl) {
    if (!window.confirm("Delete this photo?")) return;
    setEditState((prev) => ({
      ...prev,
      [defectId]: {
        ...prev[defectId],
        saving: true,
        error: "",
      },
    }));
    try {
      const defect = defects.find((d) => d.id === defectId);
      const updatedPhotos = (defect.repair_photos || []).filter(
        (url) => url !== photoUrl
      );
      await supabase
        .from("defects")
        .update({ repair_photos: updatedPhotos })
        .eq("id", defectId);
      const photoPath = photoUrl.split("/repair-photos/")[1]?.split("?")[0];
      if (photoPath) {
        await supabase.storage.from("repair-photos").remove([photoPath]);
      }
      const { data: auth } = await supabase.auth.getUser();
      const performer = auth?.user?.email ?? "Admin Portal";
      await supabase.from("defect_activity").insert({
        defect_id: defectId,
        message: "Repair photo deleted via Admin Portal",
        performed_by: performer,
      });
      await loadDefects();
      setEditState((prev) => ({
        ...prev,
        [defectId]: {
          ...prev[defectId],
          saving: false,
          error: "",
        },
      }));
    } catch (err) {
      setEditState((prev) => ({
        ...prev,
        [defectId]: {
          ...prev[defectId],
          saving: false,
          error: "Failed to delete photo.",
        },
      }));
      console.error("Delete repair photo error:", err);
    }
  }

  async function handleUpdateDefect(defect) {
    const id = defect.id;
    const state = editState[id];
    if (!state) return;

    try {
      setEditState((prev) => ({
        ...prev,
        [id]: { ...prev[id], saving: true, error: "" },
      }));

      // Upload new defect photos
      let newDefectUrls = [];
      if (state.newDefectFiles && state.newDefectFiles.length > 0) {
        for (let i = 0; i < state.newDefectFiles.length; i++) {
          const file = state.newDefectFiles[i];
          const filePath = `${id}_defect_admin_${Date.now()}_${i}`;

          const { error: uploadError } = await supabase.storage
            .from("defect-photos")
            .upload(filePath, file, {
              contentType: file.type || "image/jpeg",
            });

          if (uploadError) {
            console.error("Defect photo upload error:", uploadError);
            continue;
          }

          const { data: signed, error: urlError } = await supabase.storage
            .from("defect-photos")
            .createSignedUrl(filePath, 60 * 60 * 24 * 365);

          if (!urlError && signed?.signedUrl) {
            newDefectUrls.push(signed.signedUrl);
          }
        }
      }

      const existingDefectPhotos = Array.isArray(defect.photo_urls)
        ? defect.photo_urls
        : [];

      const updatedDefectPhotos =
        newDefectUrls.length > 0
          ? [...existingDefectPhotos, ...newDefectUrls]
          : existingDefectPhotos;

      // Upload new repair photos
      let newRepairUrls = [];
      if (state.newFiles && state.newFiles.length > 0) {
        for (let i = 0; i < state.newFiles.length; i++) {
          const file = state.newFiles[i];
          const filePath = `${id}_repair_admin_${Date.now()}_${i}`;

          const { error: uploadError } = await supabase.storage
            .from("repair-photos")
            .upload(filePath, file, {
              contentType: file.type || "image/jpeg",
            });

          if (uploadError) {
            console.error("Repair photo upload error:", uploadError);
            continue;
          }

          const { data: signed, error: urlError } = await supabase.storage
            .from("repair-photos")
            .createSignedUrl(filePath, 60 * 60 * 24 * 365);

          if (!urlError && signed?.signedUrl) {
            newRepairUrls.push(signed.signedUrl);
          }
        }
      }

      const existingRepairPhotos = Array.isArray(defect.repair_photos)
        ? defect.repair_photos
        : [];

      const updatedRepairPhotos =
        newRepairUrls.length > 0
          ? [...existingRepairPhotos, ...newRepairUrls]
          : existingRepairPhotos;

      const newStatus = state.status || "Reported";
      const newLocked = newStatus === "Completed";
      
      // Set closed_out timestamp when completing
      const closedOut = newLocked && !defect.closed_out ? new Date().toISOString() : defect.closed_out;

      const { error: updateError } = await supabase
        .from("defects")
        .update({
          status: newStatus,
          actions_taken: state.actionsTaken,
          repair_company: state.repairCompany,
          photo_urls: updatedDefectPhotos,
          repair_photos: updatedRepairPhotos,
          locked: newLocked,
          closed_out: closedOut,
        })
        .eq("id", id);

      if (updateError) throw updateError;

      const { data: auth } = await supabase.auth.getUser();
      const performer = auth?.user?.email ?? "Admin Portal";
      const updateMessages = [];
      const previousStatus = defect.status || "Reported";
      const nextActions = (state.actionsTaken || "").trim();
      const previousActions = (defect.actions_taken || "").trim();
      const previousRepairCompany = defect.repair_company || "";
      const nextRepairCompany = state.repairCompany || "";

      if (newStatus !== previousStatus) {
        updateMessages.push(
          `Status changed from "${previousStatus}" to "${newStatus}"`
        );
      }
      if (nextActions !== previousActions) {
        if (nextActions) {
          updateMessages.push(`Actions updated: ${nextActions}`);
        } else {
          updateMessages.push("Actions cleared");
        }
      }
      if (nextRepairCompany !== previousRepairCompany) {
        if (nextRepairCompany) {
          updateMessages.push(`Repair company set to "${nextRepairCompany}"`);
        } else {
          updateMessages.push("Repair company cleared");
        }
      }
      if (newDefectUrls.length > 0) {
        updateMessages.push(
          `Added ${newDefectUrls.length} defect photo${
            newDefectUrls.length > 1 ? "s" : ""
          }`
        );
      }
      if (newRepairUrls.length > 0) {
        updateMessages.push(
          `Added ${newRepairUrls.length} repair photo${
            newRepairUrls.length > 1 ? "s" : ""
          }`
        );
      }

      const message =
        updateMessages.length > 0
          ? updateMessages.join("; ")
          : "Defect saved via Admin Portal";

      const { error: logError } = await supabase.from("defect_activity").insert({
        defect_id: id,
        message,
        performed_by: performer,
      });

      if (logError) console.error("Activity log error:", logError);

      await loadActivity(id);
      await loadDefects();

      setEditState((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          newDefectFiles: [],
          newFiles: [],
          saving: false,
          error: "",
        },
      }));

      alert("Defect updated.");
      // close the details panel after update
      setExpandedIds((prev) => prev.filter((x) => x !== id));
    } catch (err) {
      console.error("Update defect error:", err);
      setEditState((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          saving: false,
          error: err.message || "Failed to update defect.",
        },
      }));
    }
  }

  const totalDefects = defects.length;

  const filteredDefects = defects.filter((d) => {
    if (statusFilter !== "All" && d.status !== statusFilter) return false;

    if (!searchText.trim()) return true;
    const q = searchText.toLowerCase();

    return (
      (d.asset || "").toLowerCase().includes(q) ||
      (d.title || "").toLowerCase().includes(q) ||
      (d.category || "").toLowerCase().includes(q)
    );
  });

  const shownCount = filteredDefects.length;

  const reportDarkBlue = "#17527c";
  const reportLightBlue = "#d1dce5";

  const blankReportTemplate = {
    __isBlank: true,
    asset: "",
    category: "",
    title: "",
    priority: "",
    status: "",
    submitted_by: "",
    created_at: "",
    closed_out: "",
    description: "",
    actions_taken: "",
    repair_company: "",
    photo_urls: [],
    repair_photos: [],
  };

  const isBlankReport = Boolean(selectedDefectForReport?.__isBlank);
  const reportData = selectedDefectForReport || {};
  const reportActivityLogs = !isBlankReport && reportData.id
    ? (activityLogs[reportData.id] || [])
    : [];
  const displayReportValue = (value, fallback = "-") =>
    isBlankReport ? "" : (value ? value : fallback);


  return (
    <div style={{ padding: "20px 30px" }}>
      {/* Refresh and Stats Bar */}
      <div style={{ 
        display: "flex", 
        justifyContent: "space-between", 
        alignItems: "center",
        marginBottom: 20,
        padding: "12px 20px",
        backgroundColor: "#3b82f6",
        color: "white",
        borderRadius: 8
      }}>
        <div style={{ display: "flex", gap: 30 }}>
          <span>Total defects loaded: {totalDefects}</span>
          <span>Shown after filters: {shownCount}</span>
        </div>
        {(lastDefectsSync || lastAdminUsersSync) && (
          <div style={{ fontSize: 12, opacity: 0.9, textAlign: "right" }}>
            {lastDefectsSync && (
              <div>Defects synced: {formatDateTime(lastDefectsSync)}</div>
            )}
            {lastAdminUsersSync && (
              <div>Admins synced: {formatDateTime(lastAdminUsersSync)}</div>
            )}
          </div>
        )}
      </div>

      {/* MAIN */}
      <main className="app-main">
        <div className="table-wrapper">
          {error && <div className="error-banner">{error}</div>}
          {error && (
            <div style={{ marginBottom: 12 }}>
              <button
                onClick={loadDefects}
                disabled={loading}
                style={{
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid #d1d5db",
                  backgroundColor: loading ? "#e5e7eb" : "#ffffff",
                  color: "#374151",
                  fontWeight: 600,
                  cursor: loading ? "not-allowed" : "pointer",
                }}
              >
                {loading ? "Loading..." : "Retry loading defects"}
              </button>
            </div>
          )}
          {!error && defectsStale && !loading && (
            <div
              style={{
                marginBottom: 12,
                padding: 10,
                borderRadius: 6,
                backgroundColor: "#fff7ed",
                color: "#9a3412",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span>Defects list may be out of date. Refresh to sync.</span>
              <button
                onClick={() => {
                  loadDefects();
                  loadAdminUsers();
                }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "none",
                  backgroundColor: "#9a3412",
                  color: "#ffffff",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Refresh
              </button>
            </div>
          )}

          {/* Filters */}
          <div className="filters-row" style={{ justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div className="filter-group">
                <label htmlFor="statusFilter">Status:</label>
                <select
                  id="statusFilter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="All">All</option>
                  <option value="Reported">Reported</option>
                  <option value="In Progress">In Progress</option>
                  <option value="Completed">Completed</option>
                </select>
              </div>

              <div className="filter-group">
                <label htmlFor="searchText">
                  Search (asset / title / category):
                </label>
                <input
                  id="searchText"
                  type="text"
                  placeholder="e.g. BX22, mixer door, Quality..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                />
              </div>
            </div>

            <div style={{ alignSelf: "flex-end", display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  if (expandedIds.length === 0) {
                    alert("Please expand a defect to generate a report.");
                    return;
                  }
                  const defectId = expandedIds[0];
                  const defect = defects.find(d => d.id === defectId);
                  if (defect) {
                    setSelectedDefectForReport(defect);
                  }
                }}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: "none",
                  backgroundColor: "#059669",
                  color: "#ffffff",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Generate Report
              </button>
              <button
                onClick={() => {
                  setSelectedDefectForReport(blankReportTemplate);
                }}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: "1px solid #1d4ed8",
                  backgroundColor: "white",
                  color: "#1d4ed8",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Blank Report
              </button>
            </div>
          </div>

          {/* Table */}
          {loading && <p className="info-text">Loading defects…</p>}
          {!loading && filteredDefects.length === 0 && (
            <p className="info-text">No defects match your filters.</p>
          )}

          {!loading && filteredDefects.length > 0 && (
            <table className="defects-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Submitted By</th>
                  <th>Submitted At</th>
                  <th>Closed Out</th>
                  <th>Stored</th>
                </tr>
              </thead>
              <tbody>
                {filteredDefects.map((d) => {
                  const statusColour = STATUS_COLOURS[d.status] || "#6b7280";
                  const isExpanded = expandedIds.includes(d.id);
                  const edit = editState[d.id] || {};
                  const logs = activityLogs[d.id];
                  const driveFileUrl = d.drive_file_url || (
                    d.drive_file_id
                      ? `https://drive.google.com/file/d/${d.drive_file_id}/view`
                      : ""
                  );
                  const driveSaved = Boolean(driveFileUrl);

                  return (
                    <React.Fragment key={d.id}>
                      {/* MAIN ROW */}
                      <tr
                        className={
                          "clickable-row" +
                          (isExpanded ? " row-selected" : "")
                        }
                        onClick={() => handleRowClick(d)}
                      >
                        <td>{d.asset}</td>
                        <td>{d.title}</td>
                        <td>{d.category}</td>
                        <td>{d.priority}</td>
                        <td>
                          <span
                            className="status-badge"
                            style={{ backgroundColor: statusColour }}
                          >
                            {d.status || "Reported"}
                          </span>
                        </td>
                        <td>{d.submitted_by}</td>
                        <td>{formatDateTime(d.created_at)}</td>
                        <td>{d.closed_out ? formatDateTime(d.closed_out) : "—"}</td>
                        <td>
                          <button
                            type="button"
                            className={
                              "drive-badge " +
                              (driveSaved
                                ? "drive-badge--active"
                                : "drive-badge--inactive")
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!driveSaved) {
                                return;
                              }
                              window.open(
                                driveFileUrl,
                                "_blank",
                                "noopener,noreferrer"
                              );
                            }}
                            aria-disabled={!driveSaved}
                            title={
                              driveSaved
                                ? "Open Drive report"
                                : "Report not stored in Drive yet"
                            }
                          >
                            Drive
                          </button>
                        </td>
                      </tr>

                      {/* DETAILS ROW */}
                      {isExpanded && (
                        <tr className="details-row">
                          <td colSpan={9}>
                            <div className="details-panel">
                              <div className="details-header">
                                <div>
                                  <h2>
                                    {d.asset} – {d.title}
                                  </h2>
                                  <p>
                                    Submitted by {d.submitted_by || "—"} on{" "}
                                    {formatDateTime(d.created_at) || "—"}
                                  </p>
                                </div>
                              </div>

                              <div className="details-grid">
                                <div>
                                  <h3>Category</h3>
                                  <p>{d.category || "—"}</p>
                                </div>
                                <div>
                                  <h3>Priority</h3>
                                  <p>{d.priority || "—"}</p>
                                </div>
                                <div>
                                  <h3>Description</h3>
                                  <p>{d.description || "No description"}</p>
                                </div>
                              </div>

                              {/* DEFECT PHOTOS SECTION */}
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: 16 }}>
                                {/* EXISTING DEFECT PHOTOS */}
                                <div>
                                  <h3>Defect Photos</h3>
                                  {(() => {
                                    const defectPhotos = Array.isArray(d.photo_urls) ? d.photo_urls : [];
                                    return defectPhotos.length > 0 ? (
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: 8 }}>
                                        {defectPhotos.map((url, idx) => {
                                          if (!url) return null;
                                          return (
                                            <div key={idx} style={{ position: 'relative', display: 'inline-block' }}>
                                              <a
                                                href={url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                style={{ textDecoration: 'none' }}
                                              >
                                                <img
                                                  src={url}
                                                  alt={`Defect Photo ${idx + 1}`}
                                                  style={{
                                                    width: '100px',
                                                    height: '100px',
                                                    objectFit: 'cover',
                                                    border: '1px solid #d1d5db',
                                                    borderRadius: '4px',
                                                    cursor: 'pointer',
                                                    transition: 'transform 0.2s'
                                                  }}
                                                  onMouseEnter={(e) => e.target.style.transform = 'scale(1.05)'}
                                                  onMouseLeave={(e) => e.target.style.transform = 'scale(1)'}
                                                />
                                              </a>
                                              <button
                                                onClick={() => handleDeleteDefectPhoto(d.id, url)}
                                                style={{
                                                  position: 'absolute',
                                                  top: 2,
                                                  right: 2,
                                                  background: '#fff',
                                                  border: 'none',
                                                  color: '#d00',
                                                  fontWeight: 'bold',
                                                  borderRadius: '50%',
                                                  width: 20,
                                                  height: 20,
                                                  cursor: 'pointer',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  justifyContent: 'center',
                                                  boxShadow: '0 0 2px rgba(0,0,0,0.2)'
                                                }}
                                                title="Delete photo"
                                                aria-label="Delete photo"
                                              >
                                                ×
                                              </button>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : (
                                      <p style={{ color: '#6b7280', fontSize: '14px', marginTop: 8 }}>No defect photos</p>
                                    );
                                  })()}
                                </div>

                                {/* ADD DEFECT PHOTOS */}
                                <div>
                                  <h3>Add Defect Photos</h3>
                                  <div style={{ marginTop: 8 }}>
                                    <input
                                      type="file"
                                      multiple
                                      accept="image/*"
                                      onChange={(e) =>
                                        handleDefectPhotosChange(
                                          d.id,
                                          e.target.files
                                        )
                                      }
                                    />
                                    {edit.newDefectFiles &&
                                      edit.newDefectFiles.length > 0 && (
                                        <p className="info-text">
                                          {edit.newDefectFiles.length} new defect photo
                                          {edit.newDefectFiles.length > 1 && "s"} ready
                                          to upload.
                                        </p>
                                      )}
                                  </div>
                                </div>
                              </div>

                              {edit.error && (
                                <div className="error-banner">
                                  {edit.error}
                                </div>
                              )}

                              <div className="details-grid">
                                <div>
                                  <h3>Status (admin override)</h3>
                                  <select
                                    value={edit.status || "Reported"}
                                    onChange={(e) =>
                                      updateEditField(
                                        d.id,
                                        "status",
                                        e.target.value
                                      )
                                    }
                                    style={{
                                      width: "100%",
                                      padding: "6px 8px",
                                      borderRadius: 6,
                                      border: "1px solid #d1d5db",
                                    }}
                                  >
                                    <option value="Reported">Reported</option>
                                    <option value="In Progress">
                                      In Progress
                                    </option>
                                    <option value="Completed">
                                      Completed
                                    </option>
                                  </select>
                                </div>

                                <div>
                                  <h3>Repair Company / Person</h3>
                                  <input
                                    type="text"
                                    value={edit.repairCompany || ""}
                                    onChange={(e) =>
                                      updateEditField(
                                        d.id,
                                        "repairCompany",
                                        e.target.value
                                      )
                                    }
                                    placeholder="Who repaired this defect?"
                                    style={{
                                      width: "100%",
                                      padding: "6px 8px",
                                      borderRadius: 6,
                                      border: "1px solid #d1d5db",
                                    }}
                                  />
                                </div>
                              </div>

                              <div className="details-grid">
                                <div style={{ gridColumn: "1 / -1" }}>
                                  <h3>Actions Taken</h3>
                                  <textarea
                                    rows={3}
                                    value={edit.actionsTaken || ""}
                                    onChange={(e) =>
                                      updateEditField(
                                        d.id,
                                        "actionsTaken",
                                        e.target.value
                                      )
                                    }
                                    placeholder="Describe repair actions..."
                                    style={{
                                      width: "100%",
                                      padding: "6px 8px",
                                      borderRadius: 6,
                                      border: "1px solid #d1d5db",
                                      resize: "vertical",
                                    }}
                                  />
                                </div>
                              </div>

                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: 16 }}>
                                {/* ADD REPAIR PHOTOS */}
                                <div>
                                  <h3>Add Repair Photos</h3>
                                  <div style={{ marginTop: 8 }}>
                                    <input
                                      type="file"
                                      multiple
                                      accept="image/*"
                                      onChange={(e) =>
                                        handleFilesChange(
                                          d.id,
                                          e.target.files
                                        )
                                      }
                                    />
                                    {edit.newFiles &&
                                      edit.newFiles.length > 0 && (
                                        <p className="info-text">
                                          {edit.newFiles.length} new file
                                          {edit.newFiles.length > 1 && "s"} ready
                                          to upload.
                                        </p>
                                      )}
                                  </div>
                                </div>

                                {/* EXISTING REPAIR PHOTOS */}
                                <div>
                                  <h3>Repair Photos</h3>
                                  {(() => {
                                    const repairPhotos = Array.isArray(d.repair_photos) ? d.repair_photos : [];
                                    return repairPhotos.length > 0 ? (
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: 8 }}>
                                        {repairPhotos.map((url, idx) => {
                                          if (!url) return null;
                                          return (
                                            <div key={idx} style={{ position: 'relative', display: 'inline-block' }}>
                                              <a
                                                href={url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                style={{ textDecoration: 'none' }}
                                              >
                                                <img
                                                  src={url}
                                                  alt={`Repair Photo ${idx + 1}`}
                                                  style={{
                                                    width: '100px',
                                                    height: '100px',
                                                    objectFit: 'cover',
                                                    border: '1px solid #d1d5db',
                                                    borderRadius: '4px',
                                                    cursor: 'pointer',
                                                    transition: 'transform 0.2s'
                                                  }}
                                                  onMouseEnter={(e) => e.target.style.transform = 'scale(1.05)'}
                                                  onMouseLeave={(e) => e.target.style.transform = 'scale(1)'}
                                                />
                                              </a>
                                              <button
                                                onClick={() => handleDeleteRepairPhoto(d.id, url)}
                                                style={{
                                                  position: 'absolute',
                                                  top: 2,
                                                  right: 2,
                                                  background: '#fff',
                                                  border: 'none',
                                                  color: '#d00',
                                                  fontWeight: 'bold',
                                                  borderRadius: '50%',
                                                  width: 20,
                                                  height: 20,
                                                  cursor: 'pointer',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  justifyContent: 'center',
                                                  boxShadow: '0 0 2px rgba(0,0,0,0.2)'
                                                }}
                                                title="Delete photo"
                                                aria-label="Delete photo"
                                              >
                                                ×
                                              </button>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : (
                                      <p style={{ color: '#6b7280', fontSize: '14px', marginTop: 8 }}>No repair photos yet</p>
                                    );
                                  })()}
                                </div>
                              </div>

                              <div
                                style={{
                                  marginTop: 16,
                                  display: "flex",
                                  justifyContent: "flex-start",
                                }}
                              >
                                <button
                                  onClick={() => handleUpdateDefect(d)}
                                  disabled={edit.saving}
                                  style={{
                                    padding: "8px 16px",
                                    borderRadius: 999,
                                    border: "none",
                                    backgroundColor: "#1d4ed8",
                                    color: "#fff",
                                    fontWeight: 600,
                                    cursor: edit.saving
                                      ? "default"
                                      : "pointer",
                                  }}
                                >
                                  {edit.saving
                                    ? "Updating defect..."
                                    : "Update Defect"}
                                </button>
                              </div>

                              <div style={{ marginTop: 16 }}>
                                <h3>Recent Activity</h3>
                                {!logs && (
                                  <p className="info-text">
                                    Loading activity…
                                  </p>
                                )}
                                {logs && logs.length === 0 && (
                                  <p className="info-text">
                                    No activity recorded yet.
                                  </p>
                                )}
                                {logs && logs.length > 0 && (
                                  <ul style={{ paddingLeft: 18 }}>
                                    {logs.map((log) => (
                                      <li key={log.id}>
                                        <strong>
                                          {formatDateTime(log.created_at)}
                                        </strong>{" "}
                                        — {log.performed_by || "Unknown"}:{" "}
                                        {log.message}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
      <footer style={{ textAlign: "center", padding: "20px", color: "#999", fontSize: 12 }}>
        Admin Portal v2.0.0
      </footer>

      {/* REPORT MODAL */}
      {selectedDefectForReport && (
        <div
          className="report-modal-overlay"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            zIndex: 1000,
            overflow: "auto",
            padding: "40px",
          }}
          onClick={() => setSelectedDefectForReport(null)}
        >
          <div
            className="report-modal-paper"
            style={{
              backgroundColor: "white",
              padding: "20mm",
              width: "210mm",
              minHeight: "297mm",
              boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
              margin: "0 auto",
              position: "relative",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSelectedDefectForReport(null)}
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                background: "transparent",
                border: "none",
                fontSize: 24,
                cursor: "pointer",
                color: "#666",
              }}
              className="no-print"
            >
              ×
            </button>

            <div id="report-content" style={{ fontFamily: "Arial, sans-serif", fontSize: "9pt", lineHeight: 1.4, color: "#000", textAlign: "left", width: "100%" }}>
              {/* Header - Logo and Title */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, paddingBottom: 4, borderBottom: `2px solid ${reportDarkBlue}` }}>
                <div style={{ textAlign: "left" }}>
                  <h1 style={{ margin: 0, fontSize: "14pt", fontWeight: "bold", color: reportDarkBlue }}>DEFECT REPORT</h1>
                </div>
                <img 
                  src="/holcim.png" 
                  alt="Logo" 
                  style={{ maxHeight: 40, maxWidth: 100 }}
                />
              </div>

              {/* Defect Details Table */}
              <table style={{ width: "100%", marginBottom: 4, borderCollapse: "collapse", fontSize: "8pt" }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "2px 4px", backgroundColor: reportLightBlue, border: "1px solid #999", width: "15%", fontWeight: "bold" }}>Asset</td>
                    <td style={{ padding: "2px 4px", border: "1px solid #999", width: "35%", fontWeight: "bold" }}>{displayReportValue(reportData.asset)}</td>
                    <td style={{ padding: "2px 4px", backgroundColor: reportLightBlue, border: "1px solid #999", width: "15%", fontWeight: "bold" }}>Category</td>
                    <td style={{ padding: "2px 4px", border: "1px solid #999", width: "35%" }}>{displayReportValue(reportData.category)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 6px", backgroundColor: reportLightBlue, border: "1px solid #999", fontWeight: "bold" }}>Title</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{displayReportValue(reportData.title)}</td>
                    <td style={{ padding: "4px 6px", backgroundColor: reportLightBlue, border: "1px solid #999", fontWeight: "bold" }}>Priority</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{displayReportValue(reportData.priority)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 6px", backgroundColor: reportLightBlue, border: "1px solid #999", fontWeight: "bold" }}>Status</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{displayReportValue(reportData.status, "Reported")}</td>
                    <td style={{ padding: "4px 6px", backgroundColor: reportLightBlue, border: "1px solid #999", fontWeight: "bold" }}>Submitted By</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{displayReportValue(reportData.submitted_by)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 6px", backgroundColor: reportLightBlue, border: "1px solid #999", fontWeight: "bold" }}>Submitted At</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{isBlankReport ? "" : (formatDateTime(reportData.created_at) || "-")}</td>
                    <td style={{ padding: "4px 6px", backgroundColor: reportLightBlue, border: "1px solid #999", fontWeight: "bold" }}>Closed Out</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{isBlankReport ? "" : (reportData.closed_out ? formatDateTime(reportData.closed_out) : "-")}</td>
                  </tr>
                </tbody>
              </table>

              {/* Description */}
              <div style={{ marginBottom: 4 }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "white", color: reportDarkBlue, borderBottom: `1px solid ${reportDarkBlue}` }}>DESCRIPTION</div>
                <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fafafa", fontSize: "8pt", minHeight: "20px", textAlign: "left" }}>
                  {isBlankReport ? "" : (reportData.description || "No description")}
                </div>
              </div>

              {/* Defect Photos */}
              <div style={{ marginBottom: 4, pageBreakInside: "avoid" }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "white", color: reportDarkBlue, borderBottom: `1px solid ${reportDarkBlue}` }}>DEFECT PHOTOS</div>
                {isBlankReport ? (
                  <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fff", minHeight: "44px" }} />
                ) : reportData.photo_urls && reportData.photo_urls.length > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginTop: 2 }}>
                    {reportData.photo_urls.map((url, idx) => (
                      <div key={idx} style={{ border: "1px solid #999", padding: 2, backgroundColor: "#fff", minHeight: "40px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <img
                          src={url}
                          alt={`Defect ${idx + 1}`}
                          style={{ maxWidth: "100%", maxHeight: "40px", objectFit: "contain", display: "block" }}
                        />
                        <div style={{ fontSize: "6pt", textAlign: "center", marginTop: 1, color: "#666" }}>Photo {idx + 1}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fafafa", fontSize: "8pt", fontStyle: "italic", textAlign: "left" }}>
                    No defect photos available
                  </div>
                )}
              </div>

              {/* Actions Taken - Middle of page */}
              <div style={{ marginBottom: 4, marginTop: 4 }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "white", color: reportDarkBlue, borderBottom: `1px solid ${reportDarkBlue}` }}>ACTIONS TAKEN</div>
                <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fafafa", fontSize: "8pt", minHeight: "20px", textAlign: "left" }}>
                  {isBlankReport ? "" : (reportData.actions_taken || "-")}
                </div>
              </div>

              {/* Repair Photos */}
              <div style={{ marginBottom: 4, pageBreakInside: "avoid" }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "white", color: reportDarkBlue, borderBottom: `1px solid ${reportDarkBlue}` }}>REPAIR PHOTOS</div>
                {isBlankReport ? (
                  <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fff", minHeight: "44px" }} />
                ) : reportData.repair_photos && reportData.repair_photos.length > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginTop: 2 }}>
                    {reportData.repair_photos.map((url, idx) => (
                      <div key={idx} style={{ border: "1px solid #999", padding: 2, backgroundColor: "#fff", minHeight: "40px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <img
                          src={url}
                          alt={`Repair ${idx + 1}`}
                          style={{ maxWidth: "100%", maxHeight: "40px", objectFit: "contain", display: "block" }}
                        />
                        <div style={{ fontSize: "6pt", textAlign: "center", marginTop: 1, color: "#666" }}>Photo {idx + 1}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fafafa", fontSize: "8pt", fontStyle: "italic", textAlign: "left" }}>
                    No repair photos available
                  </div>
                )}
              </div>

              {/* Repair Company */}
              <div style={{ marginBottom: 4 }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "white", color: reportDarkBlue, borderBottom: `1px solid ${reportDarkBlue}` }}>REPAIR COMPANY / PERSON</div>
                <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fafafa", fontSize: "8pt", textAlign: "left" }}>
                  {isBlankReport ? "" : (reportData.repair_company || "-")}
                </div>
              </div>

              {/* Activity Log */}
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "white", color: reportDarkBlue, borderBottom: `1px solid ${reportDarkBlue}` }}>ACTIVITY LOG</div>
                {reportActivityLogs.length > 0 ? (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "7pt" }}>
                    <thead>
                      <tr style={{ backgroundColor: reportLightBlue }}>
                        <th style={{ padding: "2px 4px", border: "1px solid #999", textAlign: "left", width: "30%" }}>Date/Time</th>
                        <th style={{ padding: "2px 4px", border: "1px solid #999", textAlign: "left", width: "25%" }}>User</th>
                        <th style={{ padding: "2px 4px", border: "1px solid #999", textAlign: "left" }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportActivityLogs.map((log) => (
                        <tr key={log.id}>
                          <td style={{ padding: "2px 4px", border: "1px solid #999", fontSize: "6pt" }}>{formatDateTime(log.created_at)}</td>
                          <td style={{ padding: "2px 4px", border: "1px solid #999", fontSize: "6pt" }}>{log.performed_by}</td>
                          <td style={{ padding: "2px 4px", border: "1px solid #999", fontSize: "6pt" }}>{log.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : isBlankReport ? (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "7pt" }}>
                    <thead>
                      <tr style={{ backgroundColor: reportLightBlue }}>
                        <th style={{ padding: "2px 4px", border: "1px solid #999", textAlign: "left", width: "30%" }}>Date/Time</th>
                        <th style={{ padding: "2px 4px", border: "1px solid #999", textAlign: "left", width: "25%" }}>User</th>
                        <th style={{ padding: "2px 4px", border: "1px solid #999", textAlign: "left" }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[0, 1, 2].map((idx) => (
                        <tr key={idx}>
                          <td style={{ padding: "6px 4px", border: "1px solid #999" }} />
                          <td style={{ padding: "6px 4px", border: "1px solid #999" }} />
                          <td style={{ padding: "6px 4px", border: "1px solid #999" }} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fafafa", fontSize: "8pt", fontStyle: "italic", textAlign: "left" }}>
                    No activity logs available
                  </div>
                )}
              </div>

              {/* Footer - Generated date */}
              <div style={{ marginTop: 16, paddingTop: 8, borderTop: "1px solid #ddd", textAlign: "center", fontSize: "7pt", color: "#666" }}>
                Generated: {formatDateTime(new Date().toISOString())} | Maintenance Admin Portal
              </div>
            </div>

            {/* Recipient Selection */}
            {!isBlankReport && (
              <div style={{ marginTop: 16 }} className="no-print">
                <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: "14px" }}>
                  Email Recipient:
                </label>
                <select
                  value={selectedRecipientEmail}
                  onChange={(e) => setSelectedRecipientEmail(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "1px solid #d1d5db",
                    fontSize: "14px",
                  }}
                >
                  <option value="" disabled>Please select an Administrator to send the report to</option>
                  {adminUsers.map((email) => (
                    <option key={email} value={email}>
                      {email}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ marginTop: 16, display: "flex", gap: 12 }} className="no-print">
              <button
                onClick={() => window.print()}
                style={{
                  padding: "10px 20px",
                  borderRadius: 6,
                  border: "none",
                  backgroundColor: "#1d4ed8",
                  color: "white",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Print / Save as PDF
              </button>
              {!isBlankReport && (
                <>
                  <button
                    onClick={() => sendReportEmail(selectedDefectForReport)}
                    style={{
                      padding: "10px 20px",
                      borderRadius: 6,
                      border: "1px solid #1d4ed8",
                      backgroundColor: "white",
                      color: "#1d4ed8",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Email Report to Me
                  </button>
                  <button
                    onClick={() => saveToDrive(selectedDefectForReport)}
                    disabled={selectedDefectForReport?.status !== "Completed"}
                    style={{
                      padding: "10px 20px",
                      borderRadius: 6,
                      border: "1px solid #10b981",
                      backgroundColor: selectedDefectForReport?.status !== "Completed" ? "#e5e5e5" : "white",
                      color: selectedDefectForReport?.status !== "Completed" ? "#999" : "#10b981",
                      fontWeight: 600,
                      cursor: selectedDefectForReport?.status !== "Completed" ? "not-allowed" : "pointer",
                      opacity: selectedDefectForReport?.status !== "Completed" ? 0.5 : 1,
                    }}
                    title={selectedDefectForReport?.status !== "Completed" ? "Can only save completed defects to Drive" : ""}
                  >
                    Save to Drive {selectedDefectForReport?.status !== "Completed" && "(Completed Only)"}
                  </button>
                </>
              )}
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

/* ===========================
   LOGIN PAGE (PORTAL)
   =========================== */

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  useEffect(() => {
    try {
      const savedEmail = localStorage.getItem("admin_savedEmail");

      if (savedEmail) setEmail(savedEmail);
    } catch (e) {
      console.warn("Could not read remembered login", e);
    }
  }, []);

  function rememberLogin() {
    try {
      // Remember only the email. Never store plaintext passwords.
      if (email) {
        localStorage.setItem("admin_savedEmail", email);
      } else {
        localStorage.removeItem("admin_savedEmail");
      }
    } catch (e) {
      console.warn("Could not save remembered login", e);
    }
  }

  async function handleSignIn(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setInfo("");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
    } else {
      rememberLogin();
      // App's auth listener will move us to DefectsPage
    }

    setLoading(false);
  }

  async function handleForgotPassword() {
    setError("");
    setInfo("");

    if (!email.trim()) {
      setError("Please enter your email first.");
      return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      // Use a dedicated path so the recovery view is reliable even when
      // Supabase consumes or strips fragments/params during redirect.
      redirectTo: `${window.location.origin}/reset`, // portal URL
    });

    if (error) {
      setError(error.message);
    } else {
      setInfo("Password reset email sent. Please check your inbox.");
    }
  }

  return (
    <div className="app-root">
      <div
        style={{
          maxWidth: 420,
          margin: "80px auto",
          padding: 24,
          background: "#ffffff",
          borderRadius: 12,
          boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
        }}
      >
        <h1 style={{ marginBottom: 4 }}>Maintenance Admin Login</h1>
        <p style={{ marginTop: 0, marginBottom: 20, color: "#6b7280" }}>
          Sign in with the same account you use in the mobile app.
        </p>

        <form onSubmit={handleSignIn}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", marginBottom: 4 }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 6,
                border: "1px solid #d1d5db",
              }}
              required
            />
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", marginBottom: 4 }}>
              Password
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 72px 8px 8px",
                  borderRadius: 6,
                  border: "1px solid #d1d5db",
                }}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  border: "none",
                  background: "transparent",
                  color: "#1d4ed8",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              marginBottom: 12,
              marginTop: 4,
            }}
          >
            <button
              type="button"
              onClick={handleForgotPassword}
              style={{
                border: "none",
                background: "transparent",
                color: "#1d4ed8",
                fontSize: 14,
                cursor: "pointer",
                padding: 0,
              }}
            >
              Forgot password?
            </button>
          </div>

          {error && (
            <div
              style={{
                marginBottom: 10,
                color: "#b91c1c",
                fontSize: 14,
              }}
            >
              {error}
            </div>
          )}

          {info && (
            <div
              style={{
                marginBottom: 10,
                color: "#166534",
                fontSize: 14,
              }}
            >
              {info}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: 10,
              borderRadius: 999,
              border: "none",
              backgroundColor: loading ? "#93c5fd" : "#1d4ed8",
              color: "#ffffff",
              fontWeight: 600,
              cursor: loading ? "default" : "pointer",
            }}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
        <div style={{ marginTop: 16, textAlign: "center", color: "#999", fontSize: 12 }}>
          v1.2.0
        </div>
      </div>
    </div>
  );
}

/* ===========================
   TOP-LEVEL APP (AUTH + ROLE)
   =========================== */

export default function App() {
  const [session, setSession] = useState(null);
  const [role, setRole] = useState(null); // "admin" or "user" or null
  const [roleLoading, setRoleLoading] = useState(false);
  const [accessDivisionNames, setAccessDivisionNames] = useState([]);
  const [view, setView] = useState("loading"); // "loading" | "login" | "reset" | "app"
  const [activeTab, setActiveTab] = useState("defects");

  async function loadDivisionNamesForSession(currentSession) {
    if (!currentSession?.user?.id) {
      setAccessDivisionNames([]);
      return;
    }

    const { data, error } = await withAuthRetry(() =>
      supabase
        .from("user_divisions")
        .select("divisions(name)")
        .eq("user_id", currentSession.user.id)
    );

    if (error) {
      console.error("Error loading division badges:", error);
      setAccessDivisionNames([]);
      return;
    }

    const names = Array.from(
      new Set(
        (data || [])
          .map((row) => row?.divisions?.name)
          .filter((name) => !!name)
      )
    ).sort((a, b) => a.localeCompare(b));

    setAccessDivisionNames(names);
  }

  async function loadRoleForSession(currentSession) {
    if (!currentSession) {
      setRole(null);
      setRoleLoading(false);
      setAccessDivisionNames([]);
      return;
    }

    setRoleLoading(true);
    const userId = currentSession.user.id;
    const { data, error } = await withAuthRetry(() =>
      supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle()
    );

    if (error) {
      console.error("Error loading role:", error);
      setRole(null);
      setRoleLoading(false);
      setAccessDivisionNames([]);
      return;
    }

    setRole(data?.role ?? "user");
    await loadDivisionNamesForSession(currentSession);
    setRoleLoading(false);
  }

  useEffect(() => {
    let subscription;

    async function init() {
      try {
        const {
          data: { session },
        } = await getSessionWithTimeout();
        const recovering = isRecoveryUrl();
        const passwordSetup = isPasswordSetupUrl();

        if (passwordSetup && typeof window !== "undefined") {
          sessionStorage.setItem("force_password_change", "true");
        }

        if (session && needsPasswordSetup(session)) {
          if (typeof window !== "undefined") {
            sessionStorage.setItem("force_password_change", "true");
          }
          setSession(session);
          setView("reset");
        } else if (recovering || passwordSetup) {
          setSession(session);
          setView("reset");
        } else if (session) {
          setSession(session);
          setView("app");
          void loadRoleForSession(session);
        } else {
          setView("login");
        }
      } catch (err) {
        console.error("Session init failed:", err);
        setView("login");
      }

      const { data } = supabase.auth.onAuthStateChange(
        async (event, newSession) => {
          console.log("Auth event:", event);

          if (
            event === "PASSWORD_RECOVERY" ||
            isRecoveryUrl() ||
            isPasswordSetupUrl()
          ) {
            setSession(newSession);
            setView("reset");
            return;
          }

          if (newSession && needsPasswordSetup(newSession)) {
            if (typeof window !== "undefined") {
              sessionStorage.setItem("force_password_change", "true");
            }
            setSession(newSession);
            setView("reset");
            return;
          }

          if (event === "SIGNED_OUT") {
            setSession(null);
            setRole(null);
            setRoleLoading(false);
            setAccessDivisionNames([]);
            setView("login");
            return;
          }

          if (newSession) {
            setSession(newSession);
            setView("app");
            void loadRoleForSession(newSession);
          } else {
            setSession(null);
            setRole(null);
            setRoleLoading(false);
            setView("login");
          }
        }
      );

      subscription = data.subscription;
    }

    init();

    return () => {
      if (subscription) subscription.unsubscribe();
    };
  }, []);

  if (view === "loading") {
    return (
      <div className="app-root">
        <p style={{ padding: 32 }}>Loading…</p>
      </div>
    );
  }

  if (view === "reset") {
    return (
      <ResetPasswordPage
        allowNonAdmin={
          (typeof window !== "undefined" &&
            sessionStorage.getItem("force_password_change") === "true") ||
          isPasswordSetupUrl()
        }
        onDone={() => {
          setView("login");
        }}
      />
    );
  }

  // Defensive: if the URL contains a recovery indicator, always show the
  // reset page — this handles race conditions where a session is created
  // during the redirect before the app has switched to the recovery view.
  if (isRecoveryUrl()) {
    return (
      <ResetPasswordPage
        allowNonAdmin={
          (typeof window !== "undefined" &&
            sessionStorage.getItem("force_password_change") === "true") ||
          isPasswordSetupUrl()
        }
        onDone={() => {
          setView("login");
        }}
      />
    );
  }

  if (!session || view === "login") {
    return <LoginPage />;
  }

  if (needsPasswordSetup(session)) {
    return (
      <ResetPasswordPage
        allowNonAdmin={
          (typeof window !== "undefined" &&
            sessionStorage.getItem("force_password_change") === "true") ||
          isPasswordSetupUrl()
        }
        onDone={() => {
          setView("login");
        }}
      />
    );
  }

  if (role !== "admin") {
    if (roleLoading || (session && role === null)) {
      return (
        <div className="app-root">
          <div style={{ padding: 32 }}>
            Checking access...
          </div>
        </div>
      );
    }
    return (
      <div className="app-root">
        <div style={{ padding: 32 }}>
          <h2>Access restricted</h2>
          <p>You are signed in, but not an admin for the web portal.</p>
          <button
            onClick={() => supabase.auth.signOut()}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              borderRadius: 999,
              border: "none",
              backgroundColor: "#1d4ed8",
              color: "#ffffff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // Admin portal with tabs
  return (
    <div className="app-root">
      {/* Top Bar with Logo, Title, Sign Out */}
      <div style={{ 
        display: "flex", 
        alignItems: "center", 
        justifyContent: "space-between",
        padding: "15px 30px",
        backgroundColor: "#fff",
        borderBottom: "1px solid #e5e7eb"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
          <img 
            src="/logo.png" 
            alt="Logo" 
            style={{ height: 50 }}
          />
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>
              Maintenance Admin Portal
            </h1>
            <p style={{ margin: 0, color: "#666", fontSize: 14 }}>
              Defect overview from all assets
            </p>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
          <div style={{ fontSize: 14, color: "#666" }}>
            Logged in as: <strong style={{ color: "#1d4ed8" }}>{session?.user?.email || "Unknown"}</strong>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, maxWidth: 460 }}>
            {accessDivisionNames.length > 0 ? (
              accessDivisionNames.map((divisionName) => {
                const badgeStyle = getDivisionBadgeStyle(divisionName);
                return (
                  <span
                    key={divisionName}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "3px 8px",
                      borderRadius: 999,
                      backgroundColor: badgeStyle.backgroundColor,
                      color: badgeStyle.color,
                      border: badgeStyle.border,
                    }}
                  >
                    {divisionName}
                  </span>
                );
              })
            ) : (
              <span style={{ fontSize: 12, color: "#6b7280" }}>No region assignments</span>
            )}
          </div>
          <button
            onClick={() => supabase.auth.signOut()}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#1d4ed8",
              color: "#ffffff",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div style={{ 
        borderBottom: "2px solid #e5e7eb", 
        backgroundColor: "#f9fafb",
        padding: "0 30px"
      }}>
        <div style={{ display: "flex", gap: 20 }}>
          <button
            onClick={() => setActiveTab("defects")}
            style={{
              padding: "15px 20px",
              border: "none",
              backgroundColor: "transparent",
              borderBottom: activeTab === "defects" ? "3px solid #3b82f6" : "3px solid transparent",
              color: activeTab === "defects" ? "#3b82f6" : "#6b7280",
              fontWeight: 600,
              fontSize: 16,
              cursor: "pointer",
              transition: "all 0.2s"
            }}
          >
            📋 Defects
          </button>
          <button
            onClick={() => setActiveTab("tasks")}
            style={{
              padding: "15px 20px",
              border: "none",
              backgroundColor: "transparent",
              borderBottom: activeTab === "tasks" ? "3px solid #3b82f6" : "3px solid transparent",
              color: activeTab === "tasks" ? "#3b82f6" : "#6b7280",
              fontWeight: 600,
              fontSize: 16,
              cursor: "pointer",
              transition: "all 0.2s"
            }}
          >
            ✅ Action Task
          </button>
          <button
            onClick={() => setActiveTab("users")}
            style={{
              padding: "15px 20px",
              border: "none",
              backgroundColor: "transparent",
              borderBottom: activeTab === "users" ? "3px solid #3b82f6" : "3px solid transparent",
              color: activeTab === "users" ? "#3b82f6" : "#6b7280",
              fontWeight: 600,
              fontSize: 16,
              cursor: "pointer",
              transition: "all 0.2s"
            }}
          >
            👥 User Management
          </button>
          <button
            onClick={() => setActiveTab("plant")}
            style={{
              padding: "15px 20px",
              border: "none",
              backgroundColor: "transparent",
              borderBottom: activeTab === "plant" ? "3px solid #3b82f6" : "3px solid transparent",
              color: activeTab === "plant" ? "#3b82f6" : "#6b7280",
              fontWeight: 600,
              fontSize: 16,
              cursor: "pointer",
              transition: "all 0.2s"
            }}
          >
            🏗️ Plant Management
          </button>
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "defects" && <DefectsPage activeTab={activeTab} key="defects" />}
      {activeTab === "tasks" && <ActionTaskPage activeTab={activeTab} key="tasks" />}
      {activeTab === "users" && <UserManagementPage key="users" />}
      {activeTab === "plant" && <PlantManagementPage key="plant" />}
    </div>
  );
}



