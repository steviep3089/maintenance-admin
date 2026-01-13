// src/App.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import "./App.css";
import html2pdf from 'html2pdf.js';

/* ===========================
   GOOGLE DRIVE CONFIG
   =========================== */

// TODO: Replace these with your actual Google Cloud credentials
const GOOGLE_CLIENT_ID = '753101804798-4pv1u6geld4sopu80pkam786ritibrdc.apps.googleusercontent.com';
const GOOGLE_API_KEY = 'AIzaSyD0Zkxx3q8-eONpOHWsvFjjLupEYQu7ytI';
const GOOGLE_DRIVE_FOLDER_ID = '1Zc04BOCmdTubDptvNvldcWBX6iegQ619';
const SCOPES = 'https://www.googleapis.com/auth/drive';

/* ===========================
   HELPERS
   =========================== */

const STATUS_COLOURS = {
  Reported: "#ef4444",
  "In Progress": "#f59e0b",
  Completed: "#22c55e",
};

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
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

      const { data: { session } } = await supabase.auth.getSession();
      
      if (session?.user) {
        const { data } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", session.user.id)
          .single();
        
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

      // small delay, then sign out & go to login
      setTimeout(async () => {
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
        if (onDone) onDone();
      }, 1200);
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
          Please enter a new password for your admin account.
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
  const [userSearchText, setUserSearchText] = useState("");
  const [selectedDefectId, setSelectedDefectId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (activeTab === "tasks") {
      loadDefects();
      loadUsers();
    }
  }, [activeTab]);

  useEffect(() => {
    // Filter users based on search text
    if (!userSearchText.trim()) {
      setFilteredUsers(users);
    } else {
      const search = userSearchText.toLowerCase();
      setFilteredUsers(users.filter(u => u.email.toLowerCase().includes(search)));
    }
  }, [userSearchText, users]);

  async function loadDefects() {
    try {
      const { data, error } = await supabase
        .from("defects")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setDefects(data || []);
    } catch (err) {
      console.error("Error loading defects:", err);
      setMessage("Error loading defects: " + err.message);
    }
  }

  async function loadUsers() {
    try {
      // Call edge function to get all users
      const { data, error } = await supabase.functions.invoke('list-users');

      if (error) throw error;
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to load users');
      }

      const allUsers = data.users || [];

      setUsers(allUsers);
      setFilteredUsers(allUsers);
      
      if (allUsers.length === 0) {
        setMessage("No users found in the system.");
      }
    } catch (err) {
      console.error("Error loading users:", err);
      setMessage("Error loading users: " + err.message);
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
      const selectedUser = users.find(u => u.email === selectedUserId);
      
      console.log("Found defect:", selectedDefect);
      console.log("Found user:", selectedUser);
      
      if (!selectedDefect) {
        throw new Error("Defect not found. Please refresh and try again.");
      }
      
      if (!selectedUser) {
        throw new Error("User not found. Please refresh and try again.");
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
          {defects.map((defect) => (
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
            <option key={user.id} value={user.email}>
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
        disabled={loading}
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
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  
  // For viewing current users
  const [allUsers, setAllUsers] = useState([]);
  const [userRoles, setUserRoles] = useState({});
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [deletingUserId, setDeletingUserId] = useState(null);
  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const adminRedirectBase = isLocalhost
    ? "http://localhost:5173"
    : window.location.origin;
  const expoRedirectBase = "exp://192.168.68.60:8082";
  const previewRedirectTo =
    newUserRole === "admin"
      ? `${adminRedirectBase}/reset?from=invite`
      : isLocalhost
      ? `${expoRedirectBase}/--/reset`
      : "maintenanceapp://reset";

  function withTimeout(promise, ms, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(message || "Request timed out"));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  async function loadAllUsers() {
    setLoadingUsers(true);
    try {
      // Get all users
      let usersData;
      let usersError;
      try {
        ({ data: usersData, error: usersError } = await withTimeout(
          supabase.functions.invoke('list-users'),
          30000,
          "User list request timed out"
        ));
      } catch (err) {
        ({ data: usersData, error: usersError } = await withTimeout(
          supabase.functions.invoke('list-users'),
          30000,
          "User list request timed out"
        ));
      }
      if (usersError) throw usersError;
      if (!usersData.success) throw new Error(usersData.error);

      const rolesMap = {};
      (usersData.users || []).forEach((user) => {
        rolesMap[user.id] = user.role || "user";
      });

      setAllUsers(usersData.users || []);
      setUserRoles(rolesMap);
    } catch (err) {
      console.error('Error loading users:', err);
      setMessage(`Error loading users: ${err.message}`);
    } finally {
      setLoadingUsers(false);
    }
  }

  useEffect(() => {
    loadAllUsers();
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
      // Call Supabase Edge Function to create user with proper permissions
      const redirectTo = previewRedirectTo;
      const { data, error } = await supabase.functions.invoke("create-user", {
        body: {
          email: newUserEmail,
          role: newUserRole,
          redirectTo,
        },
      });

      console.log('Create user response:', data, error);

      if (error) throw error;
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to create user');
      }

      setMessage(`User created successfully. An email invite was sent to ${newUserEmail}.`);
      loadAllUsers();
      setTimeout(() => setMessage(""), 3000);
      setNewUserEmail("");
      setNewUserRole("user");
    } catch (err) {
      console.error('Create user error:', err);
      setMessage(`Error: ${err.message}`);
    } finally {
      setLoading(false);
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
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 6,
                border: "1px solid #ddd",
                fontSize: 16
              }}
            />
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

          <div
            style={{
              marginBottom: 12,
              fontSize: 12,
              color: "#6b7280",
              wordBreak: "break-all",
            }}
          >
            Invite redirect: {previewRedirectTo}
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
          </div>

          <div style={{ marginTop: 20 }}>
            {loadingUsers ? (
              <p style={{ textAlign: "center", color: "#666" }}>Loading users...</p>
            ) : (
              <>
                {/* Search Box */}
                <div style={{ marginBottom: 15 }}>
                  <input
                    type="text"
                    placeholder="Search users by email..."
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
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
                      const canDelete = role !== "admin" && role !== "manager";
                      const isDeleting = deletingUserId === user.id;
                      return (
                        <div
                          key={user.id}
                          style={{
                            padding: "12px 16px",
                            borderBottom: index < filteredUsers.length - 1 ? "1px solid #e5e7eb" : "none",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            backgroundColor: index % 2 === 0 ? "#fff" : "#f9fafb"
                          }}
                        >
                          <span style={{ fontSize: 14, color: "#111827" }}>{user.email}</span>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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

  async function loadAdminUsers() {
    try {
      // Get all users from edge function
      const { data, error } = await supabase.functions.invoke('list-users');

      if (error) throw error;
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to load users');
      }

      console.log("All users from list-users:", data.users);

      // Get admin user IDs (using service_role via edge function to bypass RLS)
      const { data: rolesData, error: roleError } = await supabase.functions.invoke('get-admin-users');

      if (roleError) throw roleError;

      console.log("Admin users response:", rolesData);

      const adminEmails = rolesData.adminEmails || [];

      console.log("Admin emails for dropdown:", adminEmails);
      setAdminUsers(adminEmails);
    } catch (err) {
      console.error("Error loading admin users:", err);
    }
  }

  async function loadDefects() {
    setLoading(true);
    setError("");
    
    try {
      const { data, error } = await withTimeout(
        supabase
          .from("defects")
          .select("*")
          .order("created_at", { ascending: false }),
        20000,
        "Loading defects timed out."
      );

      if (error) {
        console.error(error);
        setError(error.message);
        setDefects([]);
      } else {
        setDefects(data || []);
      }
    } catch (err) {
      console.error(err);
      setError("Unexpected error while loading defects.");
      setDefects([]);
    }
    
    setLoading(false);
  }

  useEffect(() => {
    if (activeTab === "defects") {
      loadDefects();
      loadAdminUsers();
    }
  }, [activeTab]);

  // Reset selected recipient when modal opens/closes
  useEffect(() => {
    setSelectedRecipientEmail("");
  }, [selectedDefectForReport]);

  // Upload PDF to Google Drive using new Google Identity Services
  async function uploadToGoogleDrive(pdfBlob, filename) {
    try {
      return new Promise((resolve, reject) => {
        // Request access token using new Google Identity Services
        const tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          callback: async (response) => {
            if (response.error) {
              reject(new Error(response.error));
              return;
            }

            const accessToken = response.access_token;

            // Support for Shared Drives (Team Drives)
            const metadata = {
              name: filename,
              mimeType: 'application/pdf',
              parents: [GOOGLE_DRIVE_FOLDER_ID]
            };

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', pdfBlob);

            // Add supportsAllDrives=true for Shared Drive support
            const uploadResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
              method: 'POST',
              headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
              body: form,
            });

            const result = await uploadResponse.json();
            
            if (uploadResponse.ok) {
              console.log('File uploaded to Google Drive:', result);
              resolve(result);
            } else {
              reject(new Error(result.error?.message || 'Upload failed'));
            }
          },
        });

        // Request the token (this will show Google sign-in popup)
        tokenClient.requestAccessToken();
      });
    } catch (error) {
      console.error('Error uploading to Google Drive:', error);
      throw error;
    }
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
      // Log the Drive save activity BEFORE generating PDF so it appears in the PDF
      const { data: auth } = await supabase.auth.getUser();
      const performer = auth?.user?.email ?? "Admin Portal";
      const dateStr = new Date().toISOString().split('T')[0];
      const shortDesc = (defect.title || 'Report').substring(0, 30).replace(/[^a-zA-Z0-9]/g, '-');
      const filename = `Defect-Report-${defect.asset}-${shortDesc}-${dateStr}.pdf`;
      
      await supabase.from("defect_activity").insert({
        defect_id: defect.id,
        message: `PDF report saved to Google Drive: ${filename}`,
        performed_by: performer
      });
      
      // Reload activity to show in the PDF
      await loadActivity(defect.id);
      
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

      console.log("Uploading PDF to Google Drive...");
      await uploadToGoogleDrive(pdfBlob, filename);
      
      alert(`Report PDF saved to Google Drive successfully!`);
    } catch (err) {
      console.error("Google Drive save error:", err);
      alert(`Error saving to Google Drive: ${err.message}\n\nCheck browser console for details.`);
    }
  }

  async function loadActivity(defectId) {
    try {
      const { data, error } = await supabase
        .from("defect_activity")
        .select("*")
        .eq("defect_id", defectId)
        .order("created_at", { ascending: false });

      if (!error) {
        setActivityLogs((prev) => ({ ...prev, [defectId]: data || [] }));
      } else {
        console.error("Activity load error:", error);
      }
    } catch (err) {
      console.error("Activity load error:", err);
    }
  }

  function withTimeout(promise, ms, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(message || "Operation timed out"));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      clearTimeout(timeoutId);
    });
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
      const timeoutMs = 60000;
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

          const { error: uploadError } = await withTimeout(
            supabase.storage.from("defect-photos").upload(filePath, file, {
              contentType: file.type || "image/jpeg",
            }),
            timeoutMs,
            "Defect photo upload timed out."
          );

          if (uploadError) {
            console.error("Defect photo upload error:", uploadError);
            continue;
          }

          const { data: signed, error: urlError } = await withTimeout(
            supabase.storage
              .from("defect-photos")
              .createSignedUrl(filePath, 60 * 60 * 24 * 365),
            timeoutMs,
            "Defect photo URL signing timed out."
          );

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

          const { error: uploadError } = await withTimeout(
            supabase.storage.from("repair-photos").upload(filePath, file, {
              contentType: file.type || "image/jpeg",
            }),
            timeoutMs,
            "Repair photo upload timed out."
          );

          if (uploadError) {
            console.error("Repair photo upload error:", uploadError);
            continue;
          }

          const { data: signed, error: urlError } = await withTimeout(
            supabase.storage
              .from("repair-photos")
              .createSignedUrl(filePath, 60 * 60 * 24 * 365),
            timeoutMs,
            "Repair photo URL signing timed out."
          );

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

      const { error: updateError } = await withTimeout(
        supabase
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
          .eq("id", id),
        timeoutMs,
        "Defect update timed out."
      );

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

      const { error: logError } = await withTimeout(
        supabase.from("defect_activity").insert({
          defect_id: id,
          message,
          performed_by: performer,
        }),
        timeoutMs,
        "Activity log timed out."
      );

      if (logError) console.error("Activity log error:", logError);

      await withTimeout(loadActivity(id), timeoutMs, "Loading activity timed out.");
      await withTimeout(loadDefects(), timeoutMs, "Reloading defects timed out.");

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
      </div>

      {/* MAIN */}
      <main className="app-main">
        <div className="table-wrapper">
          {error && <div className="error-banner">{error}</div>}

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

            <div style={{ alignSelf: "flex-end" }}>
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
                </tr>
              </thead>
              <tbody>
                {filteredDefects.map((d) => {
                  const statusColour = STATUS_COLOURS[d.status] || "#6b7280";
                  const isExpanded = expandedIds.includes(d.id);
                  const edit = editState[d.id] || {};
                  const logs = activityLogs[d.id];

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
                      </tr>

                      {/* DETAILS ROW */}
                      {isExpanded && (
                        <tr className="details-row">
                          <td colSpan={8}>
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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, paddingBottom: 4, borderBottom: "2px solid #333" }}>
                <div style={{ textAlign: "left" }}>
                  <h1 style={{ margin: 0, fontSize: "14pt", fontWeight: "bold" }}>DEFECT REPORT</h1>
                </div>
                <img 
                  src="/holcim-logo.png" 
                  alt="Logo" 
                  style={{ maxHeight: 40, maxWidth: 100 }}
                />
              </div>

              {/* Defect Details Table */}
              <table style={{ width: "100%", marginBottom: 4, borderCollapse: "collapse", fontSize: "8pt" }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "2px 4px", backgroundColor: "#e8e8e8", border: "1px solid #999", width: "15%", fontWeight: "bold" }}>Asset</td>
                    <td style={{ padding: "2px 4px", border: "1px solid #999", width: "35%", fontWeight: "bold" }}>{selectedDefectForReport.asset}</td>
                    <td style={{ padding: "2px 4px", backgroundColor: "#e8e8e8", border: "1px solid #999", width: "15%", fontWeight: "bold" }}>Category</td>
                    <td style={{ padding: "2px 4px", border: "1px solid #999", width: "35%" }}>{selectedDefectForReport.category || "—"}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 6px", backgroundColor: "#e8e8e8", border: "1px solid #999", fontWeight: "bold" }}>Title</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{selectedDefectForReport.title}</td>
                    <td style={{ padding: "4px 6px", backgroundColor: "#e8e8e8", border: "1px solid #999", fontWeight: "bold" }}>Priority</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{selectedDefectForReport.priority || "—"}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 6px", backgroundColor: "#e8e8e8", border: "1px solid #999", fontWeight: "bold" }}>Status</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{selectedDefectForReport.status || "Reported"}</td>
                    <td style={{ padding: "4px 6px", backgroundColor: "#e8e8e8", border: "1px solid #999", fontWeight: "bold" }}>Submitted By</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{selectedDefectForReport.submitted_by || "—"}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 6px", backgroundColor: "#e8e8e8", border: "1px solid #999", fontWeight: "bold" }}>Submitted At</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{formatDateTime(selectedDefectForReport.created_at) || "—"}</td>
                    <td style={{ padding: "4px 6px", backgroundColor: "#e8e8e8", border: "1px solid #999", fontWeight: "bold" }}>Closed Out</td>
                    <td style={{ padding: "4px 6px", border: "1px solid #999" }}>{selectedDefectForReport.closed_out ? formatDateTime(selectedDefectForReport.closed_out) : "—"}</td>
                  </tr>
                </tbody>
              </table>

              {/* Description */}
              <div style={{ marginBottom: 4 }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "#333", color: "#fff" }}>DESCRIPTION</div>
                <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fafafa", fontSize: "8pt", minHeight: "20px", textAlign: "left" }}>
                  {selectedDefectForReport.description || "No description"}
                </div>
              </div>

              {/* Defect Photos */}
              <div style={{ marginBottom: 4, pageBreakInside: "avoid" }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "#333", color: "#fff" }}>DEFECT PHOTOS</div>
                {selectedDefectForReport.photo_urls && selectedDefectForReport.photo_urls.length > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginTop: 2 }}>
                    {selectedDefectForReport.photo_urls.map((url, idx) => (
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
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "#333", color: "#fff" }}>ACTIONS TAKEN</div>
                <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fafafa", fontSize: "8pt", minHeight: "20px", textAlign: "left" }}>
                  {selectedDefectForReport.actions_taken || "—"}
                </div>
              </div>

              {/* Repair Photos */}
              <div style={{ marginBottom: 4, pageBreakInside: "avoid" }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "#333", color: "#fff" }}>REPAIR PHOTOS</div>
                {selectedDefectForReport.repair_photos && selectedDefectForReport.repair_photos.length > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginTop: 2 }}>
                    {selectedDefectForReport.repair_photos.map((url, idx) => (
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
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "#333", color: "#fff" }}>REPAIR COMPANY / PERSON</div>
                <div style={{ padding: "4px", border: "1px solid #999", backgroundColor: "#fafafa", fontSize: "8pt", textAlign: "left" }}>
                  {selectedDefectForReport.repair_company || "—"}
                </div>
              </div>

              {/* Activity Log */}
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: 2, padding: "1px 4px", backgroundColor: "#333", color: "#fff" }}>ACTIVITY LOG</div>
                {activityLogs[selectedDefectForReport.id] && activityLogs[selectedDefectForReport.id].length > 0 ? (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "7pt" }}>
                    <thead>
                      <tr style={{ backgroundColor: "#e8e8e8" }}>
                        <th style={{ padding: "2px 4px", border: "1px solid #999", textAlign: "left", width: "30%" }}>Date/Time</th>
                        <th style={{ padding: "2px 4px", border: "1px solid #999", textAlign: "left", width: "25%" }}>User</th>
                        <th style={{ padding: "2px 4px", border: "1px solid #999", textAlign: "left" }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activityLogs[selectedDefectForReport.id].map((log) => (
                        <tr key={log.id}>
                          <td style={{ padding: "2px 4px", border: "1px solid #999", fontSize: "6pt" }}>{formatDateTime(log.created_at)}</td>
                          <td style={{ padding: "2px 4px", border: "1px solid #999", fontSize: "6pt" }}>{log.performed_by}</td>
                          <td style={{ padding: "2px 4px", border: "1px solid #999", fontSize: "6pt" }}>{log.message}</td>
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
                📧 Email Report to Me
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
                💾 Save to Drive {selectedDefectForReport?.status !== "Completed" && "(Completed Only)"}
              </button>
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
  const [view, setView] = useState("loading"); // "loading" | "login" | "reset" | "app"
  const [activeTab, setActiveTab] = useState("defects");

  async function loadRoleForSession(currentSession) {
    if (!currentSession) {
      setRole(null);
      return;
    }

    const userId = currentSession.user.id;
    const { data, error } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Error loading role:", error);
      setRole(null);
      return;
    }

    setRole(data?.role ?? "user");
  }

  useEffect(() => {
    let subscription;

    async function init() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
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
        await loadRoleForSession(session);
        setView("app");
      } else {
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
            setView("login");
            return;
          }

          if (newSession) {
            setSession(newSession);
            await loadRoleForSession(newSession);
            setView("app");
          } else {
            setSession(null);
            setRole(null);
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
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "defects" && <DefectsPage activeTab={activeTab} key="defects" />}
      {activeTab === "tasks" && <ActionTaskPage activeTab={activeTab} key="tasks" />}
      {activeTab === "users" && <UserManagementPage key="users" />}
    </div>
  );
}



