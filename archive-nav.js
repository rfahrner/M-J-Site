const ARCHIVE_NAV_SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const ARCHIVE_NAV_SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";

const archiveNavClient = window.supabase.createClient(
  ARCHIVE_NAV_SUPABASE_URL,
  ARCHIVE_NAV_SUPABASE_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, storageKey: "dl-dispatch-auth" } },
);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function installArchiveNavCss() {
  if (document.getElementById("archive-nav-css")) return;
  const style = document.createElement("style");
  style.id = "archive-nav-css";
  style.textContent = `
    .archive-nav-group { position: relative; display:flex; height:100%; align-items:center; }
    .archive-nav-menu {
      position:absolute; top:46px; left:0; min-width:170px; padding:6px;
      background:#fff; border:1px solid var(--line); border-radius:7px;
      box-shadow:0 8px 24px rgba(0,0,0,.16); display:none; z-index:500;
    }
    .archive-nav-group:hover .archive-nav-menu { display:block; }
    .archive-nav-menu a {
      display:block; padding:8px 10px; border-radius:5px; color:var(--navy-950);
      text-decoration:none; white-space:nowrap; font-size:12.5px;
    }
    .archive-nav-menu a:hover { background:var(--slate-100); }
    .archive-nav-spacer { margin-left:auto; }
  `;
  document.head.appendChild(style);
}

function dropdown(label, children) {
  const first = children[0];
  return `
    <div class="archive-nav-group">
      <a class="tab-btn" href="${esc(first.href)}">${esc(label)}</a>
      <div class="archive-nav-menu">
        ${children.map((c) => `<a href="${esc(c.href)}">${esc(c.label)}</a>`).join("")}
      </div>
    </div>`;
}

async function currentTrustedRole() {
  const { data: sessionData } = await archiveNavClient.auth.getSession();
  const user = sessionData?.session?.user;
  if (!user) return null;
  const { data, error } = await archiveNavClient
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .limit(1);
  if (error) {
    console.error("Archive nav role lookup failed:", error);
    return null;
  }
  return data?.[0]?.role || null;
}

async function renderArchiveNav() {
  const tabs = document.getElementById("tabs");
  if (!tabs) return;
  installArchiveNavCss();

  const role = await currentTrustedRole();
  const isAccounting = role === "accounting" || role === "admin" || role === "it";
  const isAdmin = role === "admin" || role === "it";

  const kroger = [
    { label: "Atlanta", href: "index.html" },
    { label: "Delaware", href: "dalaware.html" },
    { label: "Building C", href: "buildingc.html" },
    { label: "Houston", href: "houston.html" },
  ];
  const mondelez = [
    { label: "West Chester", href: "mondelez.html?loc=westchester" },
    { label: "Morris", href: "mondelez.html?loc=morris" },
    { label: "Addison", href: "mondelez.html?loc=addison" },
    { label: "Indianapolis", href: "mondelez.html?loc=indianapolis" },
    { label: "Louisville", href: "mondelez.html?loc=louisville" },
  ];
  const analytics = [
    { label: "Driver Analytics", href: "analytics-drivers.html" },
    { label: "Volume", href: "analytics-volume.html" },
    ...(isAdmin ? [{ label: "Location Analytics", href: "location-analytics.html" }] : []),
  ];

  tabs.innerHTML = [
    dropdown("Kroger", kroger),
    dropdown("Mondelez", mondelez),
    `<span class="tab-btn" style="opacity:.5;cursor:default;">LTL</span>`,
    `<a class="tab-btn" href="driverlist.html">Driver List</a>`,
    isAccounting ? `<a class="tab-btn" href="accounting.html">Accounting</a>` : "",
    dropdown("Analytics", analytics),
    `<a class="tab-btn active archive-nav-spacer" href="archive.html">Archive</a>`,
    `<button type="button" class="tab-btn" id="archive-nav-logout">Log Out</button>`,
  ].join("");

  document.getElementById("archive-nav-logout")?.addEventListener("click", async () => {
    await archiveNavClient.auth.signOut();
    window.location.href = "login.html";
  });
}

renderArchiveNav().catch((error) => console.error("Archive nav failed:", error));
