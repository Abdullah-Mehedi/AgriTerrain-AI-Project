# AgriTerrain AI

AgriTerrain AI is a React/Vite agricultural analysis website with Supabase
authentication, a responsive dashboard, Leaflet maps, live weather, local
analysis history, report generation, and a real selected-area land-cover model.

## Existing work preserved

- Existing homepage layout and visual style
- Existing Supabase signup, login, verification, password reset, and session flow
- Existing project structure and React/Vite approach

The remaining workspace features were completed without replacing the project
with a different application.

## Completed workspace pages

### Dashboard

The dashboard now reads the latest real saved model result instead of filling
missing data with demonstration values. It shows crop, water, and building
region counts, model certainty, live weather context when available, account
information, recent activity, and links to the main analysis/history workflow.

Flood, drought, NDVI, and NDWI values are not fabricated when the required data
is unavailable.

### Satellite Analysis

The satellite page follows this workflow:

1. Search for a Bangladesh location or use the device location.
2. Zoom in and draw a polygon no more than **420 metres** across.
3. Finish the boundary to use **Locked Map**, or switch back to **Live Map**.
4. Run the real OpenEarthMap U-Net/EfficientNet-B4 model.
5. Review crop, waterbody, and building results plus model evidence.
6. Review RGB-safe insights, weather context, recommendations, source links,
   and a basic saved-history comparison.
7. Generate a PDF report through the browser print dialog or download the
   transparent prediction mask.

Crop detections are also shown with thin individual white rectangle boundaries
in the locked analysis view, matching the project proposal direction rather
than drawing a grid overlay.

There is no fake analysis fallback. If the Python AI service is offline, the
result panel stays empty and explains how to start it.

### Reports / History

Completed Reports / History includes:

- browser-local per-account saved analyses
- location/date filtering
- previous crop/water/building region results
- land-cover coverage and model certainty
- same-location historical comparison
- recommendation summaries
- verification/source links
- PDF report generation
- delete and clear-history controls

Saved history is currently browser-local. A future database table can replace
this storage layer without changing the visible page structure.

## Easiest Windows start

Requirements:

- Node.js LTS
- Python 3.11 (including the `py` launcher)
- Your existing `.env.local` containing the Supabase values

Double-click:

`START-AGRITERRAIN.bat`

The first run installs the JavaScript and Python packages. On the Satellite
Analysis page, select **Prepare model**. It downloads the public model files
once (approximately 304 MB). Keep both terminal windows open while using the
website.

## Manual start

Terminal 1 — frontend:

```powershell
npm install
npm run dev
```

Terminal 2 — AI service:

```powershell
cd ml-service
py -3.11 -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

The frontend defaults to `http://127.0.0.1:8000`. For a different server, add
this to the root `.env.local` and restart Vite:

```env
VITE_ML_API_URL=https://your-ai-service.example
```

## Why the selected area is limited

The model consumes a 512×512 RGB image. A large map selection makes houses and
small ponds occupy fewer pixels, so the application uses a conservative 420 m
maximum side and shows the estimated metres per pixel before analysis.

## Detection precision changes

The backend now uses class-specific precision floors in addition to the user's
threshold. Water and building require stricter probability and region-average
confidence than the generic slider minimum, and tiny regions are filtered more
aggressively. This is intended to reduce obvious false positives; it does not
prove local accuracy.

The model loader first tries TensorFlow's normal SavedModel object loader. If an
older checkpoint cannot be revived as an object, the service also tries the
SavedModel `serving_default` graph/session path for inference compatibility.

## Crop health and historical science note

The current imagery endpoint supplies RGB pixels. The website therefore labels
NDVI/NDWI crop-health values as unavailable instead of inventing them.
Scientifically meaningful NDVI/NDWI requires suitable multispectral bands such
as those available through Sentinel-2 products.

The basic history comparison compares saved analysis outputs. An analysis time
is not automatically the satellite capture date, so scientific time-series
change detection should use dated imagery products and their metadata.

## Accuracy statement

This is real semantic segmentation, but no pretrained global model can guarantee
correct parcel boundaries, pond outlines, and individual houses everywhere in
Bangladesh. Neighbouring crop plots can merge, touching roofs can merge, and
false water/building predictions can still occur. Measure final Bangladesh
accuracy with locally labelled validation images before high-stakes use.

See `ML-MODEL-NOTES.md` for model and benchmark details.

## Developer checks

```powershell
npm run lint
npm run build
python -m py_compile ml-service\main.py ml-service\download_model.py
```

Never commit `.env.local`, `node_modules`, `dist`, Python virtual environments,
or downloaded model files.
