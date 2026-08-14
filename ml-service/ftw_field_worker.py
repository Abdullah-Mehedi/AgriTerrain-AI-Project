from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.features import geometry_mask
from rasterio.transform import from_bounds
from shapely.geometry import Polygon, mapping

from ftw_tools.inference.inference import run_instance_segmentation
from ftw_tools.inference.models import DelineateAnything


MARKER = "__AGRITERRAIN_FTW_JSON__"
MODEL_NAME = "DelineateAnythingV2"
MIN_FIELD_AREA_M2 = 120.0
# DAv2 is trained on coarser agricultural imagery. Small, high-resolution
# village parcels receive lower instance scores than large open fields, so the
# land-cover and exclusion gates below carry most of the precision filtering.
MIN_MODEL_SCORE = 0.10
MIN_AGRICULTURE_MEAN = 0.30
AGRICULTURE_CORE_THRESHOLD = 0.45
MIN_AGRICULTURE_CORE_RATIO = 0.20
MIN_AGRICULTURE_DOMINANT_RATIO = 0.35
MAX_EXCLUDED_RATIO = 0.08
DUPLICATE_IOU = 0.15
DUPLICATE_CONTAINMENT = 0.25

CLASS_IDS = {
    "bareland": 1,
    "grass": 2,
    "pavement": 3,
    "road": 4,
    "tree": 5,
    "water": 6,
    "crop": 7,
    "building": 8,
}


