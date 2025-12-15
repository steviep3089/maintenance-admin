// src/App.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import "./App.css";

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

// detect if URL contains a Supabase recovery link
function isRecoveryUrl() {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash || "";
  const search = window.location.search || "";
  const pathname = window.location.pathname || "";
  return (
    hash.includes("type=recovery") ||
    search.includes("type=recovery") ||
    pathname === "/reset"
  );
}

/* ===========================
   RESET PASSWORD PAGE
   =========================== */

function ResetPasswordPage({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

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

    const { error } = await supabase.auth.updateUser({ password });

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
          }
        } catch (_) {}

        await supabase.auth.signOut();
        // Close the window/tab after reset
        if (typeof window !== "undefined") {
          window.close();
        }
      }, 1200);
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
        <h1 style={{ marginBottom: 8 }}>Reset your password</h1>
        <p style={{ marginTop: 0, marginBottom: 20, color: "#6b7280" }}>
          Please enter a new password for your account.
        </p>

        <form onSubmit={handleReset}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", marginBottom: 4 }}>
              New password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 6,
                border: "1px solid #d1d5db",
              }}
              required
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", marginBottom: 4 }}>
              Confirm password
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 6,
                border: "1px solid #d1d5db",
              }}
              required
            />
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
   DEFECTS PAGE (ADMIN PORTAL)
   =========================== */

function DefectsPage() {
  const [defects, setDefects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [statusFilter, setStatusFilter] = useState("All");
  const [searchText, setSearchText] = useState("");

  const [expandedIds, setExpandedIds] = useState([]);
  const [editState, setEditState] = useState({});
  const [activityLogs, setActivityLogs] = useState({});

  async function loadDefects() {
    try {
      setLoading(true);
      setError("");

      const { data, error } = await supabase
        .from("defects")
        .select("*")
        .order("created_at", { ascending: false });

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
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDefects();
  }, []);

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

  function handleRowClick(defect) {
    const id = defect.id;
    const isOpen = expandedIds.includes(id);

    if (isOpen) {
      setExpandedIds(expandedIds.filter((x) => x !== id));
      return;
    }

    setExpandedIds([...expandedIds, id]);

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

      const { error: updateError } = await supabase
        .from("defects")
        .update({
          status: newStatus,
          actions_taken: state.actionsTaken,
          repair_company: state.repairCompany,
          photo_urls: updatedDefectPhotos,
          repair_photos: updatedRepairPhotos,
          locked: newLocked,
        })
        .eq("id", id);

      if (updateError) throw updateError;

      const { data: auth } = await supabase.auth.getUser();
      const performer = auth?.user?.email ?? "Admin Portal";

      const { error: logError } = await supabase.from("defect_activity").insert({
        defect_id: id,
        message: `Status saved as "${newStatus}" via Admin Portal`,
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

  return (
    <div className="app-root">
      {/* HEADER */}
      <header className="app-header">
        <div className="brand-left">
          <img
            src="/holcim-logo.png"
            alt="Holcim Sitebatch Technologies"
            className="brand-logo"
          />
        </div>
        <div className="brand-center">
          <h1>Maintenance Admin Portal</h1>
          <p>Defect overview from all assets</p>
        </div>
        <button
          className="refresh-button"
          onClick={loadDefects}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      {/* SIGN OUT BUTTON */}
      <button
        onClick={() => supabase.auth.signOut()}
        style={{
          marginLeft: 16,
          marginTop: 8,
          padding: "8px 16px",
          borderRadius: 999,
          border: "none",
          backgroundColor: "#1d4ed8",
          color: "#ffffff",
          fontWeight: 600,
          fontSize: 14,
          cursor: "pointer",
          boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
        }}
      >
        Sign out
      </button>

      {/* DEBUG BAR */}
      <div className="debug-bar">
        <span>Total defects loaded: {totalDefects}</span>
        <span>Shown after filters: {shownCount}</span>
      </div>

      {/* MAIN */}
      <main className="app-main">
        <div className="table-wrapper">
          {error && <div className="error-banner">{error}</div>}

          {/* Filters */}
          <div className="filters-row">
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
                      </tr>

                      {/* DETAILS ROW */}
                      {isExpanded && (
                        <tr className="details-row">
                          <td colSpan={7}>
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
                                            <a
                                              key={idx}
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
                                  >
                                    {edit.actionsTaken || ""}
                                  </textarea>
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
                                            <a
                                              key={idx}
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
    </div>
  );
}

/* ===========================
   LOGIN PAGE (PORTAL)
   =========================== */

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                width: "100%",
                padding: 8,
                borderRadius: 6,
                border: "1px solid #d1d5db",
              }}
              required
            />
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

      if (recovering) {
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

          if (event === "PASSWORD_RECOVERY" || isRecoveryUrl()) {
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
        onDone={() => {
          setView("login");
        }}
      />
    );
  }

  if (!session || view === "login") {
    return <LoginPage />;
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

  return <DefectsPage />;
}
