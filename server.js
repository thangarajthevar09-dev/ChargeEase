const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const multer = require("multer");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ML_URL = process.env.ML_URL || "http://127.0.0.1:5001";

const uploadRoot = path.join(__dirname, "uploads");
for (const folder of ["stations", "chargers", "documents"]) {
  fs.mkdirSync(path.join(uploadRoot, folder), { recursive: true });
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "chargeease",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  timezone: "local"
});

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const folder = file.fieldname === "stationPhoto"
      ? "stations"
      : file.fieldname.startsWith("chargerPhoto")
        ? "chargers"
        : "documents";
    cb(null, path.join(uploadRoot, folder));
  },
  filename(req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}-${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 30 },
  fileFilter(req, file, cb) {
    const allowedExt = /\.(jpg|jpeg|png|webp|pdf)$/i;
    const allowedMime = /^(image\/(jpeg|png|webp)|application\/pdf)$/i;
    if (!allowedExt.test(file.originalname) || !allowedMime.test(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, WEBP and PDF files are allowed."));
    }
    cb(null, true);
  }
});

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "chargeease-development-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));
app.use("/uploads", express.static(uploadRoot));
app.use(express.static(path.join(__dirname, "public")));

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Login required." });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: "Access denied." });
    }
    next();
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    role: user.role
  };
}

function validCoord(lat, lng) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    && Number(lat) >= -90 && Number(lat) <= 90
    && Number(lng) >= -180 && Number(lng) <= 180;
}

function validDateRange(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  return !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start;
}

function clean(value, fallback = "") {
  const result = String(value ?? fallback).trim();
  return result;
}

function randomReference(prefix = "CE") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function audit(req, action, entityType = null, entityId = null, details = {}) {
  try {
    await pool.query(
      "INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details,ip_address) VALUES(?,?,?,?,?,?)",
      [
        req.session.user?.id || null,
        action,
        entityType,
        entityId,
        JSON.stringify(details),
        req.ip || null
      ]
    );
  } catch (error) {
    console.error("Audit log error:", error.message);
  }
}

async function notify(userId, title, message, type = "SYSTEM") {
  if (!userId) return;
  await pool.query(
    "INSERT INTO notifications(user_id,title,message,type) VALUES(?,?,?,?)",
    [userId, title, message, type]
  );
}

async function callML(endpoint, payload) {
  try {
    const response = await fetch(`${ML_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

const GEOCODE_USER_AGENT = process.env.GEOCODER_USER_AGENT ||
  "ChargeEase/2.0 academic prototype";
let lastGeocodeAt = 0;

async function geocodePlace(query) {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastGeocodeAt));
  if (wait > 0) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  lastGeocodeAt = Date.now();

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "in");
  url.searchParams.set("q", query);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Accept-Language": "en",
        "User-Agent": GEOCODE_USER_AGENT
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Geocoding service returned HTTP ${response.status}.`);
    }

    const rows = await response.json();
    return Array.isArray(rows) ? rows.filter(row => validCoord(row.lat, row.lon)) : [];
  } finally {
    clearTimeout(timeout);
  }
}

function durationFallback({ powerKw, batteryCapacity, currentBattery, targetBattery }) {
  const energy = Math.max(0, batteryCapacity * (targetBattery - currentBattery) / 100);
  const effectivePower = Math.max(Number(powerKw) * 0.88, 1);
  return {
    minutes: Math.max(5, Math.ceil((energy / effectivePower) * 60)),
    energy
  };
}

function demandFallback({ hour, bookings, queue, avgDuration }) {
  let score = 2;
  if (hour >= 7 && hour <= 10) score += 2.5;
  if (hour >= 17 && hour <= 21) score += 4;
  score += Number(bookings) * 0.9;
  score += Number(queue) * 1.4;
  score += Number(avgDuration || 45) / 90;
  const level = score < 5 ? "Low" : score < 10 ? "Medium" : "High";
  return { score: Number(score.toFixed(2)), level };
}

async function getStationQueueStats(stationId) {
  const [[row]] = await pool.query(`
    SELECT
      COUNT(*) AS queue_count,
      COALESCE(AVG(q.estimated_wait_minutes),0) AS avg_wait,
      COALESCE((SELECT AVG(r.estimated_minutes)
                FROM reservations r
                JOIN chargers c2 ON c2.id=r.charger_id
                WHERE c2.station_id=? AND r.status IN ('CONFIRMED','ACTIVE')
                  AND r.end_time >= NOW()),45) AS avg_duration,
      (SELECT COUNT(*) FROM chargers c3 WHERE c3.station_id=? AND c3.status='AVAILABLE') AS available_chargers
    FROM queue q
    WHERE q.station_id=? AND q.status IN ('WAITING','SERVING')
  `, [stationId, stationId, stationId]);
  return row;
}

async function updateStationRating(stationId) {
  await pool.query(`
    UPDATE charging_stations s
    LEFT JOIN (
      SELECT station_id, ROUND(AVG(rating),2) rating_average, COUNT(*) rating_count
      FROM reviews
      WHERE status='VISIBLE'
      GROUP BY station_id
    ) r ON r.station_id=s.id
    SET s.rating_average=COALESCE(r.rating_average,0),
        s.rating_count=COALESCE(r.rating_count,0)
    WHERE s.id=?
  `, [stationId]);
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const ml = await fetch(`${ML_URL}/health`).then(r => r.ok).catch(() => false);
    res.json({ ok: true, database: "connected", mlService: ml ? "connected" : "optional/offline" });
  } catch (error) {
    res.status(500).json({ ok: false, database: "not connected", mlService: "unknown" });
  }
});

app.get("/api/session", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get("/api/geocode", async (req, res) => {
  const query = clean(req.query.q);

  if (query.length < 3) {
    return res.status(400).json({ error: "Enter at least 3 characters for a location search." });
  }

  if (query.length > 250) {
    return res.status(400).json({ error: "Location search is too long." });
  }

  try {
    const rows = await geocodePlace(query);
    res.json(rows.map(row => ({
      placeId: row.place_id,
      displayName: row.display_name,
      latitude: Number(row.lat),
      longitude: Number(row.lon),
      type: row.type || null,
      address: row.address || {}
    })));
  } catch (error) {
    console.error("Geocoding error:", error.message);
    const message = error.name === "AbortError"
      ? "Location search timed out. Please try again."
      : "Location search is temporarily unavailable. You can click the map to select the location.";
    res.status(502).json({ error: message });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const name = clean(req.body.name);
    const mobile = clean(req.body.mobile) || null;
    const email = clean(req.body.email).toLowerCase();
    const password = String(req.body.password || "");
    const role = req.body.role || "USER";

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email and password are required." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must contain at least 6 characters." });
    }
    if (!["USER", "STATION_OWNER"].includes(role)) {
      return res.status(400).json({ error: "Invalid account type." });
    }

    const [exists] = await pool.query("SELECT id FROM users WHERE email=?", [email]);
    if (exists.length) return res.status(409).json({ error: "Email already registered." });

    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      "INSERT INTO users(name,mobile,email,password_hash,role) VALUES(?,?,?,?,?)",
      [name, mobile, email, passwordHash, role]
    );

    await audit(req, "USER_REGISTERED", "USER", result.insertId, { role });
    res.json({ message: "Registration successful.", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = clean(req.body.email).toLowerCase();
    const password = String(req.body.password || "");
    const [rows] = await pool.query("SELECT * FROM users WHERE email=?", [email]);

    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    req.session.user = publicUser(rows[0]);
    await audit(req, "LOGIN", "USER", rows[0].id);
    res.json({ user: req.session.user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ message: "Logged out." }));
});

