from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
from PIL import Image

from ftw_tools.download.download_img import create_input, query_stac


MARKER = "__AGRITERRAIN_SENTINEL_WATER_JSON__"
CACHE_DIRECTORY = Path(__file__).resolve().parent / ".cache" / "sentinel-water"


def _cache_key(config: dict) -> str:
    box = config["box"]
    stable = {
        "bbox": [
            round(float(box["west"]), 5),
            round(float(box["south"]), 5),
            round(float(box["east"]), 5),
            round(float(box["north"]), 5),
        ],
        "width": int(config["width"]),
        "height": int(config["height"]),
        "year": int(config["year"]),
        "algorithm": "ndwi-v1",
    }
    encoded = json.dumps(stable, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _resize_probability(array: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    image = Image.fromarray(np.asarray(array, dtype=np.float32), mode="F")
    return np.asarray(image.resize(size, Image.Resampling.BILINEAR), dtype=np.float32)


def _download_ndwi(config: dict, output_file: Path) -> dict:
    box = config["box"]
    bbox = [
        float(box["west"]),
        float(box["south"]),
        float(box["east"]),
        float(box["north"]),
    ]
    year = int(config["year"])
    last_error: Exception | None = None
    selected_scene = ""
    selected_host = ""

    for host in ("earthsearch", "mspc"):
        try:
            selected_scene = query_stac(
                bbox=bbox,
                date=pd.Timestamp(f"{year}-07-01"),
                stac_host=host,
                cloud_cover_max=35,
                buffer_days=175,
                s2_collection="c1",
                nodata_max=25,
                verbose=False,
            )
            selected_host = host
            break
        except Exception as error:
            last_error = error

    if not selected_scene:
        raise RuntimeError(f"No usable Sentinel-2 scene was found: {last_error}")

    with tempfile.TemporaryDirectory(prefix="agriterrain-sentinel-") as temp_dir:
        raster_file = Path(temp_dir) / "sentinel_rgbn.tif"
        create_input(
            win_a=selected_scene,
            win_b=None,
            out=str(raster_file),
            overwrite=True,
            bbox=bbox,
            stac_host=selected_host,
            s2_collection="c1",
            verbose=False,
        )
        with rasterio.open(raster_file) as dataset:
            if dataset.count < 4:
                raise RuntimeError("Sentinel-2 image does not contain RGB and NIR bands.")
            green = dataset.read(2).astype(np.float32)
            near_infrared = dataset.read(4).astype(np.float32)
            capture_date = dataset.tags().get("TIFFTAG_DATETIME", "")

    denominator = green + near_infrared
    valid = denominator > 0
    ndwi = np.full_like(green, -1.0, dtype=np.float32)
    ndwi[valid] = (green[valid] - near_infrared[valid]) / denominator[valid]

    # Convert NDWI to a soft confirmation probability. Values around or below
    # zero remain weak; clearly positive water values approach one.
    water_probability = 1.0 / (1.0 + np.exp(-12.0 * (ndwi - 0.04)))
    water_probability[~valid] = 0.0
    resized = _resize_probability(
        water_probability,
        (int(config["width"]), int(config["height"])),
    )
    np.save(output_file, np.clip(resized, 0.0, 1.0).astype(np.float32))
    return {
        "provider": "Sentinel-2 L2A",
        "index": "NDWI (green and near-infrared)",
        "scene": selected_scene,
        "capture_date": capture_date,
        "stac_host": selected_host,
    }


def main() -> None:
    request_file = Path(sys.argv[1])
    output_file = Path(sys.argv[2])
    config = json.loads(request_file.read_text(encoding="utf-8"))

    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    cache_key = _cache_key(config)
    cache_file = CACHE_DIRECTORY / f"{cache_key}.npy"
    metadata_file = CACHE_DIRECTORY / f"{cache_key}.json"

    if cache_file.is_file() and metadata_file.is_file():
        probability = np.load(cache_file).astype(np.float32)
        expected_shape = (int(config["height"]), int(config["width"]))
        if probability.shape == expected_shape:
            np.save(output_file, probability)
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            metadata["cache_hit"] = True
            print("SENTINEL WATER CACHE: hit")
            print(MARKER + json.dumps(metadata))
            return

    metadata = _download_ndwi(config, output_file)
    probability = np.load(output_file).astype(np.float32)
    np.save(cache_file, probability)
    metadata["cache_hit"] = False
    metadata_file.write_text(json.dumps(metadata), encoding="utf-8")
    print("SENTINEL WATER CACHE: stored")
    print(MARKER + json.dumps(metadata))


if __name__ == "__main__":
    main()
