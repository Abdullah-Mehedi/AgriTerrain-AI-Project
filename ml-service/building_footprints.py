import csv
import gzip
import io
import json
import math
from pathlib import Path

import httpx

DATASET_INDEX = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
CACHE_DIR = Path(__file__).resolve().parent / ".cache" / "microsoft-buildings"


def _quadkey_bounds(quadkey):
    x = y = 0
    zoom = len(quadkey)

    for i, digit in enumerate(quadkey):
        mask = 1 << (zoom - i - 1)
        if digit in ("1", "3"):
            x |= mask
        if digit in ("2", "3"):
            y |= mask

    n = 2 ** zoom

    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0

    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))

    return {"west": west, "east": east, "north": north, "south": south}


def _boxes_intersect(a, b):
    return not (
        a["east"] < b["west"]
        or a["west"] > b["east"]
        or a["north"] < b["south"]
        or a["south"] > b["north"]
    )


def _point_inside(latitude, longitude, boundary):
    inside = False
    j = len(boundary) - 1

    for i in range(len(boundary)):
        yi, xi = boundary[i]
        yj, xj = boundary[j]

        if ((yi > latitude) != (yj > latitude)):
            crossing = (
                (xj - xi) * (latitude - yi) / ((yj - yi) or 1e-12) + xi
            )
            if longitude < crossing:
                inside = not inside

        j = i

    return inside


def _area_m2(ring):
    if len(ring) < 3:
        return 0.0

    latitude = sum(p[1] for p in ring) / len(ring)
    mx = 111320 * math.cos(math.radians(latitude))
    my = 110540

    points = [(p[0] * mx, p[1] * my) for p in ring]

    area = 0.0
    for i, (x1, y1) in enumerate(points):
        x2, y2 = points[(i + 1) % len(points)]
        area += x1 * y2 - x2 * y1

    return abs(area) / 2


def _bangladesh_tiles(box):
    response = httpx.get(DATASET_INDEX, timeout=30)
    response.raise_for_status()

    rows = csv.DictReader(io.StringIO(response.text))

    matches = []
    for row in rows:
        if row.get("Location") != "Bangladesh":
            continue

        if _boxes_intersect(_quadkey_bounds(row["QuadKey"]), box):
            matches.append(row)

    return matches


def _download_tile(row):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    path = CACHE_DIR / f'{row["QuadKey"]}.geojsonl.gz'

    if not path.exists():
        response = httpx.get(row["Url"], timeout=180, follow_redirects=True)
        response.raise_for_status()
        path.write_bytes(response.content)

    return path


def get_building_footprints(boundary, box, max_features=250, min_confidence=0.85):
    results = []

    for row in _bangladesh_tiles(box):
        path = _download_tile(row)

        with gzip.open(path, "rt", encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue

                feature = json.loads(line)

                confidence = float(
                    feature.get("properties", {}).get("confidence", 0)
                )

                if confidence < min_confidence:
                    continue

                geometry = feature.get("geometry") or {}
                geometry_type = geometry.get("type")
                coordinates = geometry.get("coordinates") or []

                if geometry_type == "Polygon":
                    polygons = [coordinates]
                elif geometry_type == "MultiPolygon":
                    polygons = coordinates
                else:
                    continue

                for polygon in polygons:
                    if not polygon:
                        continue

                    ring = polygon[0]
                    if len(ring) < 4:
                        continue

                    longitudes = [p[0] for p in ring]
                    latitudes = [p[1] for p in ring]

                    ring_box = {
                        "west": min(longitudes),
                        "east": max(longitudes),
                        "south": min(latitudes),
                        "north": max(latitudes),
                    }

                    if not _boxes_intersect(ring_box, box):
                        continue

                    centre_lat = (ring_box["north"] + ring_box["south"]) / 2
                    centre_lon = (ring_box["east"] + ring_box["west"]) / 2

                    if not _point_inside(centre_lat, centre_lon, boundary):
                        continue

                    area = _area_m2(ring)

                    if area < 8:
                        continue

                    results.append(
                        {
                            "coordinates": [
                                [round(p[1], 7), round(p[0], 7)]
                                for p in ring
                            ],
                            "area_m2": round(area, 1),
                            "confidence": round(confidence * 100, 1),
                        }
                    )

    results.sort(key=lambda item: item["area_m2"], reverse=True)
    results = results[:max_features]

    for index, result in enumerate(results, 1):
        result["id"] = f"building-{index}"

    return results