app.get("/api/profile", requireLogin, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id,name,mobile,email,role,avatar_url,created_at FROM users WHERE id=?",
    [req.session.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found." });
  res.json(rows[0]);
});

app.patch("/api/profile", requireLogin, async (req, res) => {
  try {
    const name = clean(req.body.name);
    const mobile = clean(req.body.mobile) || null;
    if (!name) return res.status(400).json({ error: "Name is required." });
    await pool.query("UPDATE users SET name=?,mobile=? WHERE id=?", [name, mobile, req.session.user.id]);
    req.session.user.name = name;
    req.session.user.mobile = mobile;
    await audit(req, "PROFILE_UPDATED", "USER", req.session.user.id);
    res.json({ message: "Profile updated.", user: req.session.user });
  } catch (error) {
    res.status(500).json({ error: "Could not update profile." });
  }
});

app.get("/api/vehicles", requireRole("USER"), async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM vehicles WHERE user_id=? ORDER BY is_default DESC,created_at DESC",
    [req.session.user.id]
  );
  res.json(rows);
});

app.post("/api/vehicles", requireRole("USER"), async (req, res) => {
  try {
    const b = req.body;
    const battery = Number(b.batteryCapacityKwh);
    const current = Number(b.currentBatteryPercent ?? 20);
    const target = Number(b.targetBatteryPercent ?? 80);
    if (!clean(b.model) || !Number.isFinite(battery) || battery <= 0) {
      return res.status(400).json({ error: "Vehicle model and valid battery capacity are required." });
    }
    if (current < 0 || current > 100 || target <= current || target > 100) {
      return res.status(400).json({ error: "Battery percentages must be valid and target must be above current level." });
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (b.isDefault) {
        await conn.query("UPDATE vehicles SET is_default=FALSE WHERE user_id=?", [req.session.user.id]);
      }
      const [result] = await conn.query(`
        INSERT INTO vehicles
        (user_id,nickname,make,model,battery_capacity_kwh,connector_type,current_battery_percent,target_battery_percent,is_default)
        VALUES(?,?,?,?,?,?,?,?,?)
      `, [
        req.session.user.id,
        clean(b.nickname) || clean(b.model),
        clean(b.make) || null,
        clean(b.model),
        battery,
        clean(b.connectorType) || "CCS2",
        current,
        target,
        Boolean(b.isDefault)
      ]);
      await conn.commit();
      await audit(req, "VEHICLE_CREATED", "VEHICLE", result.insertId);
      res.json({ message: "Vehicle added.", id: result.insertId });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not add vehicle." });
  }
});

app.patch("/api/vehicles/:id", requireRole("USER"), async (req, res) => {
  try {
    const b = req.body;
    const [owned] = await pool.query("SELECT id FROM vehicles WHERE id=? AND user_id=?", [req.params.id, req.session.user.id]);
    if (!owned.length) return res.status(404).json({ error: "Vehicle not found." });
    if (b.isDefault) await pool.query("UPDATE vehicles SET is_default=FALSE WHERE user_id=?", [req.session.user.id]);
    await pool.query(`
      UPDATE vehicles SET nickname=?,make=?,model=?,battery_capacity_kwh=?,connector_type=?,
      current_battery_percent=?,target_battery_percent=?,is_default=? WHERE id=? AND user_id=?
    `, [
      clean(b.nickname), clean(b.make) || null, clean(b.model), Number(b.batteryCapacityKwh),
      clean(b.connectorType), Number(b.currentBatteryPercent), Number(b.targetBatteryPercent),
      Boolean(b.isDefault), req.params.id, req.session.user.id
    ]);
    res.json({ message: "Vehicle updated." });
  } catch (error) {
    res.status(500).json({ error: "Could not update vehicle." });
  }
});

app.delete("/api/vehicles/:id", requireRole("USER"), async (req, res) => {
  const [result] = await pool.query("DELETE FROM vehicles WHERE id=? AND user_id=?", [req.params.id, req.session.user.id]);
  if (!result.affectedRows) return res.status(404).json({ error: "Vehicle not found." });
  res.json({ message: "Vehicle removed." });
});

app.get("/api/stations", async (req, res) => {
  try {
    const search = clean(req.query.search);
    const connector = clean(req.query.connector);
    const availability = req.query.availability === "available";
    const minPower = Number(req.query.minPower || 0);
    const [stations] = await pool.query(`
      SELECT
        s.id,s.name,s.govt_name,s.address,s.city,s.state,s.pincode,s.latitude,s.longitude,
        s.operating_hours,s.contact_number,s.status,s.station_photo,s.rating_average,s.rating_count,
        COUNT(c.id) total_chargers,
        COALESCE(SUM(c.status='AVAILABLE'),0) available_chargers,
        COALESCE(SUM(c.status='OCCUPIED'),0) occupied_chargers,
        COALESCE(SUM(c.status='MAINTENANCE'),0) maintenance_chargers,
        COALESCE(MIN(c.price_per_kwh),0) starting_price,
        COALESCE(MAX(c.power_kw),0) max_power_kw,
        COALESCE(GROUP_CONCAT(DISTINCT c.connector_type ORDER BY c.connector_type SEPARATOR ', '),'') connector_types
      FROM charging_stations s
      LEFT JOIN chargers c ON c.station_id=s.id
      WHERE s.status='APPROVED'
        AND (?='' OR CONCAT_WS(' ',s.name,s.address,s.city,s.state) LIKE CONCAT('%',?,'%'))
        AND (?='' OR EXISTS(
          SELECT 1 FROM chargers fc WHERE fc.station_id=s.id AND fc.connector_type=?
        ))
        AND (?=0 OR EXISTS(
          SELECT 1 FROM chargers fp WHERE fp.station_id=s.id AND fp.power_kw>=?
        ))
      GROUP BY s.id
      HAVING (?=0 OR available_chargers>0)
      ORDER BY s.rating_average DESC,s.created_at DESC
    `, [search, search, connector, connector, minPower, minPower, availability ? 1 : 0]);
    res.json(stations);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load stations." });
  }
});

app.get("/api/stations/:id", async (req, res) => {
  try {
    const [stationRows] = await pool.query(
      "SELECT * FROM charging_stations WHERE id=? AND status='APPROVED'",
      [req.params.id]
    );
    if (!stationRows.length) return res.status(404).json({ error: "Station not found." });
    const [chargers] = await pool.query(
      "SELECT * FROM chargers WHERE station_id=? ORDER BY power_kw DESC,id",
      [req.params.id]
    );
    const [reviews] = await pool.query(`
      SELECT r.id,r.rating,r.review_text,r.created_at,u.name user_name
      FROM reviews r JOIN users u ON u.id=r.user_id
      WHERE r.station_id=? AND r.status='VISIBLE'
      ORDER BY r.created_at DESC LIMIT 10
    `, [req.params.id]);
    const queueStats = await getStationQueueStats(req.params.id);
    res.json({ station: stationRows[0], chargers, reviews, queueStats });
  } catch (error) {
    res.status(500).json({ error: "Could not load station." });
  }
});

app.post("/api/owner/stations", requireRole("STATION_OWNER"), upload.fields([
  { name: "stationPhoto", maxCount: 1 },
  { name: "documents", maxCount: 10 },
  ...Array.from({ length: 10 }, (_, index) => ({ name: `chargerPhoto${index}`, maxCount: 1 }))
]), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    if (!clean(b.stationName) || !clean(b.govtName) || !clean(b.address) || !validCoord(b.latitude, b.longitude)) {
      return res.status(400).json({ error: "Station name, government name, address and valid coordinates are required." });
    }

    let chargers;
    try {
      chargers = JSON.parse(b.chargersJson || "[]");
    } catch {
      return res.status(400).json({ error: "Invalid charger configuration." });
    }

    if (!Array.isArray(chargers) || chargers.length < 1 || chargers.length > 10) {
      return res.status(400).json({ error: "Add between 1 and 10 chargers." });
    }

    await conn.beginTransaction();

    const stationPhoto = req.files?.stationPhoto?.[0]
      ? `/uploads/stations/${req.files.stationPhoto[0].filename}`
      : null;

    const [stationResult] = await conn.query(`
      INSERT INTO charging_stations
      (owner_id,name,govt_name,address,city,state,pincode,latitude,longitude,operating_hours,contact_number,station_photo,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING')
    `, [
      req.session.user.id,
      clean(b.stationName),
      clean(b.govtName),
      clean(b.address),
      clean(b.city) || "Navi Mumbai",
      clean(b.state) || "Maharashtra",
      clean(b.pincode) || null,
      Number(b.latitude),
      Number(b.longitude),
      clean(b.operatingHours) || "24 Hours",
      clean(b.contactNumber) || req.session.user.mobile || null,
      stationPhoto
    ]);

    const stationId = stationResult.insertId;

    for (let i = 0; i < chargers.length; i += 1) {
      const c = chargers[i];
      const power = Number(c.powerKw);
      const price = Number(c.price || 0);
      if (!clean(c.connector) || !Number.isFinite(power) || power <= 0 || !["AC", "DC"].includes(c.currentType)) {
        throw new Error(`Invalid charger ${i + 1}.`);
      }
      const photo = req.files?.[`chargerPhoto${i}`]?.[0]
        ? `/uploads/chargers/${req.files[`chargerPhoto${i}`][0].filename}`
        : null;
      await conn.query(`
        INSERT INTO chargers
        (station_id,charger_name,connector_type,current_type,power_kw,speed_category,price_per_kwh,status,image)
        VALUES(?,?,?,?,?,?,?,?,?)
      `, [
        stationId,
        clean(c.name) || `Charger ${i + 1}`,
        clean(c.connector),
        c.currentType,
        power,
        clean(c.speed) || (power >= 50 ? "Fast" : "Standard"),
        Number.isFinite(price) ? price : 0,
        "AVAILABLE",
        photo
      ]);
    }

    for (const file of (req.files?.documents || [])) {
      await conn.query(
        "INSERT INTO station_documents(station_id,document_type,file_path) VALUES(?,?,?)",
        [stationId, file.originalname, `/uploads/documents/${file.filename}`]
      );
    }

    await conn.query(
      "INSERT INTO admin_verifications(station_id,status,remarks) VALUES(?,?,?)",
      [stationId, "PENDING", "New station registration submitted."]
    );

    await conn.commit();
    await audit(req, "STATION_CREATED", "STATION", stationId, { chargers: chargers.length });
    res.json({ message: "Station submitted for admin verification.", stationId });
  } catch (error) {
    await conn.rollback();
    console.error(error);
    res.status(400).json({ error: error.message || "Station submission failed." });
  } finally {
    conn.release();
  }
});

