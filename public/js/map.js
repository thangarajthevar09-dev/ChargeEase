let sharedMap;
let sharedMarkers = [];

function createCustomMarkerIcon(isAvailable) {
  if (typeof L === "undefined") return undefined;
  const color = isAvailable ? "#10b981" : "#f59e0b";
  const glow = isAvailable ? "rgba(16, 185, 129, 0.45)" : "rgba(245, 158, 11, 0.45)";
  return L.divIcon({
    className: "custom-map-pin",
    html: `
      <div class="map-pin-inner" style="background:${color}; box-shadow: 0 4px 12px ${glow};">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
      </div>
      <div class="map-pin-pulse" style="border-color:${color};"></div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16]
  });
}

function createMap(elementId, center = [19.0330, 73.0297], zoom = 13) {
  if (typeof L === "undefined") return null;
  const element = document.getElementById(elementId);
  if (!element) return null;
  const map = L.map(element).setView(center, zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  setTimeout(() => map.invalidateSize(), 150);
  return map;
}

function renderMapStations(map, stations, onClick = () => {}) {
  sharedMarkers.forEach(marker => map?.removeLayer(marker));
  sharedMarkers = [];
  if (!map) return;
  stations.forEach(station => {
    const isAvailable = Number(station.available_chargers || 0) > 0;
    const icon = createCustomMarkerIcon(isAvailable);
    const marker = L.marker([station.latitude, station.longitude], icon ? { icon } : {}).addTo(map);
    marker.bindPopup(`
      <b>${esc(station.name)}</b><br>
      <span style="color:var(--muted)">${esc(station.address)}</span><br>
      <span style="font-weight:700; color:${isAvailable ? '#059669' : '#d97706'}">
        ${station.available_chargers || 0}/${station.total_chargers || 0} chargers available
      </span><br>
      <button class="map-action" onclick="(${onClick.toString()})(${station.id})">Open station</button>
    `);
    sharedMarkers.push(marker);
  });
}
