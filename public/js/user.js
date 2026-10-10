let userMap;
let userStations = [];
let userVehicles = [];
let userReservations = [];
let userQueue = [];
let userMarkers = [];
const mapCenter = [19.0330, 73.0297];

document.addEventListener("DOMContentLoaded", async () => {
  userMap = createMap("map", mapCenter, 12.5);
  ["stationSearch", "availabilityFilter", "connectorFilter", "powerFilter"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", renderStations);
    document.getElementById(id)?.addEventListener("change", renderStations);
  });
  try {
    const session = await currentSession();
    if (!session.user || session.user.role !== "USER") return location.href = "/login.html";
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    setText("greetingText", greeting);
    setText("userName", session.user.name?.split(" ")[0] || "there");
    setText("welcomeUser", session.user.email);
    setText("avatar", initials(session.user.name));
    await loadDashboard();
    await loadVehicles();
    await loadNotifications();
    await loadComplaints();
    await loadRecommendations();
  } catch (error) {
    if (error.status === 401 || error.status === 403) location.href = "/login.html";
    else toast(error.message, "error");
  }
});

async function loadDashboard() {
  try {
    userStations = await api("/api/stations");
    renderStations();
    setText("availableCount", userStations.reduce((sum, station) => sum + Number(station.available_chargers || 0), 0));
    await Promise.all([loadReservations(), loadQueue(), loadPayments()]);
  } catch (error) {
    toast(error.message, "error");
  }
}

function filteredStations() {
  const search = String(document.getElementById("stationSearch")?.value || "").toLowerCase();
  const availability = document.getElementById("availabilityFilter")?.value;
  const connector = document.getElementById("connectorFilter")?.value;
  const power = Number(document.getElementById("powerFilter")?.value || 0);
  return userStations.filter(station => {
    const text = `${station.name} ${station.address} ${station.city} ${station.state}`.toLowerCase();
    const matchesSearch = !search || text.includes(search);
    const matchesAvailability = availability !== "available" || Number(station.available_chargers) > 0;
    const connectorText = String(station.connector_types || "").toLowerCase();
    const matchesConnector = !connector || connectorText.split(",").map(value => value.trim()).includes(connector.toLowerCase());
    const matchesPower = !power || Number(station.max_power_kw || 0) >= power;
    return matchesSearch && matchesAvailability && matchesConnector && matchesPower;
  });
}

function renderStations() {
  const rows = filteredStations();

  userMarkers.forEach(marker => userMap?.removeLayer(marker));
  userMarkers = [];
  rows.forEach(station => {
    if (!userMap) return;
    const isAvailable = Number(station.available_chargers || 0) > 0;
    const icon = typeof createCustomMarkerIcon === "function" ? createCustomMarkerIcon(isAvailable) : undefined;
    const marker = L.marker([station.latitude, station.longitude], icon ? { icon } : {}).addTo(userMap);
    marker.bindPopup(`<b>${esc(station.name)}</b><br><span style="color:var(--muted)">${esc(station.address)}</span><br><b style="color:${isAvailable ? '#059669' : '#d97706'}">${station.available_chargers || 0} chargers available</b>`);
    marker.on("click", () => focusStation(station.id));
    userMarkers.push(marker);
  });

  const container = document.getElementById("stations");
  container.innerHTML = rows.length ? rows.map(station => `
    <article class="station-item rich-station">
      <div class="station-main" onclick="focusStation(${station.id})">
        <div class="station-meta"><h3>${esc(station.name)}</h3><span class="status APPROVED">VERIFIED</span></div>
        <p>${esc(station.address)}, ${esc(station.city)}</p>
        <div class="tag-row">
          <span class="availability ${Number(station.available_chargers) ? "available" : "busy"}">${station.available_chargers || 0}/${station.total_chargers || 0} available</span>
          <span class="rating">★ ${Number(station.rating_average || 0).toFixed(1)} (${station.rating_count || 0})</span>
          <span class="price">From ${money(station.starting_price)}/kWh</span>
        </div>
      </div>
      <div class="station-actions">
        <button class="btn btn-primary btn-sm" onclick="openStation(${station.id})">View & reserve</button>
        <button class="btn btn-light btn-sm" onclick="joinQueue(${station.id})">Join queue</button>
      </div>
    </article>
  `).join("") : `<div class="empty">No matching charging stations.</div>`;
}

