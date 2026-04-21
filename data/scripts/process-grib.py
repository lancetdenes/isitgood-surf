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


def _derive_scale(arr):
    """Pick an int16 scale that preserves the array's range with headroom.

    Returns (scale, offset) such that int16 = round((value - offset) / scale),
    value = int16 * scale + offset. offset is always 0 here — centering on
    zero keeps the decode symmetric and matches how the client parses.
    """
    max_abs = float(np.max(np.abs(arr))) if arr.size else 0.0
    if max_abs == 0:
        return (1.0, 0.0)
    # 32000 leaves 2% headroom under int16's 32767 ceiling so downstream
    # numerical drift (e.g. bilinear interpolation) can't clip.
    return (max_abs / 32000.0, 0.0)


def write_binary(filepath, nx, ny, lo1, la1, dx, dy, *arrays):
    """Write arrays in SRF2 int16-quantized format.

    Layout:
      Header (32 bytes): magic "SRF2", nx, ny, lo1, la1, dx, dy, nParams
      Scale table (nParams × 8 bytes): scale (f32), offset (f32)
      Data: nParams arrays of int16 (nx*ny each)

    Decoder: value = int16 * scale + offset.
    """
    n_params = len(arrays)
    grid_size = nx * ny

    # Derive per-param scales from observed ranges, then quantize.
    scales = []
    packed_arrays = []
    for arr in arrays:
        flat = np.asarray(arr).flatten().astype(np.float32)
        assert len(flat) == grid_size, f"Array size {len(flat)} != grid size {grid_size}"
        scale, offset = _derive_scale(flat)
        # round() → nearest, clip to int16 range as a safety net.
        quantized = np.clip(np.round((flat - offset) / scale), -32768, 32767).astype(np.int16)
        scales.append((scale, offset))
        packed_arrays.append(quantized)

    with open(filepath, 'wb') as f:
        # Header: 32 bytes
        f.write(b'SRF2')
        f.write(struct.pack('<I', nx))
        f.write(struct.pack('<I', ny))
        f.write(struct.pack('<f', lo1))
        f.write(struct.pack('<f', la1))
        f.write(struct.pack('<f', dx))
        f.write(struct.pack('<f', dy))
        f.write(struct.pack('<I', n_params))

        # Scale table
        for scale, offset in scales:
            f.write(struct.pack('<ff', scale, offset))

        # Data arrays (int16)
        for q in packed_arrays:
            f.write(q.tobytes())

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


def _read_srf2(path):
    """Read an SRF2 .bin file and return a dict with decoded float32 arrays.

    Used by build_cube to re-read the per-hour grids it just wrote. Keeps
    the cube builder decoupled from in-memory state of the main pipeline.
    """
    with open(path, 'rb') as f:
        header = f.read(32)
        magic = header[0:4]
        if magic != b'SRF2':
            raise ValueError(f"{path}: not an SRF2 file (magic={magic!r})")
        nx = struct.unpack('<I', header[4:8])[0]
        ny = struct.unpack('<I', header[8:12])[0]
        lo1 = struct.unpack('<f', header[12:16])[0]
        la1 = struct.unpack('<f', header[16:20])[0]
        dx = struct.unpack('<f', header[20:24])[0]
        dy = struct.unpack('<f', header[24:28])[0]
        n_params = struct.unpack('<I', header[28:32])[0]

        scales = []
        for _ in range(n_params):
            scales.append(struct.unpack('<ff', f.read(8)))

        grid_size = nx * ny
        arrays = []
        for p in range(n_params):
            raw = np.frombuffer(f.read(grid_size * 2), dtype=np.int16)
            scale, offset = scales[p]
            arrays.append(raw.astype(np.float32) * scale + offset)

    return {
        'nx': nx, 'ny': ny, 'lo1': lo1, 'la1': la1, 'dx': dx, 'dy': dy,
        'arrays': arrays,
    }


