#!/usr/bin/env python3
"""
process-grib.py — Convert downloaded GRIB2 files to CrowdSurf binary format.

Reads wind (U/V 10m) and wave (height, direction, period) GRIB2 files,
and writes compact binary files for the web app.

Usage:
    python3 data/scripts/process-grib.py gfs 20260409_00z
    python3 data/scripts/process-grib.py ecmwf 20260409_00z
    python3 data/scripts/process-grib.py gfs              # processes latest run

Prerequisites:
    pip install xarray cfgrib eccodes
    (or: conda install -c conda-forge xarray cfgrib eccodes)
"""

import sys
import os
import struct
import glob
import numpy as np

try:
    import xarray as xr
except ImportError:
    print("Error: xarray is required. Install with: pip install xarray cfgrib eccodes")
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.dirname(SCRIPT_DIR)


def write_binary(filepath, nx, ny, lo1, la1, dx, dy, *arrays):
    """Write arrays in CrowdSurf binary format."""
    n_params = len(arrays)
    grid_size = nx * ny

    with open(filepath, 'wb') as f:
        # Header: 32 bytes
        f.write(b'SURF')                                # magic
        f.write(struct.pack('<I', nx))                   # nx
        f.write(struct.pack('<I', ny))                   # ny
        f.write(struct.pack('<f', lo1))                  # first lon
        f.write(struct.pack('<f', la1))                  # first lat
        f.write(struct.pack('<f', dx))                   # lon step
        f.write(struct.pack('<f', dy))                   # lat step
        f.write(struct.pack('<I', n_params))             # num params

        # Data arrays
        for arr in arrays:
            flat = arr.flatten().astype(np.float32)
            assert len(flat) == grid_size, f"Array size {len(flat)} != grid size {grid_size}"
            f.write(flat.tobytes())

    size_kb = os.path.getsize(filepath) / 1024
    print(f"    Wrote {filepath} ({size_kb:.0f} KB)")


def process_gfs_wind(grib_path, out_path):
    """Process GFS wind GRIB2 → binary (u10, v10)."""
    try:
        ds = xr.open_dataset(grib_path, engine='cfgrib',
                             backend_kwargs={'filter_by_keys': {'typeOfLevel': 'heightAboveGround', 'level': 10}})
    except Exception as e:
        print(f"    Warning: Could not read {grib_path}: {e}")
        return False

    # Get U and V components
    u_key = 'u10' if 'u10' in ds else 'u' if 'u' in ds else None
    v_key = 'v10' if 'v10' in ds else 'v' if 'v' in ds else None

    if not u_key or not v_key:
        # Try alternate variable names
        for key in ds.data_vars:
            if 'u' in key.lower() and 'grd' not in key.lower():
                u_key = key
            elif 'v' in key.lower() and 'grd' not in key.lower():
                v_key = key

    if not u_key or not v_key:
        print(f"    Warning: Could not find U/V wind variables in {grib_path}")
        print(f"    Available variables: {list(ds.data_vars)}")
        return False

    u = ds[u_key].values
    v = ds[v_key].values

    # Grid info
    lats = ds.latitude.values
    lons = ds.longitude.values
    ny, nx = u.shape
    la1 = float(lats[0])    # first lat (should be 90 for N→S)
    lo1 = float(lons[0])    # first lon
    dy = abs(float(lats[1] - lats[0]))
    dx = abs(float(lons[1] - lons[0]))

    # Replace NaN with 0
    u = np.nan_to_num(u, 0.0)
    v = np.nan_to_num(v, 0.0)

    write_binary(out_path, nx, ny, lo1, la1, dx, dy, u, v)
    ds.close()
    return True


def process_gfs_wave(grib_path, out_path):
    """Process GFS-Wave GRIB2 → binary (height, direction, period)."""
    # Wave GRIB files contain multiple messages (one per variable).
    # Use open_datasets (plural) to get separate datasets per message,
    # or filter by shortName to read each variable individually.
    height = direction = period = None
    lats = lons = None

    for short_name, target in [('swh', 'height'), ('dirpw', 'direction'), ('perpw', 'period')]:
        try:
            ds = xr.open_dataset(grib_path, engine='cfgrib',
                                 backend_kwargs={'filter_by_keys': {'shortName': short_name}})
            # Get the first (only) data variable
            var_name = list(ds.data_vars)[0]
            data = np.nan_to_num(ds[var_name].values, nan=0.0)

            # Ensure 2D
            if data.ndim > 2:
                data = data[0]

            if lats is None:
                lats = ds.latitude.values
                lons = ds.longitude.values

            if target == 'height':
                height = data
            elif target == 'direction':
                direction = data
            elif target == 'period':
                period = data

            ds.close()
        except Exception as e:
            print(f"    Warning: Could not read {short_name} from {grib_path}: {e}")

    if height is None:
        # Fallback: try reading without filter and pick by variable name
        try:
            datasets = xr.open_datasets(grib_path, engine='cfgrib')
            for ds in datasets:
                for key in ds.data_vars:
                    kl = key.lower()
                    data = np.nan_to_num(ds[key].values, nan=0.0)
                    if data.ndim > 2:
                        data = data[0]
                    if lats is None:
                        lats = ds.latitude.values
                        lons = ds.longitude.values
                    if ('swh' in kl or 'htsgw' in kl) and height is None:
                        height = data
                    elif ('dirpw' in kl or 'dir' in kl) and direction is None:
                        direction = data
                    elif ('perpw' in kl or 'per' in kl or 'mwp' in kl) and period is None:
                        period = data
                ds.close()
        except Exception as e:
            print(f"    Warning: Could not read {grib_path}: {e}")
            return False

    if height is None or lats is None:
        print(f"    Warning: No wave height found in {grib_path}")
        return False

    if direction is None:
        direction = np.zeros_like(height)
    if period is None:
        period = np.zeros_like(height)

    # Native 0.25° resolution. No downsampling: coastal accuracy beats file
    # size now that storage is on R2 (free egress) and the server isn't
    # memory-bound. Each swell file is ~12 MB, run total ~684 MB.

    ny, nx = height.shape
    la1 = float(lats[0])
    lo1 = float(lons[0])
    dy = abs(float(lats[1] - lats[0]))
    dx = abs(float(lons[1] - lons[0]))

    write_binary(out_path, nx, ny, lo1, la1, dx, dy, height, direction, period)
    return True