function focusStation(id) {
  const station = userStations.find(item => Number(item.id) === Number(id));
  if (station && userMap) userMap.setView([station.latitude, station.longitude], 16);
}

async function openStation(id) {
  try {
    const data = await api(`/api/stations/${id}`);
    const station = data.station;
    const modal = showModal(`
      <div class="modal-card wide-modal">
        <div class="modal-head">
          <div><span class="eyebrow">VERIFIED STATION</span><h2>${esc(station.name)}</h2><p>${esc(station.address)}, ${esc(station.city)} · ${esc(station.operating_hours || "Hours not listed")}</p></div>
          <button class="close" onclick="closeModal()">×</button>
        </div>
        <div class="station-detail-grid">
          <div>
            <h3>Chargers</h3>
            <div class="charger-list">${data.chargers.map(charger => chargerCard(station.id, charger)).join("")}</div>
          </div>
          <div class="station-ai-box">
            <h3>AI queue prediction</h3>
            <div id="stationPrediction" class="prediction-card">Calculating…</div>
            <h3>Recent reviews</h3>
            <div class="review-list">${data.reviews.length ? data.reviews.map(review => `<div class="review-item"><b>${esc(review.user_name)} · ${"★".repeat(review.rating)}</b><p>${esc(review.review_text || "No written review")}</p></div>`).join("") : `<div class="empty">No reviews yet.</div>`}</div>
          </div>
        </div>
        <button class="btn btn-light btn-wide" onclick="joinQueue(${station.id})">♧ Join station queue</button>
      </div>
    `);
    const prediction = await api(`/api/ai/station/${station.id}/queue`);
    const box = modal.querySelector("#stationPrediction");
    if (box) box.innerHTML = `<strong>${prediction.estimated_wait_minutes} min</strong><span>Estimated wait · ${prediction.predicted_queue_length} waiting</span>`;
  } catch (error) {
    toast(error.message, "error");
  }
}

function chargerCard(stationId, charger) {
  const available = charger.status === "AVAILABLE";
  return `<div class="charger-option">
    <div class="charger-option-top"><b>${esc(charger.charger_name)}</b><span class="status ${statusClass(charger.status)}">${esc(charger.status)}</span></div>
    <p>${esc(charger.connector_type)} · ${esc(charger.current_type)} · ${charger.power_kw} kW · ${money(charger.price_per_kwh)}/kWh</p>
    ${available ? `<div class="reservation-form">
      <label>Vehicle<select id="vehicle-${charger.id}"><option value="">No vehicle</option>${userVehicles.map(v => `<option value="${v.id}">${esc(v.nickname || v.model)} · ${esc(v.connector_type)}</option>`).join("")}</select></label>
      <label>Start<input id="start-${charger.id}" type="datetime-local"></label>
      <label>End<input id="end-${charger.id}" type="datetime-local"></label>
      <button class="btn btn-primary btn-sm" onclick="reserve(${charger.id})">Reserve</button>
    </div>` : `<span class="field-help">This charger is ${charger.status.toLowerCase()}. Join the station queue if you need a place.</span>`}
  </div>`;
}

