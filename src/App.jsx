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
  const [selectedDefectForReport, setSelectedDefectForReport] = useState(null);

  async function loadDefects() {
    setLoading(true);
    setError("");
    
    try {
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
    }
    
    setLoading(false);
  }

  useEffect(() => {
    loadDefects();
  }, []);

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
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        alert("Could not get user email");
        return;
      }

      alert("Generating PDF... This may take a moment.");

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
      const filename = `Defect-Report-${defect.asset}.pdf`;

      console.log("Sending email with PDF to:", user.email);

      // Call Supabase function to send email with PDF attachment
      const { data, error } = await supabase.functions.invoke('send-report-email', {
        body: {
          to: user.email,
          subject: `Defect Report: ${defect.asset} - ${defect.title}`,
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
        alert(`Report PDF emailed successfully to ${user.email}`);
      }
    } catch (err) {
      console.error("Email error:", err);
      alert(`Error: ${err.message}\n\nCheck browser console for details.`);
    }
  }

  async function saveToDrive(defect) {
    try {
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
      const filename = `Defect-Report-${defect.asset}.pdf`;

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
      <footer style={{ textAlign: "center", padding: "20px", color: "#999", fontSize: 12 }}>
        Admin Portal v1.0
      </footer>

      {/* REPORT MODAL */}
      {selectedDefectForReport && (
        <div
          className="report-modal-overlay no-print"
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
            className="report-modal-paper no-print"
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

            <div style={{ marginTop: 24, display: "flex", gap: 12 }} className="no-print">
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
                style={{
                  padding: "10px 20px",
                  borderRadius: 6,
                  border: "1px solid #10b981",
                  backgroundColor: "white",
                  color: "#10b981",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                💾 Save to Drive
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
        <div style={{ marginTop: 16, textAlign: "center", color: "#999", fontSize: 12 }}>
          v1.0
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
