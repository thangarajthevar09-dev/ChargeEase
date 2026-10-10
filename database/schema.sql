CREATE DATABASE IF NOT EXISTS chargeease CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE chargeease;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  mobile VARCHAR(30),
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('USER','STATION_OWNER','ADMIN') NOT NULL DEFAULT 'USER',
  avatar_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role(role)
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  nickname VARCHAR(100) NOT NULL,
  make VARCHAR(100),
  model VARCHAR(100) NOT NULL,
  battery_capacity_kwh DECIMAL(8,2) NOT NULL,
  connector_type VARCHAR(50) NOT NULL,
  current_battery_percent DECIMAL(5,2) DEFAULT 20,
  target_battery_percent DECIMAL(5,2) DEFAULT 80,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_vehicle_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_vehicle_user(user_id)
);

CREATE TABLE IF NOT EXISTS charging_stations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_id INT NOT NULL,
  name VARCHAR(150) NOT NULL,
  govt_name VARCHAR(200) NOT NULL,
  address VARCHAR(300) NOT NULL,
  city VARCHAR(100) NOT NULL DEFAULT 'Navi Mumbai',
  state VARCHAR(100) NOT NULL DEFAULT 'Maharashtra',
  pincode VARCHAR(15),
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  operating_hours VARCHAR(100) DEFAULT '24 Hours',
  contact_number VARCHAR(30),
  station_photo VARCHAR(500),
  status ENUM('PENDING','APPROVED','REJECTED','CHANGES_REQUIRED') NOT NULL DEFAULT 'PENDING',
  rating_average DECIMAL(3,2) DEFAULT 0,
  rating_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_station_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_station_status(status),
  INDEX idx_station_location(latitude,longitude),
  INDEX idx_station_owner(owner_id)
);

CREATE TABLE IF NOT EXISTS chargers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  station_id INT NOT NULL,
  charger_name VARCHAR(100) NOT NULL,
  connector_type VARCHAR(50) NOT NULL,
  current_type ENUM('AC','DC') NOT NULL,
  power_kw DECIMAL(8,2) NOT NULL,
  speed_category VARCHAR(80),
  price_per_kwh DECIMAL(10,2) DEFAULT 0,
  status ENUM('AVAILABLE','OCCUPIED','MAINTENANCE') NOT NULL DEFAULT 'AVAILABLE',
  image VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_charger_station FOREIGN KEY(station_id) REFERENCES charging_stations(id) ON DELETE CASCADE,
  INDEX idx_charger_station_status(station_id,status)
);

CREATE TABLE IF NOT EXISTS station_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  station_id INT NOT NULL,
  document_type VARCHAR(200) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_doc_station FOREIGN KEY(station_id) REFERENCES charging_stations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_verifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  station_id INT NOT NULL,
  admin_id INT NULL,
  status ENUM('PENDING','APPROVED','REJECTED','CHANGES_REQUIRED') NOT NULL,
  remarks VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ver_station FOREIGN KEY(station_id) REFERENCES charging_stations(id) ON DELETE CASCADE,
  CONSTRAINT fk_ver_admin FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_ver_station(station_id,created_at)
);

CREATE TABLE IF NOT EXISTS reservations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  charger_id INT NOT NULL,
  vehicle_id INT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  estimated_minutes INT DEFAULT 60,
  estimated_energy_kwh DECIMAL(10,2) DEFAULT 0,
  estimated_cost DECIMAL(10,2) DEFAULT 0,
  status ENUM('CONFIRMED','ACTIVE','COMPLETED','CANCELLED','NO_SHOW') NOT NULL DEFAULT 'CONFIRMED',
  payment_status ENUM('PENDING','PAID','REFUNDED','NOT_REQUIRED') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_res_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_res_charger FOREIGN KEY(charger_id) REFERENCES chargers(id) ON DELETE CASCADE,
  CONSTRAINT fk_res_vehicle FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
  INDEX idx_reservation_overlap(charger_id,status,start_time,end_time),
  INDEX idx_res_user(user_id,start_time)
);

CREATE TABLE IF NOT EXISTS queue (
  id INT AUTO_INCREMENT PRIMARY KEY,
  station_id INT NOT NULL,
  user_id INT NOT NULL,
  vehicle_id INT NULL,
  queue_number INT NOT NULL,
  estimated_wait_minutes INT DEFAULT 0,
  status ENUM('WAITING','SERVING','SERVED','CANCELLED') NOT NULL DEFAULT 'WAITING',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  served_at DATETIME NULL,
  CONSTRAINT fk_queue_station FOREIGN KEY(station_id) REFERENCES charging_stations(id) ON DELETE CASCADE,
  CONSTRAINT fk_queue_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_queue_vehicle FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
  INDEX idx_queue_station_status(station_id,status,queue_number),
  INDEX idx_queue_user(user_id,status)
);

CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  reservation_id INT NULL,
  amount DECIMAL(10,2) NOT NULL,
  method ENUM('SIMULATED_UPI','SIMULATED_CARD','SIMULATED_WALLET','FREE') NOT NULL,
  transaction_ref VARCHAR(80) NOT NULL UNIQUE,
  status ENUM('SUCCESS','PENDING','FAILED','REFUNDED') NOT NULL DEFAULT 'SUCCESS',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_payment_reservation FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE SET NULL,
  INDEX idx_payment_user(user_id,created_at)
);

CREATE TABLE IF NOT EXISTS charging_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reservation_id INT NOT NULL,
  user_id INT NOT NULL,
  charger_id INT NOT NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  energy_kwh DECIMAL(10,2) DEFAULT 0,
  duration_minutes INT DEFAULT 0,
  amount DECIMAL(10,2) DEFAULT 0,
  status ENUM('SCHEDULED','CHARGING','COMPLETED','CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_session_res FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE CASCADE,
  CONSTRAINT fk_session_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_session_charger FOREIGN KEY(charger_id) REFERENCES chargers(id) ON DELETE CASCADE,
  INDEX idx_session_charger(charger_id,status)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  station_id INT NOT NULL,
  reservation_id INT NULL,
  rating TINYINT NOT NULL,
  review_text VARCHAR(1000),
  status ENUM('VISIBLE','HIDDEN','FLAGGED') NOT NULL DEFAULT 'VISIBLE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_review_rating CHECK(rating BETWEEN 1 AND 5),
  CONSTRAINT fk_review_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_review_station FOREIGN KEY(station_id) REFERENCES charging_stations(id) ON DELETE CASCADE,
  CONSTRAINT fk_review_res FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE SET NULL,
  INDEX idx_review_station(station_id,status,created_at)
);

CREATE TABLE IF NOT EXISTS complaints (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  station_id INT NULL,
  subject VARCHAR(200) NOT NULL,
  description VARCHAR(1500) NOT NULL,
  priority ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
  status ENUM('OPEN','IN_PROGRESS','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN',
  admin_response VARCHAR(1500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_complaint_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_complaint_station FOREIGN KEY(station_id) REFERENCES charging_stations(id) ON DELETE SET NULL,
  INDEX idx_complaint_status(status,created_at)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(180) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  type ENUM('SYSTEM','RESERVATION','QUEUE','PAYMENT','REVIEW','STATION','AI') NOT NULL DEFAULT 'SYSTEM',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notification_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notification_user(user_id,is_read,created_at)
);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  charger_id INT NOT NULL,
  owner_id INT NOT NULL,
  issue_title VARCHAR(200) NOT NULL,
  issue_description VARCHAR(1000),
  status ENUM('OPEN','IN_PROGRESS','RESOLVED') NOT NULL DEFAULT 'OPEN',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  CONSTRAINT fk_maintenance_charger FOREIGN KEY(charger_id) REFERENCES chargers(id) ON DELETE CASCADE,
  CONSTRAINT fk_maintenance_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_maintenance_status(status)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  action VARCHAR(120) NOT NULL,
  entity_type VARCHAR(80),
  entity_id INT NULL,
  details JSON NULL,
  ip_address VARCHAR(64),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_audit_created(created_at),
  INDEX idx_audit_user(user_id,created_at)
);

CREATE TABLE IF NOT EXISTS ai_predictions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  station_id INT NULL,
  prediction_type VARCHAR(80) NOT NULL,
  input_json JSON NOT NULL,
  output_json JSON NOT NULL,
  model_name VARCHAR(120) NOT NULL DEFAULT 'rule-fallback',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_station FOREIGN KEY(station_id) REFERENCES charging_stations(id) ON DELETE SET NULL,
  INDEX idx_ai_station_type(station_id,prediction_type,created_at)
);

CREATE TABLE IF NOT EXISTS station_demand_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  station_id INT NOT NULL,
  observation_date DATE NOT NULL,
  hour_of_day TINYINT NOT NULL,
  day_of_week TINYINT NOT NULL,
  bookings_count INT NOT NULL DEFAULT 0,
  queue_count INT NOT NULL DEFAULT 0,
  avg_duration_minutes DECIMAL(8,2) DEFAULT 0,
  completed_sessions INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_demand_station FOREIGN KEY(station_id) REFERENCES charging_stations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_demand_observation(station_id,observation_date,hour_of_day)
);