def process_ecmwf_wind(grib_path, out_path):
    """Process ECMWF GRIB2 → binary (u10, v10)."""
    try:
        ds = xr.open_dataset(grib_path, engine='cfgrib',
                             backend_kwargs={'filter_by_keys': {
                                 'shortName': ['10u', '10v'],
                             }})
    except Exception:
        # Fall back to reading without filter
        try:
            ds = xr.open_dataset(grib_path, engine='cfgrib',
                                 backend_kwargs={'filter_by_keys': {'typeOfLevel': 'heightAboveGround', 'level': 10}})
        except Exception as e:
            print(f"    Warning: Could not read {grib_path}: {e}")
            return False

    # Find U/V
    u_key = v_key = None
    for key in ds.data_vars:
        if '10u' in key or 'u10' in key:
            u_key = key
        elif '10v' in key or 'v10' in key:
            v_key = key

    if not u_key or not v_key:
        print(f"    Warning: Could not find U/V in {grib_path}: {list(ds.data_vars)}")
        return False

    u = np.nan_to_num(ds[u_key].values, 0.0)
    v = np.nan_to_num(ds[v_key].values, 0.0)

    lats = ds.latitude.values
    lons = ds.longitude.values
    ny, nx = u.shape

    write_binary(out_path, nx, ny, float(lons[0]), float(lats[0]),
                 abs(float(lons[1] - lons[0])), abs(float(lats[1] - lats[0])), u, v)
    ds.close()
    return True


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 process-grib.py <model> [run_id]")
        print("  model: gfs or ecmwf")
        print("  run_id: e.g. 20260409_00z (optional, defaults to latest)")
        sys.exit(1)

    model = sys.argv[1].lower()
    grib_base = os.path.join(DATA_DIR, 'grib', model)

    if len(sys.argv) >= 3:
        run_id = sys.argv[2]
    else:
        # Find latest run
        runs = sorted([d for d in os.listdir(grib_base) if os.path.isdir(os.path.join(grib_base, d))])
        if not runs:
            print(f"No GRIB data found in {grib_base}")
            sys.exit(1)
        run_id = runs[-1]

    grib_dir = os.path.join(grib_base, run_id)
    out_dir = os.path.join(DATA_DIR, model, run_id)
    os.makedirs(out_dir, exist_ok=True)

    print(f"━━━ Processing {model.upper()} run: {run_id} ━━━")
    print(f"  GRIB dir: {grib_dir}")
    print(f"  Output: {out_dir}")
    print()

    # Process all forecast hours
    for fhr in range(0, 169, 3):
        fhrp = f"{fhr:03d}"
        print(f"  f{fhrp}:")

        if model == 'gfs':
            wind_grib = os.path.join(grib_dir, f"gfs_wind_f{fhrp}.grib2")
            wave_grib = os.path.join(grib_dir, f"gfs_wave_f{fhrp}.grib2")

            if os.path.exists(wind_grib):
                process_gfs_wind(wind_grib, os.path.join(out_dir, f"wind_f{fhrp}.bin"))
            else:
                print(f"    Skipping wind (no GRIB file)")

            if os.path.exists(wave_grib):
                process_gfs_wave(wave_grib, os.path.join(out_dir, f"swell_f{fhrp}.bin"))
            else:
                print(f"    Skipping swell (no GRIB file)")

        elif model == 'ecmwf':
            atmo_grib = os.path.join(grib_dir, f"ecmwf_atmo_f{fhrp}.grib2")
            wave_grib = os.path.join(grib_dir, f"ecmwf_wave_f{fhrp}.grib2")

            if os.path.exists(atmo_grib):
                process_ecmwf_wind(atmo_grib, os.path.join(out_dir, f"wind_f{fhrp}.bin"))
            else:
                print(f"    Skipping wind (no GRIB file)")

            if os.path.exists(wave_grib):
                process_gfs_wave(wave_grib, os.path.join(out_dir, f"swell_f{fhrp}.bin"))
            else:
                print(f"    Skipping swell (no GRIB file)")

    print()
    print(f"━━━ Done! Processed data in: {out_dir} ━━━")
    print(f"Start the app: npm start")


if __name__ == '__main__':
    main()
