#!/usr/bin/env python3
"""Denní auto-refresh dat appky (běží v GitHub Actions, ne na PC).

Self-contained (jen stdlib): stáhne čerstvá USO data (sipky.org) a přegeneruje:
  - liga_index.json  (STC/Praha ligy: jméno -> tým, liga, kat, LKH, legy)
  - players.json      LEHKÁ pole (lkh, legy, turnaje, tým, kat, docházka),
                      TĚŽKÁ pole (bt, h2h, reg) ZACHOVÁ z existujícího players.json
                      (počítají se z turnajových pavouků = pomalé, ne denně).
+ history.jsonl       append-only denní snímek klíčových metrik (úsporné).

Trading je netknutý — tohle běží v cloudu GitHubu.

Spuštění (CI):  python scripts/refresh.py
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
SEASON_SIPKY = "5987"          # liga 2025/2026
SEASON_TURN = "2026"
SIPKY_LIGY = {"A": "211208", "B": "217864"}   # 7 rota: 1. liga A, 3. liga N
RANK_POHAR = {"M": "64008", "Z": "63752"}
LKH_BODY = {"n95": 10, "n133": 20, "n170": 30, "z6": 40, "z5": 80, "z4": 120,
            "z3": 200, "legy_v": 50, "zapasy_v": 70}


def get(url: str) -> str:
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
    for enc in ("cp1250", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def cells_of(tr: str) -> list[str]:
    return [re.sub(r"<[^>]+>|&nbsp;", " ", c).strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]


def num(s: str) -> float:
    s = (s or "").replace("\xa0", "").replace(" ", "").replace(",", ".")
    return float(s) if re.fullmatch(r"-?\d+(\.\d+)?", s or "") else 0.0


# --- LKH + legy z ligových statistik (sipky.org) -----------------------------
def parse_league(html: str) -> dict[str, dict]:
    out = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        c = [x for x in cells_of(tr) if x]
        if len(c) < 18 or "user=" in tr and False:
            pass
        uid = re.search(r"user=(\d+)", tr)
        if not uid or len(c) < 18:
            continue
        # heuristika: jméno = první nečíselná buňka s písmenem
        jm = next((x for x in c if re.search(r"[A-Za-zÁ-Žá-ž]{3}", x) and "%" not in x), None)
        try:
            rec = {"legy_o": int(num(c[5])), "legy_v": int(num(c[6])),
                   "zapasy_v": int(num(c[4])), "n95": int(num(c[7])), "n133": int(num(c[8])),
                   "n170": int(num(c[9])), "z6": int(num(c[10])), "z5": int(num(c[11])),
                   "z4": int(num(c[12])), "z3": int(num(c[13]))}
        except (IndexError, ValueError):
            continue
        if not jm or not rec["legy_o"]:
            continue
        body = sum(rec[k] * LKH_BODY[k] for k in LKH_BODY)
        out[jm] = {"lkh": round(body / rec["legy_o"], 1), "legy": rec["legy_o"]}
    return out


def fetch_our_lkh() -> dict[str, dict]:
    res = {}
    for tym, lid in SIPKY_LIGY.items():
        url = (f"https://www.sipky.org/?region=stc&page=statistika-hracu"
               f"&season={SEASON_SIPKY}&league={lid}")
        for jm, rec in parse_league(get(url)).items():
            res[jm] = {**rec, "tym": tym}
    return res


# --- turnajové body (Středočeský pohár) --------------------------------------
def fetch_pohar() -> dict[str, int]:
    body = {}
    for rank in RANK_POHAR.values():
        url = (f"https://www.sipky.org/?region=stc&page=poradi-hracu-v-zebricku"
               f"&rank={rank}&players_limit=5000")
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", get(url), re.S):
            if "CZE" not in tr:
                continue
            c = [x for x in cells_of(tr) if x]
            reg = next((x for x in c if re.fullmatch(r"CZE\d{6}", x)), None)
            if not reg:
                continue
            b = 0
            for x in reversed(c):
                d = x.replace(" ", "")
                if d.isdigit():
                    b = int(d)
                    break
            body[reg] = b
    return body


# --- ligový index STC (všechny mužské ligy s pražským klubem) -----------------
def mens_leagues() -> list[tuple[str, str]]:
    html = get("https://www.sipky.org/?region=stc&page=statistika-hracu")
    m = re.search(r'<select[^>]*name=["\']?league["\']?[^>]*>(.*?)</select>', html, re.S | re.I)
    out = []
    for v, t in re.findall(r'<option[^>]*value=["\']?([^"\'>]*)["\']?[^>]*>(.*?)</option>',
                           m.group(1), re.S):
        nm = re.sub(r"<[^>]+>|&nbsp;", "", t).strip()
        if v and re.search(r"extraliga|^\d\.\s*liga", nm, re.I) and "ŽENY" not in nm.upper() \
                and "Letní" not in nm:
            out.append((v, nm))
    return out


def liga_to_kat(liga: str) -> str | None:
    s = (liga or "").lower()
    if "extraliga" in s:
        return "A"
    m = re.search(r"(\d)\.\s*liga", s)
    return {"1": "B", "2": "C", "3": "D"}.get(m.group(1)) if m else None


def build_liga_index() -> dict[str, dict]:
    idx = {}
    for lid, lname in mens_leagues():
        url = (f"https://www.sipky.org/?region=stc&page=statistika-hracu"
               f"&season={SEASON_SIPKY}&league={lid}")
        html = get(url)
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
            if "user=" not in tr:
                continue
            c = [x for x in cells_of(tr) if x]
            if len(c) < 18:
                continue
            jm = next((x for x in c if re.search(r"[A-Za-zÁ-Žá-ž]{3}", x) and "%" not in x), None)
            tym_m = re.findall(r"profil-druzstva[^>]*>([^<]+)</a>", tr)
            tym = tym_m[0].strip() if tym_m else None
            try:
                legy = int(num(c[5]))
            except (IndexError, ValueError):
                continue
            if not jm or not legy:
                continue
            body = (int(num(c[7])) * 10 + int(num(c[8])) * 20 + int(num(c[9])) * 30
                    + int(num(c[10])) * 40 + int(num(c[11])) * 80 + int(num(c[12])) * 120
                    + int(num(c[13])) * 200 + int(num(c[6])) * 50 + int(num(c[4])) * 70)
            idx[jm] = {"tym": tym, "liga": lname, "kat": liga_to_kat(lname),
                       "lkh": round(body / legy, 1), "legy": legy}
    # STC/Praha filtr: ligy obsahující pražský klub
    by_liga = defaultdict(list)
    for r in idx.values():
        by_liga[r["liga"]].append(r.get("tym") or "")
    stc = {lg for lg, tys in by_liga.items() if any("praha" in (t or "").lower() for t in tys)}
    return {jm: r for jm, r in idx.items() if r["liga"] in stc}


def main() -> None:
    print("Refresh: LKH…", flush=True)
    our = fetch_our_lkh()
    print(f"  {len(our)} našich hráčů z ligy")
    print("Refresh: pohár…", flush=True)
    pohar = fetch_pohar()
    print(f"  {len(pohar)} hráčů v poháru")
    print("Refresh: liga index (STC)…", flush=True)
    idx = build_liga_index()
    print(f"  {len(idx)} hráčů v STC indexu")

    # players.json: aktualizuj LEHKÁ pole, ZACHOVEJ těžká (bt, h2h, reg)
    pj_path = ROOT / "players.json"
    data = json.loads(pj_path.read_text(encoding="utf-8"))
    for p in data["players"]:
        jm, reg = p["jmeno"], p.get("reg")
        o = our.get(jm)
        if o:
            p["lkh"], p["legy"], p["tym"] = o["lkh"], o["legy"], o["tym"]
        if reg in pohar:
            p["turnaje"] = pohar[reg]
        li = idx.get(jm)
        if li and li.get("kat"):
            p["kat"] = li["kat"]
    pj_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    (ROOT / "liga_index.json").write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")

    # history.jsonl — append-only denní snímek klíčových metrik
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    snap = {"date": today,
            "players": {p["jmeno"]: {"lkh": p.get("lkh"), "turnaje": p.get("turnaje"),
                                     "tym": p.get("tym")} for p in data["players"]},
            "index_size": len(idx)}
    with open(ROOT / "history.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(snap, ensure_ascii=False) + "\n")
    print(f"Hotovo {today}: players.json + liga_index.json ({len(idx)}) + history append")


if __name__ == "__main__":
    sys.exit(main())
