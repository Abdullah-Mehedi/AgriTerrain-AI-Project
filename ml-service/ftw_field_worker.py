from __future__ import annotations

import json
import sys
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Point, Polygon

from ftw_tools.download.download_img import create_input, scene_selection
from ftw_tools.inference.inference import run_instance_segmentation


MARKER = "__AGRITERRAIN_FTW_JSON__"


def main():
    request_file = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])

    config = json.loads(request_file.read_text(encoding="utf-8"))

    bbox = config["bbox"]
    selection_bbox = config["selection_bbox"]
    boundary = config["boundary"]
    max_features = int(config.get("max_features", 250))

    output_dir.mkdir(parents=True, exist_ok=True)

    tif_file = output_dir / "inference_data.tif"
    polygon_file = output_dir / "inference_output.parquet"

    last_error = None
    selected_scene = None

    # Use a completed growing year so both crop-calendar windows exist.
    for cloud_limit, buffer_days in ((60, 60), (85, 100), (100, 160)):
        try:
            win_a, _ = scene_selection(
                bbox=bbox,
                year=2025,
                stac_host="mspc",
                cloud_cover_max=cloud_limit,
                buffer_days=buffer_days,
                s2_collection="c1",
                nodata_max=60,
                verbose=False,
            )
            selected_scene = win_a
            break
        except Exception as error:
            last_error = error

    if selected_scene is None:
        raise RuntimeError(f"No usable Sentinel-2 scene found: {last_error}")

    create_input(
        win_a=selected_scene,
        win_b=None,
        out=str(tif_file),
        overwrite=True,
        bbox=bbox,
        stac_host="mspc",
        s2_collection="c1",
        verbose=False,
    )

    run_instance_segmentation(
        input=str(tif_file),
        model="DelineateAnythingV2",
        out=str(polygon_file),
        gpu=None,
        resize_factor=2,
        patch_size=128,
        batch_size=2,
        num_workers=1,
        max_detections=150,
        iou_threshold=0.30,
        conf_threshold=0.15,
        padding=None,
        overwrite=True,
        mps_mode=False,
        simplify=2,
        min_size=150,
        max_size=100000,
        close_interiors=True,
        overlap_iou_threshold=0.20,
        overlap_contain_threshold=0.80,
    )

    fields = gpd.read_parquet(polygon_file)

    if fields.empty:
        print(MARKER + "[]")
        return

    if fields.crs is None:
        raise RuntimeError("FTW output has no CRS.")

    original = fields.copy()

    if original.crs.is_geographic:
        metric = original.to_crs(original.estimate_utm_crs())
    else:
        metric = original

    areas = metric.geometry.area.tolist()
    fields = original.to_crs(epsg=4326)

    # User-selected polygon.
    selection_polygon = Polygon(
        [(float(lon), float(lat)) for lat, lon in boundary]
    )

    min_lon, min_lat, max_lon, max_lat = selection_bbox

    result = []

    for row_number, (_, row) in enumerate(fields.iterrows()):
        geometry = row.geometry

        if geometry is None or geometry.is_empty:
            continue

        geometries = (
            list(geometry.geoms)
            if geometry.geom_type == "MultiPolygon"
            else [geometry]
        )

        for geometry_part in geometries:
            center = geometry_part.representative_point()

            if not (
                min_lon <= center.x <= max_lon
                and min_lat <= center.y <= max_lat
            ):
                continue

            if not selection_polygon.contains(Point(center.x, center.y)):
                continue

            coords = [
                [round(float(lat), 7), round(float(lon), 7)]
                for lon, lat in geometry_part.exterior.coords
            ]

            if len(coords) < 4:
                continue

            confidence = 0.80

            for confidence_key in (
                "confidence",
                "score",
                "conf",
                "probability",
            ):
                try:
                    value = row.get(confidence_key)
                    if value is not None:
                        confidence = float(value)
                        break
                except Exception:
                    pass

            area = float(areas[row_number])

            result.append(
                {
                    "coordinates": coords,
                    "area_m2": round(area, 1),
                    "confidence": round(confidence, 3),
                    "id": f"ftw-field-{len(result) + 1}",
                }
            )

            if len(result) >= max_features:
                break

        if len(result) >= max_features:
            break

    print(MARKER + json.dumps(result))


if __name__ == "__main__":
    main()