app.get("/api/owner/stations", requireRole("STATION_OWNER"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.*,COUNT(c.id) total_chargers,
        COALESCE(SUM(c.status='AVAILABLE'),0) available_chargers,
        COALESCE(SUM(c.status='OCCUPIED'),0) occupied_chargers,
        COALESCE(SUM(c.status='MAINTENANCE'),0) maintenance_chargers,
        (SELECT COUNT(*) FROM queue q WHERE q.station_id=s.id AND q.status IN ('WAITING','SERVING')) queue_count
      FROM charging_stations s
      LEFT JOIN chargers c ON c.station_id=s.id
      WHERE s.owner_id=?
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `, [req.session.user.id]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load owner stations." });
  }
});

app.get("/api/owner/stations/:id", requireRole("STATION_OWNER"), async (req, res) => {
  try {
    const [station] = await pool.query(
      "SELECT * FROM charging_stations WHERE id=? AND owner_id=?",
      [req.params.id, req.session.user.id]
    );
    if (!station.length) return res.status(404).json({ error: "Station not found." });
    const [chargers] = await pool.query("SELECT * FROM chargers WHERE station_id=? ORDER BY id", [req.params.id]);
    const [maintenance] = await pool.query(`
      SELECT m.*,c.charger_name
      FROM maintenance_logs m JOIN chargers c ON c.id=m.charger_id
      WHERE c.station_id=? ORDER BY m.started_at DESC
    `, [req.params.id]);
    res.json({ station: station[0], chargers, maintenance });
  } catch (error) {
    res.status(500).json({ error: "Could not load station." });
  }
});

app.patch("/api/owner/chargers/:id/status", requireRole("STATION_OWNER"), async (req, res) => {
  try {
    const status = req.body.status;
    if (!["AVAILABLE", "OCCUPIED", "MAINTENANCE"].includes(status)) {
      return res.status(400).json({ error: "Invalid charger status." });
    }
    const [result] = await pool.query(`
      UPDATE chargers c JOIN charging_stations s ON s.id=c.station_id
      SET c.status=? WHERE c.id=? AND s.owner_id=?
    `, [status, req.params.id, req.session.user.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Charger not found." });
    await audit(req, "CHARGER_STATUS_UPDATED", "CHARGER", Number(req.params.id), { status });
    res.json({ message: "Charger status updated." });
  } catch (error) {
    res.status(500).json({ error: "Could not update charger." });
  }
});

app.post("/api/owner/maintenance", requireRole("STATION_OWNER"), async (req, res) => {
  try {
    const { chargerId, issueTitle, issueDescription } = req.body;
    const [owned] = await pool.query(`
      SELECT c.id FROM chargers c JOIN charging_stations s ON s.id=c.station_id
      WHERE c.id=? AND s.owner_id=?
    `, [chargerId, req.session.user.id]);
    if (!owned.length) return res.status(404).json({ error: "Charger not found." });
    const [result] = await pool.query(`
      INSERT INTO maintenance_logs(charger_id,owner_id,issue_title,issue_description)
      VALUES(?,?,?,?)
    `, [chargerId, req.session.user.id, clean(issueTitle) || "Maintenance required", clean(issueDescription) || null]);
    await pool.query("UPDATE chargers SET status='MAINTENANCE' WHERE id=?", [chargerId]);
    await audit(req, "MAINTENANCE_CREATED", "MAINTENANCE", result.insertId);
    res.json({ message: "Maintenance issue created." });
  } catch (error) {
    res.status(500).json({ error: "Could not create maintenance issue." });
  }
});

app.patch("/api/owner/maintenance/:id", requireRole("STATION_OWNER"), async (req, res) => {
  try {
    const status = req.body.status;
    if (!["OPEN", "IN_PROGRESS", "RESOLVED"].includes(status)) return res.status(400).json({ error: "Invalid maintenance status." });
    const [result] = await pool.query(`
      UPDATE maintenance_logs SET status=?,resolved_at=IF(?='RESOLVED',NOW(),NULL)
      WHERE id=? AND owner_id=?
    `, [status, status, req.params.id, req.session.user.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Maintenance record not found." });
    const [[row]] = await pool.query("SELECT charger_id FROM maintenance_logs WHERE id=?", [req.params.id]);
    if (status === "RESOLVED" && row) await pool.query("UPDATE chargers SET status='AVAILABLE' WHERE id=?", [row.charger_id]);
    res.json({ message: "Maintenance status updated." });
  } catch (error) {
    res.status(500).json({ error: "Could not update maintenance." });
  }
});

app.get("/api/owner/queue", requireRole("STATION_OWNER"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT q.*,s.name station_name,u.name user_name,u.mobile,v.model vehicle_model
      FROM queue q
      JOIN charging_stations s ON s.id=q.station_id
      JOIN users u ON u.id=q.user_id
      LEFT JOIN vehicles v ON v.id=q.vehicle_id
      WHERE s.owner_id=? AND q.status IN ('WAITING','SERVING')
      ORDER BY q.station_id,q.queue_number
    `, [req.session.user.id]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load queue." });
  }
});

