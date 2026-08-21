const ARCHIVE_SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const ARCHIVE_SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";
const ARCHIVE_LOCATIONS = ["atlanta", "buildingc", "delaware"];
const ARCHIVE_ROLE_TABLE = "user_roles";
const ARCHIVE_STORAGE_KEY = "dl-dispatch-auth";

function archiveCutoffDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}

function prettyDate(dateKey) {
  if (!dateKey) return "";
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function addArchiveAdminLink() {
  if (document.getElementById("admin-archive-link")) return;
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;

  const link = document.createElement("a");
  link.id = "admin-archive-link";
  link.href = "archive.html";
  link.textContent = "Archive";
  link.title = "Historical load archive";
  link.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "margin-left:auto",
    "padding:6px 11px",
    "border:1px solid rgba(255,255,255,.24)",
    "border-radius:6px",
    "color:inherit",
    "text-decoration:none",
    "font-size:12.5px",
    "font-weight:600",
    "white-space:nowrap",
  ].join(";");
  topbar.appendChild(link);
}

function showArchiveDueBanner({ count, oldestDate, cutoff }) {
  const dismissKey = `dl-archive-reminder-dismissed:${cutoff}`;
  if (sessionStorage.getItem(dismissKey) === "1") return;
  if (document.getElementById("archive-due-banner")) return;

  const banner = document.createElement("div");
  banner.id = "archive-due-banner";
  banner.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:12px",
    "padding:10px 18px",
    "border-bottom:1px solid #d6b650",
    "background:#fff8d8",
    "color:#513f00",
    "font-size:13px",
    "box-sizing:border-box",
  ].join(";");

  const message = document.createElement("div");
  message.style.cssText = "flex:1;min-width:0;";
  message.innerHTML = `<strong>Historical archive due.</strong> ${count.toLocaleString()} load${count === 1 ? "" : "s"} older than six months ${count === 1 ? "is" : "are"} ready to export. Oldest: ${prettyDate(oldestDate)}.`;

  const review = document.createElement("a");
  review.href = "archive.html";
  review.textContent = "Review Archive";
  review.style.cssText = "font-weight:700;color:#513f00;text-decoration:underline;white-space:nowrap;";

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Remind me later";
  dismiss.style.cssText = "border:0;background:transparent;color:#6d5700;cursor:pointer;font-size:12px;white-space:nowrap;";
  dismiss.addEventListener("click", () => {
    sessionStorage.setItem(dismissKey, "1");
    banner.remove();
  });

  banner.append(message, review, dismiss);
  const topbar = document.querySelector(".topbar");
  if (topbar && topbar.parentNode) topbar.insertAdjacentElement("afterend", banner);
  else document.body.prepend(banner);
}

async function initArchiveReminder() {
  if (!window.supabase || typeof window.supabase.createClient !== "function") return;

  const client = window.__dlArchiveReminderClient || window.supabase.createClient(
    ARCHIVE_SUPABASE_URL,
    ARCHIVE_SUPABASE_KEY,
    { auth: { persistSession: true, autoRefreshToken: true, storageKey: ARCHIVE_STORAGE_KEY } },
  );
  window.__dlArchiveReminderClient = client;

  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData?.session?.user) return;

  const userId = sessionData.session.user.id;
  const { data: roleRows, error: roleError } = await client
    .from(ARCHIVE_ROLE_TABLE)
    .select("role")
    .eq("user_id", userId)
    .limit(1);
  if (roleError) {
    console.error("Archive reminder role lookup failed:", roleError);
    return;
  }

  const role = roleRows?.[0]?.role || null;
  if (role !== "admin" && role !== "it") return;

  addArchiveAdminLink();

  const cutoff = archiveCutoffDate();
  const { data: oldestRows, error: loadError, count } = await client
    .from("loads_shifts")
    .select("id,shift_date", { count: "exact" })
    .in("location", ARCHIVE_LOCATIONS)
    .lt("shift_date", cutoff)
    .order("shift_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);

  if (loadError) {
    console.error("Archive reminder load check failed:", loadError);
    return;
  }

  if ((count || 0) > 0) {
    showArchiveDueBanner({ count, oldestDate: oldestRows?.[0]?.shift_date || null, cutoff });
  }
}

function scheduleArchiveReminder() {
  // loadboard.js performs its own async auth initialization. Waiting for the
  // window load event keeps this reminder out of that critical path.
  if (document.readyState === "complete") {
    window.setTimeout(() => initArchiveReminder().catch((e) => console.error("Archive reminder failed:", e)), 0);
  } else {
    window.addEventListener("load", () => {
      initArchiveReminder().catch((e) => console.error("Archive reminder failed:", e));
    }, { once: true });
  }
}

scheduleArchiveReminder();
