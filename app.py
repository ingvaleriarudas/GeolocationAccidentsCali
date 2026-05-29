"""
Moto Cali — Análisis de Accidentes de Motos en Cali, Colombia.
Geocodificación: Nominatim (geopy) con caché persistente.
Trazabilidad vial: Overpass API (OpenStreetMap).
"""

import os
import json, json, time, hashlib, threading
import pandas as pd
from flask import Flask, render_template, request, jsonify
from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut, GeocoderServiceError
import requests as http_req

app = Flask(__name__)
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/moto_cali")
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

CACHE_FILE  = os.path.join(UPLOAD_FOLDER, "geocode_cache.json")
RESULT_FILE = os.path.join(UPLOAD_FOLDER, "result.json")
STATUS_FILE = os.path.join(UPLOAD_FOLDER, "status.json")

geocoder = Nominatim(user_agent="MotoCalyAnalyzer_v4", timeout=10)

MOTO_KW = ["MOTO", "MOTOCICLETA", "MOTOCARRO"]

# GeoJSON local de comunas (convertido desde ESRI MAGNA-SIRGAS wkid 6249)
COMUNAS_GEOJSON = os.path.join(os.path.dirname(__file__), "static", "comunas_cali.geojson")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

_lock_cache  = threading.Lock()
_lock_status = threading.Lock()
_lock_result = threading.Lock()

# ── On startup: reset any stale "geocoding" state ─────────────
# Threads don't survive a Flask restart, so reset to idle.
def _reset_stale_status():
    if os.path.exists(STATUS_FILE):
        try:
            with open(STATUS_FILE) as f:
                s = json.load(f)
            if s.get("state") == "geocoding":
                # Keep progress info but mark as interrupted
                s["state"] = "interrupted"
                with open(STATUS_FILE, "w") as f:
                    json.dump(s, f)
        except Exception:
            pass

_reset_stale_status()

# ── Cache ──────────────────────────────────────────────────────

def load_cache() -> dict:
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_cache(cache: dict):
    with _lock_cache:
        try:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False)
        except Exception:
            pass


# ── Status (progress only, no records list) ────────────────────

def write_status(s: dict):
    # Never embed the full records list in status — use result.json for that
    s.pop("records", None)
    with _lock_status:
        try:
            with open(STATUS_FILE, "w", encoding="utf-8") as f:
                json.dump(s, f)
        except Exception:
            pass


def read_status() -> dict:
    if os.path.exists(STATUS_FILE):
        try:
            with open(STATUS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"state": "idle"}


# ── Result file (written progressively) ───────────────────────

def save_result(records: list, summary: dict):
    with _lock_result:
        try:
            with open(RESULT_FILE, "w", encoding="utf-8") as f:
                json.dump({"records": records, "summary": summary}, f,
                          ensure_ascii=False)
        except Exception:
            pass


# ── CSV reader ─────────────────────────────────────────────────

def read_csv_smart(path: str) -> pd.DataFrame:
    for enc in ["latin-1", "cp1252", "utf-8", "utf-8-sig"]:
        for sep in [";", ",", "\t"]:
            try:
                df = pd.read_csv(path, encoding=enc, sep=sep,
                                 low_memory=False, dtype=str,
                                 on_bad_lines="skip")
                if len(df.columns) >= 5:
                    return df
            except Exception:
                continue
    raise ValueError("No se pudo leer el CSV.")


# ── Column finders ─────────────────────────────────────────────

def find_col(df, candidates, partial=None):
    cl = {c.lower().strip(): c for c in df.columns}
    for c in candidates:
        if c in df.columns:      return c
        if c.lower() in cl:      return cl[c.lower()]
    if partial:
        for c in df.columns:
            if all(p in c.lower() for p in partial):
                return c
    return None


get_addr_col    = lambda df: find_col(df,
    ["Dirección reporte", "Direccion reporte", "DIRECCIÓN REPORTE"],
    partial=["reporte"])