app.patch("/api/owner/queue/:id", requireRole("STATION_OWNER"), async (req, res) => {
  try {
    const status = req.body.status;
    if (!["SERVING", "SERVED", "CANCELLED"].includes(status)) return res.status(400).json({ error: "Invalid queue status." });
    const [result] = await pool.query(`
      UPDATE queue q JOIN charging_stations s ON s.id=q.station_id
      SET q.status=?,q.served_at=IF(? IN ('SERVED','CANCELLED'),NOW(),NULL)
      WHERE q.id=? AND s.owner_id=?
    `, [status, status, req.params.id, req.session.user.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Queue entry not found." });
    const [[entry]] = await pool.query("SELECT user_id,station_id,queue_number FROM queue WHERE id=?", [req.params.id]);
    if (entry) await notify(entry.user_id, "Queue updated", `Your queue status is now ${status}.`, "QUEUE");
    res.json({ message: "Queue updated." });
  } catch (error) {
    res.status(500).json({ error: "Could not update queue." });
  }
});

app.get("/api/owner/analytics", requireRole("STATION_OWNER"), async (req, res) => {
  try {
    const [[summary]] = await pool.query(`
      SELECT
        COUNT(DISTINCT r.id) reservations,
        COALESCE(SUM(CASE WHEN r.status='COMPLETED' THEN 1 ELSE 0 END),0) completed,
        COALESCE(SUM(p.amount),0) revenue,
        COALESCE(AVG(r.estimated_minutes),0) avg_duration
      FROM charging_stations s
      LEFT JOIN chargers c ON c.station_id=s.id
      LEFT JOIN reservations r ON r.charger_id=c.id
      LEFT JOIN payments p ON p.reservation_id=r.id AND p.status='SUCCESS'
      WHERE s.owner_id=?
    `, [req.session.user.id]);
    const [daily] = await pool.query(`
      SELECT DATE(r.created_at) day,COUNT(*) bookings
      FROM reservations r JOIN chargers c ON c.id=r.charger_id
      JOIN charging_stations s ON s.id=c.station_id
      WHERE s.owner_id=? AND r.created_at >= DATE_SUB(CURDATE(),INTERVAL 13 DAY)
      GROUP BY DATE(r.created_at) ORDER BY day
    `, [req.session.user.id]);
    res.json({ summary, daily });
  } catch (error) {
    res.status(500).json({ error: "Could not load analytics." });
  }
});

app.get("/api/admin/stations", requireRole("ADMIN"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.*,u.name owner_name,u.email owner_email,u.mobile owner_mobile,
      COUNT(c.id) total_chargers,
      COALESCE(SUM(c.status='AVAILABLE'),0) available_chargers
      FROM charging_stations s
      JOIN users u ON u.id=s.owner_id
      LEFT JOIN chargers c ON c.station_id=s.id
      GROUP BY s.id
      ORDER BY FIELD(s.status,'PENDING','CHANGES_REQUIRED','APPROVED','REJECTED'),s.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load admin stations." });
  }
});

app.get("/api/admin/stations/:id", requireRole("ADMIN"), async (req, res) => {
  try {
    const [station] = await pool.query(`
      SELECT s.*,u.name owner_name,u.email owner_email,u.mobile owner_mobile
      FROM charging_stations s JOIN users u ON u.id=s.owner_id WHERE s.id=?
    `, [req.params.id]);
    if (!station.length) return res.status(404).json({ error: "Station not found." });
    const [chargers] = await pool.query("SELECT * FROM chargers WHERE station_id=? ORDER BY id", [req.params.id]);
    const [documents] = await pool.query("SELECT * FROM station_documents WHERE station_id=? ORDER BY id", [req.params.id]);
    const [verifications] = await pool.query("SELECT * FROM admin_verifications WHERE station_id=? ORDER BY id DESC", [req.params.id]);
    res.json({ station: station[0], chargers, documents, verifications });
  } catch (error) {
    res.status(500).json({ error: "Could not load review." });
  }
});

app.patch("/api/admin/stations/:id/review", requireRole("ADMIN"), async (req, res) => {
  const map = { APPROVE: "APPROVED", REJECT: "REJECTED", CHANGES: "CHANGES_REQUIRED" };
  const status = map[req.body.action];
  if (!status) return res.status(400).json({ error: "Invalid review action." });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [stationRows] = await conn.query("SELECT owner_id,name FROM charging_stations WHERE id=? FOR UPDATE", [req.params.id]);
    if (!stationRows.length) throw new Error("Station not found.");
    await conn.query("UPDATE charging_stations SET status=? WHERE id=?", [status, req.params.id]);
    await conn.query(
      "INSERT INTO admin_verifications(station_id,admin_id,status,remarks) VALUES(?,?,?,?)",
      [req.params.id, req.session.user.id, status, clean(req.body.remarks) || `Station ${status.toLowerCase().replace("_", " ")}.`]
    );
    await conn.commit();
    await notify(
      stationRows[0].owner_id,
      "Station verification updated",
      `${stationRows[0].name} is now ${status.replace("_", " ")}.`,
      "STATION"
    );
    await audit(req, "STATION_REVIEWED", "STATION", Number(req.params.id), { status });
    res.json({ message: `Station ${status}.` });
  } catch (error) {
    await conn.rollback();
    res.status(400).json({ error: error.message || "Review failed." });
  } finally {
    conn.release();
  }
});

