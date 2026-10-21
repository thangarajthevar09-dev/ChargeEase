async function loadOwnerEmergencies() {
  const container = document.getElementById("ownerEmergencies");
  if (!container) return;
  try {
    const rows = await api("/api/owner/emergencies");
    container.innerHTML = rows.length ? rows.map(item => `
      <article class="emergency-request">
        <div class="section-inline">
          <b>🆘 SOS #${item.id} · ${esc(item.user_name || "Driver")}</b>
          <span class="status ${item.status === "OPEN" ? "PENDING" : "APPROVED"}">${esc(item.status)}</span>
        </div>
        <p>${esc(item.message || "Roadside charging assistance requested.")}</p>
        <small>Phone: ${esc(item.user_mobile || "Not provided")} · ${dateTime(item.created_at)}</small>
        ${item.location_text ? `<p>${esc(item.location_text)}</p>` : ""}
        ${item.latitude != null && item.longitude != null ? `<p><a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${Number(item.latitude)},${Number(item.longitude)}">📍 Open driver's location in Maps</a></p>` : ""}
        <div class="station-actions">
          ${item.status === "OPEN" ? `<button class="btn btn-primary btn-sm" onclick="respondToEmergency(${item.id}, 'ACCEPT')">Accept SOS</button>` : ""}
          <button class="btn btn-light btn-sm" onclick="respondToEmergency(${item.id}, 'RESOLVE')">Mark resolved</button>
        </div>
      </article>
    `).join("") : `<div class="empty">No open SOS requests. New requests will appear here.</div>`;
  } catch (error) {
    container.innerHTML = `<div class="empty">Could not load SOS requests. ${esc(error.message || "")}</div>`;
  }
}

async function respondToEmergency(id, action) {
  const promptText = action === "ACCEPT"
    ? "Accept this SOS? You should contact the driver promptly."
    : "Mark this SOS as resolved?";
  if (!confirm(promptText)) return;
  try {
    const result = await api(`/api/owner/emergencies/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    toast(result.message || "SOS updated.");
    await loadOwnerEmergencies();
  } catch (error) {
    toast(error.message || "Could not update SOS.", "error");
  }
}

let ownerMap;
let ownerMarker;
let chargerCount = 0;
let ownerStations = [];

document.addEventListener("DOMContentLoaded", async () => {
  ownerMap = createMap("ownerMap", [19.0330, 73.0297], 12);
  if (ownerMap) ownerMap.on("click", event => setCoordinates(event.latlng.lat, event.latlng.lng));
  addCharger();
  try {
    const session = await currentSession();
    if (!session.user || session.user.role !== "STATION_OWNER") return location.href = "/login.html";
    setText("ownerName", session.user.name);
    setText("avatar", initials(session.user.name, "O"));
    await loadOwner();
    await loadOwnerEmergencies();
    setInterval(loadOwnerEmergencies, 30000);
    await loadQueue();
    await loadAnalytics();
    await loadOwnerAI();
  } catch (error) { toast(error.message, "error"); }
});

function scrollToForm() {
  const panel = document.getElementById("stationFormPanel");
  const btn = document.getElementById("addStationBtn");
  if (!panel) return;

  if (panel.style.display === "none") {
    panel.style.display = "block";
    if (btn) btn.textContent = "✕ Close form";
    setTimeout(() => {
      panel.scrollIntoView({ behavior: "smooth" });
      if (ownerMap) ownerMap.invalidateSize();
    }, 120);
  } else {
    if (ownerStations.length > 0) {
      panel.style.display = "none";
      if (btn) btn.textContent = "+ Register station";
    } else {
      panel.scrollIntoView({ behavior: "smooth" });
      if (ownerMap) ownerMap.invalidateSize();
    }
  }
}

function setCoordinates(lat, lng) {
  document.getElementById("lat").value = Number(lat).toFixed(7);
  document.getElementById("lng").value = Number(lng).toFixed(7);
  if (!ownerMarker) {
    ownerMarker = L.marker([lat, lng], { draggable: true }).addTo(ownerMap);
    ownerMarker.on("dragend", event => {
      const point = event.target.getLatLng();
      setCoordinates(point.lat, point.lng);
    });
  } else {
    ownerMarker.setLatLng([lat, lng]);
  }
}

async function searchPlace() {
  const input = document.getElementById("placeSearch");
  const query = input?.value.trim();
  if (!query) return toast("Enter an address, landmark or area to search.", "error");
  if (!ownerMap) return toast("The map is still loading. Please try again.", "error");

  const button = document.getElementById("searchPlaceButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Searching…";
  }

  try {
    const rows = await api(`/api/geocode?q=${encodeURIComponent(query)}`);

    if (!rows.length) {
      return toast("Location not found. Try adding city and state, for example: Nerul, Navi Mumbai, Maharashtra.", "error");
    }

    const first = rows[0];
    const lat = Number(first.latitude);
    const lng = Number(first.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return toast("The location service returned invalid coordinates.", "error");
    }

    ownerMap.setView([lat, lng], 16, { animate: true });
    setCoordinates(lat, lng);
    input.value = first.displayName || query;
    toast("Location found and selected.");
  } catch (error) {
    toast(error.message || "Location search failed. You can click the map instead.", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Search";
    }
  }
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    return toast("Your browser does not support location access. Click the map instead.", "error");
  }
  if (!ownerMap) return toast("The map is still loading. Please try again.", "error");

  toast("Requesting your current location…");
  navigator.geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude } = position.coords;
      ownerMap.setView([latitude, longitude], 17, { animate: true });
      setCoordinates(latitude, longitude);
      toast("Current location selected.");
    },
    error => {
      const message = error.code === error.PERMISSION_DENIED
        ? "Location permission was denied. You can search the address or click the map."
        : "Could not get your current location. Search the address or click the map.";
      toast(message, "error");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function addCharger() {
  const index = chargerCount++;
  const node = document.createElement("div");
  node.className = "charger-card form-section-card";
  node.dataset.index = index;
  node.innerHTML = `
    <div class="section-inline">
      <h4>Charger ${index + 1}</h4>
      <button type="button" class="btn btn-danger btn-sm" onclick="removeCharger(this)">Remove</button>
    </div>
    <div class="form-row">
      <label>Name<input data-k="name" value="Charger ${index + 1}"></label>
      <label>Connector<select data-k="connector"><option>CCS2</option><option>Type 2</option><option>CHAdeMO</option><option>GB/T</option></select></label>
    </div>
    <div class="form-row three">
      <label>Current type<select data-k="currentType"><option>DC</option><option>AC</option></select></label>
      <label>Power kW<input data-k="powerKw" type="number" min="1" step="0.1" value="60"></label>
      <label>Price ₹/kWh<input data-k="price" type="number" min="0" step="0.01" value="18"></label>
    </div>
    <div class="form-row">
      <label>Speed category<select data-k="speed"><option>Fast</option><option>Standard</option><option>Ultra Fast</option></select></label>
      <label>Photo<input type="file" accept="image/*"></label>
    </div>
  `;
  document.getElementById("chargers").appendChild(node);
}

function removeCharger(button) {
  button.closest(".charger-card")?.remove();
}

async function submitStation(event) {
  event.preventDefault();
  const msg = document.getElementById("msg");
  msg.className = "form-msg";
  msg.textContent = "Submitting station for verification…";
  const cards = [...document.querySelectorAll(".charger-card")];
  if (!cards.length) return toast("Add at least one charger.", "error");
  if (!document.getElementById("lat").value || !document.getElementById("lng").value) return toast("Select a station location on the map.", "error");

  cards.forEach((card, index) => {
    const file = card.querySelector('input[type="file"]');
    if (file) file.name = `chargerPhoto${index}`;
  });

  const formData = new FormData(event.target);
  const chargers = cards.map(card => {
    const result = {};
    card.querySelectorAll("[data-k]").forEach(input => result[input.dataset.k] = input.value);
    return result;
  });
  formData.append("chargersJson", JSON.stringify(chargers));

  try {
    const data = await api("/api/owner/stations", { method: "POST", body: formData });
    msg.className = "form-msg success";
    msg.textContent = data.message;
    event.target.reset();
    document.getElementById("chargers").innerHTML = "";
    chargerCount = 0;
    addCharger();
    document.getElementById("lat").value = "";
    document.getElementById("lng").value = "";
    if (ownerMarker) { ownerMarker.remove(); ownerMarker = null; }

    toast("Station submitted! Awaiting admin verification.", "success");

    // Automatically collapse registration form
    const formPanel = document.getElementById("stationFormPanel");
    if (formPanel) formPanel.style.display = "none";
    const addBtn = document.getElementById("addStationBtn");
    if (addBtn) addBtn.textContent = "+ Register station";

    await loadOwner();
    await loadOwnerAI();
  } catch (error) {
    msg.className = "form-msg error";
    msg.textContent = error.message;
  }
}

document.getElementById("stationForm")?.addEventListener("submit", submitStation);

async function loadOwner() {
  try {
    ownerStations = await api("/api/owner/stations");
    setText("stationCount", ownerStations.length);
    setText("chargerCount", ownerStations.reduce((sum, station) => sum + Number(station.total_chargers || 0), 0));
    setText("ownerAvailable", ownerStations.reduce((sum, station) => sum + Number(station.available_chargers || 0), 0));
    setText("ownerQueueCount", ownerStations.reduce((sum, station) => sum + Number(station.queue_count || 0), 0));

    const approvedStations = ownerStations.filter(s => s.status === "APPROVED");
    const pendingStations = ownerStations.filter(s => s.status !== "APPROVED");
    const formPanel = document.getElementById("stationFormPanel");
    const addBtn = document.getElementById("addStationBtn");
    const noticeContainer = document.getElementById("statusNoticeContainer");

    // 1. Manage Registration Form Visibility & Notice Banners based on user state
    if (ownerStations.length === 0) {
      // First time sign-up: Owner has no stations yet. Next step is registering their first EV station!
      if (formPanel) formPanel.style.display = "block";
      if (addBtn) addBtn.textContent = "+ Register station";
      if (noticeContainer) {
        noticeContainer.innerHTML = `
          <div class="panel notice-panel" style="border-left-color:var(--primary); margin-bottom:20px;">
            <div class="panel-head">
              <div>
                <span class="eyebrow">STEP 1: GET STARTED</span>
                <h2>Welcome to ChargeEase Partner Portal!</h2>
                <p>Register your EV charging station below to join the public network.</p>
              </div>
              <span class="step-pill">ONBOARDING</span>
            </div>
            <p style="margin:0; font-size:13px; color:var(--text);">
              Please fill out your station location, business details, verification documents, and charger specs below. Once submitted, our platform admin will verify and approve your station to go live.
            </p>
          </div>
        `;
      }
      renderPumpsView([]);
    } else if (approvedStations.length === 0) {
      // Station is registered, but pending admin approval
      if (formPanel) formPanel.style.display = "none";
      if (addBtn) addBtn.textContent = "+ Register another station";
      renderPendingNotice(pendingStations);
      renderPumpsView([]);
    } else {
      // Station is APPROVED! Owner can manage live pumps and chargers
      if (formPanel) formPanel.style.display = "none";
      if (addBtn) addBtn.textContent = "+ Register station";
      if (pendingStations.length > 0) {
        renderPendingNotice(pendingStations);
      } else if (noticeContainer) {
        noticeContainer.innerHTML = "";
      }
      await renderPumpsView(approvedStations);
    }

    renderSidebarStations(ownerStations);
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderPendingNotice(pendingStations) {
  const container = document.getElementById("statusNoticeContainer");
  if (!container) return;
  container.innerHTML = `
    <div class="panel notice-panel" style="margin-bottom:20px;">
      <div class="panel-head">
        <div>
          <span class="eyebrow">VERIFICATION IN PROGRESS</span>
          <h2>Station under administrative review</h2>
          <p>Your station has been submitted and is in the verification pipeline.</p>
        </div>
        <span class="status PENDING">⏳ PENDING APPROVAL</span>
      </div>
      <div class="pending-stations-list">
        ${pendingStations.map(station => `
          <div class="pending-station-item">
            <div class="station-meta">
              <h3 style="font-size:17px;">${esc(station.name)}</h3>
              <span class="status ${statusClass(station.status)}">${esc(station.status.replace("_", " "))}</span>
            </div>
            <p style="margin:4px 0 8px; color:var(--muted); font-size:13px;">${esc(station.address)}, ${esc(station.city)}, ${esc(station.state)} ${esc(station.pincode || "")}</p>
            <div class="tag-row">
              <span>⚡ ${station.total_chargers || 0} chargers configured</span>
              <span>📞 ${esc(station.contact_number || "Contact not listed")}</span>
              <span>🕒 Submitted: ${dateTime(station.created_at)}</span>
            </div>
            <div class="verification-step-box">
              <div class="step-indicator">
                <span class="step-done">✓ 1. Registered</span>
                <span class="step-current">⏳ 2. Admin Verifying Documents</span>
                <span class="step-upcoming">○ 3. Go Live & Manage Pumps</span>
              </div>
              <p style="margin:10px 0 0; font-size:12px; color:var(--muted); line-height:1.5;">
                Our platform admin is reviewing your business registration and technical charger safety documents. 
                <b>Once approved by the admin, your station will go live on the driver map and you can control live pumps right here.</b>
              </p>
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

async function renderPumpsView(approvedStations) {
  const container = document.getElementById("approvedChargersList");
  if (!container) return;

  if (!approvedStations.length) {
    if (ownerStations.length === 0) {
      container.innerHTML = `
        <div class="empty">
          <p style="margin:0 0 4px; font-weight:700;">No active pumps yet</p>
          <small style="color:var(--muted);">Complete station registration below. Once approved by admin, you will manage live chargers here.</small>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="empty">
          <p style="margin:0 0 4px; font-weight:700;">Charger Management Locks Until Admin Approval</p>
          <small style="color:var(--muted);">Your station is currently pending admin verification. Once verified, live pumps and status controls will unlock here.</small>
        </div>
      `;
    }
    return;
  }

  try {
    const stationDetails = await Promise.all(
      approvedStations.map(station => api(`/api/owner/stations/${station.id}`))
    );

    container.innerHTML = stationDetails.map(({ station, chargers }) => `
      <div class="approved-station-card">
        <div class="station-meta" style="margin-bottom:12px; justify-content:space-between;">
          <div>
            <h3 style="font-size:18px; margin:0 0 4px;">${esc(station.name)}</h3>
            <p style="margin:0; color:var(--muted); font-size:12px;">${esc(station.address)}, ${esc(station.city)} · ${esc(station.operating_hours || "24 Hours")}</p>
          </div>
          <span class="status APPROVED">✓ APPROVED & LIVE</span>
        </div>
        <div class="pumps-grid">
          ${chargers.map(charger => `
            <div class="pump-card">
              <div class="pump-card-header">
                <div class="pump-name-box">
                  <span class="pump-icon">⚡</span>
                  <b>${esc(charger.charger_name)}</b>
                </div>
                <span class="status ${statusClass(charger.status)}">${esc(charger.status)}</span>
              </div>
              <div class="pump-specs">
                <span>${esc(charger.connector_type)}</span>
                <span>${esc(charger.current_type)}</span>
                <span>${charger.power_kw} kW</span>
                <span style="font-weight:700; color:var(--text);">${money(charger.price_per_kwh)}/kWh</span>
              </div>
              <div class="last-used-details">
                <b>Last used by:</b> ${charger.last_used_user ? esc(charger.last_used_user) : "No completed sessions yet"}
                ${charger.last_used_at ? `<span> · ${dateTime(charger.last_used_at)}</span>` : ""}
              </div>
              <div class="pump-status-actions">
                <button class="btn btn-sm btn-success ${charger.status === 'AVAILABLE' ? 'active-status' : ''}" onclick="setStatus(${charger.id},'AVAILABLE')">
                  ✓ Available
                </button>
                <button class="btn btn-sm btn-light ${charger.status === 'OCCUPIED' ? 'active-status' : ''}" onclick="setStatus(${charger.id},'OCCUPIED')">
                  ● Occupied
                </button>
                <button class="btn btn-sm btn-danger ${charger.status === 'MAINTENANCE' ? 'active-status' : ''}" onclick="setStatus(${charger.id},'MAINTENANCE')">
                  ⚠ Maintenance
                </button>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `).join("");
  } catch (error) {
    container.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function renderSidebarStations(rows) {
  const container = document.getElementById("myStations");
  if (!container) return;
  container.innerHTML = rows.length ? rows.map(station => `
    <article class="owner-station">
      <div class="station-meta">
        <h3>${esc(station.name)}</h3>
        <span class="status ${statusClass(station.status)}">${esc(station.status.replace("_", " "))}</span>
      </div>
      <p>${esc(station.address)}</p>
      <div class="tag-row">
        <span>${station.available_chargers || 0}/${station.total_chargers || 0} available</span>
        <span>Queue ${station.queue_count || 0}</span>
      </div>
      <div class="owner-station-actions" style="margin-top:10px;">
        ${station.status === 'APPROVED' ? `<button class="btn btn-light btn-sm" onclick="viewOwnerStation(${station.id})">Manage chargers</button>` : `<span style="font-size:11px; color:var(--muted); font-style:italic;">Awaiting admin approval</span>`}
        <button class="btn btn-primary btn-sm" onclick="predictStation(${station.id})">AI demand</button>
      </div>
    </article>
  `).join("") : `<div class="empty">No stations registered yet.</div>`;
}

async function viewOwnerStation(id) {
  try {
    const data = await api(`/api/owner/stations/${id}`);
    document.getElementById("myStations").innerHTML = `
      <button class="btn btn-light btn-sm" onclick="loadOwner()" style="margin-bottom:10px;">← Back to all</button>
      <h3 class="subheading" style="margin:0 0 10px;">${esc(data.station.name)}</h3>
      ${data.chargers.map(charger => `
        <div class="owner-station">
          <div class="station-meta">
            <b>${esc(charger.charger_name)}</b>
            <span class="status ${statusClass(charger.status)}">${esc(charger.status)}</span>
          </div>
          <p>${esc(charger.connector_type)} · ${charger.current_type} · ${charger.power_kw} kW · ${money(charger.price_per_kwh)}/kWh</p>
          <div class="owner-station-actions" style="margin-top:8px;">
            <button class="btn btn-success btn-sm" onclick="setStatus(${charger.id},'AVAILABLE')">Available</button>
            <button class="btn btn-light btn-sm" onclick="setStatus(${charger.id},'OCCUPIED')">Occupied</button>
            <button class="btn btn-danger btn-sm" onclick="setStatus(${charger.id},'MAINTENANCE')">Maintenance</button>
          </div>
        </div>
      `).join("")}
    `;
    renderMaintenance(data.maintenance);
  } catch (error) { toast(error.message, "error"); }
}

async function setStatus(id, status) {
  try {
    await api(`/api/owner/chargers/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    toast(`Charger status updated to ${status}.`, "success");
    await loadOwner();
    await loadOwnerAI();
  } catch (error) { toast(error.message, "error"); }
}

async function loadQueue() {
  try {
    const rows = await api("/api/owner/queue");
    document.getElementById("ownerQueue").innerHTML = rows.length ? rows.map(row => `
      <div class="queue-item">
        <div class="queue-number">#${row.queue_number}</div>
        <div>
          <b>${esc(row.user_name)}</b>
          <p>${esc(row.station_name)} · ${esc(row.vehicle_model || "No vehicle")}</p>
          <span style="font-size:11px; color:var(--muted);">${row.estimated_wait_minutes || 0} min estimated wait</span>
          <div class="inline-actions" style="margin-top:8px;">
            <button class="btn btn-primary btn-sm" onclick="updateQueue(${row.id},'SERVING')">Serve</button>
            <button class="btn btn-success btn-sm" onclick="updateQueue(${row.id},'SERVED')">Done</button>
            <button class="btn btn-light btn-sm" onclick="updateQueue(${row.id},'CANCELLED')">Cancel</button>
          </div>
        </div>
      </div>
    `).join("") : `<div class="empty">Queue is clear.</div>`;
  } catch (error) {
    document.getElementById("ownerQueue").innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function updateQueue(id, status) {
  try {
    await api(`/api/owner/queue/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    toast("Queue updated.", "success");
    await loadQueue();
  } catch (error) { toast(error.message, "error"); }
}

async function loadAnalytics() {
  try {
    const data = await api("/api/owner/analytics");
    setText("analyticsReservations", data.summary.reservations || 0);
    setText("analyticsCompleted", data.summary.completed || 0);
    setText("analyticsRevenue", money(data.summary.revenue));
    setText("analyticsDuration", `${Math.round(Number(data.summary.avg_duration || 0))} min`);
    const chart = document.getElementById("analyticsChart");
    chart.innerHTML = data.daily.map(row => `
      <div class="bar-row">
        <span>${String(row.day).slice(5)}</span>
        <div class="bar"><i style="width:${Math.min(100, Number(row.bookings) * 12)}%"></i></div>
        <b>${row.bookings}</b>
      </div>
    `).join("") || `<div class="empty">No booking history yet.</div>`;
  } catch (error) { toast(error.message, "error"); }
}

async function loadOwnerAI() {
  try {
    const rows = await Promise.all(ownerStations.map(async station => {
      const [demand, queue] = await Promise.all([
        api(`/api/ai/station/${station.id}/demand`),
        api(`/api/ai/station/${station.id}/queue`)
      ]);
      return { station, demand, queue };
    }));
    document.getElementById("ownerAi").innerHTML = rows.map(row => `
      <article class="ai-owner-card">
        <div class="station-meta">
          <h3>${esc(row.station.name)}</h3>
          <span class="demand ${row.demand.demand_level?.toLowerCase()}">${esc(row.demand.demand_level || "—")} demand</span>
        </div>
        <div class="ai-stat-grid">
          <div><small>Demand score</small><b>${row.demand.demand_score ?? "—"}</b></div>
          <div><small>Queue</small><b>${row.queue.predicted_queue_length}</b></div>
          <div><small>Wait</small><b>${row.queue.estimated_wait_minutes} min</b></div>
          <div><small>Available</small><b>${row.station.available_chargers}/${row.station.total_chargers}</b></div>
        </div>
      </article>
    `).join("") || `<div class="empty">Register an approved station to see AI predictions.</div>`;
  } catch (error) {
    document.getElementById("ownerAi").innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function predictStation(id) {
  try {
    const data = await api(`/api/ai/station/${id}/demand`);
    toast(`Predicted demand: ${data.demand_level} (${data.demand_score})`);
  } catch (error) { toast(error.message, "error"); }
}

function renderMaintenance(rows = []) {
  document.getElementById("maintenance").innerHTML = rows.length ? rows.slice(0, 8).map(row => `
    <div class="maintenance-item">
      <div class="station-meta">
        <b>${esc(row.charger_name)}</b>
        <span class="status ${statusClass(row.status)}">${esc(row.status)}</span>
      </div>
      <p>${esc(row.issue_title)}</p>
      <small>${esc(row.issue_description || "")}</small>
    </div>
  `).join("") : `<div class="empty">No maintenance issues.</div>`;
}
