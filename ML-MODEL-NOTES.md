# OpenEarthMap model notes

## Integrated model

The Python service uses the existing public U-Net with an EfficientNet-B4
backbone used by this project for OpenEarthMap inference. The configured
checkpoint is cross-validation fold 1 from:

https://github.com/sebastianbahr/OpenEarthMap

The service works with nine semantic classes and AgriTerrain exposes crop,
water, and building outputs. Morphological cleanup and contour extraction turn
class masks into map regions. Counts are separated mask regions after physical
size and confidence filtering, not verified parcel/pond/house totals.

## Accuracy-oriented features in this implementation

- The user must select a compact area before inference.
- The frontend and backend reject selections over 420 m on the longest side.
- Four-view test-time augmentation averages the original, horizontal flip,
  vertical flip, and combined flip predictions in accurate mode.
- The user can request a general probability threshold from 40% to 80%.
- The backend applies stricter class floors: crop 55%, water 70%, and building
  60%. The user slider can make these stricter but cannot lower them.
- A detected region must also pass a class-specific mean confidence floor:
  crop 58%, water 72%, building 62%.
- Minimum region areas are 220 m² for crop, 35 m² for water, and 10 m² for
  building; water also receives stronger opening cleanup.
- Input resolution and mean model probability are shown with the result.
- No random polygons, fake counts, or demo fallback are generated.

These thresholds are precision-oriented heuristics. They can reduce some false
positives but are not a substitute for labelled Bangladesh validation data.

## TensorFlow model-loading compatibility

The service first uses `tf.saved_model.load()` and the `serving_default`
signature. If object revival fails for this older checkpoint, it tries a legacy
TensorFlow v1-compatible SavedModel serving graph/session and runs the exported
input/output tensors directly.

This fallback is for inference compatibility only; it does not change model
weights or accuracy.

## Published benchmark context shown by the UI

The project's configured benchmark metadata is:

| Class | IoU |
| --- | ---: |
| Agriculture | 79.82% |
| Water | 86.04% |
| Building | 80.92% |

Those values are benchmark context, not measured accuracy for a new Bangladesh
selection. Model probability/certainty is also not ground-truth accuracy.

## RGB limitation: NDVI / NDWI

The current inference image is an RGB mosaic. The website deliberately does not
calculate or fake NDVI/NDWI from it. Vegetation/water indices require suitable
multispectral bands. Connect dated Sentinel-2 or another appropriate
multispectral source before adding a scientific crop-health score.

## Known limitations

- Semantic segmentation finds class pixels; it is not a cadastral parcel model.
- Adjacent crop fields with similar appearance may merge.
- Touching roofs may merge into one building region.
- Small, shaded, tree-covered, or visually unusual ponds and roofs can be
  missed or confused with other classes.
- Stricter water/building thresholds reduce sensitivity as well as false
  positives.
- The Esri mosaic capture date varies by location.
- Seasonal appearance, haze, shadows, image compression, and regional building
  styles can reduce accuracy.
- Model/source-imagery licences should be reviewed for deployment use.

## Recommended next research step

Create a Bangladesh validation set of carefully labelled 512×512 patches from
representative districts and seasons. Measure per-class IoU, precision, and
recall, fine-tune the model if needed, and select thresholds from those results
instead of relying on heuristics.

For scientific historical comparison, use dated imagery metadata rather than
treating the time a user clicked Analyze as the image capture date.
