# ChargeEase 2.0

ChargeEase is a cost-free academic EV charging station reservation and queue-management prototype.

## Final project scope

ChargeEase combines:

- User registration, login and role-based access
- Station discovery with Leaflet + OpenStreetMap
- Search and availability filters
- Charger and connector information
- Vehicle management
- Slot reservation with overlap protection
- Virtual queue management
- Estimated queue waiting time
- Charging-duration prediction
- Simulated payment and transaction receipt/history
- Ratings and reviews
- In-app notifications
- Support / complaints
- Station-owner management
- Charger status and maintenance management
- Owner analytics
- Admin station verification
- Admin support management
- Audit logs
- Admin analytics
- AI/ML demand prediction
- AI/ML charging-duration prediction
- Queue prediction
- Smart station/slot recommendations

## Free-first technology stack

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js + Express
- Database: MySQL 8
- Map: Leaflet + OpenStreetMap
- ML: Python + Flask + pandas + NumPy + scikit-learn
- Charts: HTML/CSS bars in the prototype; no paid chart service
- Payment: simulation only
- IoT: not required
- OCPP: future extension / simulator, not required for the current prototype

## Setup

### 1. MySQL

Run `database/schema.sql` in MySQL 8.

### 2. Environment

Copy `.env.example` to `.env` and set your local MySQL password.

Never commit real passwords or secrets.

### 3. Node dependencies

```bash
npm install
```

### 4. Seed demo data

```bash
npm run seed
```

Demo accounts:

- Admin: `admin@chargeease.local` / `Admin@123`
- User: `user@chargeease.local` / `User@123`
- Owner: `owner@chargeease.local` / `Owner@123`

Change these passwords for any non-demo environment.

### 5. Start ChargeEase

```bash
npm start
```

Open `http://localhost:3000`.

### Location search troubleshooting

Station-owner location search uses a server-side OpenStreetMap Nominatim request. This avoids unreliable browser-side geocoding and lets ChargeEase send a proper application User-Agent.

- Enter an address, landmark or area such as `SIES GST, Nerul, Navi Mumbai, Maharashtra`.
- You can also enter only a place such as `Nerul, Navi Mumbai` and refine the marker on the map.
- Click **Use my location** if browser location permission is available.
- You can always click the map manually; the latitude and longitude fields are filled automatically.
- Location search requires an internet connection because OpenStreetMap Nominatim is an online geocoding service.
- The project limits geocoding requests to one request per second to be respectful of the free service.

If the search service is temporarily unavailable, ChargeEase shows an error and the map-click/current-location options remain available.

## Optional ML service

The Node server includes deterministic free fallbacks, so ChargeEase can operate even when the Python service is not running.

To enable the Random Forest charging-duration service:

```bash
cd ml
python -m venv .venv
```

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r ..\requirements.txt
python app.py
```

Linux/macOS:

```bash
source .venv/bin/activate
pip install -r ../requirements.txt
python app.py
```

Then keep Node running on port 3000 and the ML service on port 5001.

## AI components

### Charging-duration prediction

The ML service uses Random Forest Regression with:

- charger power
- battery capacity
- current battery percentage
- target battery percentage
- connector code
- estimated energy

If the ML service is unavailable, the Node server uses a transparent physics-based estimate.

### Demand prediction

Demand uses time-of-day, booking activity, queue length and average charging duration. The architecture is ready for a larger historical Random Forest model when enough real project data is collected.

### Queue prediction

Queue prediction estimates waiting time using queue size, available chargers and expected charging duration.

### Smart recommendation

Recommendations combine charger availability, vehicle connector compatibility, queue length, predicted demand, rating and simulated price.

## Future extension

OCPP can later be added as:

`Physical Charger -> OCPP -> ChargeEase Backend -> Database / AI -> Web UI`

The current project intentionally does not require physical charger hardware.
