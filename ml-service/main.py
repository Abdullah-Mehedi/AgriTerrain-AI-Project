"""Real OpenEarthMap inference service for AgriTerrain AI.

The service downloads one public OpenEarthMap U-Net/EfficientNet-B4 checkpoint,
fetches the RGB image that corresponds to a user-drawn map boundary, runs
four-view test-time augmentation, and returns only model-derived masks and
vector regions. It never creates demonstration detections.
"""

from __future__ import annotations

import base64
import io
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Literal

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import cv2
import gdown
import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageDraw
from pydantic import BaseModel, Field
from building_footprints import get_building_footprints
from field_detector import (
    get_field_boundaries,
    get_sentinel_water_prior,
    get_visible_field_boundaries,
)
from imagery_tiles import fetch_esri_world_imagery

# PERF TIMING V1 — measurement only; does not change detection logic.
def _timed_stage(
    label: str,
    function: Callable[..., Any] | None = None,
) -> Callable[..., Any]:
    """Measure a stage without changing its behaviour.

    Supports both:
        _timed_stage("Stage", function)
        @_timed_stage("Stage")
    """

    def decorator(target: Callable[..., Any]) -> Callable[..., Any]:
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            started = time.perf_counter()
            try:
                return target(*args, **kwargs)
            finally:
                print(
                    f"PERF {label}: "
                    f"{time.perf_counter() - started:.2f}s"
                )

        return wrapper

    if function is None:
        return decorator

    return decorator(function)


get_building_footprints = _timed_stage("Microsoft buildings", get_building_footprints)
get_sentinel_water_prior = _timed_stage("Sentinel-2", get_sentinel_water_prior)
get_visible_field_boundaries = _timed_stage("Visible fields", get_visible_field_boundaries)
get_field_boundaries = _timed_stage("DAv2", get_field_boundaries)
fetch_esri_world_imagery = _timed_stage("Esri imagery", fetch_esri_world_imagery)


SERVICE_DIRECTORY = Path(__file__).resolve().parent
MODEL_DIRECTORY = Path(
    os.getenv(
        "AGRI_MODEL_DIRECTORY",
        str(SERVICE_DIRECTORY / "models" / "openearthmap-effnetb4-fold1"),
    )
)
IMAGE_SIZE = 512
MAX_SELECTION_SIDE_METRES = 420.0
MIN_SELECTION_SIDE_METRES = 20.0
MAX_FEATURES_PER_CLASS = 250

# Public files from the model folder linked by
# https://github.com/sebastianbahr/OpenEarthMap
MODEL_FILES = {
    "saved_model.pb": ("1P9qEqwP6DQf-rON9MkeawdAHz1oLQbvR", 8_000_000),
    "variables/variables.data-00000-of-00001": (
        "12EcAR98AhFxWzUjRMNqT688uw-kqeDhm",
        300_000_000,
    ),
    "variables/variables.index": ("168sI3mejey-shb3Hoyl4xDPHkyx7Wz_N", 100_000),
}

CLASS_IDS = {
    "unknown": 0,
    "bareland": 1,
    "grass": 2,
    "pavement": 3,
    "road": 4,
    "tree": 5,
    "water": 6,
    "crop": 7,
    "building": 8,
}

CLASS_SETTINGS = {
    "crop": {
        "minimum_area_m2": 220.0,
        "colour": (57, 177, 77, 170),
        "close_kernel": 3,
        "open_kernel": 2,
        "simplify": 0.006,
    },
    "water": {
        "minimum_area_m2": 60.0,
        "colour": (37, 142, 211, 180),
        "close_kernel": 3,
        "open_kernel": 3,
        "simplify": 0.008,
    },
    "building": {
        "minimum_area_m2": 10.0,
        "colour": (232, 132, 51, 185),
        "close_kernel": 2,
        "open_kernel": 2,
        "simplify": 0.012,
    },
}

# Precision-oriented floors. The user threshold may make these stricter, never looser.
CLASS_CONFIDENCE_FLOORS = {
    "crop": 0.55,
    "water": 0.70,
    "building": 0.60,
}
REGION_MEAN_CONFIDENCE_FLOORS = {
    "crop": 0.58,
    "water": 0.72,
    "building": 0.62,
}

MODEL_BENCHMARK = {
    "dataset": "OpenEarthMap held-out folds with test-time augmentation",
    "crop_iou": 79.82,
    "water_iou": 86.04,
    "building_iou": 80.92,
    "note": "Benchmark scores are not the measured accuracy of the selected image.",
}


app = FastAPI(
    title="AgriTerrain AI OpenEarthMap Service",
    version="2.0.0",
    description="High-resolution RGB land-cover segmentation without fake fallback data.",
)

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5300,http://127.0.0.1:5300",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


download_lock = threading.Lock()
model_lock = threading.Lock()
inference_lock = threading.Lock()
loaded_model: Any | None = None
serving_signature: Any | None = None
tensorflow_module: Any | None = None
legacy_session: Any | None = None
model_state = {"downloading": False, "last_error": ""}


class ModelSetupError(RuntimeError):
    """Raised when model files cannot be downloaded or loaded."""


class AnalyzeRequest(BaseModel):
    boundary: list[list[float]]
    location: str | None = Field(default=None, max_length=300)
    confidence_threshold: float = Field(default=0.55, ge=0.30, le=0.95)
    quality: Literal["accurate", "fast"] = "accurate"
    analysis_mode: Literal["standard", "balanced", "faster"] = "standard"


class ReportBackgroundRequest(BaseModel):
    boundary: list[list[float]]


def model_files_ready() -> bool:
    return all(
        (MODEL_DIRECTORY / relative_path).is_file()
        and (MODEL_DIRECTORY / relative_path).stat().st_size >= minimum_size
        for relative_path, (_, minimum_size) in MODEL_FILES.items()
    )


def model_status() -> str:
    if model_state["downloading"]:
        return "downloading"
    if loaded_model is not None:
        return "loaded"
    if model_files_ready():
        return "downloaded"
    if model_state["last_error"]:
        return "error"
    return "not_downloaded"


def ensure_model_files() -> Path:
    """Download the three SavedModel files once, with size checks."""

    if model_files_ready():
        return MODEL_DIRECTORY

    with download_lock:
        if model_files_ready():
            return MODEL_DIRECTORY

        model_state["downloading"] = True
        model_state["last_error"] = ""
        try:
            for relative_path, (file_id, minimum_size) in MODEL_FILES.items():
                target = MODEL_DIRECTORY / relative_path
                if target.is_file() and target.stat().st_size >= minimum_size:
                    continue

                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(f"{target.name}.part")
                temporary.unlink(missing_ok=True)

                downloaded_path = gdown.download(
                    id=file_id,
                    output=str(temporary),
                    quiet=False,
                    fuzzy=True,
                )
                if not downloaded_path or not temporary.is_file():
                    raise ModelSetupError(
                        f"Google Drive did not provide {target.name}. Try again later."
                    )
                if temporary.stat().st_size < minimum_size:
                    temporary.unlink(missing_ok=True)
                    raise ModelSetupError(
                        f"The downloaded {target.name} file was incomplete. Try again."
                    )
                os.replace(temporary, target)

            if not model_files_ready():
                raise ModelSetupError("The OpenEarthMap model download is incomplete.")
            return MODEL_DIRECTORY
        except Exception as error:
            model_state["last_error"] = str(error)
            if isinstance(error, ModelSetupError):
                raise
            raise ModelSetupError(f"Unable to download the AI model: {error}") from error
        finally:
            model_state["downloading"] = False


def import_tensorflow() -> Any:
    global tensorflow_module
    if tensorflow_module is not None:
        return tensorflow_module
    try:
        import tensorflow as tf  # Imported lazily so /health remains lightweight.
    except Exception as error:
        raise ModelSetupError(
            "TensorFlow is not installed correctly. Re-run pip install -r requirements.txt."
        ) from error
    tensorflow_module = tf
    return tensorflow_module


def _load_legacy_saved_model(model_path: Path, tf: Any) -> dict[str, Any]:
    """Load older SavedModels through the serving graph if object revival fails."""

    global legacy_session
    graph = tf.Graph()
    with graph.as_default():
        session = tf.compat.v1.Session(graph=graph)
        meta_graph = tf.compat.v1.saved_model.loader.load(
            session,
            [tf.saved_model.SERVING],
            str(model_path),
        )

    signature_def = meta_graph.signature_def.get("serving_default")
    if signature_def is None or not signature_def.inputs or not signature_def.outputs:
        session.close()
        raise ModelSetupError(
            "The downloaded model has no usable serving_default graph signature."
        )

    input_info = next(iter(signature_def.inputs.values()))
    output_info = next(iter(signature_def.outputs.values()))
    input_tensor = graph.get_tensor_by_name(input_info.name)
    output_tensor = graph.get_tensor_by_name(output_info.name)
    legacy_session = session
    return {
        "mode": "legacy_session",
        "session": session,
        "input": input_tensor,
        "output": output_tensor,
        "input_dtype": input_tensor.dtype.as_numpy_dtype,
    }