app.get("/api/admin/stats", requireRole("ADMIN"), async (req, res) => {
  try {
    const [[users]] = await pool.query("SELECT COUNT(*) count FROM users WHERE role='USER'");
    const [[owners]] = await pool.query("SELECT COUNT(*) count FROM users WHERE role='STATION_OWNER'");
    const [[pending]] = await pool.query("SELECT COUNT(*) count FROM charging_stations WHERE status='PENDING'");
    const [[approved]] = await pool.query("SELECT COUNT(*) count FROM charging_stations WHERE status='APPROVED'");
    const [[rejected]] = await pool.query("SELECT COUNT(*) count FROM charging_stations WHERE status='REJECTED'");
    const [[chargers]] = await pool.query("SELECT COUNT(*) count FROM chargers");
    const [[reservations]] = await pool.query("SELECT COUNT(*) count FROM reservations");
    const [[revenue]] = await pool.query("SELECT COALESCE(SUM(amount),0) amount FROM payments WHERE status='SUCCESS'");
    res.json({
      users: users.count,
      owners: owners.count,
      pending: pending.count,
      approved: approved.count,
      rejected: rejected.count,
      chargers: chargers.count,
      reservations: reservations.count,
      revenue: Number(revenue.amount || 0)
    });
  } catch (error) {
    res.status(500).json({ error: "Could not load statistics." });
  }
});

app.get("/api/admin/complaints", requireRole("ADMIN"), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT c.*,u.name user_name,u.email user_email,s.name station_name
    FROM complaints c JOIN users u ON u.id=c.user_id
    LEFT JOIN charging_stations s ON s.id=c.station_id
    ORDER BY FIELD(c.status,'OPEN','IN_PROGRESS','RESOLVED','CLOSED'),c.created_at DESC
  `);
  res.json(rows);
});

app.patch("/api/admin/complaints/:id", requireRole("ADMIN"), async (req, res) => {
  const status = req.body.status;
  if (!["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].includes(status)) return res.status(400).json({ error: "Invalid complaint status." });
  const [result] = await pool.query(
    "UPDATE complaints SET status=?,admin_response=? WHERE id=?",
    [status, clean(req.body.response) || null, req.params.id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: "Complaint not found." });
  const [[row]] = await pool.query("SELECT user_id FROM complaints WHERE id=?", [req.params.id]);
  if (row) await notify(row.user_id, "Support complaint updated", `Your complaint is now ${status}.`, "SYSTEM");
  res.json({ message: "Complaint updated." });
});

app.get("/api/admin/audit", requireRole("ADMIN"), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT a.*,u.name user_name,u.email user_email
    FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    ORDER BY a.created_at DESC LIMIT 100
  `);
  res.json(rows);
});

