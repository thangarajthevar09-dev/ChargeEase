let allStations = [];

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("adminSearch")?.addEventListener("input", renderStations);
  document.getElementById("statusFilter")?.addEventListener("change", renderStations);
  try {
    const session = await currentSession();
    if (!session.user || session.user.role !== "ADMIN") return location.href = "/login.html";
    setText("adminName", session.user.name);
    setText("avatar", initials(session.user.name, "A"));
    await loadAll();
  } catch (error) { toast(error.message, "error"); }
});

async function loadAll() { await Promise.all([loadStats(), loadStations(), loadAIOverview(), loadComplaints(), loadAudit()]); }

async function loadStats() {
  const stats = await api("/api/admin/stats");
  const cards = [
    ["users", "Users", "◉"], ["owners", "Owners", "⌂"], ["pending", "Pending review", "◷"],
    ["approved", "Approved stations", "✓"], ["chargers", "Chargers", "⚡"], ["reservations", "Reservations", "◌"], ["revenue", "Simulated revenue", "₹"]
  ];
  document.getElementById("stats").innerHTML = cards.map(([key, label, icon]) => `<div class="metric-card"><span class="metric-icon">${icon}</span><small>${label}</small><b>${key === "revenue" ? money(stats[key]) : stats[key] ?? 0}</b></div>`).join("");
}

async function loadStations() { allStations = await api("/api/admin/stations"); renderStations(); }
function renderStations() {
  const query = String(document.getElementById("adminSearch")?.value || "").toLowerCase();
  const filter = document.getElementById("statusFilter")?.value || "all";
  const rows = allStations.filter(station => (filter === "all" || station.status === filter) && (!query || `${station.name} ${station.owner_name} ${station.owner_email} ${station.address}`.toLowerCase().includes(query)));
  document.getElementById("adminStations").innerHTML = rows.length ? rows.map(station => `<article class="admin-item"><div><div class="station-meta"><h3>${esc(station.name)}</h3><span class="status ${statusClass(station.status)}">${esc(station.status.replace("_", " "))}</span></div><p>Owner: ${esc(station.owner_name)} · ${esc(station.owner_email)}</p><p>${esc(station.address)} · ${station.total_chargers || 0} chargers · ${station.available_chargers || 0} available</p></div><button class="btn btn-primary btn-sm" onclick="reviewStation(${station.id})">Review</button></article>`).join("") : `<div class="empty">No stations match the filters.</div>`;
}

async function reviewStation(id) {
  try {
    const data = await api(`/api/admin/stations/${id}`);
    const station = data.station;
    const panel = document.getElementById("review");
    panel.hidden = false;
    panel.innerHTML = `<div class="panel-head"><div><span class="eyebrow">STATION REVIEW #${station.id}</span><h2>${esc(station.name)}</h2><p>Submitted by ${esc(station.owner_name)} · ${esc(station.owner_email)}</p></div><button class="close" onclick="document.getElementById('review').hidden=true">×</button></div><div class="review-grid"><div class="review-box"><h3>Station information</h3><p><b>Business:</b> ${esc(station.govt_name)}</p><p><b>Address:</b> ${esc(station.address)}, ${esc(station.city)}, ${esc(station.state)} ${esc(station.pincode || "")}</p><p><b>Hours:</b> ${esc(station.operating_hours || "Not provided")}</p><p><b>Contact:</b> ${esc(station.contact_number || "Not provided")}</p><p><b>Coordinates:</b> ${station.latitude}, ${station.longitude}</p>${station.station_photo ? `<img class="photo" src="${station.station_photo}" alt="Station">` : ""}</div><div class="review-box"><h3>Chargers</h3>${data.chargers.map(charger => `<div class="owner-station"><b>${esc(charger.charger_name)}</b><span class="status ${statusClass(charger.status)}">${esc(charger.status)}</span><p>${esc(charger.connector_type)} · ${charger.current_type} · ${charger.power_kw} kW · ${money(charger.price_per_kwh)}/kWh</p></div>`).join("")}</div></div><div class="review-box"><h3>Documents</h3>${data.documents.length ? data.documents.map(doc => `<a class="doc-link" href="${doc.file_path}" target="_blank" rel="noopener">↗ ${esc(doc.document_type)}</a>`).join("") : `<div class="empty">No documents uploaded.</div>`}</div><div class="review-actions"><textarea id="remarks" rows="3" placeholder="Optional remarks for the owner"></textarea><button class="btn btn-success" onclick="reviewAction(${id},'APPROVE')">✓ Approve</button><button class="btn btn-danger" onclick="reviewAction(${id},'REJECT')">Reject</button><button class="btn btn-light" onclick="reviewAction(${id},'CHANGES')">Request changes</button></div>`;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { toast(error.message, "error"); }
}

async function reviewAction(id, action) {
  try {
    const remarks = document.getElementById("remarks")?.value || "";
    await api(`/api/admin/stations/${id}/review`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, remarks }) });
    toast("Station review saved.");
    document.getElementById("review").hidden = true;
    await loadStations(); await loadStats();
  } catch (error) { toast(error.message, "error"); }
}

