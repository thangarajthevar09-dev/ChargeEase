
from pathlib import Path

import matplotlib
matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    mean_absolute_error,
    mean_squared_error,
    r2_score,
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    confusion_matrix,
    ConfusionMatrixDisplay,
    roc_curve,
    roc_auc_score
)

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "sample_ev_data.csv"
OUTPUT_DIR = BASE_DIR / "evaluation_results"
OUTPUT_DIR.mkdir(exist_ok=True)

if not DATA_FILE.exists():
    raise FileNotFoundError(
        "sample_ev_data.csv not found. Run generate_data.py first."
    )

data = pd.read_csv(DATA_FILE)

features = [
    "hour",
    "day_type",
    "charger_power_kw",
    "battery_percent",
    "energy_required_kwh",
    "available_chargers",
    "vehicles_waiting",
    "total_chargers"
]

X = data[features]

results = []


def evaluate_regression(name, target):
    y = data[target]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.30, random_state=42
    )

    model = RandomForestRegressor(
        n_estimators=100,
        random_state=42
    )

    model.fit(X_train, y_train)
    predictions = model.predict(X_test)

    mae = mean_absolute_error(y_test, predictions)
    rmse = np.sqrt(mean_squared_error(y_test, predictions))
    r2 = r2_score(y_test, predictions)

    results.append({
        "Model": name,
        "Metric": "MAE (minutes)",
        "Value": round(mae, 4)
    })
    results.append({
        "Model": name,
        "Metric": "RMSE (minutes)",
        "Value": round(rmse, 4)
    })
    results.append({
        "Model": name,
        "Metric": "R2 score",
        "Value": round(r2, 4)
    })

    # Actual versus predicted graph
    plt.figure(figsize=(7, 5))
    plt.scatter(y_test, predictions)
    low = min(y_test.min(), predictions.min())
    high = max(y_test.max(), predictions.max())
    plt.plot([low, high], [low, high], linestyle="--")
    plt.xlabel("Actual time (minutes)")
    plt.ylabel("Predicted time (minutes)")
    plt.title(f"{name}: Actual vs Predicted")
    plt.tight_layout()
    plt.savefig(
        OUTPUT_DIR / f"{name.lower().replace(' ', '_')}_prediction.png"
    )
    plt.close()

    return model


def evaluate_classification():
    y = data["high_demand"]

    if y.nunique() != 2 or y.value_counts().min() < 2:
        print("ROC evaluation skipped: both classes need enough records.")
        return None

    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=0.30,
        random_state=42,
        stratify=y
    )

    model = RandomForestClassifier(
        n_estimators=100,
        random_state=42,
        class_weight="balanced"
    )

    model.fit(X_train, y_train)

    predictions = model.predict(X_test)
    probabilities = model.predict_proba(X_test)[:, 1]

    metrics = {
        "Accuracy": accuracy_score(y_test, predictions),
        "Precision": precision_score(
            y_test, predictions, zero_division=0
        ),
        "Recall": recall_score(
            y_test, predictions, zero_division=0
        ),
        "F1 score": f1_score(
            y_test, predictions, zero_division=0
        ),
        "ROC-AUC": roc_auc_score(y_test, probabilities)
    }

    for metric, value in metrics.items():
        results.append({
            "Model": "Station Demand",
            "Metric": metric,
            "Value": round(value, 4)
        })

    # Confusion matrix
    cm = confusion_matrix(y_test, predictions, labels=[0, 1])
    display = ConfusionMatrixDisplay(
        confusion_matrix=cm,
        display_labels=["Low demand", "High demand"]
    )
    display.plot()
    plt.title("Station Demand: Confusion Matrix")
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "confusion_matrix.png")
    plt.close()

    # ROC curve
    fpr, tpr, thresholds = roc_curve(y_test, probabilities)
    auc = roc_auc_score(y_test, probabilities)

    plt.figure(figsize=(7, 5))
    plt.plot(fpr, tpr, label=f"Random Forest (AUC = {auc:.3f})")
    plt.plot([0, 1], [0, 1], linestyle="--", label="Random baseline")
    plt.xlabel("False Positive Rate")
    plt.ylabel("True Positive Rate")
    plt.title("Station Demand: ROC Curve")
    plt.legend()
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "roc_curve.png")
    plt.close()

    # Feature importance
    importance = pd.Series(
        model.feature_importances_, index=features
    ).sort_values()

    plt.figure(figsize=(8, 5))
    importance.plot(kind="barh")
    plt.xlabel("Feature importance")
    plt.title("Station Demand: Feature Importance")
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "feature_importance.png")
    plt.close()

    return model


print("Training ChargeEase evaluation models...")

duration_model = evaluate_regression(
    "Charging Duration", "charging_duration_min"
)

queue_model = evaluate_regression(
    "Queue Waiting Time", "queue_wait_min"
)

demand_model = evaluate_classification()

results_df = pd.DataFrame(results)
results_df.to_csv(OUTPUT_DIR / "evaluation_metrics.csv", index=False)

print("\nEVALUATION RESULTS")
print(results_df.to_string(index=False))

print("\nResults saved in:", OUTPUT_DIR)
print("Evaluation complete.")