get_date_col    = lambda df: find_col(df, ["Fecha", "fecha", "FECHA"])
get_type_col    = lambda df: find_col(df,
    ["Tipo clase de accidente", "TIPO CLASE DE ACCIDENTE"],
    partial=["clase", "accidente"])
get_sev_col     = lambda df: find_col(df,
    ["Tipo confirmado", "TIPO CONFIRMADO"],
    partial=["confirmado"])
get_vehicle_col = lambda df: find_col(df,
    ["Tipo de vehículos implicados", "Tipo de vehiculos implicados"],
    partial=["veh"])


def has_coords(df: pd.DataFrame) -> bool:
    """Devuelve True si el CSV ya trae columnas lat y lon con datos válidos."""
    lat_col = find_col(df, ["lat", "LAT", "Lat", "latitude", "LATITUDE"])
    lon_col = find_col(df, ["lon", "LON", "Lon", "lng", "LNG", "longitude", "LONGITUDE"])
    if not lat_col or not lon_col:
        return False
    sample = df[[lat_col, lon_col]].dropna().head(10)
    if sample.empty:
        return False
    try:
        lats = pd.to_numeric(sample[lat_col], errors="coerce").dropna()
        lons = pd.to_numeric(sample[lon_col], errors="coerce").dropna()
        return len(lats) >= 3 and len(lons) >= 3
    except Exception:
        return False


def filter_motos(df: pd.DataFrame) -> pd.DataFrame:
    col = get_vehicle_col(df)
    if not col:
        return df
    mask = df[col].fillna("").str.upper().apply(
        lambda x: any(kw in x for kw in MOTO_KW))
    return df[mask].copy()


# ── Nominatim geocoder (1 req/sec) ─────────────────────────────

CALI_BOUNDS = dict(lon_min=-76.75, lon_max=-76.27, lat_min=3.27, lat_max=3.65)


def _in_cali(lat, lon) -> bool:
    return (CALI_BOUNDS["lat_min"] < lat < CALI_BOUNDS["lat_max"] and
            CALI_BOUNDS["lon_min"] < lon < CALI_BOUNDS["lon_max"])


def geocode_nominatim(address: str, cache: dict) -> dict | None:
    key = hashlib.md5(address.encode("utf-8", errors="replace")).hexdigest()
    if key in cache:
        return cache[key]      # None means "tried and failed"

    full   = f"{address}, Cali, Valle del Cauca, Colombia"
    result = None

    for attempt in range(3):
        try:
            time.sleep(1.05)   # Nominatim policy: max 1 req/sec
            loc = geocoder.geocode(full, exactly_one=True)
            if loc and _in_cali(loc.latitude, loc.longitude):
                result = {"lat": loc.latitude, "lon": loc.longitude}
            break
        except (GeocoderTimedOut, GeocoderServiceError):
            if attempt < 2:
                time.sleep(5)
        except Exception:
            break

    cache[key] = result
    return result


# ── Normalization ──────────────────────────────────────────────

_SEV_MAP = {
    "con fallecido": "Fallecido",
    "con fallecido (foraneo)": "Fallecido",
    "con lesionado": "Lesionado",
    "solo daños": "Solo daños",
    "solo daæos": "Solo daños",
    "negativo": "Negativo",
}

_TYPE_MAP = {
    "choque": "Choque",
    "atropello": "Atropello",
    "volcamiento": "Volcamiento",
    "caida de ocupante": "Caída de ocupante",
    "otro": "Otro",
    "no aplica": "No aplica",
}


def _normalize_severity(s: str) -> str:
    return _SEV_MAP.get(s.strip().lower(), s.strip() or "No registrado")


def _normalize_type(s: str) -> str:
    k = s.strip().lower()
    if k in (".", "", "nan", "none"):
        return "No registrado"
    return _TYPE_MAP.get(k, s.strip())


# ── Background geocoding worker ────────────────────────────────