async function loadAIOverview() {
  try {
    const rows = await api("/api/admin/ai/overview");
    document.getElementById("aiOverview").innerHTML = rows.length ? rows.map(row => `<article class="ai-owner-card"><div class="station-meta"><h3>${esc(row.stationName)}</h3><span class="demand ${row.demandLevel.toLowerCase()}">${esc(row.demandLevel)} demand</span></div><div class="ai-stat-grid"><div><small>Demand</small><b>${row.demandScore}</b></div><div><small>Queue</small><b>${row.queueCount}</b></div><div><small>Wait</small><b>${row.predictedWaitMinutes}m</b></div><div><small>Chargers</small><b>${row.availableChargers}/${row.totalChargers}</b></div></div></article>`).join("") : `<div class="empty">No approved stations yet.</div>`;
  } catch (error) { document.getElementById("aiOverview").innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
}

async function loadComplaints() {
  try {
    const rows = await api("/api/admin/complaints");
    document.getElementById("adminComplaints").innerHTML = rows.length ? rows.map(row => `<article class="complaint-item"><div class="station-meta"><b>${esc(row.subject)}</b><span class="status ${statusClass(row.status)}">${esc(row.status)}</span></div><p>${esc(row.description)}</p><small>${esc(row.user_name)} · ${esc(row.user_email)}${row.station_name ? ` · ${esc(row.station_name)}` : ""}</small><div class="inline-actions"><select id="complaint-status-${row.id}"><option ${row.status === "OPEN" ? "selected" : ""}>OPEN</option><option ${row.status === "IN_PROGRESS" ? "selected" : ""}>IN_PROGRESS</option><option ${row.status === "RESOLVED" ? "selected" : ""}>RESOLVED</option><option ${row.status === "CLOSED" ? "selected" : ""}>CLOSED</option></select><button class="btn btn-light btn-sm" onclick="updateComplaint(${row.id})">Save</button></div></article>`).join("") : `<div class="empty">No complaints.</div>`;
  } catch (error) { toast(error.message, "error"); }
}
async function updateComplaint(id) { try { const status = document.getElementById(`complaint-status-${id}`).value; await api(`/api/admin/complaints/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, response: `Status updated to ${status}.` }) }); toast("Complaint updated."); await loadComplaints(); } catch (error) { toast(error.message, "error"); } }

async function loadAudit() {
  try {
    const rows = await api("/api/admin/audit");
    document.getElementById("audit").innerHTML = rows.map(row => `<div class="audit-item"><b>${esc(row.action)}</b><p>${esc(row.user_name || "System")} · ${esc(row.entity_type || "")}${row.entity_id ? ` #${row.entity_id}` : ""}</p><small>${dateTime(row.created_at)}</small></div>`).join("") || `<div class="empty">No audit activity yet.</div>`;
  } catch (error) { toast(error.message, "error"); }
}
