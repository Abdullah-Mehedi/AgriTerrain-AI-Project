"""Download and validate the OpenEarthMap checkpoint before starting the API."""

from main import ensure_model_files, get_model


if __name__ == "__main__":
    print("Preparing the OpenEarthMap model (about 304 MB)...")
    model_directory = ensure_model_files()
    print(f"Files downloaded to: {model_directory}")
    print("Loading the model once to validate it...")
    get_model()
    print("OpenEarthMap model is ready.")
