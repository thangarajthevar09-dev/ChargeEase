require("dotenv").config();
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "chargeease"
  });

  const adminHash = await bcrypt.hash("Admin@123", 12);
  const userHash = await bcrypt.hash("User@123", 12);
  const ownerHash = await bcrypt.hash("Owner@123", 12);

  await db.query(`
    INSERT INTO users(name,email,password_hash,role)
    VALUES('ChargeEase Admin','admin@chargeease.local',?,'ADMIN')
    ON DUPLICATE KEY UPDATE name=VALUES(name),password_hash=VALUES(password_hash),role='ADMIN'
  `, [adminHash]);

  await db.query(`
    INSERT INTO users(name,email,password_hash,role)
    VALUES('Demo User','user@chargeease.local',?,'USER')
    ON DUPLICATE KEY UPDATE name=VALUES(name),password_hash=VALUES(password_hash),role='USER'
  `, [userHash]);

  const [ownerRows] = await db.query("SELECT id FROM users WHERE email='owner@chargeease.local'");
  let ownerId;
  if (ownerRows.length) {
    ownerId = ownerRows[0].id;
  } else {
    const [result] = await db.query(
      "INSERT INTO users(name,mobile,email,password_hash,role) VALUES(?,?,?,?, 'STATION_OWNER')",
      ["Demo Station Owner", "9000000000", "owner@chargeease.local", ownerHash]
    );
    ownerId = result.insertId;
  }

  const [stationRows] = await db.query("SELECT id FROM charging_stations WHERE govt_name='ChargeEase Demo Station'");
  let stationId;
  if (stationRows.length) {
    stationId = stationRows[0].id;
  } else {
    const [result] = await db.query(`
      INSERT INTO charging_stations
      (owner_id,name,govt_name,address,city,state,pincode,latitude,longitude,operating_hours,contact_number,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'APPROVED')
    `, [
      ownerId,
      "ChargeEase Demo Station",
      "ChargeEase Demo Station",
      "Nerul, Navi Mumbai",
      "Navi Mumbai",
      "Maharashtra",
      "400706",
      19.0330,
      73.0297,
      "24 Hours",
      "9000000000"
    ]);
    stationId = result.insertId;
  }

  const [[chargerCount]] = await db.query("SELECT COUNT(*) count FROM chargers WHERE station_id=?", [stationId]);
  if (!Number(chargerCount.count)) {
    await db.query(`
      INSERT INTO chargers(station_id,charger_name,connector_type,current_type,power_kw,speed_category,price_per_kwh,status)
      VALUES(?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?)
    `, [
      stationId, "CCS2 Fast Charger", "CCS2", "DC", 60, "Fast", 18, "AVAILABLE",
      stationId, "Type 2 AC Charger", "Type 2", "AC", 22, "Standard", 12, "AVAILABLE"
    ]);
  }

  const [vehicleRows] = await db.query("SELECT id FROM vehicles WHERE user_id=(SELECT id FROM users WHERE email='user@chargeease.local')");
  if (!vehicleRows.length) {
    const [[user]] = await db.query("SELECT id FROM users WHERE email='user@chargeease.local'");
    await db.query(`
      INSERT INTO vehicles(user_id,nickname,make,model,battery_capacity_kwh,connector_type,current_battery_percent,target_battery_percent,is_default)
      VALUES(?,?,?,?,?,?,?,?,TRUE)
    `, [user.id, "Demo EV", "Tata", "Nexon EV", 40.5, "CCS2", 25, 80]);
  }

  await db.end();
  console.log("ChargeEase seed complete.");
  console.log("Admin: admin@chargeease.local / Admin@123");
  console.log("User: user@chargeease.local / User@123");
  console.log("Owner: owner@chargeease.local / Owner@123");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
