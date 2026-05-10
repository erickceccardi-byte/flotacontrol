#!/usr/bin/env python3
"""
fix_paid_at_retroactivo.py

Repara las 23 carreras (sobre todo de abril 2026) cuyo campo `paid_at` quedó
sembrado con la fecha de la migración Firebase→PB (2-may-2026) en vez de la
fecha real del registro.

Para cada carrera afectada:
  1. Reescribe paid_at de cada payment como `date + 'T' + time + ':00-04:00'`
     (UTC-4 = horario Habana). Convierte a ISO Z (UTC) antes de guardar.
  2. Agrega `paid_on_date_local = date` en cada payment para que la PWA pueda
     mostrar la fecha de cobro local correcta sin depender de timezone.

Uso:
  Ejecutar en el VPS (45.77.65.79) o desde cualquier lugar con acceso a:
    https://ecocargo.app/api/...

Requiere las credenciales admin de PocketBase. Pasalas por variables de
entorno antes de ejecutar:

  export PB_ADMIN_EMAIL='tu-admin@email.com'
  export PB_ADMIN_PASS='la-contraseña-admin'
  python3 fix_paid_at_retroactivo.py

El script primero hace DRY-RUN (solo muestra qué tocaría). Para aplicar
cambios reales, agregar el flag `--apply` al final.
"""
import os
import sys
import json
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

PB_BASE = "https://ecocargo.app"
HABANA_TZ = timezone(timedelta(hours=-4))  # UTC-4 (Cuba sin DST en mayo 2026)

def pb_request(path, method="GET", body=None, token=None):
    url = PB_BASE + path
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw else None

def admin_login(email, password):
    res = pb_request(
        "/api/admins/auth-with-password",
        method="POST",
        body={"identity": email, "password": password},
    )
    return res["token"]

def list_trips_all(token):
    items = []
    page = 1
    while True:
        res = pb_request(
            f"/api/collections/trips/records?perPage=200&page={page}",
            token=token,
        )
        items.extend(res["items"])
        if page >= res["totalPages"]:
            break
        page += 1
    return items

def needs_fix(trip):
    """Devuelve True si paid_at del payment principal está desfasado >1 día respecto a date."""
    pays = trip.get("payments") or []
    if not pays:
        return False
    main = next((p for p in pays if not p.get("is_tip", False)), pays[0])
    pa = main.get("paid_at") or ""
    if not pa or not trip.get("date"):
        return False
    try:
        d_date = datetime.strptime(trip["date"], "%Y-%m-%d").date()
        d_pa = datetime.strptime(pa[:10], "%Y-%m-%d").date()
        return abs((d_pa - d_date).days) > 1
    except Exception:
        return False

def make_correct_paid_at(date_str, time_str):
    """Convierte 'YYYY-MM-DD' + 'HH:MM' (hora local Habana) a ISO Z (UTC)."""
    if not time_str:
        time_str = "12:00"
    if len(time_str) == 5:
        time_str = time_str + ":00"
    local_dt = datetime.fromisoformat(f"{date_str}T{time_str}").replace(
        tzinfo=HABANA_TZ
    )
    utc_dt = local_dt.astimezone(timezone.utc)
    return utc_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")

def fix_trip(trip):
    """Construye el patch para corregir un trip."""
    correct_iso = make_correct_paid_at(trip["date"], trip.get("time", "12:00"))
    new_payments = []
    for p in (trip.get("payments") or []):
        np = dict(p)
        np["paid_at"] = correct_iso
        np["paid_on_date_local"] = trip["date"]
        new_payments.append(np)
    return {"payments": new_payments}

def main():
    apply = "--apply" in sys.argv
    email = os.environ.get("PB_ADMIN_EMAIL")
    password = os.environ.get("PB_ADMIN_PASS")
    if not email or not password:
        print("ERROR: faltan PB_ADMIN_EMAIL y PB_ADMIN_PASS en environment.")
        print("Uso:")
        print("  export PB_ADMIN_EMAIL='tu-admin@email.com'")
        print("  export PB_ADMIN_PASS='la-contraseña'")
        print("  python3 fix_paid_at_retroactivo.py            # dry-run")
        print("  python3 fix_paid_at_retroactivo.py --apply    # aplica de verdad")
        sys.exit(1)

    print(f"Login admin {email}...")
    token = admin_login(email, password)
    print("OK token recibido.\n")

    print("Listando todas las trips...")
    trips = list_trips_all(token)
    print(f"  {len(trips)} carreras totales.\n")

    afectadas = [t for t in trips if needs_fix(t)]
    print(f"Carreras con paid_at desfasado: {len(afectadas)}\n")

    if not afectadas:
        print("Nada que reparar. Saliendo.")
        return

    print(f"{'#':<4}{'driver':<12}{'date':<12}{'time':<7}{'paid_at viejo':<28}{'→':<3}{'paid_at corregido'}")
    print("-" * 100)
    for i, t in enumerate(afectadas, 1):
        pays = t.get("payments") or []
        main = next((p for p in pays if not p.get("is_tip", False)), pays[0])
        old = (main.get("paid_at") or "")[:19]
        new = make_correct_paid_at(t["date"], t.get("time", "12:00"))[:19]
        print(f"{i:<4}{(t.get('driverName') or '?')[:11]:<12}{t['date']:<12}{(t.get('time') or '-'):<7}{old:<28}→  {new}")

    if not apply:
        print("\nDRY-RUN — no se aplicaron cambios.")
        print("Para aplicar de verdad: python3 fix_paid_at_retroactivo.py --apply")
        return

    print(f"\nAplicando PATCH a {len(afectadas)} carreras...")
    ok = 0
    err = 0
    for i, t in enumerate(afectadas, 1):
        patch = fix_trip(t)
        try:
            pb_request(
                f"/api/collections/trips/records/{t['id']}",
                method="PATCH",
                body=patch,
                token=token,
            )
            ok += 1
            print(f"  [{i}/{len(afectadas)}] ✓ {t['id']} ({t.get('driverName')} {t['date']})")
        except Exception as e:
            err += 1
            print(f"  [{i}/{len(afectadas)}] ✗ {t['id']}: {e}")

    print(f"\nDone. OK={ok}  ERR={err}")

if __name__ == "__main__":
    main()
