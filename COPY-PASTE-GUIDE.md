# Beginner setup guide for VS Code

## Recommended: use the complete ZIP

1. Make a backup of your current project folder.
2. Extract the new ZIP into a new folder.
3. Copy your original `.env.local` into the new project folder. Do not post or
   share that file.
4. Open the new project folder in VS Code.
5. Confirm that Node.js LTS and Python 3.11 are installed.
6. Double-click `START-AGRITERRAIN.bat`.
7. Keep both terminal windows open.
8. Open the URL shown by Vite, sign in, and visit **Satellite Analysis**.
9. Select **Check service**, then **Prepare model**. The one-time model download
   is approximately 304 MB.

## Manual terminal method

Open the first VS Code terminal:

```powershell
npm install
npm run dev
```

Open a second VS Code terminal:

```powershell
cd ml-service
py -3.11 -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

If your frontend uses another AI URL, add this line to `.env.local`:

```env
VITE_ML_API_URL=http://127.0.0.1:8000
```

Restart `npm run dev` after changing `.env.local`.

## How to get better detections

1. Use the **Satellite** basemap.
2. Zoom to level 17–20.
3. Draw around a compact area; every side must be 420 m or less.
4. Aim for **1.0 m/pixel or better** in the selection card.
5. Start with a 55% threshold. Increase it if there are false detections;
   decrease it if real objects are missed.
6. Treat displayed counts as connected model regions, not verified house or
   cadastral parcel totals.

## Important troubleshooting

- **AI service offline:** run `ml-service\start-service.bat` and keep it open.
- **Python 3.11 not found:** install Python 3.11 from python.org and enable the
  Python Launcher during installation.
- **Model download fails:** check the internet connection and press **Prepare
  model** again. Partial downloads are not accepted as ready.
- **Selection rejected:** zoom in and draw a smaller polygon.
- **Supabase login fails:** confirm the original `.env.local` was copied and the
  Supabase redirect URLs include the local Vite address.

## Files changed for the satellite feature

- `src/pages/SatelliteAnalysis.jsx`
- `src/pages/SatelliteAnalysis.css`
- `src/services/satelliteAnalysis.js`
- complete `ml-service` folder
- `.env.example`, `.gitignore`, documentation, and Windows start scripts

The homepage, authentication pages, and dashboard source remain included.