def get_model() -> tuple[Any, Any]:
    global loaded_model, serving_signature
    if loaded_model is not None and serving_signature is not None:
        return loaded_model, serving_signature

    with model_lock:
        if loaded_model is not None and serving_signature is not None:
            return loaded_model, serving_signature

        model_path = ensure_model_files()
        tf = import_tensorflow()
        object_loader_error: Exception | None = None
        try:
            next_model = tf.saved_model.load(str(model_path))
            signatures = getattr(next_model, "signatures", {})
            if "serving_default" not in signatures:
                raise ModelSetupError(
                    "The downloaded model has no serving_default inference signature."
                )
            loaded_model = next_model
            serving_signature = signatures["serving_default"]
            model_state["last_error"] = ""
            return loaded_model, serving_signature
        except Exception as error:
            object_loader_error = error

        try:
            legacy_signature = _load_legacy_saved_model(model_path, tf)
            loaded_model = {"mode": "legacy_session"}
            serving_signature = legacy_signature
            model_state["last_error"] = ""
            return loaded_model, serving_signature
        except Exception as legacy_error:
            detail = (
                f"TensorFlow object loader failed: {object_loader_error}. "
                f"Legacy serving-graph loader also failed: {legacy_error}"
            )
            model_state["last_error"] = detail
            raise ModelSetupError(
                f"The OpenEarthMap model could not be loaded. {detail}"
            ) from legacy_error


def validate_boundary(boundary: list[list[float]]) -> list[tuple[float, float]]:
    if len(boundary) < 3 or len(boundary) > 80:
        raise HTTPException(
            status_code=422,
            detail="Draw a boundary containing between 3 and 80 points.",
        )

    validated: list[tuple[float, float]] = []
    for point in boundary:
        if len(point) != 2:
            raise HTTPException(status_code=422, detail="Each point must be [latitude, longitude].")
        latitude, longitude = float(point[0]), float(point[1])
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise HTTPException(status_code=422, detail="Boundary coordinates are invalid.")
        validated.append((latitude, longitude))
    return validated


def boundary_box(boundary: list[tuple[float, float]]) -> dict[str, float]:
    latitudes = [point[0] for point in boundary]
    longitudes = [point[1] for point in boundary]
    box = {
        "south": min(latitudes),
        "west": min(longitudes),
        "north": max(latitudes),
        "east": max(longitudes),
    }
    if box["north"] == box["south"] or box["east"] == box["west"]:
        raise HTTPException(status_code=422, detail="The selected boundary has no measurable area.")
    return box


def box_dimensions_metres(box: dict[str, float]) -> tuple[float, float]:
    centre_latitude = (box["north"] + box["south"]) / 2
    width = (
        (box["east"] - box["west"])
        * 111_320
        * math.cos(math.radians(centre_latitude))
    )
    height = (box["north"] - box["south"]) * 110_540
    return abs(width), abs(height)


def validate_image_scale(box: dict[str, float]) -> dict[str, float | str]:
    width_metres, height_metres = box_dimensions_metres(box)
    longest_side = max(width_metres, height_metres)
    shortest_side = min(width_metres, height_metres)

    if longest_side > MAX_SELECTION_SIDE_METRES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"The selected area is about {longest_side:.0f} m across. "
                f"Zoom in and keep each side below {MAX_SELECTION_SIDE_METRES:.0f} m "
                "so houses and small ponds remain visible to the model."
            ),
        )
    if shortest_side < MIN_SELECTION_SIDE_METRES:
        raise HTTPException(
            status_code=422,
            detail="The selection is too narrow. Draw an area at least 20 m wide and high.",
        )

    horizontal_gsd = width_metres / IMAGE_SIZE
    vertical_gsd = height_metres / IMAGE_SIZE
    estimated_gsd = max(horizontal_gsd, vertical_gsd)
    if estimated_gsd <= 0.65:
        rating = "excellent"
    elif estimated_gsd <= 1.0:
        rating = "good"
    else:
        rating = "fair"

    return {
        "width_metres": round(width_metres, 1),
        "height_metres": round(height_metres, 1),
        "estimated_gsd_metres": round(estimated_gsd, 2),
        "quality_rating": rating,
    }


def polygon_area_hectares(boundary: list[tuple[float, float]]) -> float:
    average_latitude = sum(point[0] for point in boundary) / len(boundary)
    metres_per_longitude = 111_320 * math.cos(math.radians(average_latitude))
    metres_per_latitude = 110_540
    projected = [
        (longitude * metres_per_longitude, latitude * metres_per_latitude)
        for latitude, longitude in boundary
    ]
    twice_area = 0.0
    for index, (x1, y1) in enumerate(projected):
        x2, y2 = projected[(index + 1) % len(projected)]
        twice_area += x1 * y2 - x2 * y1
    return abs(twice_area) / 2 / 10_000


def fetch_satellite_image(box: dict[str, float]) -> Image.Image:
    try:
        return fetch_esri_world_imagery(box, IMAGE_SIZE)
    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=502,
            detail="The satellite imagery provider could not supply this selection.",
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="The satellite imagery provider returned no usable image.",
        ) from error


def polygon_pixel_mask(
    boundary: list[tuple[float, float]],
    box: dict[str, float],
    size: tuple[int, int],
) -> np.ndarray:
    width, height = size
    longitude_span = box["east"] - box["west"]
    latitude_span = box["north"] - box["south"]
    pixels = []
    for latitude, longitude in boundary:
        x = (longitude - box["west"]) / longitude_span * (width - 1)
        y = (box["north"] - latitude) / latitude_span * (height - 1)
        pixels.append((round(x), round(y)))

    mask_image = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask_image).polygon(pixels, fill=255)
    return np.asarray(mask_image) > 0


def regions_pixel_mask(
    regions: list[dict[str, Any]],
    box: dict[str, float],
    size: tuple[int, int],
) -> np.ndarray:
    """Rasterize flat polygons or Leaflet-style polygons with holes."""

    width, height = size
    longitude_span = box["east"] - box["west"]
    latitude_span = box["north"] - box["south"]

    mask_image = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask_image)

    def is_coordinate_pair(value: Any) -> bool:
        return (
            isinstance(value, (list, tuple))
            and len(value) >= 2
            and isinstance(value[0], (int, float))
            and isinstance(value[1], (int, float))
        )

    def ring_to_pixels(ring: list[Any]) -> list[tuple[int, int]]:
        pixels: list[tuple[int, int]] = []

        for point in ring:
            if not is_coordinate_pair(point):
                continue

            latitude = float(point[0])
            longitude = float(point[1])

            pixels.append(
                (
                    round(
                        (longitude - box["west"])
                        / longitude_span
                        * (width - 1)
                    ),
                    round(
                        (box["north"] - latitude)
                        / latitude_span
                        * (height - 1)
                    ),
                )
            )

        return pixels

    for region in regions:
        coordinates = region.get("coordinates") or []

        if not coordinates:
            continue

        # Old format:
        # [[lat, lon], [lat, lon], ...]
        if is_coordinate_pair(coordinates[0]):
            rings = [coordinates]

        # Hole-aware format:
        # [
        #   [[lat, lon], ...],   # outer
        #   [[lat, lon], ...],   # hole
        # ]
        else:
            rings = coordinates

        if not rings:
            continue

        outer_pixels = ring_to_pixels(rings[0])

        if len(outer_pixels) < 3:
            continue

        draw.polygon(outer_pixels, fill=255)

        # Internal rings are holes.
        for hole_ring in rings[1:]:
            hole_pixels = ring_to_pixels(hole_ring)

            if len(hole_pixels) >= 3:
                draw.polygon(hole_pixels, fill=0)

    return np.asarray(mask_image) > 0



