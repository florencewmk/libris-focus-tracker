import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LOCAL_USER_ID, deleteSession as removeSession, exportBackup, importBackup, loadData as loadSavedData, saveCheckIn, saveSession } from "./storage";
import type { CheckIn, StudySession } from "./types";

type ActiveTimer = {
  sessionId: string;
  startedAt: number;
  accumulatedSeconds: number;
  segmentStartedAt: number | null;
  location: string;
  subject: string;
  celebratedIntervals: number;
};

const FIREWORKS = [
  { x: "8%", y: "12%", delay: "0s", hue: 340, size: ".85" },
  { x: "32%", y: "18%", delay: ".4s", hue: 38, size: "1.15" },
  { x: "57%", y: "10%", delay: ".8s", hue: 188, size: ".95" },
  { x: "86%", y: "16%", delay: "1.2s", hue: 275, size: "1.2" },
  { x: "17%", y: "39%", delay: "1.6s", hue: 118, size: "1.05" },
  { x: "48%", y: "43%", delay: "2s", hue: 322, size: "1.25" },
  { x: "79%", y: "42%", delay: "2.4s", hue: 28, size: "1" },
  { x: "94%", y: "57%", delay: "2.8s", hue: 196, size: ".9" },
  { x: "7%", y: "68%", delay: "3.2s", hue: 260, size: "1.15" },
  { x: "31%", y: "78%", delay: "3.6s", hue: 62, size: ".95" },
  { x: "62%", y: "73%", delay: "4s", hue: 350, size: "1.2" },
  { x: "88%", y: "86%", delay: "4.4s", hue: 150, size: "1.05" },
];
const FIREWORK_ANGLES = Array.from({ length: 24 }, (_, index) => index * 15);
const CELEBRATION_DURATION_MS = 30_000;

const ACTIVE_TIMER_KEY = "libris-active-timer:local";
const readActiveTimer = (): ActiveTimer | null => {
  try {
    const saved = window.localStorage.getItem(ACTIVE_TIMER_KEY);
    if (!saved) return null;
    const timer = JSON.parse(saved) as Partial<ActiveTimer>;
    if (typeof timer.sessionId !== "string" || typeof timer.startedAt !== "number" || !Number.isFinite(timer.startedAt) || timer.startedAt <= 0 || timer.startedAt > Date.now()) return null;
    return {
      sessionId: timer.sessionId,
      startedAt: timer.startedAt,
      accumulatedSeconds: Number.isSafeInteger(timer.accumulatedSeconds) && timer.accumulatedSeconds! >= 0 ? timer.accumulatedSeconds! : 0,
      segmentStartedAt: typeof timer.segmentStartedAt === "number" && Number.isFinite(timer.segmentStartedAt) && timer.segmentStartedAt >= timer.startedAt && timer.segmentStartedAt <= Date.now() ? timer.segmentStartedAt : null,
      location: typeof timer.location === "string" ? timer.location.slice(0, 100) : "",
      subject: typeof timer.subject === "string" ? timer.subject.slice(0, 80) : "",
      celebratedIntervals: typeof timer.celebratedIntervals === "number" && timer.celebratedIntervals >= 0 ? Math.floor(timer.celebratedIntervals) : 0,
    };
  } catch {
    return null;
  }
};

const saveActiveTimer = (timer: ActiveTimer) => {
  try { window.localStorage.setItem(ACTIVE_TIMER_KEY, JSON.stringify(timer)); }
  catch { throw new Error("Your browser could not save the timer. Allow site storage, then try again."); }
};

const clearActiveTimer = () => {
  try { window.localStorage.removeItem(ACTIVE_TIMER_KEY); }
  catch { throw new Error("Your session was saved, but the browser could not clear the timer. Allow site storage, then stop it again."); }
};

const elapsedSeconds = (timer: ActiveTimer) => timer.accumulatedSeconds + (timer.segmentStartedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - timer.segmentStartedAt) / 1000)));
const errorMessage = (issue: unknown) => issue instanceof Error ? issue.message : "Your browser could not save this change. Please try again.";

const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return minutes ? `${minutes}m` : `${seconds}s`;
};

