let homeMap;
let homeMarkers = [];
let homeStations = [];
const defaultCenter = [19.0330, 73.0297];

document.addEventListener("DOMContentLoaded", async () => {
  if (typeof L !== "undefined") {
    homeMap = L.map("map").setView(defaultCenter, 12.5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors"
    }).addTo(homeMap);

    const hero = document.getElementById("heroMap");
    if (hero) {
      const heroMap = L.map("heroMap", { zoomControl: false, attributionControl: false }).setView(defaultCenter, 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(heroMap);
    }
  }

  const search = document.getElementById("stationSearch");
  const filter = document.getElementById("availabilityFilter");
  if (search) search.addEventListener("input", renderStations);
  if (filter) filter.addEventListener("change", renderStations);

  await loadStations();
});

async function loadStations() {
  try {
    homeStations = await api("/api/stations");
    setText("heroCount", homeStations.length);
    renderStations();
  } catch (error) {
    const list = document.getElementById("stationsList");
    if (list) list.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function renderStations() {
  const search = String(document.getElementById("stationSearch")?.value || "").toLowerCase();
  const onlyAvailable = document.getElementById("availabilityFilter")?.value === "available";
  const rows = homeStations.filter(station => {
    const text = `${station.name} ${station.address} ${station.city} ${station.state}`.toLowerCase();
    return (!search || text.includes(search)) && (!onlyAvailable || Number(station.available_chargers) > 0);
  });

  homeMarkers.forEach(marker => homeMap?.removeLayer(marker));
  homeMarkers = [];

  rows.forEach(station => {
    if (!homeMap) return;
    const isAvailable = Number(station.available_chargers || 0) > 0;
    const icon = typeof createCustomMarkerIcon === "function" ? createCustomMarkerIcon(isAvailable) : undefined;
    const marker = L.marker([station.latitude, station.longitude], icon ? { icon } : {}).addTo(homeMap);
    marker.bindPopup(`
      <b>${esc(station.name)}</b><br>
      <span style="color:var(--muted)">${esc(station.address)}</span><br>
      <span style="font-weight:700; color:${isAvailable ? '#059669' : '#d97706'}">
        ${station.available_chargers || 0}/${station.total_chargers || 0} chargers available
      </span>
    `);
    homeMarkers.push(marker);
  });

  const list = document.getElementById("stationsList");
  if (!list) return;

  list.innerHTML = rows.length ? rows.map(station => `
    <article class="station-item" onclick="focusHomeStation(${station.id})">
      <div>
        <div class="station-meta">
          <h3>${esc(station.name)}</h3>
          <span class="status APPROVED">VERIFIED</span>
        </div>
        <p>${esc(station.address)}, ${esc(station.city)}</p>
        <div class="tag-row">
          <span class="availability ${Number(station.available_chargers) ? "available" : "busy"}">${station.available_chargers || 0}/${station.total_chargers || 0} available</span>
          <span class="rating">★ ${Number(station.rating_average || 0).toFixed(1)}</span>
          <span class="price">From ${money(station.starting_price)}/kWh</span>
        </div>
      </div>
    </article>
  `).join("") : `<div class="empty">No matching stations.</div>`;
}

function focusHomeStation(id) {
  const station = homeStations.find(item => Number(item.id) === Number(id));
  if (station && homeMap) homeMap.setView([station.latitude, station.longitude], 16);
}