app.post("/api/reservations", requireRole("USER"), async (req, res) => {
  const chargerId = Number(req.body.chargerId);
  const vehicleId = req.body.vehicleId ? Number(req.body.vehicleId) : null;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime;

  if (!chargerId || !startTime || !endTime || !validDateRange(startTime, endTime)) {
    return res.status(400).json({ error: "Charger and valid start/end times are required." });
  }

  const start = new Date(startTime);
  const end = new Date(endTime);
  const durationMinutes = Math.ceil((end - start) / 60000);
  if (durationMinutes > 480) return res.status(400).json({ error: "A reservation can be at most 8 hours." });
  if (start.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ error: "Reservation start time cannot be in the past." });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [chargerRows] = await conn.query(`
      SELECT c.*,s.name station_name,s.status station_status
      FROM chargers c JOIN charging_stations s ON s.id=c.station_id
      WHERE c.id=? AND s.status='APPROVED' FOR UPDATE
    `, [chargerId]);
    if (!chargerRows.length) throw new Error("Charger is not available for reservation.");
    const charger = chargerRows[0];
    if (charger.status === "MAINTENANCE") throw new Error("This charger is under maintenance.");

    if (vehicleId) {
      const [vehicle] = await conn.query("SELECT id FROM vehicles WHERE id=? AND user_id=?", [vehicleId, req.session.user.id]);
      if (!vehicle.length) throw new Error("Selected vehicle does not belong to your account.");
    }

    const [overlap] = await conn.query(`
      SELECT id FROM reservations
      WHERE charger_id=? AND status IN ('CONFIRMED','ACTIVE')
        AND start_time < ? AND end_time > ?
      LIMIT 1 FOR UPDATE
    `, [chargerId, end, start]);
    if (overlap.length) throw new Error("This charger is already reserved for the selected time.");

    let estimatedMinutes = durationMinutes;
    let energy = 0;
    if (vehicleId) {
      const [[vehicle]] = await conn.query("SELECT * FROM vehicles WHERE id=?", [vehicleId]);
      const ml = await callML("/predict/duration", {
        power_kw: charger.power_kw,
        battery_capacity_kwh: vehicle.battery_capacity_kwh,
        current_battery_percent: vehicle.current_battery_percent,
        target_battery_percent: vehicle.target_battery_percent,
        connector_type: vehicle.connector_type
      });
      if (ml) {
        estimatedMinutes = Math.min(durationMinutes, Math.max(5, Number(ml.prediction_minutes || durationMinutes)));
        energy = Number(ml.estimated_energy_kwh || 0);
      } else {
        const fallback = durationFallback({
          powerKw: charger.power_kw,
          batteryCapacity: vehicle.battery_capacity_kwh,
          currentBattery: vehicle.current_battery_percent,
          targetBattery: vehicle.target_battery_percent
        });
        estimatedMinutes = Math.min(durationMinutes, fallback.minutes);
        energy = fallback.energy;
      }
    }

    const cost = Number((energy * Number(charger.price_per_kwh || 0)).toFixed(2));
    const [result] = await conn.query(`
      INSERT INTO reservations
      (user_id,charger_id,vehicle_id,start_time,end_time,estimated_minutes,estimated_energy_kwh,estimated_cost,status,payment_status)
      VALUES(?,?,?,?,?,?,?,?, 'CONFIRMED',?)
    `, [
      req.session.user.id, chargerId, vehicleId, start, end,
      estimatedMinutes, energy, cost, cost > 0 ? "PENDING" : "NOT_REQUIRED"
    ]);

    await conn.commit();
    await notify(req.session.user.id, "Reservation confirmed", `Your reservation at ${charger.station_name} is confirmed.`, "RESERVATION");
    await audit(req, "RESERVATION_CREATED", "RESERVATION", result.insertId, { chargerId, startTime, endTime });
    res.json({
      message: "Reservation confirmed.",
      reservationId: result.insertId,
      estimatedMinutes,
      estimatedEnergyKwh: Number(energy.toFixed(2)),
      estimatedCost: cost
    });
  } catch (error) {
    await conn.rollback();
    res.status(409).json({ error: error.message || "Reservation failed." });
  } finally {
    conn.release();
  }
});

app.get("/api/my/reservations", requireRole("USER"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT r.*,c.charger_name,c.connector_type,c.power_kw,c.price_per_kwh,
             s.name station_name,s.address,s.latitude,s.longitude,
             v.model vehicle_model
      FROM reservations r
      JOIN chargers c ON c.id=r.charger_id
      JOIN charging_stations s ON s.id=c.station_id
      LEFT JOIN vehicles v ON v.id=r.vehicle_id
      WHERE r.user_id=?
      ORDER BY r.start_time DESC
    `, [req.session.user.id]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load reservations." });
  }
});

app.delete("/api/my/reservations/:id", requireRole("USER"), async (req, res) => {
  try {
    const [result] = await pool.query(`
      UPDATE reservations SET status='CANCELLED',payment_status=IF(payment_status='PAID','REFUNDED',payment_status)
      WHERE id=? AND user_id=? AND status IN ('CONFIRMED','ACTIVE')
    `, [req.params.id, req.session.user.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Reservation not found or cannot be cancelled." });
    await notify(req.session.user.id, "Reservation cancelled", "Your reservation has been cancelled.", "RESERVATION");
    res.json({ message: "Reservation cancelled." });
  } catch (error) {
    res.status(500).json({ error: "Could not cancel reservation." });
  }
});

app.post("/api/payments/simulate", requireRole("USER"), async (req, res) => {
  const reservationId = Number(req.body.reservationId);
  const method = req.body.method || "SIMULATED_UPI";
  if (!["SIMULATED_UPI", "SIMULATED_CARD", "SIMULATED_WALLET", "FREE"].includes(method)) {
    return res.status(400).json({ error: "Invalid simulated payment method." });
  }
  try {
    const [rows] = await pool.query(`
      SELECT r.*,c.charger_name,s.name station_name
      FROM reservations r JOIN chargers c ON c.id=r.charger_id
      JOIN charging_stations s ON s.id=c.station_id
      WHERE r.id=? AND r.user_id=?
    `, [reservationId, req.session.user.id]);
    if (!rows.length) return res.status(404).json({ error: "Reservation not found." });
    const reservation = rows[0];
    if (reservation.payment_status === "PAID") return res.status(409).json({ error: "Payment already completed." });
    const amount = Number(reservation.estimated_cost || 0);
    const transactionRef = randomReference("SIM");
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`
        INSERT INTO payments(user_id,reservation_id,amount,method,transaction_ref,status)
        VALUES(?,?,?,?,?,'SUCCESS')
      `, [req.session.user.id, reservationId, amount, amount === 0 ? "FREE" : method, transactionRef]);
      await conn.query("UPDATE reservations SET payment_status=? WHERE id=?", [amount === 0 ? "NOT_REQUIRED" : "PAID", reservationId]);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    await notify(req.session.user.id, "Payment recorded", `Simulated payment ${transactionRef} was successful.`, "PAYMENT");
    res.json({ message: "Simulated payment successful.", transactionRef, amount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Simulated payment failed." });
  }
});

app.get("/api/my/payments", requireRole("USER"), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT p.*,s.name station_name,r.start_time
    FROM payments p
    LEFT JOIN reservations r ON r.id=p.reservation_id
    LEFT JOIN chargers c ON c.id=r.charger_id
    LEFT JOIN charging_stations s ON s.id=c.station_id
    WHERE p.user_id=? ORDER BY p.created_at DESC
  `, [req.session.user.id]);
  res.json(rows);
});