@_timed_stage("Building fusion")
def merge_building_detections(
    microsoft_buildings: list[dict[str, Any]],
    semantic_buildings: list[dict[str, Any]],
    refined_water_mask: np.ndarray,
    box: dict[str, float],
    size: tuple[int, int],
    max_features: int,
) -> list[dict[str, Any]]:
    """Fuse Microsoft footprints with high-confidence OpenEarthMap backups.

    Microsoft remains the preferred geometry. OpenEarthMap contributes only
    buildings Microsoft missed. Strong overlap with confirmed Water V2 removes
    a building candidate from the visible orange result.
    """

    accepted: list[tuple[dict[str, Any], np.ndarray, str]] = []

    rejected_water_microsoft = 0
    rejected_water_semantic = 0
    rejected_semantic_confidence = 0
    rejected_semantic_duplicate = 0

    def region_mask(region: dict[str, Any]) -> np.ndarray:
        return regions_pixel_mask([region], box, size)

    def water_overlap(mask: np.ndarray) -> float:
        pixels = int(np.count_nonzero(mask))
        if pixels <= 0:
            return 1.0
        return float(
            np.count_nonzero(mask & refined_water_mask)
            / pixels
        )

    # --------------------------------------------------------
    # Microsoft first: preferred footprint geometry.
    # --------------------------------------------------------
    for region in microsoft_buildings:
        mask = region_mask(region)
        pixels = int(np.count_nonzero(mask))

        if pixels <= 0:
            continue

        overlap = water_overlap(mask)

        # A building almost entirely inside confirmed water is considered
        # a false/stale footprint. Small shoreline overlap remains allowed.
        if overlap >= 0.55:
            rejected_water_microsoft += 1
            continue

        accepted.append((dict(region), mask, "microsoft"))

    microsoft_masks = [
        mask
        for _, mask, source in accepted
        if source == "microsoft"
    ]

    # --------------------------------------------------------
    # OpenEarthMap backup: stricter than the crop-exclusion mask.
    # --------------------------------------------------------
    for region in semantic_buildings:
        confidence = float(region.get("confidence", 0.0))

        if confidence < 70.0:
            rejected_semantic_confidence += 1
            continue

        mask = region_mask(region)
        pixels = int(np.count_nonzero(mask))

        if pixels <= 0:
            continue

        overlap = water_overlap(mask)

        if overlap >= 0.45:
            rejected_water_semantic += 1
            continue

        duplicate = False

        for microsoft_mask in microsoft_masks:
            intersection = int(
                np.count_nonzero(mask & microsoft_mask)
            )

            if intersection <= 0:
                continue

            microsoft_pixels = int(
                np.count_nonzero(microsoft_mask)
            )

            union = (
                pixels
                + microsoft_pixels
                - intersection
            )

            iou = intersection / max(union, 1)
            semantic_containment = intersection / max(pixels, 1)

            # Microsoft geometry wins whenever the semantic region clearly
            # represents the same roof.
            if iou >= 0.20 or semantic_containment >= 0.35:
                duplicate = True
                break

        if duplicate:
            rejected_semantic_duplicate += 1
            continue

        backup_region = {
            **region,
            "source": "openearthmap-backup",
        }

        accepted.append(
            (backup_region, mask, "openearthmap")
        )

    # Microsoft results first, then confidence/area.
    accepted.sort(
        key=lambda item: (
            1 if item[2] == "microsoft" else 0,
            float(item[0].get("confidence", 0.0)),
            float(item[0].get("area_m2", 0.0)),
        ),
        reverse=True,
    )

    results: list[dict[str, Any]] = []

    microsoft_kept = 0
    semantic_kept = 0

    for index, (region, _, source) in enumerate(
        accepted[:max_features],
        start=1,
    ):
        if source == "microsoft":
            microsoft_kept += 1
        else:
            semantic_kept += 1

        results.append(
            {
                **region,
                "id": f"building-{index}",
            }
        )

    print(
        "BUILDING V2-A DIAGNOSTICS: "
        f"microsoft_input={len(microsoft_buildings)}, "
        f"semantic_input={len(semantic_buildings)}, "
        f"microsoft_kept={microsoft_kept}, "
        f"semantic_kept={semantic_kept}, "
        f"water_reject_ms={rejected_water_microsoft}, "
        f"water_reject_semantic={rejected_water_semantic}, "
        f"semantic_low_conf={rejected_semantic_confidence}, "
        f"semantic_duplicates={rejected_semantic_duplicate}, "
        f"final={len(results)}"
    )

    return results

def merge_field_boundaries(
    dav2_fields: list[dict[str, Any]],
    visible_fields: list[dict[str, Any]],
    box: dict[str, float],
    size: tuple[int, int],
    max_features: int,
) -> list[dict[str, Any]]:
    """Return precision-filtered visible parcels as the final field geometry.

    The visible-field stage has already removed water/buildings and rejected
    light non-crop surfaces, tree-like dark rough vegetation and strongly
    irregular blobs. DAv2 is therefore supporting evidence only: agreement can
    raise confidence, but disagreement never deletes an otherwise valid field.
    """

    visible_entries = [
        (region, regions_pixel_mask([region], box, size))
        for region in visible_fields
    ]
    dav2_entries = [
        (region, regions_pixel_mask([region], box, size))
        for region in dav2_fields
    ]

    accepted: list[tuple[dict[str, Any], np.ndarray]] = []

    dav2_confirmed_count = 0
    independent_count = 0
    duplicate_rejections = 0

    for region, mask in visible_entries:
        pixel_count = int(np.count_nonzero(mask))

        if pixel_count == 0:
            continue

        dav2_confirmed = False
        best_visible_containment = 0.0
        best_proposal_coverage = 0.0

        for _, dav2_mask in dav2_entries:
            dav2_pixel_count = int(np.count_nonzero(dav2_mask))

            if dav2_pixel_count == 0:
                continue

            intersection = int(np.count_nonzero(mask & dav2_mask))

            if intersection < 8:
                continue

            visible_containment = intersection / max(pixel_count, 1)
            proposal_coverage = intersection / max(dav2_pixel_count, 1)

            best_visible_containment = max(
                best_visible_containment,
                visible_containment,
            )
            best_proposal_coverage = max(
                best_proposal_coverage,
                proposal_coverage,
            )

            if (
                visible_containment >= 0.20
                and proposal_coverage >= 0.04
            ):
                dav2_confirmed = True
                break

        # DAv2 does not control acceptance anymore. It gives a small certainty
        # bonus when its proposal agrees with the precision-filtered parcel.
        original_confidence = float(region.get("confidence", 0.0))

        if dav2_confirmed:
            dav2_confirmed_count += 1
            adjusted_confidence = min(99.0, original_confidence + 5.0)
        else:
            independent_count += 1
            adjusted_confidence = original_confidence

        adjusted_region = {
            **region,
            "confidence": round(adjusted_confidence, 1),
            "dav2_confirmed": dav2_confirmed,
        }

        # Remove duplicate visible parcels only. A DAv2 proposal can never
        # replace or reshape the final visible-field geometry.
        duplicate = False

        for _, accepted_mask in accepted:
            accepted_pixel_count = int(np.count_nonzero(accepted_mask))

            intersection = int(np.count_nonzero(mask & accepted_mask))

            if intersection == 0:
                continue

            union = (
                pixel_count
                + accepted_pixel_count
                - intersection
            )

            iou = intersection / max(union, 1)

            smaller_containment = intersection / max(
                min(pixel_count, accepted_pixel_count),
                1,
            )

            if iou >= 0.45 or smaller_containment >= 0.72:
                duplicate = True
                break

        if duplicate:
            duplicate_rejections += 1
            continue

        accepted.append((adjusted_region, mask))

    accepted.sort(
        key=lambda item: (
            float(item[0].get("confidence", 0.0)),
            float(item[0].get("field_shape_score", 0.0)),
            float(item[0].get("area_m2", 0.0)),
        ),
        reverse=True,
    )

    result: list[dict[str, Any]] = []

    for index, (region, _) in enumerate(
        accepted[:max_features],
        start=1,
    ):
        result.append(
            {
                **region,
                "id": f"field-{index}",
            }
        )

    print(
        "DAV2 CONFIRMATION BOOST: "
        f"confirmed={dav2_confirmed_count}, "
        f"independent={independent_count}"
    )

    print(
        "FIELD FUSION DIAGNOSTICS: "
        f"visible={len(visible_entries)}, "
        f"dav2={len(dav2_entries)}, "
        f"duplicates={duplicate_rejections}, "
        f"accepted={len(result)}"
    )

    return result

def _normalise_model_output(output: np.ndarray) -> np.ndarray:
    prediction = np.asarray(output)
    if prediction.ndim != 4:
        raise ModelSetupError(f"Unexpected model output shape: {prediction.shape}")
    if prediction.shape[-1] != 9 and prediction.shape[1] == 9:
        prediction = np.moveaxis(prediction, 1, -1)
    if prediction.shape[-1] != 9:
        raise ModelSetupError(f"The model returned {prediction.shape[-1]} classes instead of 9.")

    probabilities = prediction[0].astype(np.float32)
    probability_sum = float(np.mean(np.sum(probabilities, axis=-1)))
    if not 0.97 <= probability_sum <= 1.03:
        probabilities -= probabilities.max(axis=-1, keepdims=True)
        probabilities = np.exp(probabilities)
        probabilities /= np.maximum(probabilities.sum(axis=-1, keepdims=True), 1e-8)
    return probabilities


def _call_signature(signature: Any, image_batch: np.ndarray) -> np.ndarray:
    if isinstance(signature, dict) and signature.get("mode") == "legacy_session":
        session = signature["session"]
        input_tensor = signature["input"]
        output_tensor = signature["output"]
        input_dtype = signature.get("input_dtype", np.float32)
        return np.asarray(
            session.run(
                output_tensor,
                feed_dict={input_tensor: image_batch.astype(input_dtype, copy=False)},
            )
        )

    tf = import_tensorflow()
    keyword_specs = signature.structured_input_signature[1]
    if keyword_specs:
        input_name, input_spec = next(iter(keyword_specs.items()))
        tensor = tf.convert_to_tensor(image_batch, dtype=input_spec.dtype)
        outputs = signature(**{input_name: tensor})
    else:
        tensor = tf.convert_to_tensor(image_batch, dtype=tf.float32)
        outputs = signature(tensor)

    if isinstance(outputs, dict):
        output_tensor = next(iter(outputs.values()))
    elif isinstance(outputs, (tuple, list)):
        output_tensor = outputs[0]
    else:
        output_tensor = outputs
    return np.asarray(output_tensor.numpy())


