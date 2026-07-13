#!/usr/bin/env python3
"""Génère js/data-osm.js : catalogue d'itinéraires balisés réels (relations
OSM route=hiking) pour l'Italie du Nord, géométrie simplifiée à ~15 m."""

import json
import math
import subprocess
import time
import urllib.parse

OVERPASS = "https://overpass-api.de/api/interpreter"

# (nom de région, S, W, N, E) — arc alpin italien complet, de la Ligurie au Frioul
ZONES = [
    ("Alpes ligures", 44.00, 7.35, 44.35, 8.05),
    ("Alpes maritimes", 44.05, 7.00, 44.40, 7.45),
    ("Monviso", 44.55, 6.95, 44.78, 7.20),
    ("Val de Suse", 44.90, 6.65, 45.25, 7.30),
    ("Gran Paradiso", 45.40, 7.00, 45.65, 7.40),
    ("Mont Rose", 45.70, 7.60, 45.95, 7.95),
    ("Ossola — Val Grande", 45.90, 8.15, 46.35, 8.60),
    ("Grigne — Orobie", 45.85, 9.25, 46.10, 9.90),
    ("Bernina — Valteline", 46.15, 9.80, 46.50, 10.40),
    ("Ortles — Stelvio", 46.35, 10.40, 46.70, 10.95),
    ("Adamello — Brenta", 45.90, 10.40, 46.30, 11.00),
    ("Alpes de Venoste", 46.60, 10.55, 46.90, 11.30),
    ("Dolomites", 46.55, 11.95, 46.78, 12.45),
    ("Dolomites", 46.35, 11.55, 46.65, 12.00),
    ("Dolomites", 46.42, 12.00, 46.60, 12.35),
    ("Dolomites de Belluno", 46.10, 11.95, 46.40, 12.60),
    ("Alpes carniques et juliennes", 46.30, 12.60, 46.65, 13.80),
]

SAC_FR = {
    "hiking": "facile",
    "mountain_hiking": "modéré",
    "demanding_mountain_hiking": "difficile",
    "alpine_hiking": "difficile",
    "demanding_alpine_hiking": "difficile",
    "difficult_alpine_hiking": "difficile",
}


def haversine_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(h))


def rdp(points, eps):
    """Ramer-Douglas-Peucker sur des couples (lat, lon), eps en degrés."""
    if len(points) < 3:
        return points
    (x1, y1), (x2, y2) = points[0], points[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-12
    dmax, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        d = abs(dx * (y1 - py) - dy * (x1 - px)) / norm
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        left = rdp(points[: idx + 1], eps)
        right = rdp(points[idx:], eps)
        return left[:-1] + right
    return [points[0], points[-1]]


def fetch_zone(region, s, w, n, e):
    query = (
        f"[out:json][timeout:90];"
        f'relation["route"="hiking"]({s},{w},{n},{e});'
        f"out geom 60;"
    )
    # curl : le Python framework macOS n'a pas les certificats SSL installés
    res = subprocess.run(
        ["curl", "-sS", "--max-time", "120",
         "-A", "SanchoRossi/1.0 (outil personnel)",
         "--data", "data=" + urllib.parse.quote(query), OVERPASS],
        capture_output=True, text=True, check=True,
    )
    return json.loads(res.stdout).get("elements", [])


def build_trail(rel, region):
    tags = rel.get("tags", {})
    name = tags.get("name") or (tags.get("ref") and f"Sentier {tags['ref']}")
    if not name:
        return None

    segments = []
    for m in rel.get("members", []):
        if m.get("type") == "way" and m.get("geometry"):
            seg = [(g["lat"], g["lon"]) for g in m["geometry"]]
            if len(seg) >= 2:
                segments.append(rdp(seg, 0.00008))  # ~8 m : précision GPS de terrain
    if not segments:
        return None

    flat = [p for seg in segments for p in seg]
    dist = sum(
        haversine_km(seg[i - 1], seg[i])
        for seg in segments
        for i in range(1, len(seg))
    )
    if dist < 4 or dist > 140:
        return None

    loop = haversine_km(flat[0], flat[-1]) < 0.6
    hours = dist / 3.5
    duration = (f"{int(hours)} h {int(hours % 1 * 60):02d}" if hours < 9
                else f"{max(2, round(hours / 7))} j (est.)")
    center = flat[len(flat) // 2]
    parts = [p for p in (tags.get("from"), tags.get("to")) if p]
    location = " → ".join(parts) if len(parts) == 2 else (parts[0] if parts else region)
    desc_bits = []
    if tags.get("ref"):
        desc_bits.append(f"réf. {tags['ref']}")
    if tags.get("operator"):
        desc_bits.append(f"entretenu par {tags['operator']}")
    if tags.get("osmc:symbol"):
        desc_bits.append(f"balisage {tags['osmc:symbol'].split(':')[0]}")
    desc = (
        "Itinéraire balisé officiel issu d'OpenStreetMap"
        + (" (" + ", ".join(desc_bits) + ")" if desc_bits else "")
        + ". Géométrie réelle relevée sur le terrain par la communauté, précision ~15 m."
    )

    return {
        "id": f"osmc-{rel['id']}",
        "osm": True,
        "name": name,
        "location": location,
        "region": region,
        "difficulty": SAC_FR.get(tags.get("sac_scale"), "non renseignée"),
        "type": "boucle" if loop else "traversée",
        "days": None,
        "bivouac": False,
        "distance": round(dist, 1),
        "elevationGain": None,
        "altMax": None,
        "duration": duration,
        "center": [round(center[0], 5), round(center[1], 5)],
        "gradient": "linear-gradient(135deg, #4a5d8a, #8fa3cc)",
        "description": desc,
        "eau": "—",
        "bivouacSpot": "—",
        "periode": "—",
        "segments": [[[round(a, 5), round(b, 5)] for a, b in seg] for seg in segments],
    }


def score(t):
    ideal = math.log(18)
    return -abs(math.log(t["distance"]) - ideal)


def main():
    seen, catalog = set(), []
    for region, s, w, n, e in ZONES:
        elements = []
        for attempt in range(3):
            try:
                elements = fetch_zone(region, s, w, n, e)
                break
            except Exception as err:  # rate-limit Overpass : on patiente puis on réessaie
                print(f"!! zone {region} ({s},{w}) tentative {attempt + 1} : {err}")
                time.sleep(25)
        zone_trails = []
        for rel in elements:
            if rel["id"] in seen:
                continue
            t = build_trail(rel, region)
            if t:
                seen.add(rel["id"])
                zone_trails.append(t)
        zone_trails.sort(key=score, reverse=True)
        catalog.extend(zone_trails[:25])
        print(f"zone {region} ({s},{w}) : {len(zone_trails)} tracés, gardés {len(zone_trails[:25])}")
        time.sleep(12)

    catalog.sort(key=lambda t: (t["region"], -t["distance"]))
    body = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    out = (
        "// Généré par scripts/fetch_osm_trails.py — itinéraires balisés réels (OSM)\n"
        f"// {len(catalog)} itinéraires, géométrie simplifiée à ~15 m\n"
        f"const OSM_TRAILS = {body};\n"
    )
    with open("js/data-osm.js", "w", encoding="utf-8") as f:
        f.write(out)
    print(f"→ js/data-osm.js : {len(catalog)} itinéraires, {len(out) // 1024} Ko")


if __name__ == "__main__":
    main()
