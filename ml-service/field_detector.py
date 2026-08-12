from __future__ import annotations

import json
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

SERVICE_DIR = Path(__file__).resolve().parent
FTW_DIR = SERVICE_DIR / "ftw-baselines"
FTW_PYTHON = FTW_DIR / ".venv" / "Scripts" / "python.exe"
WORKER = SERVICE_DIR / "ftw_field_worker.py"

_FTW_LOCK = threading.Lock()


def get_field_boundaries(
    boundary: Any,
    box: tuple[float, float, float, float] | list[float],
    *,
    max_features: int = 250,
) -> list[dict[str, Any]]:
    if not FTW_PYTHON.exists():
        raise RuntimeError("FTW environment is not installed.")

    if isinstance(box, dict):
        min_lon = float(box["west"])
        min_lat = float(box["south"])
        max_lon = float(box["east"])
        max_lat = float(box["north"])
    else:
        min_lon, min_lat, max_lon, max_lat = map(float, box)

    # Give the model some surrounding context because Sentinel-2 is 10 m resolution.
    lat_pad = 0.0075
    lon_pad = 0.0085

    inference_box = [
        min_lon - lon_pad,
        min_lat - lat_pad,
        max_lon + lon_pad,
        max_lat + lat_pad,
    ]

    boundary_data = []
    for point in boundary:
        if hasattr(point, "lat"):
            lat = float(point.lat)
            lon = float(
                getattr(point, "lng", getattr(point, "lon", 0.0))
            )
        elif isinstance(point, dict):
            lat = float(point.get("lat"))
            lon = float(point.get("lng", point.get("lon")))
        else:
            lat = float(point[0])
            lon = float(point[1])

        boundary_data.append([lat, lon])

    payload = {
        "bbox": inference_box,
        "selection_bbox": [min_lon, min_lat, max_lon, max_lat],
        "boundary": boundary_data,
        "max_features": int(max_features),
    }

    with tempfile.TemporaryDirectory(prefix="agriterrain-ftw-") as temp_dir:
        request_file = Path(temp_dir) / "request.json"
        request_file.write_text(json.dumps(payload), encoding="utf-8")

        with _FTW_LOCK:
            process = subprocess.run(
                [
                    str(FTW_PYTHON),
                    str(WORKER),
                    str(request_file),
                    temp_dir,
                ],
                cwd=str(FTW_DIR),
                capture_output=True,
                text=True,
                timeout=900,
            )

        marker = "__AGRITERRAIN_FTW_JSON__"

        for line in reversed(process.stdout.splitlines()):
            if line.startswith(marker):
                result = json.loads(line[len(marker):])
                return result[:max_features]

        message = process.stderr.strip() or process.stdout.strip()
        raise RuntimeError(
            f"FTW field detection failed: {message[-1500:]}"
        )