@_timed_stage("OpenEarthMap")
def run_inference(image: Image.Image, quality: str) -> np.ndarray:
    _, signature = get_model()
    base = np.asarray(image.resize((IMAGE_SIZE, IMAGE_SIZE), Image.Resampling.BICUBIC))
    base = base.astype(np.float32)

    transforms: list[tuple[Callable[[np.ndarray], np.ndarray], Callable[[np.ndarray], np.ndarray]]] = [
        (lambda value: value, lambda value: value),
    ]
    if quality == "accurate":
        transforms.extend(
            [
                (np.fliplr, np.fliplr),
                (np.flipud, np.flipud),
                (
                    lambda value: np.flipud(np.fliplr(value)),
                    lambda value: np.fliplr(np.flipud(value)),
                ),
            ]
        )

    predictions = []
    with inference_lock:
        for apply_transform, reverse_transform in transforms:
            transformed = np.ascontiguousarray(apply_transform(base))
            output = _call_signature(signature, transformed[np.newaxis, ...])
            probabilities = _normalise_model_output(output)
            restored = np.ascontiguousarray(reverse_transform(probabilities))
            predictions.append(restored)
    return np.mean(np.stack(predictions, axis=0), axis=0)


def clean_binary_mask(binary_mask: np.ndarray, settings: dict[str, Any]) -> np.ndarray:
    cleaned = binary_mask.astype(np.uint8)
    close_size = int(settings["close_kernel"])
    open_size = int(settings["open_kernel"])
    if close_size > 1:
        kernel = np.ones((close_size, close_size), dtype=np.uint8)
        cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel)
    if open_size > 1:
        kernel = np.ones((open_size, open_size), dtype=np.uint8)
        cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, kernel)
    return cleaned > 0


