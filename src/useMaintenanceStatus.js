// src/useMaintenanceStatus.js - polls get_maintenance_status() every 30s and on focus/online.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearPrivileges,
  INITIAL_MAINTENANCE_STATE,
  MAINTENANCE_POLL_MS,
  fetchMaintenanceStatus,
  reduceMaintenanceState,
} from "./maintenanceStatus";

export function useMaintenanceStatus(client, userId) {
  // Remember which identity the last result belongs to, so a stale admin bypass is never applied
  // to a different (or signed-out) user while the new status is still being fetched.
  const [data, setData] = useState({ state: INITIAL_MAINTENANCE_STATE, forUserId: userId });
  const refreshRef = useRef(() => Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      const result = await fetchMaintenanceStatus(client);
      inFlight = false;
      if (!cancelled) {
        setData((prev) => ({ state: reduceMaintenanceState(prev.state, result), forUserId: userId }));
      }
    };
    refreshRef.current = run;

    run();
    const timer = setInterval(run, MAINTENANCE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", run);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", run);
    };
  }, [client, userId]);

  const refresh = useCallback(() => refreshRef.current(), []);
  const state = data.forUserId === userId ? data.state : clearPrivileges(data.state);
  return { ...state, refresh };
}