def _resize_float(array: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    image = Image.fromarray(np.asarray(array, dtype=np.float32), mode="F")
    return np.asarray(image.resize(size, Image.Resampling.BILINEAR), dtype=np.float32)


def _resize_mask(array: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    image = Image.fromarray(np.asarray(array, dtype=np.uint8) * 255, mode="L")
    return np.asarray(image.resize(size, Image.Resampling.NEAREST)) > 0


def _resize_probabilities(
    probabilities: np.ndarray,
    size: tuple[int, int],
) -> np.ndarray:
    return np.stack(
        [
            _resize_float(probabilities[:, :, channel], size)
            for channel in range(probabilities.shape[2])
        ],
        axis=-1,
    )


def _write_georeferenced_image(
    image: np.ndarray,
    box: dict[str, float],
    output_file: Path,
) -> rasterio.Affine:
    height, width = image.shape[:2]
    transform = from_bounds(
        float(box["west"]),
        float(box["south"]),
        float(box["east"]),
        float(box["north"]),
        width,
        height,
    )

    # The upstream DelineateAnything wrapper expects Sentinel-style reflectance
    # values and divides pixels by 3000. Preserve the visible RGB colours while
    # mapping the 8-bit Esri image into that expected numeric range.
    reflectance = np.rint(image.astype(np.float32) / 255.0 * 3000.0).astype(
        np.uint16
    )
    with rasterio.open(
        output_file,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=3,
        dtype="uint16",
        crs="EPSG:4326",
        transform=transform,
        compress="deflate",
    ) as dataset:
        for band in range(3):
            dataset.write(reflectance[:, :, band], band + 1)
        dataset.colorinterp = (
            rasterio.enums.ColorInterp.red,
            rasterio.enums.ColorInterp.green,
            rasterio.enums.ColorInterp.blue,
        )
    return transform


def _polygon_parts(geometry: Any) -> list[Any]:
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type == "MultiPolygon":
        return list(geometry.geoms)
    if geometry.geom_type == "GeometryCollection":
        return [part for part in geometry.geoms if part.geom_type == "Polygon"]
    return []


def _model_score(row: Any, crop_mean: float) -> float:
    for key in ("confidence", "score", "conf", "probability"):
        try:
            value = row.get(key)
            if value is None:
                continue
            score = float(value)
            if np.isfinite(score):
                return max(0.0, min(score / 100.0 if score > 1 else score, 1.0))
        except (TypeError, ValueError):
            continue
    # Some output drivers omit the instance score. In that case use the real
    # OpenEarthMap mean crop probability instead of inventing a confidence.
    return max(0.0, min(crop_mean, 1.0))


def _bounds_intersect(first: Any, second: Any) -> bool:
    a_west, a_south, a_east, a_north = first.bounds
    b_west, b_south, b_east, b_north = second.bounds
    return not (
        a_east < b_west
        or a_west > b_east
        or a_north < b_south
        or a_south > b_north
    )


def _is_duplicate(candidate: Any, accepted: list[dict[str, Any]]) -> bool:
    for existing in accepted:
        other = existing["geometry"]
        if not _bounds_intersect(candidate, other):
            continue
        intersection_area = candidate.intersection(other).area
        if intersection_area <= 0:
            continue
        candidate_area = candidate.area
        other_area = other.area
        union_area = candidate_area + other_area - intersection_area
        iou = intersection_area / max(union_area, 1e-18)
        containment = intersection_area / max(min(candidate_area, other_area), 1e-18)
        if iou >= DUPLICATE_IOU or containment >= DUPLICATE_CONTAINMENT:
            return True
    return False


def main() -> None:
    request_file = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    image_file = Path(sys.argv[3])
    probability_file = Path(sys.argv[4])
    selection_file = Path(sys.argv[5])
    exclusion_file = Path(sys.argv[6])

    config = json.loads(request_file.read_text(encoding="utf-8"))
    box = config["box"]
    boundary = config["boundary"]
    max_features = min(int(config.get("max_features", 250)), 120)

    output_dir.mkdir(parents=True, exist_ok=True)
    tif_file = output_dir / "visible_imagery.tif"
    polygon_file = output_dir / "field_instances.gpkg"

    image = np.asarray(Image.open(image_file).convert("RGB"))
    height, width = image.shape[:2]
    probabilities = np.load(probability_file).astype(np.float32)
    selected_mask = np.load(selection_file).astype(bool)
    excluded_mask = np.load(exclusion_file).astype(bool)
    if probabilities.shape[:2] != (height, width):
        probabilities = _resize_probabilities(probabilities, (width, height))
    if selected_mask.shape != (height, width):
        selected_mask = _resize_mask(selected_mask, (width, height))
    if excluded_mask.shape != (height, width):
        excluded_mask = _resize_mask(excluded_mask, (width, height))

    crop_probability = probabilities[:, :, CLASS_IDS["crop"]]
    # OpenEarthMap separates actively growing crops from grass and bare land.
    # Small real parcels in seasonal imagery are frequently harvested, fallow,
    # or newly planted, so use all three agricultural surface classes to
    # validate DAv2 instance proposals. DAv2 still supplies every boundary.
    agriculture_probability = np.clip(
        crop_probability
        + probabilities[:, :, CLASS_IDS["grass"]]
        + probabilities[:, :, CLASS_IDS["bareland"]],
        0.0,
        1.0,
    )

    image_transform = _write_georeferenced_image(image, box, tif_file)

    cached_weight = Path.cwd() / "weights" / "DelineateAnythingv2.pt"
    if cached_weight.is_file():
        DelineateAnything.checkpoints[MODEL_NAME] = str(cached_weight.resolve())
        print(f"FTW MODEL CACHE: {cached_weight.resolve()}")

    # Process the entire 512-pixel locked map at native scale. This preserves
    # full-scene context, eliminates internal seams, and avoids the peak memory
    # of upscaling the frame to 1024 pixels beside the TensorFlow model.
    inference_patch_size = max(height, width)
    try:
        run_instance_segmentation(
            input=str(tif_file),
            model=MODEL_NAME,
            out=str(polygon_file),
            gpu=None,
            resize_factor=1,
            patch_size=inference_patch_size,
            batch_size=1,
            num_workers=0,
            max_detections=max(250, max_features),
            iou_threshold=0.30,
            conf_threshold=0.05,
            padding=0,
            overwrite=True,
            mps_mode=False,
            simplify=0,
            min_size=int(MIN_FIELD_AREA_M2),
            max_size=100000,
            close_interiors=True,
            overlap_iou_threshold=0.0,
            overlap_contain_threshold=0.0,
        )
    except ValueError as error:
        if "No objects to concatenate" not in str(error):
            raise
        print("FTW RAW POLYGONS: 0")
        print(MARKER + "[]")
        return

    fields = gpd.read_file(polygon_file)
    print(f"FTW RAW POLYGONS: {len(fields)}")
    if fields.empty:
        print(MARKER + "[]")
        return
    if fields.crs is None:
        raise RuntimeError("DelineateAnything output has no coordinate system.")
    fields = fields.to_crs("EPSG:4326")

    selection_polygon = Polygon(
        [(float(longitude), float(latitude)) for latitude, longitude in boundary]
    ).buffer(0)
    if selection_polygon.is_empty:
        raise RuntimeError("The selected crop boundary is invalid after repair.")
    metric_crs = gpd.GeoSeries(
        [selection_polygon], crs="EPSG:4326"
    ).estimate_utm_crs()

    candidates: list[dict[str, Any]] = []
    semantic_rejections = 0
    score_rejections = 0
    rejection_reasons = {
        "agriculture_mean": 0,
        "agriculture_core": 0,
        "agriculture_dominance": 0,
        "excluded_overlap": 0,
    }
    for _, row in fields.iterrows():
        geometry = row.geometry
        if geometry is None or geometry.is_empty:
            continue
        if not geometry.is_valid:
            geometry = geometry.buffer(0)
        if geometry.is_empty or not geometry.intersects(selection_polygon):
            continue

        clipped = geometry.intersection(selection_polygon)
        for field_polygon in _polygon_parts(clipped):
            if field_polygon.is_empty:
                continue

            pixel_mask = geometry_mask(
                [mapping(field_polygon)],
                out_shape=(height, width),
                transform=image_transform,
                invert=True,
            ) & selected_mask
            pixel_count = int(np.count_nonzero(pixel_mask))
            if pixel_count < 8:
                continue

            crop_values = crop_probability[pixel_mask]
            crop_mean = float(crop_values.mean())
            agriculture_values = agriculture_probability[pixel_mask]
            agriculture_mean = float(agriculture_values.mean())
            agriculture_core_ratio = float(
                np.count_nonzero(
                    agriculture_values >= AGRICULTURE_CORE_THRESHOLD
                )
                / pixel_count
            )
            competing_values = np.maximum.reduce(
                [
                    probabilities[:, :, CLASS_IDS[class_key]][pixel_mask]
                    for class_key in (
                        "pavement",
                        "road",
                        "tree",
                        "water",
                        "building",
                    )
                ]
            )
            agriculture_dominant_ratio = float(
                np.count_nonzero(agriculture_values >= competing_values) / pixel_count
            )
            excluded_ratio = float(
                np.count_nonzero(excluded_mask[pixel_mask]) / pixel_count
            )
            failed_reasons = []
            if agriculture_mean < MIN_AGRICULTURE_MEAN:
                failed_reasons.append("agriculture_mean")
            if agriculture_core_ratio < MIN_AGRICULTURE_CORE_RATIO:
                failed_reasons.append("agriculture_core")
            if agriculture_dominant_ratio < MIN_AGRICULTURE_DOMINANT_RATIO:
                failed_reasons.append("agriculture_dominance")
            if excluded_ratio > MAX_EXCLUDED_RATIO:
                failed_reasons.append("excluded_overlap")
            if failed_reasons:
                for reason in failed_reasons:
                    rejection_reasons[reason] += 1
                semantic_rejections += 1
                continue

            metric_polygon = gpd.GeoSeries(
                [field_polygon], crs="EPSG:4326"
            ).to_crs(metric_crs)
            area_m2 = float(metric_polygon.area.iloc[0])
            if area_m2 < MIN_FIELD_AREA_M2:
                continue

            score = _model_score(row, crop_mean)
            if score < MIN_MODEL_SCORE:
                score_rejections += 1
                continue
            candidates.append(
                {
                    "geometry": field_polygon,
                    "area_m2": area_m2,
                    "score": score,
                    "crop_mean": crop_mean,
                    "agriculture_mean": agriculture_mean,
                    "agriculture_dominant_ratio": agriculture_dominant_ratio,
                }
            )

    candidates.sort(
        key=lambda item: (
            item["score"],
            item["agriculture_dominant_ratio"],
            item["agriculture_mean"],
            item["area_m2"],
        ),
        reverse=True,
    )
    accepted: list[dict[str, Any]] = []
    duplicate_rejections = 0
    for candidate in candidates:
        if _is_duplicate(candidate["geometry"], accepted):
            duplicate_rejections += 1
            continue
        accepted.append(candidate)
        if len(accepted) >= max_features:
            break

    accepted.sort(
        key=lambda item: (
            -item["geometry"].centroid.y,
            item["geometry"].centroid.x,
        )
    )
    results = []
    for index, item in enumerate(accepted, start=1):
        coordinates = [
            [round(float(latitude), 7), round(float(longitude), 7)]
            for longitude, latitude in item["geometry"].exterior.coords
        ]
        if len(coordinates) < 4:
            continue
        results.append(
            {
                "coordinates": coordinates,
                "area_m2": round(item["area_m2"], 1),
                "confidence": round(item["score"] * 100.0, 1),
                "id": f"field-{index}",
            }
        )

    print(f"FTW SEMANTIC REJECTIONS: {semantic_rejections}")
    print(f"FTW REJECTION REASONS: {json.dumps(rejection_reasons, sort_keys=True)}")
    print(f"FTW SCORE REJECTIONS: {score_rejections}")
    print(f"FTW DUPLICATE REJECTIONS: {duplicate_rejections}")
    print(f"FTW ACCEPTED POLYGONS: {len(results)}")
    print(MARKER + json.dumps(results))


if __name__ == "__main__":
    main()
