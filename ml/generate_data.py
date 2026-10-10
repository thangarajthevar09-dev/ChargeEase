
import numpy as np
import pandas as pd
from pathlib import Path

np.random.seed(42)

n = 200

data = pd.DataFrame({
    "hour": np.random.randint(0, 24, n),
    "day_type": np.random.choice([0, 1], n),
    "charger_power_kw": np.random.choice([7, 22, 30, 50, 60, 120], n),
    "battery_percent": np.random.randint(5, 81, n),
    "energy_required_kwh": np.random.uniform(5, 60, n).round(2),
    "available_chargers": np.random.randint(0, 9, n),
    "vehicles_waiting": np.random.randint(0, 13, n),
    "total_chargers": np.random.randint(2, 13, n)
})

# Generate charging duration (minutes)
data["charging_duration_min"] = (
    data["energy_required_kwh"] /
    data["charger_power_kw"] * 60
).round(2)

# Generate queue waiting time (minutes)
data["queue_wait_min"] = (
    data["vehicles_waiting"] * 12 +
    np.random.normal(0, 4, n)
).clip(0).round(2)

# Generate demand score and demand category
peak_hours = data["hour"].isin([8, 9, 10, 17, 18, 19, 20]).astype(int)

data["demand_score"] = (
    0.35 * peak_hours +
    0.35 * (data["vehicles_waiting"] / 12) +
    0.30 * (1 - data["available_chargers"] / 8)
).round(3)

data["high_demand"] = (
    data["demand_score"] >= 0.50
).astype(int)

# Save dataset in the ml folder
output = Path(__file__).resolve().parent / "sample_ev_data.csv"
data.to_csv(output, index=False)

print("Dataset generated successfully!")
print("Total records:", len(data))
print("Saved to:", output)
print("\nFirst 5 records:")
print(data.head().to_string(index=False))
print("\nDemand category counts:")
print(data["high_demand"].value_counts().sort_index())
