from __future__ import annotations

import json
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

SERVICE_DIR = Path(__file__).resolve().parent
FTW_DIR = SERVICE_DIR / "ftw-baselines"
FTW_PYTHON = FTW_DIR / ".venv" / "Scripts" / "python.exe"
WORKER = SERVICE_DIR / "ftw_field_worker.py"
SENTINEL_WATER_WORKER = SERVICE_DIR / "sentinel_water_worker.py"

_FTW_LOCK = threading.Lock()

LAND_CLASS_IDS = {
    "bareland": 1,
    "grass": 2,
    "pavement": 3,
    "road": 4,
    "tree": 5,
    "water": 6,
    "crop": 7,
    "building": 8,
}


def get_sentinel_water_prior(
    box: dict[str, float],
    size: tuple[int, int],
) -> tuple[np.ndarray, dict[str, Any]]:
    """Fetch a cached, free Sentinel-2 NDWI water probability layer."""

    if not FTW_PYTHON.exists():
        raise RuntimeError("FTW environment is not installed.")
    if not SENTINEL_WATER_WORKER.exists():
        raise RuntimeError("Sentinel water worker is not installed.")

    width, height = size
    payload = {
        "box": {
            "west": float(box["west"]),
            "south": float(box["south"]),
            "east": float(box["east"]),
            "north": float(box["north"]),
        },
        "width": int(width),
        "height": int(height),
        "year": 2025,
    }

    with tempfile.TemporaryDirectory(prefix="agriterrain-water-") as temp_dir:
        temp_path = Path(temp_dir)
        request_file = temp_path / "request.json"
        output_file = temp_path / "sentinel_water.npy"
        request_file.write_text(json.dumps(payload), encoding="utf-8")

        with _FTW_LOCK:
            process = subprocess.run(
                [
                    str(FTW_PYTHON),
                    str(SENTINEL_WATER_WORKER),
                    str(request_file),
                    str(output_file),
                ],
                cwd=str(FTW_DIR),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
            )

        marker = "__AGRITERRAIN_SENTINEL_WATER_JSON__"
        metadata: dict[str, Any] = {}
        for line in process.stdout.splitlines():
            if line.startswith("SENTINEL "):
                print(line)
            if line.startswith(marker):
                metadata = json.loads(line[len(marker):])

        if process.returncode != 0 or not output_file.is_file():
            message = process.stderr.strip() or process.stdout.strip()
            raise RuntimeError(
                f"Sentinel-2 water confirmation failed: {message[-1800:]}"
            )

        water_prior = np.load(output_file).astype(np.float32)
        if water_prior.shape != (height, width):
            raise RuntimeError("Sentinel-2 water confirmation returned an invalid size.")
        return water_prior, metadata


def _remove_small_components(mask: np.ndarray, minimum_pixels: int) -> np.ndarray:
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8),
        connectivity=8,
    )
    cleaned = np.zeros_like(mask, dtype=bool)
    for label in range(1, component_count):
        if int(stats[label, cv2.CC_STAT_AREA]) >= minimum_pixels:
            cleaned[labels == label] = True
    return cleaned