@_timed_stage("Water Rescue V3")
def merge_fast_water_rescue(
    image: Image.Image,
    accurate_probabilities: np.ndarray,
    fast_probabilities: np.ndarray,
    selected_mask: np.ndarray,
    building_mask: np.ndarray,
    existing_water_mask: np.ndarray,
    existing_confidence: np.ndarray,
    fast_water_mask: np.ndarray,
    fast_water_confidence: np.ndarray,
    sentinel_prior: np.ndarray | None,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """Add only strongly supported water bodies found by the fast scout.

    Existing Water V2 geometry is preserved exactly.

    Fast crop/building detections are never copied into the final result.
    The fast model is used only to propose water that accurate Water V2
    completely missed.
    """

    fast_water_probability = (
        fast_probabilities[:, :, CLASS_IDS["water"]]
    )

    accurate_tree_probability = (
        accurate_probabilities[:, :, CLASS_IDS["tree"]]
    )
    fast_tree_probability = (
        fast_probabilities[:, :, CLASS_IDS["tree"]]
    )

    tree_probability = np.maximum(
        accurate_tree_probability,
        fast_tree_probability,
    )

    if sentinel_prior is None:
        sentinel_probability = np.zeros_like(
            fast_water_probability,
            dtype=np.float32,
        )
    else:
        sentinel_probability = np.clip(
            sentinel_prior,
            0.0,
            1.0,
        ).astype(np.float32)

    rgb = np.asarray(
        image.resize(selected_mask.shape[::-1])
    ).astype(np.uint8)

    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)

    hue = hsv[:, :, 0].astype(np.float32)
    saturation = hsv[:, :, 1].astype(np.float32)
    value = hsv[:, :, 2].astype(np.float32)

    gray = cv2.cvtColor(
        rgb,
        cv2.COLOR_RGB2GRAY,
    ).astype(np.float32)

    local_mean = cv2.blur(gray, (9, 9))
    local_square_mean = cv2.blur(
        gray * gray,
        (9, 9),
    )

    local_std = np.sqrt(
        np.maximum(
            local_square_mean
            - local_mean * local_mean,
            0.0,
        )
    )

    # Near-black / dark water.
    dark_surface = value <= 140.0

    # Green-blue/algae water. Dark pixels are handled separately because
    # hue becomes unreliable when brightness is extremely low.
    green_blue_surface = (
        (hue >= 30.0)
        & (hue <= 130.0)
        & (saturation >= 30.0)
        & (value <= 190.0)
    )

    algae_green_surface = (
        (hue >= 35.0)
        & (hue <= 85.0)
        & (saturation >= 40.0)
        & (value <= 180.0)
    )

    smooth_surface = local_std <= 25.0

    pond_surface = (
        smooth_surface
        & (
            dark_surface
            | green_blue_surface
            | algae_green_surface
        )
    )

    # Never use the scout merely to enlarge an already accepted Water V2
    # polygon. V3 is for COMPLETELY MISSED water bodies.
    existing_buffer = cv2.dilate(
        existing_water_mask.astype(np.uint8),
        np.ones((7, 7), dtype=np.uint8),
        iterations=1,
    ).astype(bool)

    extra_fast_water = (
        fast_water_mask
        & selected_mask
        & ~existing_buffer
        & ~building_mask
    )

    component_count, labels, stats, _ = (
        cv2.connectedComponentsWithStats(
            extra_fast_water.astype(np.uint8),
            connectivity=8,
        )
    )

    rescued = np.zeros_like(
        selected_mask,
        dtype=bool,
    )

    rescue_confidence = np.zeros_like(
        fast_water_probability,
        dtype=np.float32,
    )

    evaluated = 0
    accepted = 0

    rejected_small = 0
    rejected_surface = 0
    rejected_shape = 0
    rejected_context = 0
    rejected_support = 0

    for label in range(1, component_count):
        component = labels == label

        pixel_count = int(
            stats[label, cv2.CC_STAT_AREA]
        )

        # Ignore tiny specks.
        if pixel_count < 100:
            rejected_small += 1
            continue

        evaluated += 1

        fast_water_mean = float(
            fast_water_probability[component].mean()
        )

        fast_water_peak = float(
            fast_water_probability[component].max()
        )

        surface_ratio = float(
            np.count_nonzero(
                component & pond_surface
            )
            / pixel_count
        )

        dark_ratio = float(
            np.count_nonzero(
                component & dark_surface
            )
            / pixel_count
        )

        algae_ratio = float(
            np.count_nonzero(
                component & algae_green_surface
            )
            / pixel_count
        )

        if surface_ratio < 0.45:
            rejected_surface += 1
            continue

        contours, _ = cv2.findContours(
            component.astype(np.uint8),
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )

        if not contours:
            rejected_shape += 1
            continue

        contour = max(
            contours,
            key=cv2.contourArea,
        )

        x, y, width, height = cv2.boundingRect(
            contour
        )

        if width <= 0 or height <= 0:
            rejected_shape += 1
            continue

        aspect_ratio = max(
            width / height,
            height / width,
        )

        hull = cv2.convexHull(contour)

        hull_area = float(
            cv2.contourArea(hull)
        )

        contour_area = float(
            cv2.contourArea(contour)
        )

        solidity = (
            contour_area / hull_area
            if hull_area > 0.0
            else 0.0
        )

        # Reject very thin drainage/shadow strips.
        if aspect_ratio > 7.0:
            rejected_shape += 1
            continue

        if solidity < 0.45:
            rejected_shape += 1
            continue

        # --------------------------------------------------------
        # Tree-ring context.
        #
        # Many difficult ponds are green/dark because of algae and
        # surrounding vegetation. Trees are SUPPORTING evidence only.
        # --------------------------------------------------------

        component_u8 = component.astype(
            np.uint8
        )

        outer = cv2.dilate(
            component_u8,
            np.ones((17, 17), dtype=np.uint8),
            iterations=1,
        ).astype(bool)

        inner = cv2.dilate(
            component_u8,
            np.ones((3, 3), dtype=np.uint8),
            iterations=1,
        ).astype(bool)

        ring = (
            outer
            & ~inner
            & selected_mask
            & ~existing_water_mask
        )

        ring_pixels = int(
            np.count_nonzero(ring)
        )

        if ring_pixels > 0:
            tree_ring_ratio = float(
                np.count_nonzero(
                    ring
                    & (tree_probability >= 0.30)
                )
                / ring_pixels
            )
        else:
            tree_ring_ratio = 0.0

        sentinel_mean = float(
            sentinel_probability[component].mean()
        )

        has_tree_context = (
            tree_ring_ratio >= 0.10
        )

        has_sentinel_context = (
            sentinel_mean >= 0.32
        )

        # A hard dark pond can still qualify when Sentinel misses it,
        # but only if the fast water scout is exceptionally strong.
        has_strong_dark_water = (
            dark_ratio >= 0.70
            and fast_water_mean >= 0.55
        )

        if not (
            has_tree_context
            or has_sentinel_context
            or has_strong_dark_water
        ):
            rejected_context += 1
            continue

        # The region must still have genuine fast-model water evidence.
        # Colour/tree context alone can NEVER create water.
        has_fast_water_support = (
            fast_water_mean >= 0.30
            or fast_water_peak >= 0.55
        )

        if not has_fast_water_support:
            rejected_support += 1
            continue

        rescued |= component

        rescue_confidence[component] = (
            fast_water_confidence[component]
        )

        accepted += 1

        print(
            "WATER RESCUE V3 ACCEPTED: "
            f"pixels={pixel_count}, "
            f"fast_mean={fast_water_mean:.3f}, "
            f"fast_peak={fast_water_peak:.3f}, "
            f"surface={surface_ratio:.3f}, "
            f"dark={dark_ratio:.3f}, "
            f"algae={algae_ratio:.3f}, "
            f"tree_ring={tree_ring_ratio:.3f}, "
            f"sentinel={sentinel_mean:.3f}, "
            f"solidity={solidity:.3f}"
        )

    # --------------------------------------------------------
    # POND COMPLETION V3
    #
    # The original V3 logic above rescues COMPLETELY MISSED ponds.
    #
    # This second, additive branch handles a different case:
    # Water V2 has already accepted PART of a pond, while the
    # fast water scout sees the same connected pond more completely.
    #
    # A component is NEVER completed merely because it is dark/green.
    # It must overlap or directly touch an already accepted waterbody
    # and still pass fast-water + surface + geometry/context checks.
    # --------------------------------------------------------

    completed = np.zeros_like(
        selected_mask,
        dtype=bool,
    )

    completion_confidence = np.zeros_like(
        fast_water_probability,
        dtype=np.float32,
    )

    completion_source = (
        fast_water_mask
        & selected_mask
        & ~building_mask
    )

    (
        completion_component_count,
        completion_labels,
        completion_stats,
        _,
    ) = cv2.connectedComponentsWithStats(
        completion_source.astype(np.uint8),
        connectivity=8,
    )

    # Small bridge around already accepted Water V2 geometry.
    # This permits a directly adjacent missing portion of the SAME
    # pond, but not a separate nearby pond/field.
    existing_touch_zone = cv2.dilate(
        existing_water_mask.astype(np.uint8),
        np.ones((5, 5), dtype=np.uint8),
        iterations=1,
    ).astype(bool)

    completion_evaluated = 0
    completion_accepted = 0

    completion_rejected_connection = 0
    completion_rejected_small = 0
    completion_rejected_surface = 0
    completion_rejected_shape = 0
    completion_rejected_support = 0
    completion_rejected_context = 0
    completion_rejected_expansion = 0

    for label in range(1, completion_component_count):
        full_component = completion_labels == label

        full_pixels = int(
            completion_stats[label, cv2.CC_STAT_AREA]
        )

        if full_pixels < 100:
            completion_rejected_small += 1
            continue

        existing_overlap = int(
            np.count_nonzero(
                full_component
                & existing_water_mask
            )
        )

        touching_existing = int(
            np.count_nonzero(
                full_component
                & existing_touch_zone
            )
        )

        # This is the key safety rule:
        # completion is ONLY for the same already-detected pond.
        if (
            existing_overlap < 15
            and touching_existing < 25
        ):
            completion_rejected_connection += 1
            continue

        missing_component = (
            full_component
            & ~existing_water_mask
        )

        missing_pixels = int(
            np.count_nonzero(missing_component)
        )

        if missing_pixels < 60:
            completion_rejected_small += 1
            continue

        completion_evaluated += 1

        fast_mean = float(
            fast_water_probability[
                missing_component
            ].mean()
        )

        fast_peak = float(
            fast_water_probability[
                missing_component
            ].max()
        )

        surface_ratio = float(
            np.count_nonzero(
                missing_component
                & pond_surface
            )
            / missing_pixels
        )

        dark_ratio = float(
            np.count_nonzero(
                missing_component
                & dark_surface
            )
            / missing_pixels
        )

        algae_ratio = float(
            np.count_nonzero(
                missing_component
                & algae_green_surface
            )
            / missing_pixels
        )

        if surface_ratio < 0.40:
            completion_rejected_surface += 1
            continue

        contours, _ = cv2.findContours(
            full_component.astype(np.uint8),
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )

        if not contours:
            completion_rejected_shape += 1
            continue

        contour = max(
            contours,
            key=cv2.contourArea,
        )

        x, y, width, height = cv2.boundingRect(
            contour
        )

        if width <= 0 or height <= 0:
            completion_rejected_shape += 1
            continue

        aspect_ratio = max(
            width / height,
            height / width,
        )

        hull = cv2.convexHull(contour)

        hull_area = float(
            cv2.contourArea(hull)
        )

        contour_area = float(
            cv2.contourArea(contour)
        )

        solidity = (
            contour_area / hull_area
            if hull_area > 0.0
            else 0.0
        )

        if aspect_ratio > 7.0:
            completion_rejected_shape += 1
            continue

        if solidity < 0.40:
            completion_rejected_shape += 1
            continue

        # Fast-model water evidence is mandatory.
        if not (
            fast_mean >= 0.30
            or fast_peak >= 0.55
        ):
            completion_rejected_support += 1
            continue

        # Prevent a tiny accepted water sliver from expanding into an
        # arbitrarily huge fast component.
        association_pixels = max(
            existing_overlap,
            touching_existing,
            1,
        )

        expansion_ratio = (
            missing_pixels / association_pixels
        )

        if expansion_ratio > 12.0:
            completion_rejected_expansion += 1
            continue

        component_u8 = full_component.astype(
            np.uint8
        )

        outer = cv2.dilate(
            component_u8,
            np.ones((17, 17), dtype=np.uint8),
            iterations=1,
        ).astype(bool)

        inner = cv2.dilate(
            component_u8,
            np.ones((3, 3), dtype=np.uint8),
            iterations=1,
        ).astype(bool)

        ring = (
            outer
            & ~inner
            & selected_mask
            & ~existing_water_mask
        )

        ring_pixels = int(
            np.count_nonzero(ring)
        )

        if ring_pixels > 0:
            tree_ring_ratio = float(
                np.count_nonzero(
                    ring
                    & (tree_probability >= 0.30)
                )
                / ring_pixels
            )
        else:
            tree_ring_ratio = 0.0

        sentinel_mean = float(
            sentinel_probability[
                missing_component
            ].mean()
        )

        # Existing accepted water is already strong evidence that this
        # location is a pond, but one additional contextual signal is
        # still required before we extend its geometry.
        has_context = (
            sentinel_mean >= 0.25
            or tree_ring_ratio >= 0.08
            or dark_ratio >= 0.55
            or algae_ratio >= 0.25
        )

        if not has_context:
            completion_rejected_context += 1
            continue

        completed |= missing_component

        completion_confidence[
            missing_component
        ] = fast_water_confidence[
            missing_component
        ]

        completion_accepted += 1

        print(
            "WATER COMPLETION V3 ACCEPTED: "
            f"full_pixels={full_pixels}, "
            f"missing_pixels={missing_pixels}, "
            f"overlap={existing_overlap}, "
            f"touch={touching_existing}, "
            f"expansion={expansion_ratio:.2f}, "
            f"fast_mean={fast_mean:.3f}, "
            f"fast_peak={fast_peak:.3f}, "
            f"surface={surface_ratio:.3f}, "
            f"dark={dark_ratio:.3f}, "
            f"algae={algae_ratio:.3f}, "
            f"tree_ring={tree_ring_ratio:.3f}, "
            f"sentinel={sentinel_mean:.3f}, "
            f"solidity={solidity:.3f}"
        )

    rescue_confidence = np.maximum(
        rescue_confidence,
        completion_confidence,
    )

    print(
        "WATER COMPLETION V3 DIAGNOSTICS: "
        f"evaluated={completion_evaluated}, "
        f"accepted={completion_accepted}, "
        f"completed_pixels="
        f"{int(np.count_nonzero(completed))}, "
        f"rejected_connection="
        f"{completion_rejected_connection}, "
        f"rejected_small="
        f"{completion_rejected_small}, "
        f"rejected_surface="
        f"{completion_rejected_surface}, "
        f"rejected_shape="
        f"{completion_rejected_shape}, "
        f"rejected_support="
        f"{completion_rejected_support}, "
        f"rejected_context="
        f"{completion_rejected_context}, "
        f"rejected_expansion="
        f"{completion_rejected_expansion}"
    )

    combined_mask = (
        existing_water_mask
        | rescued
        | completed
    )

    combined_confidence = np.maximum(
        existing_confidence,
        rescue_confidence,
    )

    diagnostics = {
        "evaluated": evaluated,
        "accepted": accepted,
        "rescued_pixels": int(
            np.count_nonzero(rescued)
        ),
        "rejected_small": rejected_small,
        "rejected_surface": rejected_surface,
        "rejected_shape": rejected_shape,
        "rejected_context": rejected_context,
        "rejected_support": rejected_support,
        "completion_evaluated": completion_evaluated,
        "completion_accepted": completion_accepted,
        "completion_pixels": int(
            np.count_nonzero(completed)
        ),
        "completion_rejected_connection": (
            completion_rejected_connection
        ),
        "completion_rejected_small": (
            completion_rejected_small
        ),
        "completion_rejected_surface": (
            completion_rejected_surface
        ),
        "completion_rejected_shape": (
            completion_rejected_shape
        ),
        "completion_rejected_support": (
            completion_rejected_support
        ),
        "completion_rejected_context": (
            completion_rejected_context
        ),
        "completion_rejected_expansion": (
            completion_rejected_expansion
        ),
    }

    print(
        "WATER RESCUE V3 DIAGNOSTICS: "
        f"evaluated={evaluated}, "
        f"accepted={accepted}, "
        f"rescued_pixels="
        f"{diagnostics['rescued_pixels']}, "
        f"rejected_small={rejected_small}, "
        f"rejected_surface={rejected_surface}, "
        f"rejected_shape={rejected_shape}, "
        f"rejected_context={rejected_context}, "
        f"rejected_support={rejected_support}"
    )

    return (
        combined_mask,
        combined_confidence,
        diagnostics,
    )


