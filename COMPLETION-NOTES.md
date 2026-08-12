# AgriTerrain AI completion notes

This build completes the remaining workspace flow while keeping the existing
home/authentication structure intact.

## Added

- Reports / History protected page and navigation route
- Per-account browser-local analysis history
- Same-location result comparison
- Browser-generated PDF report workflow
- Source links and recommendation sections
- Locked Map / Live Map controls
- Proposal-style white crop-region rectangles in the locked analysis map
- RGB-safe insights that explicitly leave NDVI/NDWI, disease, and hazard-risk
  values unavailable when the necessary data is not connected

## Corrected

- Dashboard now reads the actual crop/water/building schema returned by the ML
  service and no longer fills missing analysis/weather/risk values with demo
  numbers.
- Maximum selected side changed from 520 m to 420 m for more image detail.
- Water and building detection use stricter precision-oriented confidence and
  region filters.
- Older SavedModel checkpoints get a legacy serving-graph loading attempt when
  TensorFlow object revival fails.

## Important limits

The included global pretrained land-cover model is still not a guarantee of
Bangladesh accuracy. The stricter thresholds are intended to reduce false
positives, but local labelled validation/fine-tuning remains the correct next
step for reliable accuracy measurement.

Scientific NDVI/NDWI requires multispectral bands. The current Esri inference
image is RGB, so the interface does not invent a crop-health score.