app.post("/api/queue", requireRole("USER"), async (req, res) => {
  const stationId = Number(req.body.stationId);
  const vehicleId = req.body.vehicleId ? Number(req.body.vehicleId) : null;
  if (!stationId) return res.status(400).json({ error: "Station is required." });
  try {
    const [station] = await pool.query("SELECT id,name FROM charging_stations WHERE id=? AND status='APPROVED'", [stationId]);
    if (!station.length) return res.status(404).json({ error: "Station not found." });
    const [active] = await pool.query(
      "SELECT id FROM queue WHERE station_id=? AND user_id=? AND status IN ('WAITING','SERVING')",
      [stationId, req.session.user.id]
    );
    if (active.length) return res.status(409).json({ error: "You are already in this queue." });
    if (vehicleId) {
      const [vehicle] = await pool.query("SELECT id FROM vehicles WHERE id=? AND user_id=?", [vehicleId, req.session.user.id]);
      if (!vehicle.length) return res.status(400).json({ error: "Selected vehicle is invalid." });
    }
    const [[max]] = await pool.query(
      "SELECT COALESCE(MAX(queue_number),0)+1 next_no FROM queue WHERE station_id=? AND status IN ('WAITING','SERVING')",
      [stationId]
    );
    const stats = await getStationQueueStats(stationId);
    const ml = await callML("/predict/queue", {
      queue_count: Number(max.next_no) - 1,
      active_chargers: Number(stats.available_chargers || 1),
      avg_duration_minutes: Number(stats.avg_duration || 45)
    });
    const estimatedWait = Number(ml?.estimated_wait_minutes || Math.ceil(((Number(max.next_no) - 1) / Math.max(Number(stats.available_chargers || 1), 1)) * Number(stats.avg_duration || 45)));
    const [result] = await pool.query(
      "INSERT INTO queue(station_id,user_id,vehicle_id,queue_number,estimated_wait_minutes,status) VALUES(?,?,?,?,?,'WAITING')",
      [stationId, req.session.user.id, vehicleId, max.next_no, estimatedWait]
    );
    await notify(req.session.user.id, "Joined charging queue", `You are #${max.next_no} at ${station[0].name}. Estimated wait: ${estimatedWait} minutes.`, "QUEUE");
    res.json({ message: "Joined queue.", queueNumber: max.next_no, estimatedWaitMinutes: estimatedWait, id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not join queue." });
  }
});

app.get("/api/my/queue", requireRole("USER"), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT q.id,q.station_id,q.queue_number,q.status,q.estimated_wait_minutes,q.created_at,
           s.name station_name,s.address,v.model vehicle_model
    FROM queue q JOIN charging_stations s ON s.id=q.station_id
    LEFT JOIN vehicles v ON v.id=q.vehicle_id
    WHERE q.user_id=? AND q.status IN ('WAITING','SERVING')
    ORDER BY q.created_at DESC
  `, [req.session.user.id]);
  res.json(rows);
});

app.delete("/api/my/queue/:id", requireRole("USER"), async (req, res) => {
  const [result] = await pool.query(
    "UPDATE queue SET status='CANCELLED' WHERE id=? AND user_id=? AND status IN ('WAITING','SERVING')",
    [req.params.id, req.session.user.id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: "Queue entry not found." });
  res.json({ message: "Removed from queue." });
});

app.post("/api/reviews", requireRole("USER"), async (req, res) => {
  try {
    const stationId = Number(req.body.stationId);
    const rating = Number(req.body.rating);
    const reviewText = clean(req.body.reviewText) || null;
    if (!stationId || rating < 1 || rating > 5) return res.status(400).json({ error: "Station and rating from 1 to 5 are required." });
    const [completed] = await pool.query(`
      SELECT r.id FROM reservations r JOIN chargers c ON c.id=r.charger_id
      WHERE r.user_id=? AND c.station_id=? AND r.status='COMPLETED' LIMIT 1
    `, [req.session.user.id, stationId]);
    if (!completed.length) return res.status(400).json({ error: "Complete a reservation at this station before reviewing it." });
    const [result] = await pool.query(
      "INSERT INTO reviews(user_id,station_id,reservation_id,rating,review_text) VALUES(?,?,?,?,?)",
      [req.session.user.id, stationId, completed[0].id, rating, reviewText]
    );
    await updateStationRating(stationId);
    await audit(req, "REVIEW_CREATED", "REVIEW", result.insertId);
    res.json({ message: "Review submitted." });
  } catch (error) {
    res.status(500).json({ error: "Could not submit review." });
  }
});

app.get("/api/my/notifications", requireLogin, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
    [req.session.user.id]
  );
  res.json(rows);
});

app.patch("/api/my/notifications/:id/read", requireLogin, async (req, res) => {
  const [result] = await pool.query(
    "UPDATE notifications SET is_read=TRUE WHERE id=? AND user_id=?",
    [req.params.id, req.session.user.id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: "Notification not found." });
  res.json({ message: "Notification marked as read." });
});

app.post("/api/complaints", requireLogin, async (req, res) => {
  try {
    const { stationId, subject, description, priority = "MEDIUM" } = req.body;
    if (!clean(subject) || !clean(description)) return res.status(400).json({ error: "Subject and description are required." });
    if (!["LOW", "MEDIUM", "HIGH"].includes(priority)) return res.status(400).json({ error: "Invalid priority." });
    const [result] = await pool.query(`
      INSERT INTO complaints(user_id,station_id,subject,description,priority)
      VALUES(?,?,?,?,?)
    `, [req.session.user.id, stationId ? Number(stationId) : null, clean(subject), clean(description), priority]);
    await notify(req.session.user.id, "Support request created", "Your complaint has been received.", "SYSTEM");
    res.json({ message: "Support request submitted.", id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: "Could not submit complaint." });
  }
});

app.get("/api/my/complaints", requireLogin, async (req, res) => {
  const [rows] = await pool.query(`
    SELECT c.*,s.name station_name
    FROM complaints c LEFT JOIN charging_stations s ON s.id=c.station_id
    WHERE c.user_id=? ORDER BY c.created_at DESC
  `, [req.session.user.id]);
  res.json(rows);
});

app.get("/api/ai/station/:id/demand", requireLogin, async (req, res) => {
  try {
    const stationId = Number(req.params.id);
    const stats = await getStationQueueStats(stationId);
    const hour = Number(req.query.hour ?? new Date().getHours());
    const [bookingRows] = await pool.query(`
      SELECT COUNT(*) bookings FROM reservations r JOIN chargers c ON c.id=r.charger_id
      WHERE c.station_id=? AND DATE(r.start_time)=CURDATE() AND HOUR(r.start_time)=?
    `, [stationId, hour]);
    const payload = {
      hour,
      bookings_count: Number(bookingRows[0].bookings || 0),
      queue_count: Number(stats.queue_count || 0),
      avg_duration_minutes: Number(stats.avg_duration || 45)
    };
    const ml = await callML("/predict/demand", payload);
    const fallback = demandFallback(payload);
    const output = ml || { demand_score: fallback.score, demand_level: fallback.level, model: "rule-fallback" };
    await pool.query(
      "INSERT INTO ai_predictions(station_id,prediction_type,input_json,output_json,model_name) VALUES(?,?,?,?,?)",
      [stationId, "DEMAND", JSON.stringify(payload), JSON.stringify(output), output.model || "rule-fallback"]
    );
    res.json(output);
  } catch (error) {
    res.status(500).json({ error: "Could not calculate demand prediction." });
  }
});

app.get("/api/ai/station/:id/queue", requireLogin, async (req, res) => {
  try {
    const stationId = Number(req.params.id);
    const stats = await getStationQueueStats(stationId);
    const payload = {
      queue_count: Number(stats.queue_count || 0),
      active_chargers: Math.max(Number(stats.available_chargers || 1), 1),
      avg_duration_minutes: Number(stats.avg_duration || 45)
    };
    const ml = await callML("/predict/queue", payload);
    const wait = ml?.estimated_wait_minutes || Math.ceil((payload.queue_count / payload.active_chargers) * payload.avg_duration_minutes);
    const output = {
      estimated_wait_minutes: wait,
      predicted_queue_length: payload.queue_count,
      model: ml?.model || "queue-estimator"
    };
    res.json(output);
  } catch (error) {
    res.status(500).json({ error: "Could not calculate queue prediction." });
  }
});

app.post("/api/ai/duration", requireLogin, async (req, res) => {
  try {
    const data = req.body || {};
    const fallback = durationFallback({
      powerKw: Number(data.power_kw || 22),
      batteryCapacity: Number(data.battery_capacity_kwh || 50),
      currentBattery: Number(data.current_battery_percent || 20),
      targetBattery: Number(data.target_battery_percent || 80)
    });
    const ml = await callML("/predict/duration", data);
    res.json(ml || {
      prediction_minutes: fallback.minutes,
      estimated_energy_kwh: Number(fallback.energy.toFixed(2)),
      model: "formula-fallback"
    });
  } catch (error) {
    res.status(500).json({ error: "Could not predict charging duration." });
  }
});

app.get("/api/ai/recommendations", requireRole("USER"), async (req, res) => {
  try {
    const vehicleId = req.query.vehicleId ? Number(req.query.vehicleId) : null;
    const [vehicles] = await pool.query(
      "SELECT * FROM vehicles WHERE user_id=? ORDER BY is_default DESC,created_at DESC",
      [req.session.user.id]
    );
    const vehicle = vehicles.find(v => v.id === vehicleId) || vehicles[0] || null;
    const [stations] = await pool.query(`
      SELECT s.*,c.id charger_id,c.charger_name,c.connector_type,c.current_type,c.power_kw,c.price_per_kwh,c.status charger_status,
        (SELECT COUNT(*) FROM queue q WHERE q.station_id=s.id AND q.status IN ('WAITING','SERVING')) queue_count
      FROM charging_stations s
      JOIN chargers c ON c.station_id=s.id
      WHERE s.status='APPROVED' AND c.status <> 'MAINTENANCE'
      ORDER BY s.rating_average DESC,s.id
      LIMIT 30
    `);
    const hour = new Date().getHours();
    const recommendations = [];
    for (const row of stations) {
      const connectorMatch = !vehicle || !vehicle.connector_type || vehicle.connector_type.toLowerCase() === row.connector_type.toLowerCase();
      const demand = demandFallback({
        hour,
        bookings: 0,
        queue: Number(row.queue_count || 0),
        avgDuration: 45
      });
      const wait = Math.ceil(Number(row.queue_count || 0) * 45 / Math.max(row.charger_status === "AVAILABLE" ? 1 : 1, 1));
      const availabilityScore = row.charger_status === "AVAILABLE" ? 35 : 8;
      const connectorScore = connectorMatch ? 25 : 0;
      const ratingScore = Number(row.rating_average || 0) * 5;
      const queueScore = Math.max(0, 20 - Number(row.queue_count || 0) * 4);
      const demandScore = demand.level === "Low" ? 10 : demand.level === "Medium" ? 5 : 0;
      const score = availabilityScore + connectorScore + ratingScore + queueScore + demandScore;
      recommendations.push({
        stationId: row.id,
        stationName: row.name,
        address: row.address,
        chargerId: row.charger_id,
        chargerName: row.charger_name,
        connector: row.connector_type,
        powerKw: Number(row.power_kw),
        pricePerKwh: Number(row.price_per_kwh || 0),
        availability: row.charger_status,
        queueLength: Number(row.queue_count || 0),
        expectedWaitMinutes: wait,
        predictedDemand: demand.level,
        rating: Number(row.rating_average || 0),
        recommendationScore: Number(score.toFixed(1)),
        reasons: [
          row.charger_status === "AVAILABLE" ? "Charger available" : "Charger currently occupied",
          connectorMatch ? "Connector matches vehicle" : "Connector may not match vehicle",
          Number(row.queue_count || 0) === 0 ? "No waiting queue" : `${row.queue_count} vehicle(s) waiting`
        ]
      });
    }
    recommendations.sort((a, b) => b.recommendationScore - a.recommendationScore);
    res.json({ vehicle, recommendations: recommendations.slice(0, 10) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not generate recommendations." });
  }
});

app.get("/api/admin/ai/overview", requireRole("ADMIN"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id,s.name,
        (SELECT COUNT(*) FROM queue q WHERE q.station_id=s.id AND q.status IN ('WAITING','SERVING')) queue_count,
        (SELECT COUNT(*) FROM chargers c WHERE c.station_id=s.id AND c.status='AVAILABLE') available_chargers,
        (SELECT COUNT(*) FROM chargers c2 WHERE c2.station_id=s.id) total_chargers
      FROM charging_stations s
      WHERE s.status='APPROVED'
      ORDER BY queue_count DESC
    `);
    const output = rows.map(row => {
      const payload = { hour: new Date().getHours(), bookings_count: 0, queue_count: Number(row.queue_count), avg_duration_minutes: 45 };
      const demand = demandFallback(payload);
      return {
        stationId: row.id,
        stationName: row.name,
        queueCount: Number(row.queue_count),
        availableChargers: Number(row.available_chargers),
        totalChargers: Number(row.total_chargers),
        demandLevel: demand.level,
        demandScore: demand.score,
        predictedWaitMinutes: Math.ceil(Number(row.queue_count) * 45 / Math.max(Number(row.available_chargers), 1))
      };
    });
    res.json(output);
  } catch (error) {
    res.status(500).json({ error: "Could not load AI overview." });
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${error.message}` });
  }
  res.status(400).json({ error: error.message || "Request failed." });
});

app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/uploads/")) {
    return res.sendFile(path.join(__dirname, "public", "index.html"));
  }
  next();
});

app.listen(PORT, async () => {
  try {
    await pool.query("SELECT 1");
    console.log(`ChargeEase running at http://localhost:${PORT}`);
    console.log(`Optional ML service expected at ${ML_URL}`);
  } catch (error) {
    console.error("Server started, but MySQL is not connected:", error.message);
  }
});