def geocode_worker(df, addr_col, date_col, type_col, sev_col, vehicle_col):
    cache = load_cache()

    addr_map: dict[str, list] = {}
    for _, row in df.iterrows():
        addr = str(row.get(addr_col, "") or "").strip()
        if not addr or addr.lower() in ("nan", "none", ".", ""):
            continue
        addr_map.setdefault(addr, []).append(row)

    unique       = list(addr_map.keys())
    total_unique = len(unique)
    total_rows   = len(df)

    # Count already-cached (non-null) hits
    pre_cached = sum(
        1 for a in unique
        if cache.get(hashlib.md5(a.encode("utf-8", errors="replace")).hexdigest()) is not None
    )

    write_status({
        "state": "geocoding",
        "total_unique": total_unique,
        "total_rows": total_rows,
        "geocoded_unique": pre_cached,
        "geocoded_records": 0,
    })

    done    = 0
    records = []

    for addr in unique:
        coords = geocode_nominatim(addr, cache)
        if coords:
            for row in addr_map[addr]:
                fecha = str(row.get(date_col,    "") or "") if date_col    else ""
                tipo  = str(row.get(type_col,    "") or "") if type_col    else ""
                sev   = str(row.get(sev_col,     "") or "") if sev_col     else ""
                veh   = str(row.get(vehicle_col, "") or "") if vehicle_col else ""
                records.append({
                    "lat":       coords["lat"],
                    "lon":       coords["lon"],
                    "fecha":     fecha,
                    "direccion": addr,
                    "tipo":      _normalize_type(tipo),
                    "severidad": _normalize_severity(sev),
                    "vehiculos": veh,
                })
        done += 1

        # Every 50 unique addresses: flush cache + save result.json + update status
        if done % 50 == 0 or done == total_unique:
            save_cache(cache)
            summary = {
                "total_filtered": total_rows,
                "total_unique_addresses": total_unique,
                "geocoded": len(records),
            }
            save_result(records, summary)
            write_status({
                "state": "geocoding",
                "total_unique": total_unique,
                "total_rows": total_rows,
                "geocoded_unique": done,
                "geocoded_records": len(records),
            })

    # Final save
    save_cache(cache)
    summary = {
        "total_filtered": total_rows,
        "total_unique_addresses": total_unique,
        "geocoded": len(records),
    }
    save_result(records, summary)
    write_status({
        "state": "done",
        "total_unique": total_unique,
        "total_rows": total_rows,
        "geocoded_unique": done,
        "geocoded_records": len(records),
        "summary": summary,
    })


# ── Direct loader for pre-geocoded CSVs ───────────────────────

def direct_load_worker(df, addr_col, date_col, type_col, sev_col, vehicle_col,
                       lat_col, lon_col):
    """Construye result.json directamente desde columnas lat/lon ya presentes."""
    total_rows = len(df)
    write_status({"state": "geocoding", "total_unique": total_rows,
                  "total_rows": total_rows, "geocoded_unique": 0,
                  "geocoded_records": 0})
    records = []
    for _, row in df.iterrows():
        try:
            lat = float(str(row.get(lat_col, "") or "").strip())
            lon = float(str(row.get(lon_col, "") or "").strip())
        except (ValueError, TypeError):
            continue
        if not _in_cali(lat, lon):
            continue
        addr  = str(row.get(addr_col,    "") or "").strip() if addr_col  else ""
        fecha = str(row.get(date_col,    "") or "")         if date_col  else ""
        tipo  = str(row.get(type_col,    "") or "")         if type_col  else ""
        sev   = str(row.get(sev_col,     "") or "")         if sev_col   else ""
        veh   = str(row.get(vehicle_col, "") or "")         if vehicle_col else ""
        records.append({
            "lat":       lat,
            "lon":       lon,
            "fecha":     fecha,
            "direccion": addr,
            "tipo":      _normalize_type(tipo),
            "severidad": _normalize_severity(sev),
            "vehiculos": veh,
        })

    summary = {
        "total_filtered": total_rows,
        "total_unique_addresses": total_rows,
        "geocoded": len(records),
        "mode": "pre-geocoded",
    }
    save_result(records, summary)
    write_status({
        "state": "done",
        "total_unique": total_rows,
        "total_rows": total_rows,
        "geocoded_unique": total_rows,
        "geocoded_records": len(records),
        "summary": summary,
    })


