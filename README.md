# Sedmá rota — žebříček (PWA)

Mobilní (a desktop) web-appka pro žebříček hráčů šipkového klubu **Sedmá rota
Praha** a interaktivní návrh rozřazení do týmů **A/B**.

🔗 **Živá appka:** https://petr-trader.github.io/7rota-app/
📱 Na mobilu (Android): otevři odkaz → menu prohlížeče → **Přidat na plochu** →
appka má ikonu a běží na celou obrazovku (funguje i offline).

## Co umí (fáze 1+2)

- **Evidence + statistiky** všech hráčů: LKH, turnajové body, Bradley-Terry síla.
- **Interaktivní A/B tabulka** (= Master.xlsx): živě přepočítává pořadí a návrh
  týmu při změně:
  - **vah** (LKH / Vzájemná síla / Turnaje) — normalizují se, nemusí dát 1,
  - **velikosti A-týmu**,
  - **ručního zámku** hráče do A/B,
  - **vyřazení** hráče (✕).
- Tvoje úpravy (zámky, vyřazení, váhy) se pamatují v prohlížeči (localStorage).

### Pevná vs. editovatelná data

- 🔵 **Pevné** (jen čtení): LKH a turnajové body (data z UŠO) + Bradley-Terry
  síla (náš výpočet). Měníš je v pipeline, ne v appce.
- 🟡 **Editovatelné** v appce: váhy, velikost A-týmu, zámky, vyřazení.

## Výpočet (1:1 s Excelem)

- z-skóre metriky = `(hodnota − průměr) / směrodatná odchylka` (výběrová).
- vážené skóre = `Σ(váha·z přítomných metrik) / Σ(vah přítomných metrik)`
  (chybějící metrika vypadne, váhy se přepočítají).
- pořadí = sestupně dle skóre mezi hráči „v hře" (skóre ≠ prázdné a nevyřazen).
- návrh týmu = pořadí ≤ velikost A-týmu → **A**, jinak **B**; ruční zámek přebíjí.

## Data

`players.json` se generuje z pipeline v privátním repu **7-rota**
(`src/build_app_data.py`): Bradley-Terry z `bt.csv`, LKH/turnaje z Master.xlsx.

## Roadmap

- [x] Fáze 1 — evidence + statistiky hráčů
- [x] Fáze 2 — interaktivní A/B tabulka
- [ ] Fáze 3 — předzápasový lineup vs. soupeř (stáhnout sestavu soupeře, doporučit
      naše pořadí na soupisku tak, aby naši 2 top šli proti jejich nejlepším)

---

*Generováno z 7rota pipeline.*