@_timed_stage("Water V2")
def refine_water_mask(
    image: Image.Image,
    probabilities: np.ndarray,
    selected_mask: np.ndarray,
    building_mask: np.ndarray,
    minimum_probability: float,
    sentinel_prior: np.ndarray | None,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """Fuse high-resolution model evidence with optional free Sentinel-2 NDWI."""

    water_probability = probabilities[:, :, CLASS_IDS["water"]]
    tree_probability = probabilities[:, :, CLASS_IDS["tree"]]
    crop_probability = probabilities[:, :, CLASS_IDS["crop"]]
    building_probability = probabilities[:, :, CLASS_IDS["building"]]

    smooth_water = cv2.GaussianBlur(water_probability, (0, 0), sigmaX=2.0)
    rgb = np.asarray(image.resize(selected_mask.shape[::-1])).astype(np.uint8)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    local_mean = cv2.blur(gray, (9, 9))
    local_square_mean = cv2.blur(gray * gray, (9, 9))
    local_standard_deviation = np.sqrt(
        np.maximum(local_square_mean - local_mean * local_mean, 0.0)
    )

    strong_seed = (
        (water_probability >= minimum_probability)
        & (water_probability >= tree_probability)
        & (water_probability >= crop_probability)
        & (water_probability >= building_probability)
    )
    relaxed_model = smooth_water >= 0.34
    dark_smooth_surface = (gray <= 150.0) & (local_standard_deviation <= 26.0)

    if sentinel_prior is None:
        sentinel_probability = np.zeros_like(water_probability, dtype=np.float32)
        sentinel_support = np.zeros_like(selected_mask, dtype=bool)
    else:
        sentinel_probability = np.clip(sentinel_prior, 0.0, 1.0).astype(np.float32)
        sentinel_support = sentinel_probability >= 0.58

    # A Microsoft/semantic building prediction should normally block water,
    # but a false building footprint must not erase a strongly supported pond.
    #
    # Water is allowed to override building evidence only when the Esri
    # surface is dark/smooth and either the high-resolution model or
    # Sentinel-2 provides strong supporting evidence.
    model_water_override = (
        (water_probability >= max(float(minimum_probability), 0.60))
        & dark_smooth_surface
    )

    sentinel_water_override = (
        (sentinel_probability >= 0.72)
        & dark_smooth_surface
        & (water_probability >= 0.20)
    )

    strong_water_override = (
        model_water_override
        | sentinel_water_override
    )

    building_conflict = (
        (
            (building_probability > water_probability + 0.05)
            | building_mask
        )
        & ~strong_water_override
    )

    non_water_conflict = (
        building_conflict
        | (
            (tree_probability >= 0.62)
            & (tree_probability > water_probability + 0.08)
        )
        | (
            (crop_probability >= 0.65)
            & (crop_probability > water_probability + 0.12)
        )
    )

    candidate = (
        strong_seed
        | relaxed_model
        | (
            sentinel_support
            & dark_smooth_surface
            & (water_probability >= 0.12)
        )
    )

    candidate &= selected_mask & ~non_water_conflict

    candidate = cv2.morphologyEx(
        candidate.astype(np.uint8),
        cv2.MORPH_CLOSE,
        np.ones((7, 7), dtype=np.uint8),
    ).astype(bool)

    # Closing can bridge tiny gaps. Re-apply all conflicts afterwards so
    # morphology cannot accidentally grow water through trees, crops or
    # genuine buildings.
    candidate &= selected_mask & ~non_water_conflict

    accepted = np.zeros_like(selected_mask, dtype=bool)

    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(
        candidate.astype(np.uint8),
        connectivity=8,
    )

    rejected_small = 0
    rejected_tree = 0
    rejected_support = 0
    accepted_model = 0
    accepted_joint = 0

    for label in range(1, component_count):
        component = labels == label
        pixel_count = int(stats[label, cv2.CC_STAT_AREA])

        if pixel_count < 12:
            rejected_small += 1
            continue

        seed_pixels = int(
            np.count_nonzero(strong_seed & component)
        )

        model_mean = float(
            water_probability[component].mean()
        )

        sentinel_mean = float(
            sentinel_probability[component].mean()
        )

        tree_ratio = float(
            np.count_nonzero(
                component
                & (
                    tree_probability
                    > water_probability + 0.08
                )
            )
            / pixel_count
        )

        has_model_support = (
            seed_pixels >= 8
            and model_mean >= 0.48
        )

        has_joint_support = (
            sentinel_mean >= 0.60
            and model_mean >= 0.25
        )

        if tree_ratio > 0.35:
            rejected_tree += 1
            continue

        if not (
            has_model_support
            or has_joint_support
        ):
            rejected_support += 1
            continue

        accepted[component] = True

        if has_model_support:
            accepted_model += 1
        else:
            accepted_joint += 1

    combined_confidence = np.maximum(
        water_probability,
        sentinel_probability * 0.82,
    )

    building_override_pixels = int(
        np.count_nonzero(
            building_mask
            & strong_water_override
            & selected_mask
        )
    )

    accepted_pixels = int(
        np.count_nonzero(accepted)
    )

    print(
        "WATER V2 DIAGNOSTICS: "
        f"candidate_pixels={int(np.count_nonzero(candidate))}, "
        f"accepted_pixels={accepted_pixels}, "
        f"building_override_pixels={building_override_pixels}, "
        f"components={max(component_count - 1, 0)}, "
        f"accepted_model={accepted_model}, "
        f"accepted_joint={accepted_joint}, "
        f"rejected_small={rejected_small}, "
        f"rejected_tree={rejected_tree}, "
        f"rejected_support={rejected_support}"
    )

    diagnostics = {
        "components_considered": max(component_count - 1, 0),
        "components_rejected": (
            rejected_small
            + rejected_tree
            + rejected_support
        ),
        "accepted_model": accepted_model,
        "accepted_joint": accepted_joint,
        "building_override_pixels": building_override_pixels,
        "sentinel_used": sentinel_prior is not None,
    }

    return (
        accepted & selected_mask,
        combined_confidence,
        diagnostics,
    )


def pixel_to_coordinate(
    x: float,
    y: float,
    box: dict[str, float],
    width: int,
    height: int,
) -> list[float]:
    longitude = box["west"] + (x / max(width - 1, 1)) * (box["east"] - box["west"])
    latitude = box["north"] - (y / max(height - 1, 1)) * (box["north"] - box["south"])
    return [round(latitude, 7), round(longitude, 7)]


def extract_regions(
    class_key: str,
    binary_mask: np.ndarray,
    class_probability: np.ndarray,
    box: dict[str, float],
    metres_per_pixel_x: float,
    metres_per_pixel_y: float,
    minimum_mean_confidence: float | None = None,
) -> list[dict[str, Any]]:
    settings = CLASS_SETTINGS[class_key]
    cleaned = clean_binary_mask(binary_mask, settings)
    contours, _ = cv2.findContours(
        cleaned.astype(np.uint8),
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    pixel_area_m2 = max(metres_per_pixel_x * metres_per_pixel_y, 0.01)
    regions: list[dict[str, Any]] = []
    height, width = cleaned.shape

    for contour in contours:
        area_m2 = float(cv2.contourArea(contour) * pixel_area_m2)
        if area_m2 < float(settings["minimum_area_m2"]):
            continue

        perimeter = cv2.arcLength(contour, closed=True)
        simplified = cv2.approxPolyDP(
            contour,
            epsilon=max(1.0, float(settings["simplify"]) * perimeter),
            closed=True,
        )
        if len(simplified) < 3:
            continue

        region_mask = np.zeros_like(cleaned, dtype=np.uint8)
        cv2.drawContours(region_mask, [contour], -1, 1, thickness=cv2.FILLED)
        region_pixels = region_mask.astype(bool)
        confidence = (
            float(class_probability[region_pixels].mean())
            if np.any(region_pixels)
            else 0.0
        )
        required_confidence = (
            REGION_MEAN_CONFIDENCE_FLOORS[class_key]
            if minimum_mean_confidence is None
            else float(minimum_mean_confidence)
        )
        if confidence < required_confidence:
            continue

        coordinates = [
            pixel_to_coordinate(
                float(point[0][0]),
                float(point[0][1]),
                box,
                width,
                height,
            )
            for point in simplified
        ]
        regions.append(
            {
                "coordinates": coordinates,
                "area_m2": round(area_m2, 1),
                "confidence": round(confidence * 100, 1),
            }
        )

    regions.sort(key=lambda item: item["area_m2"], reverse=True)
    regions = regions[:MAX_FEATURES_PER_CLASS]
    for index, region in enumerate(regions, start=1):
        region["id"] = f"{class_key}-{index}"
    return regions


def make_overlay(class_masks: dict[str, np.ndarray], selected_mask: np.ndarray) -> str:
    height, width = selected_mask.shape
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    for class_key in ("crop", "water", "building"):
        colour = CLASS_SETTINGS[class_key]["colour"]
        visible = class_masks[class_key] & selected_mask
        rgba[visible] = colour

    overlay = Image.fromarray(rgba, mode="RGBA")
    output = io.BytesIO()
    overlay.save(output, format="PNG", optimize=True)
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


@app.get("/health")
def health() -> dict[str, Any]:
    status = model_status()
    return {
        "status": "ok",
        "service": "AgriTerrain AI OpenEarthMap Service",
        "model_status": status,
        "model_ready": status in {"downloaded", "loaded"},
        "model_loaded": status == "loaded",
        "model": "OpenEarthMap U-Net EfficientNet-B4",
        "model_download_mb": 304,
        "last_error": model_state["last_error"],
    }


@app.post("/prepare")
def prepare_model() -> dict[str, Any]:
    try:
        get_model()
    except ModelSetupError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "status": "ready",
        "model_status": "loaded",
        "model_ready": True,
        "model": "OpenEarthMap U-Net EfficientNet-B4",
    }


@app.post("/report-background")
def report_background(
    request: ReportBackgroundRequest,
) -> dict[str, Any]:
    boundary = validate_boundary(request.boundary)
    box = boundary_box(boundary)

    # Keep the same selection-size validation used by analysis.
    validate_image_scale(box)

    image = fetch_satellite_image(box).convert("RGB")

    output = io.BytesIO()
    image.save(
        output,
        format="JPEG",
        quality=90,
        optimize=True,
    )

    encoded = base64.b64encode(
        output.getvalue()
    ).decode("ascii")

    return {
        "image": f"data:image/jpeg;base64,{encoded}",
        "width": image.width,
        "height": image.height,
    }


@app.post("/analyze")
def analyze(request: AnalyzeRequest) -> dict[str, Any]:
    boundary = validate_boundary(request.boundary)
    box = boundary_box(boundary)
    image_quality = validate_image_scale(box)
    image = fetch_satellite_image(box)
    selected_mask = polygon_pixel_mask(boundary, box, image.size)

    # Shared external-source state. Balanced V2 starts these independent
    # sources while accurate OpenEarthMap inference is already running.
    # No detection rule, threshold or acceptance condition is changed.
    microsoft_buildings: list[dict[str, Any]] = []

    sentinel_water_prior: np.ndarray | None = None
    sentinel_water_metadata: dict[str, Any] = {}
    water_detection_status = "openearthmap-only"
    water_detection_detail = ""

    def fetch_microsoft_buildings() -> list[dict[str, Any]]:
        return get_building_footprints(
            boundary,
            box,
            max_features=MAX_FEATURES_PER_CLASS,
            min_confidence=0.85,
        )

    def fetch_sentinel_water() -> tuple[np.ndarray, dict[str, Any]]:
        return get_sentinel_water_prior(
            box,
            selected_mask.shape[::-1],
        )

    # Mode Remap V1:
    # Standard = former Balanced accuracy pipeline.
    # Balanced = former Faster pipeline.
    # Faster = fast inference with additional scheduling optimization.
    effective_quality = (
        "accurate"
        if request.analysis_mode == "standard"
        else "fast"
    )

    print(
        "ANALYSIS MODE: "
        f"{request.analysis_mode}, "
        f"openearthmap={effective_quality}"
    )

    if request.analysis_mode in ("standard", "faster"):
        overlap_started = time.perf_counter()

        overlap_label = (
            "STANDARD ACCURATE OVERLAP"
            if request.analysis_mode == "standard"
            else "FASTER V2 OVERLAP"
        )

        print(
            f"{overlap_label}: "
            "OpenEarthMap + Microsoft + Sentinel"
        )

        with ThreadPoolExecutor(max_workers=2) as executor:
            microsoft_future = executor.submit(
                fetch_microsoft_buildings
            )
            sentinel_future = executor.submit(
                fetch_sentinel_water
            )

            try:
                probabilities = run_inference(
                    image,
                    effective_quality,
                )
            except ModelSetupError as error:
                raise HTTPException(
                    status_code=503,
                    detail=str(error),
                ) from error

            external_wait_started = time.perf_counter()

            try:
                microsoft_buildings = microsoft_future.result()
            except Exception as error:
                print(
                    f"Microsoft building lookup failed: {error}"
                )

            try:
                (
                    sentinel_water_prior,
                    sentinel_water_metadata,
                ) = sentinel_future.result()
                water_detection_status = "complete"
            except Exception as error:
                water_detection_detail = str(error)
                print(
                    "Sentinel-2 water confirmation unavailable: "
                    f"{error}"
                )

            print(
                f"PERF {overlap_label} external wait after OEM: "
                f"{time.perf_counter() - external_wait_started:.2f}s"
            )

        print(
            f"PERF {overlap_label} span: "
            f"{time.perf_counter() - overlap_started:.2f}s"
        )

    else:
        # New Balanced = former Faster.
        # Preserve its original fast OEM-first behavior.
        try:
            probabilities = run_inference(
                image,
                effective_quality,
            )
        except ModelSetupError as error:
            raise HTTPException(
                status_code=503,
                detail=str(error),
            ) from error

    if probabilities.shape[:2] != selected_mask.shape:
        probabilities = cv2.resize(
            probabilities,
            (selected_mask.shape[1], selected_mask.shape[0]),
            interpolation=cv2.INTER_LINEAR,
        )

    label_map = probabilities.argmax(axis=-1)
    class_thresholds = {
        class_key: max(
            request.confidence_threshold,
            CLASS_CONFIDENCE_FLOORS[class_key],
        )
        for class_key in ("crop", "water", "building")
    }
    class_masks: dict[str, np.ndarray] = {}
    for class_key in ("crop", "water", "building"):
        class_id = CLASS_IDS[class_key]
        class_masks[class_key] = (
            (label_map == class_id)
            & (probabilities[:, :, class_id] >= class_thresholds[class_key])
            & selected_mask
        )

    width_metres = float(image_quality["width_metres"])
    height_metres = float(image_quality["height_metres"])
    metres_per_pixel_x = width_metres / IMAGE_SIZE
    metres_per_pixel_y = height_metres / IMAGE_SIZE
    detections = {
        class_key: extract_regions(
            class_key,
            class_masks[class_key],
            probabilities[:, :, CLASS_IDS[class_key]],
            box,
            metres_per_pixel_x,
            metres_per_pixel_y,
        )
        for class_key in ("crop", "water", "building")
    }

    # Preserve the OpenEarthMap regions. They become high-confidence backup
    # detections later instead of being discarded whenever Microsoft returns
    # at least one footprint.
    semantic_buildings = list(detections["building"])

    if request.analysis_mode == "balanced":
        # New Balanced = former Faster:
        # Microsoft + Sentinel run together after fast OEM.
        external_started = time.perf_counter()

        with ThreadPoolExecutor(max_workers=2) as executor:
            microsoft_future = executor.submit(
                fetch_microsoft_buildings
            )
            sentinel_future = executor.submit(
                fetch_sentinel_water
            )

            try:
                microsoft_buildings = microsoft_future.result()
            except Exception as error:
                print(
                    f"Microsoft building lookup failed: {error}"
                )

            try:
                (
                    sentinel_water_prior,
                    sentinel_water_metadata,
                ) = sentinel_future.result()
                water_detection_status = "complete"
            except Exception as error:
                water_detection_detail = str(error)
                print(
                    "Sentinel-2 water confirmation unavailable: "
                    f"{error}"
                )

        print(
            "PERF Balanced external parallel wall: "
            f"{time.perf_counter() - external_started:.2f}s"
        )

    # Standard and Faster already received both external sources
    # during the overlapped stage above.

    # Water V2 needs the Microsoft mask before final building fusion.
    building_exclusion_mask = (
        regions_pixel_mask(
            microsoft_buildings,
            box,
            selected_mask.shape[::-1],
        )
        & selected_mask
    )
    building_exclusion_mask = cv2.dilate(
        building_exclusion_mask.astype(np.uint8),
        np.ones((3, 3), dtype=np.uint8),
        iterations=1,
    ).astype(bool) & selected_mask

    # Microsoft footprints remain the primary building source. OpenEarthMap
    # supplies a high-confidence backup exclusion so a building missed by
    # Microsoft cannot be painted over as agricultural field.
    semantic_building_probability = probabilities[:, :, CLASS_IDS["building"]]
    semantic_building_exclusion_mask = (
        (semantic_building_probability >= 0.50)
        & selected_mask
    )

    semantic_building_exclusion_mask = cv2.morphologyEx(
        semantic_building_exclusion_mask.astype(np.uint8),
        cv2.MORPH_OPEN,
        np.ones((3, 3), dtype=np.uint8),
    ).astype(bool)

    semantic_building_exclusion_mask = cv2.dilate(
        semantic_building_exclusion_mask.astype(np.uint8),
        np.ones((3, 3), dtype=np.uint8),
        iterations=1,
    ).astype(bool) & selected_mask

    # Microsoft and Sentinel are already ready for every mode here.
    # Do not fetch either source a second time.

    refined_water_mask, water_confidence, water_diagnostics = refine_water_mask(
        image=image,
        probabilities=probabilities,
        selected_mask=selected_mask,
        building_mask=building_exclusion_mask,
        minimum_probability=class_thresholds["water"],
        sentinel_prior=sentinel_water_prior,
    )

    # ------------------------------------------------------------
    # WATER RESCUE V3 — BALANCED ONLY
    #
    # Run the existing one-view Faster inference as a WATER SCOUT.
    # We then run the EXISTING Water V2 against that probability map.
    #
    # Only extra water components are considered.
    # Fast crops/buildings are completely ignored.
    # ------------------------------------------------------------
    if request.analysis_mode == "standard":
        print(
            "WATER SCOUT V3: running fast one-view "
            "OpenEarthMap for water only"
        )

        fast_water_probabilities = run_inference(
            image,
            "fast",
        )

        if (
            fast_water_probabilities.shape[:2]
            != selected_mask.shape
        ):
            fast_water_probabilities = cv2.resize(
                fast_water_probabilities,
                (
                    selected_mask.shape[1],
                    selected_mask.shape[0],
                ),
                interpolation=cv2.INTER_LINEAR,
            )

        (
            fast_water_mask,
            fast_water_confidence,
            fast_water_diagnostics,
        ) = refine_water_mask(
            image=image,
            probabilities=fast_water_probabilities,
            selected_mask=selected_mask,
            building_mask=building_exclusion_mask,
            minimum_probability=class_thresholds["water"],
            sentinel_prior=sentinel_water_prior,
        )

        (
            refined_water_mask,
            water_confidence,
            water_rescue_v3_diagnostics,
        ) = merge_fast_water_rescue(
            image=image,
            accurate_probabilities=probabilities,
            fast_probabilities=fast_water_probabilities,
            selected_mask=selected_mask,
            building_mask=building_exclusion_mask,
            existing_water_mask=refined_water_mask,
            existing_confidence=water_confidence,
            fast_water_mask=fast_water_mask,
            fast_water_confidence=fast_water_confidence,
            sentinel_prior=sentinel_water_prior,
        )

        water_diagnostics["fast_water_scout"] = (
            fast_water_diagnostics
        )
        water_diagnostics["rescue_v3"] = (
            water_rescue_v3_diagnostics
        )

    class_masks["water"] = refined_water_mask
    detections["water"] = extract_regions(
        "water",
        refined_water_mask,
        water_confidence,
        box,
        metres_per_pixel_x,
        metres_per_pixel_y,
        # refine_water_mask already performs component-level model,
        # Sentinel, tree and building checks. Do not reject an accepted pond
        # a second time based on another mean-confidence threshold.
        minimum_mean_confidence=None,
    )

    # Building V2-A: Microsoft geometry is primary, while high-confidence
    # OpenEarthMap regions recover roofs Microsoft missed. Confirmed Water V2
    # has priority over both sources.
    detections["building"] = merge_building_detections(
        microsoft_buildings,
        semantic_buildings,
        refined_water_mask,
        box,
        selected_mask.shape[::-1],
        MAX_FEATURES_PER_CLASS,
    )

    class_masks["building"] = (
        regions_pixel_mask(
            detections["building"],
            box,
            selected_mask.shape[::-1],
        )
        & selected_mask
        & ~refined_water_mask
    )

    # Fields are detected only after buildings and water. Microsoft building
    # footprints are supplemented by OpenEarthMap building evidence for crop
    # exclusion; water continues to use the existing refined water detector.
    crop_exclusion_mask = (
        refined_water_mask
        | building_exclusion_mask
        | semantic_building_exclusion_mask
    ) & selected_mask

    print(
        "CROP HARD EXCLUSION: "
        f"water_pixels={int(np.count_nonzero(refined_water_mask))}, "
        f"microsoft_building_pixels={int(np.count_nonzero(building_exclusion_mask))}, "
        f"semantic_building_pixels={int(np.count_nonzero(semantic_building_exclusion_mask))}, "
        f"total_pixels={int(np.count_nonzero(crop_exclusion_mask))}"
    )

    # OpenEarthMap agriculture is a semantic mask, not an individual-parcel
    # detector. Never display its merged contours as a field-boundary fallback.
    detections["crop"] = []
    crop_detection_status = "complete"
    crop_detection_detail = ""
    visible_fields = get_visible_field_boundaries(
        box,
        image=image,
        probabilities=probabilities,
        selected_mask=selected_mask,
        excluded_mask=crop_exclusion_mask,
        minimum_area_m2=120.0,
        max_features=MAX_FEATURES_PER_CLASS,
    )
    # The old Standard DAv2 confirmation path is no longer exposed
    # by any analysis mode. Visible-field geometry remains unchanged.
    dav2_fields: list[dict[str, Any]] = []

    print(
        "DAV2 SKIPPED BY MODE: "
        f"{request.analysis_mode}"
    )

    field_boundaries = merge_field_boundaries(
        dav2_fields,
        visible_fields,
        box,
        selected_mask.shape[::-1],
        MAX_FEATURES_PER_CLASS,
    )
    detections["crop"] = field_boundaries
    class_masks["crop"] = (
        regions_pixel_mask(
            field_boundaries,
            box,
            selected_mask.shape[::-1],
        )
        & selected_mask
        & ~crop_exclusion_mask
    )

    selected_pixels = max(int(np.count_nonzero(selected_mask)), 1)
    coverage = {
        class_key: round(
            float(np.count_nonzero(class_masks[class_key]) / selected_pixels * 100),
            2,
        )
        for class_key in ("crop", "water", "building")
    }
    maximum_probability = probabilities.max(axis=-1)
    selected_certainty = maximum_probability[selected_mask]
    mean_certainty = (
        round(float(selected_certainty.mean() * 100), 1)
        if selected_certainty.size
        else 0.0
    )

    return {
        "mode": "ml",
        "analysis_mode": request.analysis_mode,
        "location": request.location,
        "area_hectares": round(polygon_area_hectares(boundary), 2),
        "bbox": box,
        "confidence_threshold": round(request.confidence_threshold * 100, 1),
        "class_thresholds": {
            key: round(value * 100, 1) for key, value in class_thresholds.items()
        },
        "mean_model_certainty": mean_certainty,
        "counts": {key: len(value) for key, value in detections.items()},
        "coverage": coverage,
        "detections": detections,
        "overlay_image": make_overlay(class_masks, selected_mask),
        "crop_detection": {
            "status": crop_detection_status,
            "model": "DelineateAnythingV2 + OpenEarthMap visible boundaries",
            "detail": crop_detection_detail,
            "fallback_used": False,
        },
        "water_detection": {
            "status": water_detection_status,
            "model": "OpenEarthMap + Sentinel-2 NDWI",
            "detail": water_detection_detail,
            "sentinel": sentinel_water_metadata,
            **water_diagnostics,
        },
        "imagery": {
            "provider": "Esri World Imagery",
            "type": "High-resolution RGB mosaic",
            "date_note": "Capture date varies by location; this endpoint serves the latest available mosaic.",
            "width_pixels": IMAGE_SIZE,
            "height_pixels": IMAGE_SIZE,
            **image_quality,
        },
        "model": {
            "name": "OpenEarthMap + visible-field fusion + Sentinel-2 NDWI",
            "checkpoint": "OpenEarthMap fold 1",
            "input": "512 × 512 Esri RGB",
            "test_time_augmentation": effective_quality == "accurate",
            "source": "https://github.com/sebastianbahr/OpenEarthMap",
            "benchmark": MODEL_BENCHMARK,
        },
        "warning": (
            "These are AI-assisted field instances and semantic regions, not survey or cadastral boundaries. "
            "Some neighbouring crop parcels can still be missed or imperfectly separated. "
            "Water and building outputs use stricter precision filters, but false positives can still occur. "
            "Validate important decisions with local observations and Bangladesh-labelled data."
            + (
                " Individual crop-field detection was unavailable for this request; "
                "no semantic crop fallback or fabricated polygon was shown."
                if crop_detection_status != "complete"
                else ""
            )
        ),
        "attribution": (
            "Imagery displayed and analysed from Esri World Imagery. "
            "Land-cover model trained on the OpenEarthMap benchmark. "
            "Water confirmation uses free Sentinel-2 L2A imagery when available."
        ),
    }