def build_cube(run_dir, cube_path, hours):
    """Assemble a cell-major point-forecast cube from per-hour SRF2 grids.

    Layout (SCUB format):
      Fixed header (64 B): magic "SCUB", nx, ny, lo1, la1, dx, dy, nHours,
                           nParams=5, version=1, reserved
      Hour table     : nHours × uint32 LE (forecast hour)
      Scale table    : nParams × (scale float32, offset float32)
      Cell data      : for each cell (j*nx+i), nHours × nParams int16

    5 params in order: wind_u, wind_v, swell_height, swell_direction, swell_period.
    Scales are global across all hours so a single decode rule works per param.

    Skips hours missing either wind or swell. Writes nothing if fewer than
    half the requested hours are usable — a cube built on partial data
    produces misleading forecasts.
    """
    usable_hours = []
    wind_arrays_by_hour = []  # each: list[Float32Array] of length 2
    swell_arrays_by_hour = []  # each: list[Float32Array] of length 3
    header_info = None

    for h in hours:
        fhrp = f"{h:03d}"
        w_path = os.path.join(run_dir, f"wind_f{fhrp}.bin")
        s_path = os.path.join(run_dir, f"swell_f{fhrp}.bin")
        if not (os.path.exists(w_path) and os.path.exists(s_path)):
            continue
        try:
            w = _read_srf2(w_path)
            s = _read_srf2(s_path)
        except Exception as e:
            print(f"    Warning: cube build skipping f{fhrp}: {e}")
            continue

        if header_info is None:
            header_info = {k: w[k] for k in ('nx', 'ny', 'lo1', 'la1', 'dx', 'dy')}
        elif (w['nx'], w['ny']) != (header_info['nx'], header_info['ny']):
            print(f"    Warning: f{fhrp} grid dims mismatch; skipping")
            continue

        usable_hours.append(h)
        wind_arrays_by_hour.append(w['arrays'])
        swell_arrays_by_hour.append(s['arrays'])

    if header_info is None or len(usable_hours) < len(hours) / 2:
        print(f"    Cube: only {len(usable_hours)}/{len(hours)} hours usable; skipping cube.")
        return False

    nx = header_info['nx']
    ny = header_info['ny']
    grid_size = nx * ny
    n_hours = len(usable_hours)
    n_params = 5  # wind_u, wind_v, swell_h, swell_dir, swell_period

    # Per-param global scales: scan all hours to find the max magnitude.
    # Using global scales keeps the decode rule uniform and the header tiny.
    def max_abs(arrs):
        return max(float(np.max(np.abs(a))) if a.size else 0.0 for a in arrs)

    param_streams = [
        [w[0] for w in wind_arrays_by_hour],   # u10
        [w[1] for w in wind_arrays_by_hour],   # v10
        [s[0] for s in swell_arrays_by_hour],  # height
        [s[1] for s in swell_arrays_by_hour],  # direction
        [s[2] for s in swell_arrays_by_hour],  # period
    ]
    scales = []
    for stream in param_streams:
        m = max_abs(stream)
        scales.append((m / 32000.0 if m > 0 else 1.0, 0.0))

    # Assemble the cube. Shape (grid_size, n_hours, n_params) means bytes are
    # laid out cell-major — perfect for range-request reads on a single cell.
    # int16 dtype keeps memory at ~600 MB for a full GFS run.
    cube = np.empty((grid_size, n_hours, n_params), dtype=np.int16)
    for p_idx, stream in enumerate(param_streams):
        scale, offset = scales[p_idx]
        for h_idx, arr in enumerate(stream):
            flat = arr.flatten()
            q = np.clip(np.round((flat - offset) / scale), -32768, 32767).astype(np.int16)
            cube[:, h_idx, p_idx] = q

    # Write the file. Fixed 64-byte header so offsets don't drift if fields
    # are added later (use a reserved tail instead).
    with open(cube_path, 'wb') as f:
        f.write(b'SCUB')
        f.write(struct.pack('<I', nx))
        f.write(struct.pack('<I', ny))
        f.write(struct.pack('<f', header_info['lo1']))
        f.write(struct.pack('<f', header_info['la1']))
        f.write(struct.pack('<f', header_info['dx']))
        f.write(struct.pack('<f', header_info['dy']))
        f.write(struct.pack('<I', n_hours))
        f.write(struct.pack('<I', n_params))
        f.write(struct.pack('<I', 1))  # version
        f.write(b'\x00' * 24)  # reserved (pads to 64 B)

        # Hour table
        for h in usable_hours:
            f.write(struct.pack('<I', h))

        # Scale table
        for scale, offset in scales:
            f.write(struct.pack('<ff', scale, offset))

        # Cell data (cell-major, already in correct order)
        f.write(cube.tobytes())

    size_mb = os.path.getsize(cube_path) / (1024 * 1024)
    print(f"    Wrote {cube_path} ({size_mb:.1f} MB, {n_hours} hours × {n_params} params × {grid_size} cells)")
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

    # Process all forecast hours: 0-168 at 3-hourly, then 174-336 at 6-hourly
    # (6-hourly extended range covers days 7-14 for the "score next week" tab).
    hours = list(range(0, 169, 3)) + list(range(174, 337, 6))
    for fhr in hours:
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

    # Build point-forecast cube from the per-hour grids we just wrote.
    # Client panel clicks range-request this file instead of fetching all 57
    # grids — two ~1 KB reads vs. the old ~1 GB.
    print()
    print(f"━━━ Building point cube ━━━")
    cube_hours = list(range(0, 169, 3))  # 57 hours — matches panel's range
    build_cube(out_dir, os.path.join(out_dir, 'points.bin'), cube_hours)

    print()
    print(f"━━━ Done! Processed data in: {out_dir} ━━━")
    print(f"Start the app: npm start")


if __name__ == '__main__':
    main()
