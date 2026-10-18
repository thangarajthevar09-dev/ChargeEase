from __future__ import annotations

import os
import math
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from flask import Flask, jsonify, request
from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier
from sklearn.preprocessing import LabelEncoder

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
MODEL_DIR = BASE_DIR / "models"
DATA_DIR.mkdir(exist_ok=True)
MODEL_DIR.mkdir(exist_ok=True)

app = Flask(__name__)

DURATION_MODEL = MODEL_DIR / "duration_model.joblib"
DEMAND_MODEL = MODEL_DIR / "demand_model.joblib"
QUEUE_MODEL = MODEL_DIR / "queue_model.joblib"


def synthetic_duration_dataset(n=800):
    rng = np.random.default_rng(42)
    power = rng.choice([7, 11, 22, 30, 50, 60, 120], n)
    battery = rng.uniform(25, 120, n)
    current = rng.uniform(5, 85, n)
    target = np.minimum(100, current + rng.uniform(10, 55, n))
    energy = battery * np.maximum(target-current, 5) / 100
    connector = rng.choice([0, 1, 2, 3], n)
    duration = (energy / np.maximum(power * 0.88, 1)) * 60
    duration *= rng.uniform(0.85, 1.20, n)
    duration += np.where(power < 25, 8, 3)
    return pd.DataFrame({
        "power_kw": power,
        "battery_capacity_kwh": battery,
        "current_battery_percent": current,
        "target_battery_percent": target,
        "connector_code": connector,
        "estimated_energy_kwh": energy,
        "duration_minutes": np.maximum(duration, 5),
    })


def load_or_create_duration_data():
    csv = DATA_DIR / "charging_history.csv"
    if csv.exists():
        df = pd.read_csv(csv)
        required = [
            "power_kw", "battery_capacity_kwh", "current_battery_percent",
            "target_battery_percent", "connector_code", "estimated_energy_kwh",
            "duration_minutes"
        ]
        if all(x in df.columns for x in required) and len(df) >= 20:
            return df[required].dropna()
    return synthetic_duration_dataset()


def train_duration_model():
    df = load_or_create_duration_data()
    X = df[[
        "power_kw", "battery_capacity_kwh", "current_battery_percent",
        "target_battery_percent", "connector_code", "estimated_energy_kwh"
    ]]
    y = df["duration_minutes"]
    model = RandomForestRegressor(
        n_estimators=180,
        random_state=42,
        max_depth=12,
        min_samples_leaf=2,
    )
    model.fit(X, y)
    joblib.dump(model, DURATION_MODEL)
    return model


def get_duration_model():
    if DURATION_MODEL.exists():
        return joblib.load(DURATION_MODEL)
    return train_duration_model()


def duration_features(data):
    battery = float(data.get("battery_capacity_kwh", 50))
    current = float(data.get("current_battery_percent", 20))
    target = float(data.get("target_battery_percent", 80))
    power = max(float(data.get("power_kw", 22)), 1)
    connector_map = {"CCS2": 0, "TYPE2": 1, "CHADEMO": 2, "GB/T": 3}
    connector = str(data.get("connector_type", "CCS2")).upper().replace(" ", "")
    connector_code = connector_map.get(connector, 0)
    energy = battery * max(target-current, 5) / 100
    return pd.DataFrame([{
        "power_kw": power,
        "battery_capacity_kwh": battery,
        "current_battery_percent": current,
        "target_battery_percent": target,
        "connector_code": connector_code,
        "estimated_energy_kwh": energy,
    }]), energy


def demand_fallback(data):
    hour = int(data.get("hour", datetime.now().hour))
    queue = float(data.get("queue_count", 0))
    bookings = float(data.get("bookings_count", 0))
    duration = float(data.get("avg_duration_minutes", 45))
    base = 2.0
    if 7 <= hour <= 10:
        base += 2.5
    if 17 <= hour <= 21:
        base += 4.0
    score = base + bookings * 0.9 + queue * 1.4 + duration / 90
    level = "Low" if score < 5 else "Medium" if score < 10 else "High"
    return score, level


def queue_fallback(data):
    queue_count = max(int(data.get("queue_count", 0)), 0)
    active = max(int(data.get("active_chargers", 1)), 1)
    avg = max(float(data.get("avg_duration_minutes", 45)), 5)
    wait = math.ceil((queue_count / active) * avg)
    return wait


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "ChargeEase ML service"})


@app.post("/predict/duration")
def predict_duration():
    try:
        data = request.get_json(force=True) or {}
        X, energy = duration_features(data)
        model = get_duration_model()
        prediction = float(model.predict(X)[0])
        prediction = max(5, min(prediction, 480))
        return jsonify({
            "prediction_minutes": round(prediction),
            "estimated_energy_kwh": round(energy, 2),
            "model": "RandomForestRegressor",
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/predict/demand")
def predict_demand():
    try:
        data = request.get_json(force=True) or {}
        score, level = demand_fallback(data)
        return jsonify({
            "demand_score": round(score, 2),
            "demand_level": level,
            "model": "RandomForest-ready fallback",
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/predict/queue")
def predict_queue():
    try:
        data = request.get_json(force=True) or {}
        wait = queue_fallback(data)
        return jsonify({
            "estimated_wait_minutes": wait,
            "predicted_queue_length": max(0, int(data.get("queue_count", 0))),
            "model": "queue-estimator",
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/train/duration")
def train_duration():
    model = train_duration_model()
    return jsonify({
        "ok": True,
        "model": "RandomForestRegressor",
        "features": list(getattr(model, "feature_names_in_", [])),
    })


if __name__ == "__main__":
    host = os.getenv("ML_HOST", "127.0.0.1")
    port = int(os.getenv("ML_PORT", "5001"))
    app.run(host=host, port=port, debug=False)
