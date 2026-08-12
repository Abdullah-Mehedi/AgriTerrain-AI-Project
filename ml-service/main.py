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
from field_detector import get_field_boundaries


SERVICE_DIRECTORY = Path(__file__).resolve().parent
MODEL_DIRECTORY = Path(
    os.getenv(
        "AGRI_MODEL_DIRECTORY",
        str(SERVICE_DIRECTORY / "models" / "openearthmap-effnetb4-fold1"),
    )
)
WORLD_IMAGERY_EXPORT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
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
        "minimum_area_m2": 35.0,
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
    parameters = {
        "bbox": f'{box["west"]},{box["south"]},{box["east"]},{box["north"]}',
        "bboxSR": "4326",
        "imageSR": "4326",
        "size": f"{IMAGE_SIZE},{IMAGE_SIZE}",
        "format": "png32",
        "transparent": "false",
        "f": "image",
    }
    headers = {"User-Agent": "AgriTerrain-AI university land-cover prototype"}
    try:
        with httpx.Client(timeout=45, follow_redirects=True, headers=headers) as client:
            response = client.get(WORLD_IMAGERY_EXPORT, params=parameters)
            response.raise_for_status()
    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=502,
            detail="The satellite imagery provider could not supply this selection.",
        ) from error

    if "image" not in response.headers.get("content-type", "").lower():
        raise HTTPException(status_code=502, detail="The imagery provider returned no usable image.")
    try:
        return Image.open(io.BytesIO(response.content)).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=502, detail="The imagery response was not a valid RGB image.") from error


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
        if confidence < REGION_MEAN_CONFIDENCE_FLOORS[class_key]:
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


@app.post("/analyze")
def analyze(request: AnalyzeRequest) -> dict[str, Any]:
    boundary = validate_boundary(request.boundary)
    box = boundary_box(boundary)
    image_quality = validate_image_scale(box)
    image = fetch_satellite_image(box)
    selected_mask = polygon_pixel_mask(boundary, box, image.size)

    try:
        probabilities = run_inference(image, request.quality)
    except ModelSetupError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

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

    try:
        microsoft_buildings = get_building_footprints(
            boundary,
            box,
            max_features=MAX_FEATURES_PER_CLASS,
            min_confidence=0.85,
        )
        if microsoft_buildings:
            detections["building"] = microsoft_buildings
    except Exception as error:
        print(f"Microsoft building lookup failed: {error}")

    try:
        ftw_fields = get_field_boundaries(
            boundary,
            box,
            max_features=MAX_FEATURES_PER_CLASS,
        )
        if ftw_fields:
            detections["crop"] = ftw_fields
    except Exception as error:
        print(f"FTW field detection failed: {error}")

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
        "imagery": {
            "provider": "Esri World Imagery",
            "type": "High-resolution RGB mosaic",
            "date_note": "Capture date varies by location; this endpoint serves the latest available mosaic.",
            "width_pixels": IMAGE_SIZE,
            "height_pixels": IMAGE_SIZE,
            **image_quality,
        },
        "model": {
            "name": "OpenEarthMap U-Net EfficientNet-B4",
            "checkpoint": "Cross-validation fold 1",
            "input": "512 × 512 RGB",
            "test_time_augmentation": request.quality == "accurate",
            "source": "https://github.com/sebastianbahr/OpenEarthMap",
            "benchmark": MODEL_BENCHMARK,
        },
        "warning": (
            "These are AI-assisted semantic regions, not survey or cadastral boundaries. "
            "Buildings that touch may merge, and neighbouring crop parcels can appear as one region. "
            "Water and building outputs use stricter precision filters, but false positives can still occur. "
            "Validate important decisions with local observations and Bangladesh-labelled data."
        ),
        "attribution": (
            "Imagery displayed and analysed from Esri World Imagery. "
            "Land-cover model trained on the OpenEarthMap benchmark."
        ),
    }