# ── Road quality via Overpass API ──────────────────────────────

SURFACE_ES = {
    "asphalt": "Asfalto", "concrete": "Concreto", "paved": "Pavimentada",
    "unpaved": "Sin pavimento", "gravel": "Gravilla", "dirt": "Tierra",
    "cobblestone": "Adoquín", "grass": "Césped", "sand": "Arena",
    "compacted": "Compactada", "fine_gravel": "Gravilla fina",
    "paving_stones": "Adoquín", "metal": "Metal", "wood": "Madera",
}

SMOOTHNESS_ES = {
    "excellent": "Excelente", "good": "Buena", "intermediate": "Intermedia",
    "bad": "Mala", "very_bad": "Muy mala", "horrible": "Horrible",
    "very_horrible": "Pésima", "impassable": "Impasable",
}

HIGHWAY_ES = {
    "motorway": "Autopista", "trunk": "Vía principal", "primary": "Vía primaria",
    "secondary": "Vía secundaria", "tertiary": "Vía terciaria",
    "residential": "Vía residencial", "service": "Vía de servicio",
    "living_street": "Calle compartida", "pedestrian": "Peatonal",
    "unclassified": "Sin clasificar", "road": "Vía",
}


def fetch_road_quality(lat: float, lon: float, radius: int = 40) -> list:
    query = f"""
[out:json][timeout:15];
way(around:{radius},{lat},{lon})["highway"];
out tags;
"""
    try:
        resp = http_req.post(OVERPASS_URL, data={"data": query}, timeout=20)
        resp.raise_for_status()
        elements = resp.json().get("elements", [])
        roads, seen = [], set()
        for el in elements:
            tags = el.get("tags", {})
            hw   = tags.get("highway", "")
            name = tags.get("name", tags.get("ref", ""))
            if not hw or name in seen:
                continue
            seen.add(name)
            roads.append({
                "name":       name or "Sin nombre",
                "highway":    HIGHWAY_ES.get(hw, hw),
                "surface":    SURFACE_ES.get(tags.get("surface", ""), tags.get("surface", "No registrada")),
                "smoothness": SMOOTHNESS_ES.get(tags.get("smoothness", ""), tags.get("smoothness", "No registrada")),
                "maxspeed":   tags.get("maxspeed", "No registrada"),
                "lanes":      tags.get("lanes", "No registrada"),
                "lit":        "Sí" if tags.get("lit") == "yes" else ("No" if tags.get("lit") == "no" else "No registrada"),
                "oneway":     "Sí" if tags.get("oneway") == "yes" else "No",
            })
        return roads[:4]
    except Exception:
        return []


# ── Routes ─────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload_file():
    if "file" not in request.files:
        return jsonify({"error": "No se encontró archivo"}), 400
    file = request.files["file"]
    if not file.filename or not file.filename.lower().endswith(".csv"):
        return jsonify({"error": "Solo se aceptan archivos CSV"}), 400

    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], "accidents.csv")
    try:
        file.save(filepath)
    except Exception as e:
        return jsonify({"error": f"No se pudo guardar el archivo: {e}"}), 400

    try:
        df = read_csv_smart(filepath)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    df = filter_motos(df)
    if df.empty:
        return jsonify({"error": "No se encontraron registros de motos"}), 400

    addr_col    = get_addr_col(df)
    date_col    = get_date_col(df)
    type_col    = get_type_col(df)
    sev_col     = get_sev_col(df)
    vehicle_col = get_vehicle_col(df)

    if not addr_col:
        return jsonify({"error": "No se encontró columna de dirección"}), 400

    # Clear any previous result so the UI knows it's a fresh run
    if os.path.exists(RESULT_FILE):
        os.remove(RESULT_FILE)

    # ── Detectar si el CSV ya viene pre-geocodificado ──────────
    pre_geocoded = has_coords(df)
    lat_col = find_col(df, ["lat", "LAT", "Lat", "latitude", "LATITUDE"])
    lon_col = find_col(df, ["lon", "LON", "Lon", "lng", "LNG", "longitude", "LONGITUDE"])

    if pre_geocoded:
        write_status({"state": "starting", "total_rows": len(df),
                      "mode": "pre-geocoded"})
        threading.Thread(
            target=direct_load_worker,
            args=(df, addr_col, date_col, type_col, sev_col, vehicle_col,
                  lat_col, lon_col),
            daemon=True,
        ).start()
        return jsonify({
            "success": True,
            "total_filtered": len(df),
            "mode": "pre-geocoded",
            "message": "CSV pre-geocodificado detectado — cargando coordenadas directamente",
        })

    # ── CSV sin coordenadas: geocodificar con Nominatim ────────
    write_status({"state": "starting", "total_rows": len(df)})
    threading.Thread(
        target=geocode_worker,
        args=(df, addr_col, date_col, type_col, sev_col, vehicle_col),
        daemon=True,
    ).start()

    return jsonify({
        "success": True,
        "total_filtered": len(df),
        "mode": "nominatim",
        "message": "Geocodificación Nominatim iniciada (1 req/seg)",
    })