def get_visible_field_boundaries(
    box: dict[str, float],
    *,
    image: Image.Image,
    probabilities: np.ndarray,
    selected_mask: np.ndarray,
    excluded_mask: np.ndarray,
    minimum_area_m2: float = 120.0,
    max_features: int = 250,
) -> list[dict[str, Any]]:
    """Split model-supported agricultural land along real visible RGB edges."""

    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    height, width = rgb.shape[:2]
    selected = np.asarray(selected_mask, dtype=bool)
    excluded = np.asarray(excluded_mask, dtype=bool)
    if selected.shape != (height, width) or probabilities.shape[:2] != (height, width):
        raise RuntimeError("Visible field detector received inconsistent raster sizes.")

    centre_latitude = (float(box["north"]) + float(box["south"])) / 2.0
    width_metres = (
        abs(float(box["east"]) - float(box["west"]))
        * 111_320.0
        * np.cos(np.radians(centre_latitude))
    )
    height_metres = (
        abs(float(box["north"]) - float(box["south"])) * 110_540.0
    )
    metres_per_pixel_x = width_metres / max(width, 1)
    metres_per_pixel_y = height_metres / max(height, 1)
    square_metres_per_pixel = max(metres_per_pixel_x * metres_per_pixel_y, 1e-6)
    minimum_pixels = max(18, round(minimum_area_m2 / square_metres_per_pixel))

    agriculture_probability = np.clip(
        probabilities[:, :, LAND_CLASS_IDS["crop"]]
        + probabilities[:, :, LAND_CLASS_IDS["grass"]]
        + probabilities[:, :, LAND_CLASS_IDS["bareland"]],
        0.0,
        1.0,
    )
    conflict_probability = np.maximum.reduce(
        [
            probabilities[:, :, LAND_CLASS_IDS[class_key]]
            for class_key in ("pavement", "road", "tree", "water", "building")
        ]
    )
    candidate = (
        (agriculture_probability >= 0.42)
        & (agriculture_probability >= conflict_probability)
        & selected
        & ~excluded
    )
    candidate = cv2.morphologyEx(
        candidate.astype(np.uint8),
        cv2.MORPH_CLOSE,
        np.ones((5, 5), dtype=np.uint8),
    ).astype(bool)
    candidate = cv2.morphologyEx(
        candidate.astype(np.uint8),
        cv2.MORPH_OPEN,
        np.ones((3, 3), dtype=np.uint8),
    ).astype(bool)
    candidate &= selected & ~excluded
    candidate = _remove_small_components(candidate, minimum_pixels)
    if not np.any(candidate):
        print("VISIBLE FIELD PARCELS: 0")
        return []

    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    lab = cv2.GaussianBlur(lab, (5, 5), 0)
    gradients = []
    for channel in range(3):
        horizontal = cv2.Sobel(lab[:, :, channel], cv2.CV_32F, 1, 0, ksize=3)
        vertical = cv2.Sobel(lab[:, :, channel], cv2.CV_32F, 0, 1, ksize=3)
        gradients.append(cv2.magnitude(horizontal, vertical))
    edge_strength = np.maximum.reduce(gradients)
    edge_threshold = max(float(np.percentile(edge_strength[candidate], 78)), 22.0)
    edge_barrier = (edge_strength >= edge_threshold) & candidate
    edge_barrier = cv2.dilate(
        edge_barrier.astype(np.uint8),
        np.ones((3, 3), dtype=np.uint8),
        iterations=1,
    ).astype(bool)

    interiors = candidate & ~edge_barrier
    interiors = cv2.morphologyEx(
        interiors.astype(np.uint8),
        cv2.MORPH_OPEN,
        np.ones((3, 3), dtype=np.uint8),
    ).astype(bool)
    seed_count, seed_labels, seed_stats, _ = cv2.connectedComponentsWithStats(
        interiors.astype(np.uint8),
        connectivity=8,
    )
    minimum_seed_pixels = max(10, round(minimum_pixels * 0.12))
    seed_mask = np.zeros_like(candidate, dtype=bool)
    seed_areas = []
    for label in range(1, seed_count):
        area = int(seed_stats[label, cv2.CC_STAT_AREA])
        if area >= minimum_seed_pixels:
            seed_areas.append((area, label))
    for _, label in sorted(seed_areas, reverse=True)[: max_features * 3]:
        seed_mask[seed_labels == label] = True

    if not np.any(seed_mask):
        seed_mask = cv2.erode(
            candidate.astype(np.uint8),
            np.ones((3, 3), dtype=np.uint8),
            iterations=1,
        ).astype(bool)
    if not np.any(seed_mask):
        print("VISIBLE FIELD PARCELS: 0")
        return []

    distance_source = np.ones((height, width), dtype=np.uint8)
    distance_source[seed_mask] = 0
    _, nearest_seed = cv2.distanceTransformWithLabels(
        distance_source,
        cv2.DIST_L2,
        5,
        labelType=cv2.DIST_LABEL_CCOMP,
    )

    selected_pixels = max(int(np.count_nonzero(selected)), 1)
    maximum_parcel_pixels = round(selected_pixels * 0.32)
    results: list[dict[str, Any]] = []
    for seed_label in np.unique(nearest_seed[seed_mask]):
        if seed_label <= 0:
            continue
        parcel_mask = candidate & (nearest_seed == seed_label)
        pixel_count = int(np.count_nonzero(parcel_mask))
        if pixel_count < minimum_pixels or pixel_count > maximum_parcel_pixels:
            continue

        agriculture_values = agriculture_probability[parcel_mask]
        agriculture_mean = float(agriculture_values.mean())
        agriculture_dominance = float(
            np.count_nonzero(
                agriculture_values >= conflict_probability[parcel_mask]
            )
            / pixel_count
        )
        if agriculture_mean < 0.48 or agriculture_dominance < 0.58:
            continue

        contours, _ = cv2.findContours(
            parcel_mask.astype(np.uint8),
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        contour_area = float(cv2.contourArea(contour))
        if contour_area < minimum_pixels * 0.75:
            continue
        x, y, parcel_width, parcel_height = cv2.boundingRect(contour)
        aspect_ratio = max(
            parcel_width / max(parcel_height, 1),
            parcel_height / max(parcel_width, 1),
        )
        perimeter = float(cv2.arcLength(contour, True))
        compactness = 4.0 * np.pi * contour_area / max(perimeter * perimeter, 1.0)
        if aspect_ratio > 9.0 or compactness < 0.035:
            continue

        boundary_pixels = cv2.dilate(
            parcel_mask.astype(np.uint8),
            np.ones((3, 3), dtype=np.uint8),
        ).astype(bool) ^ parcel_mask
        edge_scale = max(float(np.percentile(edge_strength, 95)), 1.0)
        edge_support = min(
            float(edge_strength[boundary_pixels].mean()) / edge_scale
            if np.any(boundary_pixels)
            else 0.0,
            1.0,
        )
        confidence = np.clip(
            0.58 * agriculture_mean
            + 0.27 * agriculture_dominance
            + 0.15 * edge_support,
            0.0,
            1.0,
        )

        simplified = cv2.approxPolyDP(
            contour,
            max(1.2, perimeter * 0.004),
            True,
        ).reshape(-1, 2)
        if len(simplified) < 3:
            continue
        coordinates = [
            [
                round(
                    float(box["north"])
                    - float(pixel_y) / max(height - 1, 1)
                    * (float(box["north"]) - float(box["south"])),
                    7,
                ),
                round(
                    float(box["west"])
                    + float(pixel_x) / max(width - 1, 1)
                    * (float(box["east"]) - float(box["west"])),
                    7,
                ),
            ]
            for pixel_x, pixel_y in simplified
        ]
        if coordinates[0] != coordinates[-1]:
            coordinates.append(coordinates[0])
        results.append(
            {
                "coordinates": coordinates,
                "area_m2": round(pixel_count * square_metres_per_pixel, 1),
                "confidence": round(float(confidence) * 100.0, 1),
                "id": f"visible-field-{len(results) + 1}",
            }
        )

    results.sort(key=lambda region: (region["confidence"], region["area_m2"]), reverse=True)
    print(f"VISIBLE FIELD PARCELS: {len(results[:max_features])}")
    return results[:max_features]


def get_field_boundaries(
    boundary: Any,
    box: dict[str, float],
    *,
    image: Image.Image,
    probabilities: np.ndarray,
    selected_mask: np.ndarray,
    excluded_mask: np.ndarray,
    max_features: int = 250,
) -> list[dict[str, Any]]:
    if not FTW_PYTHON.exists():
        raise RuntimeError("FTW environment is not installed.")

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
        "box": {
            "west": float(box["west"]),
            "south": float(box["south"]),
            "east": float(box["east"]),
            "north": float(box["north"]),
        },
        "boundary": boundary_data,
        "max_features": int(max_features),
    }

    with tempfile.TemporaryDirectory(prefix="agriterrain-ftw-") as temp_dir:
        temp_path = Path(temp_dir)
        request_file = Path(temp_dir) / "request.json"
        image_file = temp_path / "visible_imagery.png"
        probability_file = temp_path / "class_probabilities.npy"
        selection_file = temp_path / "selected_mask.npy"
        exclusion_file = temp_path / "excluded_mask.npy"

        request_file.write_text(json.dumps(payload), encoding="utf-8")
        image.convert("RGB").save(image_file)
        np.save(probability_file, np.asarray(probabilities, dtype=np.float32))
        np.save(selection_file, np.asarray(selected_mask, dtype=np.uint8))
        np.save(exclusion_file, np.asarray(excluded_mask, dtype=np.uint8))

        with _FTW_LOCK:
            process = subprocess.run(
                [
                    str(FTW_PYTHON),
                    str(WORKER),
                    str(request_file),
                    temp_dir,
                    str(image_file),
                    str(probability_file),
                    str(selection_file),
                    str(exclusion_file),
                ],
                cwd=str(FTW_DIR),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=900,
            )

        marker = "__AGRITERRAIN_FTW_JSON__"

        for line in process.stdout.splitlines():
            if line.startswith("FTW "):
                print(line)

        if process.returncode != 0:
            message = process.stderr.strip() or process.stdout.strip()
            raise RuntimeError(
                f"FTW field detection failed: {message[-2000:]}"
            )

        for line in reversed(process.stdout.splitlines()):
            if line.startswith(marker):
                result = json.loads(line[len(marker):])
                return result[:max_features]

        message = process.stderr.strip() or process.stdout.strip()
        raise RuntimeError(
            f"FTW field detection failed: {message[-1500:]}"
        )

