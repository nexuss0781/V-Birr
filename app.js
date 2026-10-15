import { readReceiptScreenshots } from "./lib/browser-ocr.js";
import { chooseReceiptLocator } from "./sdk/receipt-locator.js";

const STORE_KEY = "vbirr.workspace.preview.v1";
const main = document.getElementById("main");
const toast = document.getElementById("toast");
const nav = document.querySelector(".sidebar");
let currentView = "overview";
let toastTimer;
let selectedFiles = [];
let latestResult = null;

function emptyState() { return { projects: [], reviews: [], activity: [] }; }
function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!parsed || !Array.isArray(parsed.projects) || !Array.isArray(parsed.reviews) || !Array.isArray(parsed.activity)) return emptyState();
    return parsed;
  } catch { return emptyState(); }
}
let state = loadState();
let serverBacked = false;
let stateSync = Promise.resolve();
function saveState() {
  const serialized = JSON.stringify(state);
  if (serverBacked) {
    stateSync = stateSync.then(async () => {
      if (!serverBacked) return;
      const response = await fetch("/api/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-vbirr-project-secret": currentSecret() },
        body: JSON.stringify({ workspace: state }),
        cache: "no-store"
      });
      if (!response.ok) throw new Error("Workspace save failed");
    }).catch(() => {
      serverBacked = false;
      try { localStorage.setItem(STORE_KEY, serialized); } catch {}
      updateWorkspaceNotice();
      notify("Server save failed. Changes remain in this browser preview.");
    });
    return true;
  }
  try { localStorage.setItem(STORE_KEY, serialized); return true; }
  catch { notify("Browser storage is full. Export or clear older review records before continuing."); return false; }
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function normalizeAccount(value) { return String(value || "").replace(/\D/g, ""); }
function formatDate(value) {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
  catch { return String(value || ""); }
}
function makeId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function notify(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
}
function projectById(id) { return state.projects.find((project) => project.id === id); }
function openView(view) {
  currentView = view;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  render();
  main.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function pageHeader(title, description, button = "") {
  return `<div class="page-header"><div><div class="eyebrow">V-Birr workspace</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${button}</div>`;
}
function emptyBlock(title, description, symbol = "+") {
  return `<div class="empty"><div class="empty-mark">${escapeHtml(symbol)}</div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>`;
}
function statusBadge(status) {
  const map = {
    verified: ["Verified", "good"], matched: ["Matched", "good"],
    needs_review: ["Needs review", "warn"], inconclusive: ["Inconclusive", "warn"],
    mismatch: ["Mismatch", "bad"], failed: ["Failed", "bad"],
    pending: ["Pending", "warn"], resolved: ["Reviewed", "good"]
  };
  const [label, kind] = map[status] || [status || "Unknown", ""];
  return `<span class="badge ${kind}">${escapeHtml(label)}</span>`;
}
function statCard(label, value, foot) {
  return `<div class="stat"><span class="stat-label">${escapeHtml(label)}</span><strong class="stat-value">${escapeHtml(value)}</strong><div class="stat-foot">${escapeHtml(foot)}</div></div>`;
}
function renderOverview() {
  const openReviews = state.reviews.filter((item) => !item.resolved).length;
  const verifiedCount = state.activity.filter((item) => item.status === "verified").length;
  const recent = [...state.reviews, ...state.activity].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  return `${pageHeader("Overview", "A clear view of your organization accounts and payment checks.", `<button class="button" data-action="new-project">Create project <span aria-hidden="true">＋</span></button>`)}
    <div class="stats-grid">${statCard("Projects", state.projects.length, "Fixed receiving accounts")}${statCard("Payer accounts", state.projects.reduce((sum, project) => sum + project.payers.length, 0), "Registered under projects")}${statCard("Awaiting review", openReviews, "Failed or inconclusive checks")}</div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-title"><div><h2>Recent activity</h2><p>Latest verification decisions and review items.</p></div><button class="button button-outline button-small" data-action="view-activity">View all</button></div>
        ${recent.length ? `<div class="list">${recent.map((item) => `<div class="list-row"><div class="list-row-main"><strong>${escapeHtml(item.projectName || "Project")}${item.senderAccount ? ` · ${escapeHtml(item.senderAccount)}` : ""}</strong><small>${escapeHtml(formatDate(item.createdAt))}${item.reason ? ` · ${escapeHtml(item.reason)}` : ""}</small></div>${statusBadge(item.resolved ? "resolved" : item.status)}</div>`).join("")}</div>` : emptyBlock("No activity yet", "Create an organization project, add payer accounts, then submit a receipt screenshot.", "↻")}
      </section>
      <section class="panel"><div class="panel-title"><div><h2>Quick actions</h2><p>Set up the organization workflow.</p></div></div><div class="quick-grid">
        <button class="quick-card" data-action="new-project"><b>Create an organization project</b><span>Set the fixed receiving account and its account type.</span></button>
        <button class="quick-card" data-action="view-payers"><b>Register payer accounts</b><span>Maintain the one-to-many payer directory.</span></button>
        <button class="quick-card" data-action="new-verification"><b>Verify a payment</b><span>Enter the sender account and upload receipt proof.</span></button>
        <button class="quick-card" data-action="view-reviews"><b>Review exceptions</b><span>Inspect exact V-Birr and provider responses.</span></button>
      </div></section>
    </div>
    <section class="panel section-gap"><div class="panel-title"><div><h2>Organization projects</h2><p>Each project has one fixed receiving account and can have multiple payer accounts.</p></div><button class="button button-outline button-small" data-action="view-projects">Manage projects</button></div>
      ${state.projects.length ? `<div class="projects-grid">${state.projects.slice(0, 4).map(projectCard).join("")}</div>` : emptyBlock("No projects created", "Start by adding the organization account that should receive payments.", "▦")}
    </section>`;
}
function projectCard(project) {
  return `<article class="project-card"><div class="project-card-head"><div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.organization)}</p></div><span class="badge">${escapeHtml(project.accountType)}</span></div><div class="project-meta"><span>Receiving · ${escapeHtml(project.baseAccount)}</span><span>${project.payers.length} payer${project.payers.length === 1 ? "" : "s"}</span></div><div class="form-actions"><button class="button button-outline button-small" data-action="manage-payers" data-project="${escapeHtml(project.id)}">Manage payers</button><button class="button button-outline button-small" data-action="verify-project" data-project="${escapeHtml(project.id)}">Verify payment</button></div></article>`;
}
function renderProjects() {
  const createForm = `<section class="panel"><div class="panel-title"><div><h2>Create an organization project</h2><p>The receiving account is fixed per project. Add multiple payer accounts after creating it.</p></div></div>
    <form id="projectForm" data-form="project"><div class="form-grid">
      <div class="field"><label for="organization">Organization name</label><input id="organization" name="organization" maxlength="100" required placeholder="e.g. Example Trading PLC"></div>
      <div class="field"><label for="projectName">Project name</label><input id="projectName" name="name" maxlength="80" required placeholder="e.g. Monthly collections"></div>
      <div class="field"><label for="accountType">Receiving account type</label><select id="accountType" name="accountType" required><option value="Telebirr">Telebirr</option><option value="CBE">CBE</option><option value="Bank of Abyssinia">Bank of Abyssinia</option><option value="Zemen Bank">Zemen Bank</option><option value="Awash Bank">Awash Bank</option><option value="Other bank">Other bank</option></select></div>
      <div class="field"><label for="baseAccount">Fixed receiving account number</label><input id="baseAccount" name="baseAccount" maxlength="64" inputmode="numeric" required placeholder="Enter the full account number"><small class="help">This is the organization account every receipt must credit.</small></div>
    </div><div class="form-actions"><button class="button" type="submit">Create project</button></div></form></section>
    <section class="panel section-gap"><div class="panel-title"><div><h2>Existing projects</h2><p>${state.projects.length} project${state.projects.length === 1 ? "" : "s"} in this browser workspace.</p></div></div>${state.projects.length ? `<div class="projects-grid">${state.projects.map(projectCard).join("")}</div>` : emptyBlock("Nothing here yet", "Your organization projects will appear here after creation.", "▦")}</section>`;
  return `${pageHeader("Projects", "Create separate verification projects for each organization account.")}${createForm}`;
}
function selectedProjectOptions(selected = "") {
  return state.projects.map((project) => `<option value="${escapeHtml(project.id)}" ${project.id === selected ? "selected" : ""}>${escapeHtml(project.name)} · ${escapeHtml(project.baseAccount)}</option>`).join("");
}
function renderPayers() {
  const selected = state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0];
  if (!selected) return `${pageHeader("Payer accounts", "Manage the many-to-one relationship between payer accounts and each organization project.")}${emptyBlock("Create a project first", "A payer account belongs to a project with a fixed receiving account.", "♧")}`;
  state.activeProjectId = selected.id;
  return `${pageHeader("Payer accounts", "Each project can have many registered sender accounts.")}
    <section class="panel"><div class="field"><label for="payerProject">Project</label><select id="payerProject" data-select="payer-project">${selectedProjectOptions(selected.id)}</select></div>
      <div class="divider"></div><div class="panel-title"><div><h2>Add a payer account</h2><p>Use the full sender account number. During verification, the sender's entered number must match this directory to avoid manual review.</p></div></div>
      <form data-form="payer" data-project="${escapeHtml(selected.id)}"><div class="form-grid"><div class="field"><label for="payerName">Payer name or label</label><input id="payerName" name="name" maxlength="90" required placeholder="e.g. Hana Tesfaye"></div><div class="field"><label for="payerAccount">Full payer account number</label><input id="payerAccount" name="accountNumber" maxlength="64" inputmode="numeric" required placeholder="e.g. 0912792308"></div></div><div class="form-actions"><button class="button" type="submit">Add payer account</button></div></form>
    </section>
    <section class="panel section-gap"><div class="panel-title"><div><h2>${escapeHtml(selected.name)} · Payer directory</h2><p>Receiving account: ${escapeHtml(selected.baseAccount)} · ${selected.payers.length} registered payer${selected.payers.length === 1 ? "" : "s"}</p></div></div>
      ${selected.payers.length ? `<div class="list">${selected.payers.map((payer) => `<div class="list-row"><div class="list-row-main"><strong>${escapeHtml(payer.name)}</strong><small>${escapeHtml(payer.accountNumber)} · Added ${escapeHtml(formatDate(payer.createdAt))}</small></div><button class="button button-danger button-small" data-action="delete-payer" data-project="${escapeHtml(selected.id)}" data-payer="${escapeHtml(payer.id)}">Remove</button></div>`).join("")}</div>` : emptyBlock("No payer accounts yet", "Add the sender accounts that are allowed to pay into this project's receiving account.", "♧")}
    </section>`;
}
function renderVerify() {
  const preferred = state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0];
  if (!preferred) return `${pageHeader("Verify payment", "Check a receipt against a project's fixed receiving account and the sender account.")}${emptyBlock("Create a project first", "Every verification needs a fixed organization receiving account.", "＋")}`;
  const projectOptions = selectedProjectOptions(preferred.id);
  const payerOptions = preferred.payers.map((payer) => `<option value="${escapeHtml(payer.accountNumber)}">${escapeHtml(payer.name)} · ${escapeHtml(payer.accountNumber)}</option>`).join("");
  return `${pageHeader("Verify payment", "Read a receipt locally, then verify its URL or reference against both account numbers.")}
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-title"><div><h2>Payment submission</h2><p>The receiving account is loaded from project settings and cannot be changed here.</p></div></div>
        <form id="verifyForm" data-form="verify"><div class="form-grid">
          <div class="field full"><label for="verifyProject">Organization project</label><select id="verifyProject" name="projectId" required>${projectOptions}</select></div>
          <div class="field"><label for="payerLookup">Registered payer (optional)</label><select id="payerLookup"><option value="">Enter sender account manually</option>${payerOptions}</select><small class="help">Selecting a registered payer fills the sender account field.</small></div>
          <div class="field"><label for="senderAccount">Sender account number</label><input id="senderAccount" name="clientAccount" maxlength="64" inputmode="numeric" required placeholder="Enter the full sender account"></div>
          <div class="field full"><label>Fixed receiving account</label><div class="list-row"><div class="list-row-main"><strong id="fixedAccount">${escapeHtml(preferred.baseAccount)}</strong><small id="fixedAccountMeta">${escapeHtml(preferred.organization)} · ${escapeHtml(preferred.accountType)}</small></div><span class="badge">Project account</span></div></div>
      <div class="field full"><label for="receiptFiles">Receipt screenshot (optional)</label><div class="dropzone" id="dropzone"><label for="receiptFiles"><span class="upload-icon">↑</span><strong>Choose screenshots or drop them here</strong><span>JPEG, PNG or WebP · up to 5 images of the same transaction</span></label><input id="receiptFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple><div class="file-list" id="fileList"></div></div>
            <div class="privacy-note">Screenshot text is read locally in this browser. The screenshot is never uploaded or saved by V-Birr; only the extracted receipt URL/reference and account details are sent to V-Birr for an on-the-fly Links.et lookup.</div>
          </div>
          <div class="field full"><label for="receiptLocator">Receipt URL or reference</label><input id="receiptLocator" name="receiptLocator" type="text" maxlength="2048" autocomplete="off" list="receiptLocatorCandidates" placeholder="Extracted from screenshot, or enter it manually"><datalist id="receiptLocatorCandidates"></datalist><small class="help">If OCR finds more than one candidate, choose the correct receipt reference here before verifying.</small></div>
        </div><div class="form-actions"><button class="button" id="verifyButton" type="submit">Verify payment <span aria-hidden="true">→</span></button><button class="button button-outline" type="reset">Clear</button></div><p class="small-copy">Automatic approval requires both a verified receipt-account match and a sender account registered to this project. All other outcomes go to admin review.</p></form>
      </section>
      <aside class="panel"><div class="panel-title"><div><h2>Latest result</h2><p>Every non-verified outcome is saved to the review queue.</p></div></div>${latestResult ? renderLatestResult(latestResult) : emptyBlock("Ready to verify", "Enter the sender account and upload a screenshot to begin.", "✓")}</aside>
    </div>`;
}
function renderLatestResult(item) {
  const appStatus = item.status;
  const decision = item.vbirrResponse?.decision || {};
  const checks = item.vbirrResponse?.accountChecks || {};
  const message = item.reason || item.vbirrResponse?.error?.message || (decision.grant ? "Both receipt accounts matched and the sender is registered." : "The payment was not automatically verified.");
  return `<div class="result-card" data-state="${escapeHtml(appStatus)}"><h3>${escapeHtml(appStatus === "verified" ? "Verified — both account checks passed" : appStatus === "needs_review" ? "Manual review required" : appStatus === "mismatch" ? "Not verified — account mismatch" : appStatus === "inconclusive" ? "Inconclusive — do not approve" : "Verification failed")}</h3><p>${escapeHtml(message)}</p><div class="result-rows"><div class="result-row"><span>Project</span><span>${escapeHtml(item.projectName)}</span></div><div class="result-row"><span>Sender</span><span>${escapeHtml(item.senderAccount)}</span></div><div class="result-row"><span>Receiving account</span><span>${escapeHtml(item.baseAccount)}</span></div><div class="result-row"><span>Sender account check</span><span class="${escapeHtml(checks.sender?.status === "matched" ? "match" : checks.sender?.status === "mismatch" ? "mismatch" : "neutral")}">${escapeHtml(checks.sender?.status || "not checked")}</span></div><div class="result-row"><span>Receiving account check</span><span class="${escapeHtml(checks.recipient?.status === "matched" ? "match" : checks.recipient?.status === "mismatch" ? "mismatch" : "neutral")}">${escapeHtml(checks.recipient?.status || "not checked")}</span></div></div></div><div class="form-actions"><button class="button button-outline button-small" data-action="view-review-item" data-review="${escapeHtml(item.id)}">${item.status === "verified" ? "View activity" : "Open admin review"}</button></div>`;
}
function renderReview(item) {
  const body = item.vbirrResponse || {};
  const provider = body.providerResponse;
  const vbirrCopy = JSON.stringify(body, null, 2);
  const providerCopy = JSON.stringify(provider ?? null, null, 2);
  return `<article class="review-card"><div class="review-head"><div><h3>${escapeHtml(item.projectName)} · ${escapeHtml(item.senderAccount || "Sender not identified")}</h3><p>${escapeHtml(formatDate(item.createdAt))} · Receiving account ${escapeHtml(item.baseAccount)}${item.reason ? ` · ${escapeHtml(item.reason)}` : ""}</p></div><div class="review-actions">${statusBadge(item.resolved ? "resolved" : item.status)}${item.resolved ? "" : `<button class="button button-outline button-small" data-action="resolve-review" data-review="${escapeHtml(item.id)}">Mark reviewed</button>`}</div></div>
    <div class="result-rows"><div class="result-row"><span>Receipt account checks</span><span>${escapeHtml(body.accountChecks?.sender?.status || "not checked")} / ${escapeHtml(body.accountChecks?.recipient?.status || "not checked")}</span></div><div class="result-row"><span>Provider receipt source</span><span>${escapeHtml(body.receipt?.source || body.detected?.provider || "not identified")}</span></div><div class="result-row"><span>V-Birr code</span><span>${escapeHtml(body.vbirr?.code || body.error?.code || "not available")}</span></div></div>
    <details><summary>Exact V-Birr response</summary><pre class="raw-response">${escapeHtml(vbirrCopy)}</pre></details>
    <details><summary>Exact provider response</summary><pre class="raw-response">${escapeHtml(providerCopy)}</pre></details>
    <label class="help" for="note-${escapeHtml(item.id)}">Admin review note</label><textarea class="admin-note" id="note-${escapeHtml(item.id)}" data-note="${escapeHtml(item.id)}" placeholder="Record the review decision or follow-up">${escapeHtml(item.adminNote || "")}</textarea>
  </article>`;
}
function renderReviews() {
  const open = state.reviews.filter((item) => !item.resolved).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const resolved = state.reviews.filter((item) => item.resolved).sort((a, b) => new Date(b.reviewedAt || b.createdAt) - new Date(a.reviewedAt || a.createdAt));
  return `${pageHeader("Admin review queue", "Review failed, mismatched, unregistered, or inconclusive receipts. Original responses are retained for review.")}
    <section class="panel"><div class="panel-title"><div><h2>Open reviews</h2><p>${open.length} item${open.length === 1 ? "" : "s"} require admin attention.</p></div></div>${open.length ? open.map(renderReview).join("") : emptyBlock("Queue is clear", "Failed and inconclusive checks will appear here with their exact response payloads.", "✓")}</section>
    ${resolved.length ? `<section class="panel section-gap"><div class="panel-title"><div><h2>Reviewed items</h2><p>Previously resolved exceptions.</p></div></div>${resolved.map(renderReview).join("")}</section>` : ""}`;
}
function renderActivity() {
  const items = [...state.activity, ...state.reviews].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return `${pageHeader("Activity", "Recent payment checks across your organization projects.")}<section class="panel"><div class="panel-title"><div><h2>All activity</h2><p>${items.length} recorded verification${items.length === 1 ? "" : "s"}.</p></div></div>${items.length ? `<div class="list">${items.map((item) => `<div class="list-row"><div class="list-row-main"><strong>${escapeHtml(item.projectName)} · ${escapeHtml(item.senderAccount || "Sender not identified")}</strong><small>${escapeHtml(formatDate(item.createdAt))} · Receiving ${escapeHtml(item.baseAccount)}${item.reason ? ` · ${escapeHtml(item.reason)}` : ""}</small></div>${statusBadge(item.resolved ? "resolved" : item.status)}</div>`).join("")}</div>` : emptyBlock("No verification activity", "Submit an authorized screenshot to create the first activity record.", "↻")}</section>`;
}
function render() {
  const openCount = state.reviews.filter((item) => !item.resolved).length;
  document.getElementById("reviewCount").textContent = String(openCount);
  if (currentView === "projects") main.innerHTML = renderProjects();
  else if (currentView === "payers") main.innerHTML = renderPayers();
  else if (currentView === "verify") main.innerHTML = renderVerify();
  else if (currentView === "reviews") main.innerHTML = renderReviews();
  else if (currentView === "activity") main.innerHTML = renderActivity();
  else main.innerHTML = renderOverview();
  bindFilePicker();
}
function setHealth(ok) {
  const pill = document.getElementById("health");
  pill.classList.toggle("online", ok);
  pill.classList.toggle("offline", !ok);
  pill.querySelector("span").textContent = ok ? "Service online" : "Service unavailable";
}
async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (response.status === 404) {
      const pill = document.getElementById("health");
      pill.classList.remove("online");
      pill.classList.add("offline");
      pill.querySelector("span").textContent = "Preview only";
      return;
    }
    const body = await response.json();
    setHealth(Boolean(response.ok && body.ok));
  }
  catch { setHealth(false); }
}
function currentSecret() {
  return sessionStorage.getItem("vbirr.projectSecret") || "";
}
function updateWorkspaceNotice() {
  const notice = document.querySelector(".notice");
  if (!notice) return;
  const strong = notice.querySelector("strong");
  const span = notice.querySelector("span:not(.notice-icon)");
  if (serverBacked) {
    strong.textContent = "Server workspace connected";
    span.textContent = "Projects and admin review records are saved on the V-Birr server and require the verification key to access.";
  } else {
    strong.textContent = "Workspace preview";
    span.textContent = "Projects and review records are stored in this browser only. Use an authenticated, server-backed workspace before processing production customer data.";
  }
}
async function connectWorkspace(showToast = true) {
  const secret = currentSecret();
  if (!secret) return false;
  try {
    const response = await fetch("/api/workspace", {
      method: "GET",
      headers: { "x-vbirr-project-secret": secret },
      cache: "no-store"
    });
    if (!response.ok) {
      serverBacked = false;
      updateWorkspaceNotice();
      if (showToast) notify(response.status === 401 ? "The V-Birr verification key was not accepted." : "Server storage is not configured; using this browser's preview workspace.");
      return false;
    }
    const data = await response.json();
    if (!data.ok || !data.workspace || !Array.isArray(data.workspace.projects) || !Array.isArray(data.workspace.reviews) || !Array.isArray(data.workspace.activity)) {
      serverBacked = false;
      updateWorkspaceNotice();
      if (showToast) notify("The server workspace response was invalid.");
      return false;
    }
    serverBacked = true;
    state = data.workspace;
    state.activeProjectId ||= state.projects[0]?.id;
    localStorage.removeItem(STORE_KEY);
    updateWorkspaceNotice();
    render();
    if (showToast) notify("Connected to the authenticated server workspace.");
    return true;
  } catch {
    serverBacked = false;
    updateWorkspaceNotice();
    if (showToast) notify("Server workspace is unavailable; using this browser's preview workspace.");
    return false;
  }
}
function updateFileList() {
  const box = document.getElementById("fileList");
  if (!box) return;
  box.innerHTML = selectedFiles.map((file) => `<div class="file-chip"><span>${escapeHtml(file.name)} · ${(file.size / (1024 * 1024)).toFixed(2)} MB</span><span>${escapeHtml(file.type || "image")}</span></div>`).join("");
}
function bindFilePicker() {
  const input = document.getElementById("receiptFiles");
  const dropzone = document.getElementById("dropzone");
  if (!input || !dropzone) return;
  input.addEventListener("change", () => acceptFiles([...input.files]));
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (event) => { event.preventDefault(); dropzone.classList.remove("dragover"); acceptFiles([...event.dataTransfer.files]); });
}
function acceptFiles(files) {
  const validTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (files.length > 5) { notify("Choose no more than five screenshots for one transaction."); return; }
  if (files.some((file) => !validTypes.has(file.type))) { notify("Use JPEG, PNG, or WebP screenshots."); return; }
  if (files.some((file) => Math.ceil(file.size / 3) * 4 > 5 * 1024 * 1024)) { notify("Each encoded screenshot must be no larger than 5 MB."); return; }
  selectedFiles = files;
  updateFileList();
}
function decideAppStatus(response, registered) {
  if (response?.decision?.grant === true) return registered ? { status: "verified", reason: "Both receipt accounts matched and the sender is registered to this project." } : { status: "needs_review", reason: "Receipt accounts matched, but the sender account is not registered to this project." };
  if (response?.vbirr?.code === "UNREGISTERED_PAYER" || response?.project?.registeredPayer === false) return { status: "needs_review", reason: "Receipt accounts matched, but the sender account is not registered to this project." };
  const state = response?.decision?.status || response?.vbirr?.status || "failed";
  return { status: state === "needs_review" ? "needs_review" : state === "mismatch" ? "mismatch" : state === "inconclusive" ? "inconclusive" : "failed", reason: response?.error?.message || (state === "needs_review" ? "This payment needs an admin review." : state === "mismatch" ? "The receipt account details did not match." : state === "inconclusive" ? "The receipt did not provide enough detail for automatic approval." : "V-Birr could not complete verification.") };
}
async function submitVerification(form) {
  const secret = currentSecret();
  if (!secret) { notify("Open Connection and add the V-Birr project secret before verifying."); document.querySelector(".connection-menu").open = true; return; }
  const project = projectById(form.elements.projectId.value);
  if (!project) { notify("Choose a valid organization project."); return; }
  const senderAccount = form.elements.clientAccount.value.trim();
  if (normalizeAccount(senderAccount).length < 4) { notify("Enter the sender's full account number."); return; }
  let locator = form.elements.receiptLocator.value.trim();
  if (!selectedFiles.length && !locator) { notify("Add a receipt screenshot or enter its URL/reference."); return; }
  const registered = project.payers.some((payer) => normalizeAccount(payer.accountNumber) === normalizeAccount(senderAccount));
  const button = document.getElementById("verifyButton");
  button.disabled = true;
  let responseBody;
  try {
    await stateSync;
    if (selectedFiles.length && !locator) {
      button.textContent = "Reading screenshot locally…";
      let candidates;
      try {
        candidates = await readReceiptScreenshots(selectedFiles, ({ status, progress }) => {
          if (status === "recognizing text") button.textContent = `Reading screenshot locally… ${Math.round(progress * 100)}%`;
        });
      } catch {
        notify("Local screenshot reading failed. Enter the receipt URL or reference manually.");
        return;
      } finally {
        selectedFiles = [];
        const input = document.getElementById("receiptFiles");
        if (input) input.value = "";
        updateFileList();
      }
      const selected = chooseReceiptLocator(candidates);
      if (!selected) {
        const list = document.getElementById("receiptLocatorCandidates");
        if (list) {
          list.replaceChildren(...(candidates || []).map((candidate) => {
            const option = document.createElement("option");
            option.value = candidate.value;
            option.label = candidate.type === "url" ? "Receipt URL" : "Receipt reference";
            return option;
          }));
        }
        notify(candidates?.length ? "Several receipt locators were found. Choose the correct one, then verify again." : "No receipt URL or reference was found. Enter it manually and verify again.");
        return;
      }
      locator = selected.value;
      form.elements.receiptLocator.value = locator;
    } else if (selectedFiles.length) {
      selectedFiles = [];
      const input = document.getElementById("receiptFiles");
      if (input) input.value = "";
      updateFileList();
    }
    if (!locator) {
      notify("Enter a receipt URL or reference before verifying.");
      return;
    }
    const locatorField = form.elements.receiptLocator;
    if (locatorField) locatorField.value = locator;
    button.textContent = "Looking up receipt…";
    const receiptInput = /^https:\/\//i.test(locator) ? { url: locator } : { reference: locator };
    const response = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vbirr-project-secret": secret, "Idempotency-Key": makeId() },
      body: JSON.stringify({ ...receiptInput, projectId: project.id, clientAccount: senderAccount }),
      cache: "no-store"
    });
    try { responseBody = await response.json(); }
    catch { responseBody = { ok: false, error: { code: "INVALID_RESPONSE", message: "The V-Birr response could not be read." }, vbirr: { status: "failed", code: "INVALID_RESPONSE" }, providerResponse: null }; }
    if (!response.ok && !responseBody.error) responseBody.error = { code: `HTTP_${response.status}`, message: "V-Birr could not complete the request." };
  } catch {
    responseBody = { ok: false, error: { code: "NETWORK_ERROR", message: "Could not reach V-Birr. Check the connection and try again." }, vbirr: { status: "failed", code: "NETWORK_ERROR" }, providerResponse: null };
  } finally {
    button.disabled = false;
    button.textContent = "Verify payment →";
  }
  if (!responseBody) return;
  const final = decideAppStatus(responseBody, registered);
  const record = {
    id: makeId(), createdAt: new Date().toISOString(), projectId: project.id,
    projectName: project.name, organization: project.organization,
    accountType: project.accountType, senderAccount,
    baseAccount: project.baseAccount, status: final.status,
    reason: final.reason, registeredPayer: registered,
    vbirrResponse: responseBody, resolved: false, adminNote: ""
  };
  if (final.status === "verified") {
    state.activity.unshift(record);
    state.activity = state.activity.slice(0, 200);
    notify("Payment verified. Both accounts matched and the sender is registered.");
  } else {
    state.reviews.unshift(record);
    notify("Payment was not automatically verified and has been added to admin review.");
  }
  saveState();
  latestResult = record;
  selectedFiles = [];
  currentView = "verify";
  render();
}

