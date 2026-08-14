from __future__ import annotations

import io
import math

import httpx
from PIL import Image


TILE_SIZE = 256
TILE_URL = (
    "https://server.arcgisonline.com/ArcGIS/rest/services/"
    "World_Imagery/MapServer/tile/{z}/{y}/{x}"
)


def _world_pixel(longitude: float, latitude: float, zoom: int) -> tuple[float, float]:
    latitude = max(min(latitude, 85.05112878), -85.05112878)
    scale = TILE_SIZE * (2**zoom)
    x = (longitude + 180.0) / 360.0 * scale
    sin_latitude = math.sin(math.radians(latitude))
    y = (
        0.5
        - math.log((1 + sin_latitude) / (1 - sin_latitude)) / (4 * math.pi)
    ) * scale
    return x, y


def _choose_zoom(box: dict[str, float], output_size: int) -> int:
    centre_latitude = (box["north"] + box["south"]) / 2.0
    width_metres = (
        abs(box["east"] - box["west"])
        * 111_320.0
        * math.cos(math.radians(centre_latitude))
    )
    height_metres = abs(box["north"] - box["south"]) * 111_320.0
    target_metres_per_pixel = max(width_metres, height_metres) / max(output_size, 1)
    target_metres_per_pixel = max(target_metres_per_pixel, 0.05)
    zoom = round(
        math.log2(
            (156_543.03392 * math.cos(math.radians(centre_latitude)))
            / target_metres_per_pixel
        )
    )
    return max(17, min(20, zoom))


def fetch_esri_world_imagery(
    box: dict[str, float],
    output_size: int = 512,
) -> Image.Image:
    """Stitch the same cached Esri tiles displayed by the Leaflet map."""
    zoom = _choose_zoom(box, output_size)
    left, top = _world_pixel(box["west"], box["north"], zoom)
    right, bottom = _world_pixel(box["east"], box["south"], zoom)

    tile_x_min = math.floor(left / TILE_SIZE)
    tile_x_max = math.floor((right - 1) / TILE_SIZE)
    tile_y_min = math.floor(top / TILE_SIZE)
    tile_y_max = math.floor((bottom - 1) / TILE_SIZE)

    width_tiles = tile_x_max - tile_x_min + 1
    height_tiles = tile_y_max - tile_y_min + 1
    canvas = Image.new("RGB", (width_tiles * TILE_SIZE, height_tiles * TILE_SIZE))
    headers = {"User-Agent": "Mozilla/5.0 AgriTerrain-AI/1.0"}

    with httpx.Client(
        timeout=30,
        follow_redirects=True,
        headers=headers,
    ) as client:
        for tile_y in range(tile_y_min, tile_y_max + 1):
            for tile_x in range(tile_x_min, tile_x_max + 1):
                response = client.get(
                    TILE_URL.format(zoom=zoom, z=zoom, y=tile_y, x=tile_x)
                )
                response.raise_for_status()
                tile = Image.open(io.BytesIO(response.content)).convert("RGB")
                canvas.paste(
                    tile,
                    (
                        (tile_x - tile_x_min) * TILE_SIZE,
                        (tile_y - tile_y_min) * TILE_SIZE,
                    ),
                )

    crop_left = round(left - tile_x_min * TILE_SIZE)
    crop_top = round(top - tile_y_min * TILE_SIZE)
    crop_right = round(right - tile_x_min * TILE_SIZE)
    crop_bottom = round(bottom - tile_y_min * TILE_SIZE)
    cropped = canvas.crop((crop_left, crop_top, crop_right, crop_bottom))
    if cropped.width < 2 or cropped.height < 2:
        raise RuntimeError("Selected imagery area is too small.")
    return cropped.resize((output_size, output_size), Image.Resampling.LANCZOS)