async function reserve(chargerId) {
  const start = document.getElementById(`start-${chargerId}`)?.value;
  const end = document.getElementById(`end-${chargerId}`)?.value;
  const vehicleId = document.getElementById(`vehicle-${chargerId}`)?.value || null;
  if (!start || !end) return toast("Select both start and end time.", "error");
  try {
    const data = await api("/api/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargerId, startTime: start, endTime: end, vehicleId })
    });
    closeModal();
    toast(`Reservation confirmed. Estimated charge time: ${data.estimatedMinutes} minutes.`);
    await loadDashboard();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadReservations() {
  try {
    userReservations = await api("/api/my/reservations");
    setText("reservationCount", userReservations.length);
    const container = document.getElementById("reservations");
    container.innerHTML = userReservations.length ? userReservations.slice(0, 10).map(row => `
      <div class="reservation-item">
        <div class="reservation-main"><b>${esc(row.station_name)}</b><p>${esc(row.charger_name)} · ${dateTime(row.start_time)} → ${dateTime(row.end_time)}</p></div>
        <div class="reservation-side"><span class="status ${statusClass(row.status)}">${esc(row.status)}</span><span>${money(row.estimated_cost)}</span></div>
        <div class="reservation-extra"><span>AI duration: ${row.estimated_minutes || "—"} min</span><span>Payment: ${esc(row.payment_status)}</span>${["CONFIRMED", "ACTIVE"].includes(row.status) ? `<button class="btn btn-light btn-sm" onclick="cancelReservation(${row.id})">Cancel</button>` : ""}${row.payment_status === "PENDING" ? `<button class="btn btn-primary btn-sm" onclick="simulatePayment(${row.id})">Simulate payment</button>` : ""}</div>
      </div>
    `).join("") : `<div class="empty">No reservations yet.</div>`;
  } catch (error) {
    toast(error.message, "error");
  }
}

async function cancelReservation(id) {
  if (!confirm("Cancel this reservation?")) return;
  try {
    await api(`/api/my/reservations/${id}`, { method: "DELETE" });
    toast("Reservation cancelled.");
    await loadDashboard();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function simulatePayment(id) {
  try {
    const data = await api("/api/payments/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId: id, method: "SIMULATED_UPI" })
    });
    toast(`Simulated payment successful: ${data.transactionRef}`);
    await loadDashboard();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadQueue() {
  try {
    userQueue = await api("/api/my/queue");
    setText("queueCount", userQueue.length ? userQueue.map(item => `#${item.queue_number}`).join(", ") : "—");
    const container = document.getElementById("queue");
    container.innerHTML = userQueue.length ? userQueue.map(item => `
      <div class="queue-item"><div class="queue-number">#${item.queue_number}</div><div><b>${esc(item.station_name)}</b><p>${item.estimated_wait_minutes || 0} min estimated wait · ${esc(item.status)}</p><button class="btn btn-light btn-sm" onclick="leaveQueue(${item.id})">Leave queue</button></div></div>
    `).join("") : `<div class="empty">You are not waiting at any station.</div>`;
  } catch (error) { toast(error.message, "error"); }
}

async function joinQueue(stationId) {
  const vehicleId = userVehicles.find(vehicle => vehicle.is_default)?.id || userVehicles[0]?.id || null;
  try {
    const data = await api("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stationId, vehicleId })
    });
    toast(`Joined queue at #${data.queueNumber}. Estimated wait: ${data.estimatedWaitMinutes} minutes.`);
    await loadQueue();
    await loadNotifications();
  } catch (error) { toast(error.message, "error"); }
}

async function leaveQueue(id) {
  try {
    await api(`/api/my/queue/${id}`, { method: "DELETE" });
    toast("Removed from queue.");
    await loadQueue();
  } catch (error) { toast(error.message, "error"); }
}

async function loadVehicles() {
  try {
    userVehicles = await api("/api/vehicles");
  } catch (error) { toast(error.message, "error"); }
}

function openVehicles() {
  const modal = showModal(`<div class="modal-card"><div class="modal-head"><div><span class="eyebrow">MY GARAGE</span><h2>Vehicles</h2><p>Vehicle data helps ChargeEase estimate charging time and compatibility.</p></div><button class="close" onclick="closeModal()">×</button></div><div id="vehicleList"></div><hr><form id="vehicleForm" class="form"><div class="form-row"><label>Nickname<input name="nickname" placeholder="My EV" required></label><label>Make<input name="make" placeholder="Tata / Hyundai / MG"></label></div><div class="form-row"><label>Model<input name="model" placeholder="Nexon EV" required></label><label>Battery capacity (kWh)<input name="batteryCapacityKwh" type="number" min="1" step="0.1" required></label></div><div class="form-row"><label>Connector<select name="connectorType"><option>CCS2</option><option>Type 2</option><option>CHAdeMO</option><option>GB/T</option></select></label><label>Current battery %<input name="currentBatteryPercent" type="number" min="0" max="99" value="20"></label></div><div class="form-row"><label>Target battery %<input name="targetBatteryPercent" type="number" min="1" max="100" value="80"></label><label class="check-label"><input name="isDefault" type="checkbox"> Default vehicle</label></div><button class="btn btn-primary btn-wide">Add vehicle</button></form></div>`);
  renderVehiclesInModal();
  modal.querySelector("#vehicleForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(event.target));
      payload.isDefault = event.target.isDefault.checked;
      await api("/api/vehicles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await loadVehicles();
      renderVehiclesInModal();
      toast("Vehicle added.");
      await loadRecommendations();
    } catch (error) { toast(error.message, "error"); }
  });
}

function renderVehiclesInModal() {
  const list = document.getElementById("vehicleList");
  if (!list) return;
  list.innerHTML = userVehicles.length ? `<div class="vehicle-list">${userVehicles.map(vehicle => `<div class="vehicle-item"><div><b>🚗 ${esc(vehicle.nickname)}</b><p>${esc(vehicle.make || "")} ${esc(vehicle.model)} · ${vehicle.battery_capacity_kwh} kWh · ${esc(vehicle.connector_type)}</p></div><button class="btn btn-danger btn-sm" onclick="deleteVehicle(${vehicle.id})">Remove</button></div>`).join("")}</div>` : `<div class="empty">No vehicles added yet.</div>`;
}

async function deleteVehicle(id) {
  if (!confirm("Remove this vehicle?")) return;
  try { await api(`/api/vehicles/${id}`, { method: "DELETE" }); await loadVehicles(); renderVehiclesInModal(); await loadRecommendations(); toast("Vehicle removed."); }
  catch (error) { toast(error.message, "error"); }
}

async function loadRecommendations() {
  const container = document.getElementById("recommendations");
  if (!container) return;
  try {
    const data = await api("/api/ai/recommendations");
    if (!data.recommendations.length) return container.innerHTML = `<div class="empty">No recommendations available right now.</div>`;
    container.innerHTML = data.recommendations.slice(0, 5).map(item => `<article class="recommendation-card"><div class="recommendation-score">${item.recommendationScore}<small>score</small></div><div class="recommendation-body"><div class="station-meta"><h3>${esc(item.stationName)}</h3><span class="status ${statusClass(item.availability)}">${esc(item.availability)}</span></div><p>${esc(item.chargerName)} · ${item.powerKw} kW · ${esc(item.connector)}</p><div class="tag-row"><span>Queue ${item.queueLength}</span><span>Wait ~${item.expectedWaitMinutes} min</span><span>Demand ${item.predictedDemand}</span><span>★ ${item.rating.toFixed(1)}</span></div><div class="recommendation-reasons">${item.reasons.map(reason => `<span>✓ ${esc(reason)}</span>`).join("")}</div><button class="btn btn-primary btn-sm" onclick="openStation(${item.stationId})">Open station</button></div></article>`).join("");
  } catch (error) { container.innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
}

async function loadPayments() {
  try { const rows = await api("/api/my/payments"); setText("paymentCount", rows.length); } catch (_) {}
}

async function loadNotifications() {
  try {
    const rows = await api("/api/my/notifications");
    const unread = rows.filter(row => !row.is_read).length;
    setText("notificationBadge", unread);
    const container = document.getElementById("notifications");
    container.innerHTML = rows.slice(0, 6).map(row => `<div class="notification-item ${row.is_read ? "read" : "unread"}" onclick="markNotification(${row.id})"><b>${esc(row.title)}</b><p>${esc(row.message)}</p><small>${dateTime(row.created_at)}</small></div>`).join("") || `<div class="empty">No notifications.</div>`;
  } catch (_) {}
}

function openNotifications() {
  document.getElementById("notifications")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function markNotification(id) {
  try { await api(`/api/my/notifications/${id}/read`, { method: "PATCH" }); await loadNotifications(); } catch (_) {}
}

async function loadComplaints() {
  try {
    const rows = await api("/api/my/complaints");
    document.getElementById("complaints").innerHTML = rows.slice(0, 4).map(row => `<div class="complaint-item"><b>${esc(row.subject)}</b><span class="status ${statusClass(row.status)}">${esc(row.status)}</span><p>${esc(row.description)}</p></div>`).join("") || `<div class="empty">No support requests.</div>`;
  } catch (_) {}
}

function openComplaint() {
  const modal = showModal(`<div class="modal-card"><div class="modal-head"><div><span class="eyebrow">SUPPORT</span><h2>New support request</h2><p>Tell us what happened.</p></div><button class="close" onclick="closeModal()">×</button></div><form id="complaintForm" class="form"><label>Subject<input name="subject" required placeholder="Charger was unavailable"></label><label>Priority<select name="priority"><option>LOW</option><option selected>MEDIUM</option><option>HIGH</option></select></label><label>Description<textarea name="description" rows="5" required placeholder="Describe the issue…"></textarea></label><button class="btn btn-primary btn-wide">Submit request</button></form></div>`);
  modal.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await api("/api/complaints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
      closeModal();
      toast("Support request submitted.");
      loadComplaints();
    } catch (error) { toast(error.message, "error"); }
  });
}