nav.addEventListener("click", (event) => {
  const item = event.target.closest("[data-view]");
  if (item) openView(item.dataset.view);
});
document.getElementById("saveSecret").addEventListener("click", async () => {
  const secret = document.getElementById("projectSecret").value.trim();
  if (!secret) { notify("Enter a V-Birr project secret first."); return; }
  sessionStorage.setItem("vbirr.projectSecret", secret);
  document.getElementById("projectSecret").value = "";
  await connectWorkspace(true);
});
document.getElementById("dismissNotice").addEventListener("click", (event) => event.currentTarget.closest(".notice").remove());
main.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) return;
  const projectId = action.dataset.project;
  if (action.dataset.action === "new-project" || action.dataset.action === "view-projects") openView("projects");
  else if (action.dataset.action === "view-payers") openView("payers");
  else if (action.dataset.action === "new-verification") openView("verify");
  else if (action.dataset.action === "view-reviews") openView("reviews");
  else if (action.dataset.action === "view-activity") openView("activity");
  else if (action.dataset.action === "manage-payers") { state.activeProjectId = projectId; openView("payers"); }
  else if (action.dataset.action === "verify-project") { state.activeProjectId = projectId; openView("verify"); }
  else if (action.dataset.action === "delete-payer") {
    const project = projectById(projectId);
    if (project && window.confirm("Remove this payer account from the project? Existing payment records will remain.")) {
      project.payers = project.payers.filter((payer) => payer.id !== action.dataset.payer);
      saveState(); render(); notify("Payer account removed.");
    }
  } else if (action.dataset.action === "resolve-review") {
    const item = state.reviews.find((review) => review.id === action.dataset.review);
    if (item) { item.resolved = true; item.reviewedAt = new Date().toISOString(); item.adminNote = document.querySelector(`[data-note="${CSS.escape(item.id)}"]`)?.value || ""; saveState(); render(); notify("Review marked as complete."); }
  } else if (action.dataset.action === "view-review-item") {
    if (action.dataset.review && state.reviews.some((item) => item.id === action.dataset.review)) openView("reviews");
    else openView("activity");
  }
});
main.addEventListener("change", (event) => {
  if (event.target.matches('[data-select="payer-project"]')) { state.activeProjectId = event.target.value; saveState(); render(); }
  if (event.target.id === "verifyProject") {
    state.activeProjectId = event.target.value;
    const project = projectById(event.target.value);
    const account = document.getElementById("fixedAccount");
    const meta = document.getElementById("fixedAccountMeta");
    const lookup = document.getElementById("payerLookup");
    if (account && project) account.textContent = project.baseAccount;
    if (meta && project) meta.textContent = `${project.organization} · ${project.accountType}`;
    if (lookup && project) lookup.innerHTML = `<option value="">Enter sender account manually</option>${project.payers.map((payer) => `<option value="${escapeHtml(payer.accountNumber)}">${escapeHtml(payer.name)} · ${escapeHtml(payer.accountNumber)}</option>`).join("")}`;
    saveState();
  }
  if (event.target.id === "payerLookup") { const sender = document.getElementById("senderAccount"); if (sender && event.target.value) sender.value = event.target.value; }
});
main.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.matches("form[data-form]")) return;
  event.preventDefault();
  if (form.dataset.form === "project") {
    const values = new FormData(form);
    const project = { id: makeId(), organization: String(values.get("organization")).trim(), name: String(values.get("name")).trim(), accountType: String(values.get("accountType")), baseAccount: String(values.get("baseAccount")).trim(), payers: [], createdAt: new Date().toISOString() };
    if (normalizeAccount(project.baseAccount).length < 4) { notify("Enter a full receiving account number."); return; }
    state.projects.unshift(project); state.activeProjectId = project.id; saveState(); notify("Organization project created."); openView("payers");
  } else if (form.dataset.form === "payer") {
    const project = projectById(form.dataset.project);
    const values = new FormData(form);
    const name = String(values.get("name")).trim();
    const accountNumber = String(values.get("accountNumber")).trim();
    if (!project || normalizeAccount(accountNumber).length < 4) { notify("Enter a valid full payer account number."); return; }
    if (project.payers.some((payer) => normalizeAccount(payer.accountNumber) === normalizeAccount(accountNumber))) { notify("That payer account is already registered to this project."); return; }
    project.payers.push({ id: makeId(), name, accountNumber, createdAt: new Date().toISOString() });
    state.activeProjectId = project.id; saveState(); render(); notify("Payer account added to the project.");
  } else if (form.dataset.form === "verify") {
    await submitVerification(form);
  }
});
main.addEventListener("reset", (event) => {
  if (event.target.id === "verifyForm") { selectedFiles = []; setTimeout(render, 0); }
});

const savedSecret = currentSecret();
if (savedSecret) document.querySelector(".connection-menu summary").setAttribute("title", "Verification key is available for this tab session");
render();
if (savedSecret) connectWorkspace(false);
checkHealth();
