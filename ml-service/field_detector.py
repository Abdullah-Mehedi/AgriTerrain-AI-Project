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

    crop_probability = probabilities[:, :, LAND_CLASS_IDS["crop"]]
    grass_probability = probabilities[:, :, LAND_CLASS_IDS["grass"]]
    bareland_probability = probabilities[:, :, LAND_CLASS_IDS["bareland"]]
    tree_probability = probabilities[:, :, LAND_CLASS_IDS["tree"]]

    # Crop is strongest evidence. Grass can support green fields.
    # Bare land receives less weight so empty yards and exposed
    # surfaces do not automatically become agricultural fields.
    green_agriculture = np.maximum(
        crop_probability,
        grass_probability * 0.78,
    )
    fallow_agriculture = np.maximum(
        crop_probability * 0.70,
        bareland_probability * 0.72,
    )
    agriculture_probability = np.maximum(
        green_agriculture,
        fallow_agriculture,
    )
    conflict_probability = np.maximum.reduce(
        [
            probabilities[:, :, LAND_CLASS_IDS[class_key]]
            for class_key in ("pavement", "road", "tree", "water", "building")
        ]
    )
    candidate = (
        (agriculture_probability >= 0.36)
        & (agriculture_probability >= conflict_probability)
        & (tree_probability <= 0.52)
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

    # Tree/bush canopies generally have rougher local RGB texture
    # than cultivated surfaces. Texture is supporting evidence only.
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    local_mean = cv2.blur(gray, (9, 9))
    local_square_mean = cv2.blur(gray * gray, (9, 9))
    texture_std = np.sqrt(
        np.maximum(local_square_mean - local_mean * local_mean, 0.0)
    )

    # HSV helps separate genuinely green dark vegetation from ordinary
    # shadows/dark soil. OpenCV hue uses approximately 0-179.
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    hue = hsv[:, :, 0]
    saturation = hsv[:, :, 1]
    brightness = hsv[:, :, 2]

    green_pixel = (
        (hue >= 28)
        & (hue <= 95)
        & (saturation >= 45)
    )

    dark_green_pixel = (
        green_pixel
        & (brightness <= 115)
    )

    # Bright low-saturation surfaces are typically concrete, roofs,
    # pale exposed ground or other white/light non-crop surfaces.
    light_neutral_pixel = (
        (brightness >= 175)
        & (saturation <= 60)
    )

    # Dry, harvested and fallow fields are often brown/yellow rather than
    # green. This is supporting evidence only; field geometry is still needed.
    brown_bare_pixel = (
        (hue >= 5)
        & (hue <= 32)
        & (saturation >= 35)
        & (brightness >= 55)
        & (brightness <= 210)
    )

    # High local standard deviation is a useful clue for rough tree/bush
    # canopies. It is never used by itself to reject a parcel.
    rough_pixel = texture_std >= 18.0

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
        crop_mean = float(crop_probability[parcel_mask].mean())
        grass_mean = float(grass_probability[parcel_mask].mean())
        bareland_mean = float(bareland_probability[parcel_mask].mean())

        agriculture_dominance = float(
            np.count_nonzero(
                agriculture_values >= conflict_probability[parcel_mask]
            )
            / pixel_count
        )
        tree_values = tree_probability[parcel_mask]
        tree_mean = float(tree_values.mean())
        tree_dominance = float(
            np.count_nonzero(tree_values > agriculture_values) / pixel_count
        )

        # Keep this early gate deliberately permissive. Final cultivated /
        # fallow decisions happen later using visible colour, field geometry
        # and tree-canopy evidence.
        if agriculture_mean < 0.20 or agriculture_dominance < 0.30:
            continue

        # Only discard overwhelming semantic tree predictions here. Normal
        # dark vegetation is evaluated later with darkness + roughness.
        if tree_mean > 0.80 and agriculture_mean < 0.45:
            continue

        contours, hierarchy = cv2.findContours(
            parcel_mask.astype(np.uint8),
            cv2.RETR_CCOMP,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        if not contours:
            continue

        hierarchy = (
            hierarchy[0]
            if hierarchy is not None and len(hierarchy)
            else None
        )

        # Use the largest outer contour as the real parcel boundary.
        outer_indices = (
            [
                index
                for index in range(len(contours))
                if hierarchy is None or hierarchy[index][3] == -1
            ]
        )

        if not outer_indices:
            continue

        outer_index = max(
            outer_indices,
            key=lambda index: cv2.contourArea(contours[index]),
        )

        contour = contours[outer_index]
        contour_area = float(cv2.contourArea(contour))
        if contour_area < minimum_pixels * 0.75:
            continue
        x, y, parcel_width, parcel_height = cv2.boundingRect(contour)
        aspect_ratio = max(
            parcel_width / max(parcel_height, 1),
            parcel_height / max(parcel_width, 1),
        )

        perimeter = float(cv2.arcLength(contour, True))

        rotated_rectangle = cv2.minAreaRect(contour)
        rectangle_width, rectangle_height = rotated_rectangle[1]
        rectangle_area = max(
            float(rectangle_width) * float(rectangle_height),
            1.0,
        )

        rectangularity = float(
            np.clip(contour_area / rectangle_area, 0.0, 1.0)
        )

        hull = cv2.convexHull(contour)
        hull_area = max(float(cv2.contourArea(hull)), 1.0)
        solidity = float(
            np.clip(contour_area / hull_area, 0.0, 1.0)
        )

        corner_polygon = cv2.approxPolyDP(
            contour,
            max(2.0, perimeter * 0.018),
            True,
        )
        corner_count = len(corner_polygon)

        # Most agricultural parcels in our target imagery are close to
        # quadrilateral. Four sides therefore receive the strongest score,
        # but real trapezoids and slightly irregular fields remain possible.
        if corner_count == 4:
            corner_score = 1.0
        elif corner_count == 5:
            corner_score = 0.92
        elif corner_count == 6:
            corner_score = 0.80
        elif corner_count == 3:
            corner_score = 0.70
        elif corner_count in (7, 8):
            corner_score = 0.60
        elif corner_count in (9, 10):
            corner_score = 0.42
        else:
            corner_score = 0.24

        geometry_score = float(
            np.clip(
                0.45 * rectangularity
                + 0.30 * solidity
                + 0.25 * corner_score,
                0.0,
                1.0,
            )
        )

        # Do not force rectangles. Reject only extreme shapes or strongly
        # organic/blob-like contours with weak rectangular structure.
        highly_irregular = (
            corner_count >= 11
            and rectangularity < 0.54
            and solidity < 0.72
        )

        if aspect_ratio > 10.0 or highly_irregular:
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
        parcel_texture = float(texture_std[parcel_mask].mean())

        green_ratio = float(
            np.count_nonzero(green_pixel & parcel_mask) / pixel_count
        )
        dark_green_ratio = float(
            np.count_nonzero(dark_green_pixel & parcel_mask) / pixel_count
        )
        rough_ratio = float(
            np.count_nonzero(rough_pixel & parcel_mask) / pixel_count
        )
        light_neutral_ratio = float(
            np.count_nonzero(light_neutral_pixel & parcel_mask) / pixel_count
        )
        brown_ratio = float(
            np.count_nonzero(brown_bare_pixel & parcel_mask) / pixel_count
        )

        # Darkness by itself is NOT a tree rule: healthy crops can also be
        # dark. A parcel is considered tree/bush-like only when darkness,
        # canopy roughness and tree evidence agree.
        strong_tree_canopy = (
            dark_green_ratio >= 0.52
            and rough_ratio >= 0.24
            and tree_mean >= 0.08
        )
        very_rough_dark_canopy = (
            dark_green_ratio >= 0.68
            and rough_ratio >= 0.34
        )
        model_tree_canopy = (
            tree_mean >= 0.32
            and rough_ratio >= 0.18
        )

        tree_like_parcel = (
            strong_tree_canopy
            or very_rough_dark_canopy
            or model_tree_canopy
        )

        # Trees/bushes are the vegetation we explicitly reject. White/brown
        # surfaces are NOT automatically rejected because they may be
        # uncultivated, harvested or fallow agricultural fields.
        if tree_like_parcel:
            continue

        texture_score = float(
            np.clip(
                1.0 - parcel_texture / 45.0,
                0.0,
                1.0,
            )
        )

        field_shape_score = float(
            np.clip(
                0.45 * corner_score
                + 0.30 * rectangularity
                + 0.25 * solidity,
                0.0,
                1.0,
            )
        )

        # Cultivated land may be somewhat irregular, so strong vegetation /
        # agricultural evidence is enough once tree-like canopy is removed.
        cultivated_field = (
            (
                green_ratio >= 0.16
                and agriculture_mean >= 0.34
            )
            or crop_mean >= 0.45
            or (
                grass_mean >= 0.42
                and green_ratio >= 0.10
            )
        )

        # White/brown/bare land is accepted as an uncultivated/fallow field
        # only when it has a strong field-like geometry. Four sides are
        # strongest; five and six sides are also allowed.
        fallow_surface_evidence = (
            bareland_mean >= 0.25
            or brown_ratio >= 0.12
            or light_neutral_ratio >= 0.12
        )

        uncultivated_field = (
            corner_count in (4, 5, 6)
            and field_shape_score >= 0.70
            and rectangularity >= 0.58
            and fallow_surface_evidence
        )

        if not cultivated_field and not uncultivated_field:
            continue

        surface_score = (
            max(
                min(green_ratio * 1.6, 1.0),
                crop_mean,
                grass_mean * 0.85,
            )
            if cultivated_field
            else max(
                bareland_mean,
                min((brown_ratio + light_neutral_ratio) * 1.8, 1.0),
            )
        )

        confidence = np.clip(
            0.25 * agriculture_mean
            + 0.15 * agriculture_dominance
            + 0.30 * field_shape_score
            + 0.10 * texture_score
            + 0.10 * edge_support
            + 0.10 * surface_score,
            0.0,
            1.0,
        )

        # Explicit colour/tree/shape checks above now do most rejection.
        # Keep only a low floor for extremely weak candidates.
        if confidence < 0.46:
            continue

        print(
            "FIELD CANDIDATE DIAGNOSTIC: "
            f"seed={int(seed_label)}, "
            f"pixels={pixel_count}, "
            f"agriculture={agriculture_mean:.3f}, "
            f"agri_dominance={agriculture_dominance:.3f}, "
            f"tree={tree_mean:.3f}, "
            f"tree_dominance={tree_dominance:.3f}, "
            f"green={green_ratio:.3f}, "
            f"dark_green={dark_green_ratio:.3f}, "
            f"rough={rough_ratio:.3f}, "
            f"light={light_neutral_ratio:.3f}, "
            f"brown={brown_ratio:.3f}, "
            f"bare={bareland_mean:.3f}, "
            f"cultivated={int(cultivated_field)}, "
            f"fallow={int(uncultivated_field)}, "
            f"corners={corner_count}, "
            f"rectangularity={rectangularity:.3f}, "
            f"solidity={solidity:.3f}, "
            f"geometry={geometry_score:.3f}, "
            f"field_shape={field_shape_score:.3f}, "
            f"texture={texture_score:.3f}, "
            f"edge={edge_support:.3f}, "
            f"confidence={float(confidence):.3f}"
        )

        simplified = cv2.approxPolyDP(
            contour,
            max(1.2, perimeter * 0.004),
            True,
        ).reshape(-1, 2)
        if len(simplified) < 3:
            continue
        def contour_to_coordinates(points):
            ring = [
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
                for pixel_x, pixel_y in points
            ]

            if ring and ring[0] != ring[-1]:
                ring.append(ring[0])

            return ring

        outer_ring = contour_to_coordinates(simplified)

        if len(outer_ring) < 4:
            continue

        hole_rings = []

        if hierarchy is not None:
            child_index = int(hierarchy[outer_index][2])

            while child_index != -1:
                hole_contour = contours[child_index]
                hole_area = float(cv2.contourArea(hole_contour))

                # Ignore tiny pixel noise but preserve meaningful excluded
                # building/water islands inside a field.
                if hole_area >= 9.0:
                    hole_perimeter = float(
                        cv2.arcLength(hole_contour, True)
                    )

                    hole_simplified = cv2.approxPolyDP(
                        hole_contour,
                        max(1.0, hole_perimeter * 0.006),
                        True,
                    ).reshape(-1, 2)

                    hole_ring = contour_to_coordinates(
                        hole_simplified
                    )

                    if len(hole_ring) >= 4:
                        hole_rings.append(hole_ring)

                child_index = int(hierarchy[child_index][0])

        # Keep the old flat format when no holes exist. This preserves complete
        # backwards compatibility. Leaflet receives nested rings only when a
        # real internal water/building hole exists.
        coordinates = (
            [outer_ring, *hole_rings]
            if hole_rings
            else outer_ring
        )
        results.append(
            {
                "coordinates": coordinates,
                "area_m2": round(pixel_count * square_metres_per_pixel, 1),
                "confidence": round(float(confidence) * 100.0, 1),
                "agriculture_score": round(agriculture_mean, 4),
                "tree_score": round(tree_mean, 4),
                "green_ratio": round(green_ratio, 4),
                "dark_green_ratio": round(dark_green_ratio, 4),
                "rough_ratio": round(rough_ratio, 4),
                "light_ratio": round(light_neutral_ratio, 4),
                "brown_ratio": round(brown_ratio, 4),
                "bareland_score": round(bareland_mean, 4),
                "field_type": (
                    "cultivated"
                    if cultivated_field
                    else "uncultivated"
                ),
                "corner_count": int(corner_count),
                "rectangularity": round(rectangularity, 4),
                "solidity": round(solidity, 4),
                "geometry_score": round(geometry_score, 4),
                "field_shape_score": round(field_shape_score, 4),
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