export default function Dashboard() {
  const displayName = "Student";
  const [initialTimer] = useState(readActiveTimer);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [checkIns, setCheckIns] = useState<CheckIn[]>([]);
  const [location, setLocation] = useState(initialTimer?.location || "");
  const [subject, setSubject] = useState(initialTimer?.subject || "");
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(initialTimer);
  const [seconds, setSeconds] = useState(() => initialTimer ? elapsedSeconds(initialTimer) : 0);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [ownsTab, setOwnsTab] = useState(false);
  const [anotherTabOpen, setAnotherTabOpen] = useState(false);
  const [error, setError] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const [celebrationMinutes, setCelebrationMinutes] = useState<number | null>(null);
  const canEdit = ready && ownsTab;
  const running = activeTimer?.segmentStartedAt != null;
  const paused = Boolean(activeTimer && !running);

  async function loadData() {
    try {
      const saved = await loadSavedData();
      setSessions(saved.sessions);
      setCheckIns(saved.checkIns);
      setReady(true);
      return true;
    } catch (issue) {
      setError(errorMessage(issue));
      return false;
    }
  }

  // Hold one writer for this browser so an older tab cannot revive a stopped timer.
  useEffect(() => {
    if (!navigator.locks) { setOwnsTab(true); return; }
    let disposed = false;
    let release = () => {};
    void navigator.locks.request("libris-focus-local-writer", { ifAvailable: true }, async (lock) => {
      if (disposed) return;
      if (!lock) { setAnotherTabOpen(true); return; }
      setOwnsTab(true);
      await new Promise<void>((resolve) => { release = resolve; });
    }).catch(() => { if (!disposed) setError("Your browser could not open local saves. Reload Libris and try again."); });
    return () => { disposed = true; release(); };
  }, []);
  useEffect(() => { if (ownsTab) void loadData(); }, [ownsTab]);
  useEffect(() => {
    if (!activeTimer) return;
    const updateElapsedTime = () => setSeconds(elapsedSeconds(activeTimer));
    updateElapsedTime();
    const timer = window.setInterval(updateElapsedTime, 1000);
    return () => window.clearInterval(timer);
  }, [activeTimer]);
  useEffect(() => {
    if (!activeTimer || !ownsTab) return;
    const updatedTimer = { ...activeTimer, location, subject };
    try { saveActiveTimer(updatedTimer); } catch (issue) { setError(errorMessage(issue)); }
  }, [activeTimer, location, subject, ownsTab]);
  useEffect(() => {
    if (!activeTimer || !running || !ready || !ownsTab) return;
    const sync = () => { void syncSession({ ...activeTimer, location, subject }, elapsedSeconds(activeTimer)); };
    const syncTimer = window.setInterval(sync, 5000);
    const saveWhenHidden = () => { if (document.visibilityState === "hidden") sync(); };
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      window.clearInterval(syncTimer);
      document.removeEventListener("visibilitychange", saveWhenHidden);
    };
  }, [activeTimer, running, location, subject, ready, ownsTab]);
  useEffect(() => {
    if (!activeTimer || !running || !ownsTab) return;
    const pauseWhenLeaving = () => {
      const duration = elapsedSeconds(activeTimer);
      const pausedTimer = { ...activeTimer, accumulatedSeconds: duration, segmentStartedAt: null, location, subject };
      try { saveActiveTimer(pausedTimer); } catch (issue) { setError(errorMessage(issue)); }
      setActiveTimer(pausedTimer);
      setSeconds(duration);
      void syncSession(pausedTimer, duration);
    };
    window.addEventListener("pagehide", pauseWhenLeaving);
    return () => window.removeEventListener("pagehide", pauseWhenLeaving);
  }, [activeTimer, running, location, subject, ownsTab]);
  useEffect(() => {
    if (ready && ownsTab && initialTimer) void syncSession(initialTimer, elapsedSeconds(initialTimer));
  }, [ready, ownsTab]);
  useEffect(() => {
    if (!activeTimer || !ownsTab) return;
    const completedIntervals = Math.floor(seconds / 1800);
    if (completedIntervals < 1 || completedIntervals <= activeTimer.celebratedIntervals) return;
    const celebratedTimer = { ...activeTimer, celebratedIntervals: completedIntervals };
    setActiveTimer(celebratedTimer);
    try { saveActiveTimer(celebratedTimer); } catch (issue) { setError(errorMessage(issue)); }
    setCelebrationMinutes(completedIntervals * 30);
  }, [activeTimer, seconds, ownsTab]);
  useEffect(() => {
    if (celebrationMinutes === null) return;
    const hideCelebration = window.setTimeout(() => setCelebrationMinutes(null), CELEBRATION_DURATION_MS);
    return () => window.clearTimeout(hideCelebration);
  }, [celebrationMinutes]);

  const todayKey = new Date().toDateString();
  const displayedSessions = useMemo(() => sessions.map((item) => item.id === activeTimer?.sessionId ? { ...item, duration_seconds: seconds, location: location.trim() || "Independent study", subject: subject.trim() || "General study" } : item), [sessions, activeTimer?.sessionId, seconds, location, subject]);
  const todaySeconds = useMemo(() => displayedSessions.filter((item) => new Date(item.started_at).toDateString() === todayKey).reduce((sum, item) => sum + item.duration_seconds, 0), [displayedSessions, todayKey]);
  const weekSessions = useMemo(() => displayedSessions.filter((item) => new Date(item.started_at).getTime() >= Date.now() - 7 * 86400000), [displayedSessions]);
  const weekSeconds = weekSessions.reduce((sum, item) => sum + item.duration_seconds, 0);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;

  async function checkIn() {
    if (!canEdit || !location.trim()) return;
    setBusy(true); setError("");
    try {
      const record: CheckIn = { id: crypto.randomUUID(), user_id: LOCAL_USER_ID, location: location.trim(), checked_in_at: new Date().toISOString() };
      await saveCheckIn(record);
      setCheckIns((items) => [record, ...items]);
    } catch (issue) { setError(errorMessage(issue)); }
    finally { setBusy(false); }
  }

  async function syncSession(timer: ActiveTimer, duration: number) {
    const record: StudySession = {
      id: timer.sessionId,
      user_id: LOCAL_USER_ID,
      location: timer.location.trim() || "Independent study",
      subject: timer.subject.trim() || "General study",
      started_at: new Date(timer.startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      duration_seconds: Math.max(0, Math.floor(duration)),
    };
    try {
      await saveSession(record);
      setSessions((items) => [record, ...items.filter((item) => item.id !== record.id)].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)));
      return true;
    } catch (issue) { setError(errorMessage(issue)); return false; }
  }

  async function startTimer() {
    if (running || !canEdit) return;
    setBusy(true); setError("");
    try {
      const startedAt = Date.now();
      const timer: ActiveTimer = activeTimer
        ? { ...activeTimer, segmentStartedAt: startedAt, location, subject }
        : { sessionId: crypto.randomUUID(), startedAt, accumulatedSeconds: 0, segmentStartedAt: startedAt, location, subject, celebratedIntervals: 0 };
      if (!await syncSession(timer, elapsedSeconds(timer))) return;
      saveActiveTimer(timer);
      setActiveTimer(timer);
      setSeconds(elapsedSeconds(timer));
    } catch (issue) { setError(errorMessage(issue)); }
    finally { setBusy(false); }
  }

  async function pauseTimer() {
    if (!activeTimer || !running) return;
    const duration = elapsedSeconds(activeTimer);
    const pausedTimer = { ...activeTimer, accumulatedSeconds: duration, segmentStartedAt: null, location, subject };
    setActiveTimer(pausedTimer);
    setSeconds(duration);
    setBusy(true); setError("");
    try {
      saveActiveTimer(pausedTimer);
      await syncSession(pausedTimer, duration);
    } catch (issue) { setError(errorMessage(issue)); }
    finally { setBusy(false); }
  }

  async function stopTimer() {
    if (!activeTimer) return;
    const duration = elapsedSeconds(activeTimer);
    setBusy(true); setError("");
    const pausedTimer = { ...activeTimer, accumulatedSeconds: duration, segmentStartedAt: null, location, subject };
    setActiveTimer(pausedTimer);
    setSeconds(duration);
    try {
      saveActiveTimer(pausedTimer);
      if (await syncSession(pausedTimer, duration)) {
        clearActiveTimer();
        setActiveTimer(null);
        setSeconds(0);
        setLocation("");
        setSubject("");
      }
    } catch (issue) { setError(errorMessage(issue)); }
    finally { setBusy(false); }
  }

  async function deleteSession(sessionId: string) {
    if (!canEdit || sessionId === activeTimer?.sessionId) return;
    if (!window.confirm("Delete this study session? This cannot be undone.")) return;
    setBusy(true); setError("");
    try {
      await removeSession(sessionId);
      setSessions((items) => items.filter((item) => item.id !== sessionId));
    } catch (issue) { setError(errorMessage(issue)); }
    finally { setBusy(false); }
  }

  async function downloadBackup() {
    setBusy(true); setError(""); setBackupMessage("");
    try {
      if (activeTimer && !await syncSession({ ...activeTimer, location, subject }, elapsedSeconds(activeTimer))) return;
      const contents = await exportBackup();
      const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `libris-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBackupMessage("Backup ready. Keep the downloaded file somewhere safe.");
    } catch (issue) { setError(errorMessage(issue)); }
    finally { setBusy(false); }
  }

  async function restoreBackup(file: File) {
    if (activeTimer) { setError("Stop your timer before importing a backup."); return; }
    setBusy(true); setError(""); setBackupMessage("");
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error("Choose a backup smaller than 25 MB.");
      const result = await importBackup(await file.text());
      if (await loadData()) setBackupMessage(`Imported ${result.sessions} sessions and ${result.checkIns} check-ins. Your existing history is kept; matching records are updated.`);
    } catch (issue) { setError(errorMessage(issue)); }
    finally { setBusy(false); if (importInput.current) importInput.current.value = ""; }
  }

  async function protectLocalSaves() {
    setBusy(true); setBackupMessage("");
    try {
      const protectedStorage = navigator.storage?.persist && await navigator.storage.persist();
      setBackupMessage(protectedStorage
        ? "This browser granted protection against automatic storage cleanup. Keep a backup too."
        : "This browser hasn't granted storage protection. Install Libris on your home screen and keep regular backups.");
    } catch {
      setBackupMessage("Storage protection isn't available here. Install Libris on your home screen and keep regular backups.");
    } finally { setBusy(false); }
  }

  const timerText = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((value) => String(value).padStart(2, "0")).join(":");
  const latestCheckIn = checkIns[0];
  const checkedInToday = latestCheckIn && new Date(latestCheckIn.checked_in_at).toDateString() === todayKey;

  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview"><span className="brand-mark">L</span><span>Libris</span></a>
        <nav className="side-nav"><a className="active" href="#overview">⌂ Overview</a><a href="#timer">◷ Study timer</a><a href="#history">▤ History</a><a href="#backups">↓ Backups</a></nav>
        <div className="profile-card"><span className="avatar">{displayName.slice(0, 1).toUpperCase()}</span><div><b>Your study space</b><small>Saved on this device</small></div></div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-header" id="overview">
          <div><p className="eyebrow">YOUR PERSONAL SPACE</p><h1>Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, {displayName}.</h1><p>Small, focused steps make remarkable progress.</p></div>
          <div className="date-chip">◌ {new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" }).format(new Date())}</div>
        </header>

        {error && <div className="error-banner" role="alert">{error}{!ready && <button className="button light" onClick={() => { setError(""); void loadData(); }}>Try again</button>}</div>}
        {anotherTabOpen && <div className="error-banner" role="status">Libris is already open in another tab. Close that tab, then reload this one to continue.<button className="button light" onClick={() => window.location.reload()}>Reload Libris</button></div>}

        <section className="dashboard-grid">
          <article className="timer-card" id="timer">
            <div className="card-heading"><span><i className={`status-dot ${running ? "live" : paused ? "paused" : ""}`} />{running ? "SESSION IN PROGRESS" : paused ? "SESSION PAUSED" : "READY TO FOCUS"}</span><b>◷</b></div>
            <div className="timer-display">{timerText}</div>
            <div className="timer-fields">
              <label>FOCUS<input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={80} placeholder="Subjects, books, etc." autoComplete="off" /></label>
            </div>
            <div className="timer-actions">
              <button className="button timer-button start" onClick={startTimer} disabled={!canEdit || busy || running}>{paused ? "Resume" : "Start"}</button>
              <button className="button timer-button pause" onClick={pauseTimer} disabled={!canEdit || busy || !running}>Pause</button>
              <button className="button timer-button stop" onClick={stopTimer} disabled={!canEdit || busy || !activeTimer}>{busy ? "Saving…" : "Stop"}</button>
            </div>
          </article>

          <article className="checkin-card">
            <span className="location-symbol">⌖</span><p className="eyebrow">TODAY'S LIBRARY</p>
            <h2 className={checkedInToday ? undefined : "focus-spot-prompt"}>{checkedInToday ? latestCheckIn.location : "Where’s today’s focus spot? 😊"}</h2>
            <p>{checkedInToday ? `Checked in at ${new Date(latestCheckIn.checked_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Type a place and mark today's visit."}</p>
            <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={100} placeholder="Type a place or address" autoComplete="off" />
            <a className="maps-link light" href={mapsUrl} target="_blank" rel="noreferrer">Open in Google Maps ↗</a>
            <button className="button light wide" onClick={checkIn} disabled={!canEdit || busy || !location.trim()}>Check in here</button>
          </article>

          <article className="stat-card"><div><p className="eyebrow">TODAY</p><strong>{formatDuration(todaySeconds)}</strong><span>focused time</span></div><div className="mini-ring" style={{ "--progress": `${Math.min(100, todaySeconds / 108)}%` } as React.CSSProperties}><span>{Math.min(100, Math.round(todaySeconds / 108))}%</span></div></article>
          <article className="stat-card"><div><p className="eyebrow">LAST 7 DAYS</p><strong>{formatDuration(weekSeconds)}</strong><span>{weekSessions.length} sessions</span></div><span className="trend">↗</span></article>
        </section>

        <section className="history-section" id="history">
          <div className="section-title"><div><p className="eyebrow">RECENT ACTIVITY</p><h2>Your focus history</h2></div><span>{sessions.length} saved sessions</span></div>
          <div className="history-list">
            {displayedSessions.length === 0 ? <div className="empty-state"><span>◷</span><div><b>Your first session starts here</b><p>Run the timer and your focused time will appear here.</p></div></div> : displayedSessions.slice(0, 10).map((item) => (
              <article key={item.id}><span className="history-icon">◷</span><div className="history-main"><b>{item.subject}</b><a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}`} target="_blank" rel="noreferrer">⌖ {item.location} ↗</a></div><div className="history-date">{new Date(item.started_at).toLocaleDateString([], { month: "short", day: "numeric" })}<small>{new Date(item.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div><strong>{formatDuration(item.duration_seconds)}</strong><button className="delete-session" onClick={() => void deleteSession(item.id)} disabled={busy || item.id === activeTimer?.sessionId} title={item.id === activeTimer?.sessionId ? "Stop this session before deleting it" : "Delete this session"} aria-label={`Delete ${item.subject} session`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg></button></article>
            ))}
          </div>
        </section>

        <section className="backup-section" id="backups" aria-labelledby="backup-title">
          <div><p className="eyebrow">SAVED ON THIS DEVICE</p><h2 id="backup-title">Keep your progress safe</h2><p>Your history stays in this browser. Export a backup before clearing browser data, or import one to move to another device.</p></div>
          <div className="backup-actions">
            <button className="button primary" onClick={downloadBackup} disabled={!canEdit || busy}>Export backup</button>
            <button className="button light" onClick={() => importInput.current?.click()} disabled={!canEdit || busy || Boolean(activeTimer)}>Import backup</button>
            <button className="button light" onClick={protectLocalSaves} disabled={!canEdit || busy}>Protect local saves</button>
            <input ref={importInput} type="file" accept="application/json,.json" aria-label="Import backup file" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void restoreBackup(file); }} />
          </div>
          <p className="backup-hint">On iPhone or iPad, add Libris to your Home Screen and open it there to protect against Safari's inactivity cleanup.</p>
          {activeTimer && <p className="backup-hint">Stop your timer before importing a backup.</p>}
          {backupMessage && <p className="backup-status" role="status">{backupMessage}</p>}
        </section>
      </div>
      {celebrationMinutes !== null && createPortal(
        <div className="celebration-overlay" role="status" aria-live="polite">
          <div className="celebration-message"><strong>{celebrationMinutes} minutes focused!</strong><span>Beautiful work, keep going ✨</span></div>
          {FIREWORKS.map((burst, burstIndex) => (
            <span className="firework" key={burstIndex} style={{ "--x": burst.x, "--y": burst.y, "--delay": burst.delay, "--hue": burst.hue, "--burst-size": burst.size } as React.CSSProperties} aria-hidden="true">
              {FIREWORK_ANGLES.map((angle, particleIndex) => <i key={angle} style={{ "--angle": `${angle}deg`, "--particle": particleIndex } as React.CSSProperties} />)}
            </span>
          ))}
        </div>,
        document.body,
      )}
    </main>
  );
}