@app.route("/status")
def get_status():
    return jsonify(read_status())


@app.route("/data")
def get_data():
    """Return the current result.json (may grow as geocoding progresses)."""
    if not os.path.exists(RESULT_FILE):
        return jsonify({"records": [], "summary": {}})
    try:
        with _lock_result:
            with open(RESULT_FILE, "r", encoding="utf-8") as f:
                return jsonify(json.load(f))
    except Exception:
        return jsonify({"records": [], "summary": {}})


@app.route("/comunas")
def get_comunas():
    try:
        with open(COMUNAS_GEOJSON, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))
    except Exception as e:
        return jsonify({"error": str(e), "type": "FeatureCollection", "features": []}), 200


@app.route("/road_quality")
def road_quality():
    try:
        lat = float(request.args.get("lat", 0))
        lon = float(request.args.get("lon", 0))
        if not _in_cali(lat, lon):
            return jsonify({"error": "Coordenadas fuera de Cali"}), 400
        roads = fetch_road_quality(lat, lon)
        return jsonify({"roads": roads, "lat": lat, "lon": lon})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/hotspots")
def hotspots():
    """Top accident streets with stats. Road quality fetched client-side."""
    if not os.path.exists(RESULT_FILE):
        return jsonify({"hotspots": [], "total_records": 0})
    try:
        with _lock_result:
            with open(RESULT_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
    except Exception:
        return jsonify({"hotspots": [], "total_records": 0})

    records = data.get("records", [])
    if not records:
        return jsonify({"hotspots": [], "total_records": 0})

    addr_data: dict[str, dict] = {}
    for r in records:
        addr = r.get("direccion", "").strip()
        if not addr:
            continue
        if addr not in addr_data:
            addr_data[addr] = {
                "count": 0, "lat": r["lat"], "lon": r["lon"],
                "sevs": {"Fallecido": 0, "Lesionado": 0, "Solo daños": 0, "Negativo": 0},
                "tipos": {},
            }
        d = addr_data[addr]
        d["count"] += 1
        sev = r.get("severidad", "")
        if sev in d["sevs"]:
            d["sevs"][sev] += 1
        tipo = r.get("tipo", "No registrado")
        d["tipos"][tipo] = d["tipos"].get(tipo, 0) + 1

    sorted_spots = sorted(addr_data.items(), key=lambda x: x[1]["count"], reverse=True)
    top = []
    for addr, d in sorted_spots[:15]:
        top_tipo = max(d["tipos"], key=d["tipos"].get) if d["tipos"] else "N/D"
        top.append({
            "direccion": addr,
            "count":     d["count"],
            "lat":       d["lat"],
            "lon":       d["lon"],
            "fallecidos": d["sevs"]["Fallecido"],
            "lesionados": d["sevs"]["Lesionado"],
            "solo_danos": d["sevs"]["Solo daños"],
            "top_tipo":  top_tipo,
        })

    return jsonify({"hotspots": top, "total_records": len(records)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
