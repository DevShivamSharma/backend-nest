#!/usr/bin/env python3
"""
Builds test/fixtures/plan-texts/eval.json: floor-plan texts with the kind each one truly is,
to measure how well plan texts are read (rules alone, and rules plus the local model).

Two parts:
  - itpo:    texts from ITPO's own hall layouts and stall data, whose role ITPO's database
             records (gate labels, icon captions, legend rows, stall codes, stall areas). The
             export is read from a folder of plain-text dumps; no exhibitor names are kept.
  - general: hand-labelled texts in other venues' wording and other languages.

  python3 scripts/build-plan-text-eval.py <itpo-dump-folder>
"""
import json
import re
import sys
from pathlib import Path

dump = Path(sys.argv[1])
items = []


def add(text, kind, source):
    text = re.sub(r"\s+", " ", text).strip()
    if text:
        items.append({"text": text, "kind": kind, "source": source})


# --- ITPO: gate, exit, toilet and foyer labels --------------------------------------------
for line in (dump / "labels.txt").read_text().splitlines():
    add(line, "label", "itpo:exit_labels")

# --- ITPO: icon captions; the truth comes from the words (one row's icon file is wrong) ---
ICON_CAPTIONS = {
    "Toilet (Male)": "icon:toilet-male",
    "Toilet (Female)": "icon:toilet-female",
    "Stairs/Elevators": "icon:stairs",
    "Emergency Exit": "icon:emergency-exit",
    "Cargo Entry": "icon:cargo-truck",
    "Cargo/Service Entry": "icon:cargo-truck",
    "Drinking Water": "icon:drinking-water",
    "Circulation Area": "icon:circulation",
}
for line in (dump / "icons.tsv").read_text().splitlines():
    caption = line.split("\t")[0]
    kind = ICON_CAPTIONS.get(caption, "icon:entry")  # Entry, Entry/Exit, Entry from..., EXIT TO...
    add(caption, kind, "itpo:helper_text")

# --- ITPO: legend rows ----------------------------------------------------------------------
COLOUR_MEANING = {
    "#8a2be2": "area:fire_curtain",
    "red": "area:passage",
    "gray": "area:column",
    "blue": "area:utility",
    "yellow": "area:unavailable",
    "#2e8b57": "area:entry",
    "saddlebrown": "area:no_build",
}
CODE_ROWS = {"Emergency Exit": "icon:emergency-exit", "Toilet": "icon:toilet"}
for line in (dump / "legends.tsv").read_text().splitlines():
    label, colour, code = (line.split("\t") + ["", ""])[:3]
    if colour:
        add(label, COLOUR_MEANING[colour], "itpo:legends")
    else:
        # Rows explaining a code ("GF: Gate First Floor", "First digit indicates Hall no.").
        add(label, CODE_ROWS.get(label, "title"), "itpo:legends")
        if code:
            add(code, "title", "itpo:legend_codes")

# --- ITPO: stall codes (no exhibitor names; rooms and junk left out) -----------------------
ROOMS = {"Business Lounge", "Conference Room", "Media Lounge", "Protocol Lounge", "Pantry",
         "Digital Garden"}
SERIES = re.compile(r"^(Outlet|Vending|Nozzle|Cluster)-[\w]+$")
for line in sorted(set((dump / "stalls.txt").read_text().splitlines())):
    text = line.strip()
    if text in ROOMS:
        add(text, "label", "itpo:rooms")
        continue
    if SERIES.match(text):
        add(text, "stall_number", "itpo:stalls")
        continue
    if re.search(r"[a-z]{3,}|^[&`]|^\d{4,}$", text):  # words, junk, long numbers
        continue
    if not re.search(r"\d", text) and not re.fullmatch(r"[A-Za-z]{1,2}|[A-Z]( ?[&,] ?[A-Z])+", text):
        continue  # bare capitals such as company initials
    add(text, "stall_number", "itpo:stalls")

# --- ITPO: stall areas -------------------------------------------------------------------------
for line in (dump / "areas.txt").read_text().splitlines():
    add(line, "dimension", "itpo:areas")

# --- general: other venues, other drafting habits, other languages -------------------------
GENERAL = {
    "icon:toilet-male": ["Gents Toilet", "Male WC", "Toilet - Gents", "Men's Restroom", "पुरुष शौचालय",
                         "Toilet (Gents)", "WC (M)", "Male Washroom"],
    "icon:toilet-female": ["Ladies Toilet", "Female WC", "Toilet - Ladies", "Women's Restroom",
                           "महिला शौचालय", "Toilet (Ladies)", "WC (F)", "Female Washroom"],
    "icon:toilet": ["Toilets", "WC", "Washroom", "Restrooms", "Accessible Toilet", "Unisex Toilet",
                    "शौचालय", "Aseos", "Toilettes", "卫生间", "Disabled Toilet", "Toilet Block"],
    "icon:stairs": ["Staircase", "Stairs", "Escalator", "Escalators", "सीढ़ियाँ", "Escaleras",
                    "Fire Staircase", "Stair Core", "Treppe", "楼梯"],
    "icon:lift": ["Lift", "Lifts", "Elevator", "Goods Lift", "Service Lift", "Lift Lobby", "लिफ्ट",
                  "Ascensor", "Aufzug", "电梯", "Passenger Lift"],
    "icon:emergency-exit": ["Emergency Exit", "Fire Exit", "Fire Escape", "आपातकालीन निकास",
                            "Salida de emergencia", "Sortie de secours", "Notausgang", "安全出口",
                            "Emergency Exit Door", "EXIT (Emergency)"],
    "icon:entry": ["Entry", "Exit", "Entrance", "Main Entrance", "Entry/Exit", "प्रवेश", "निकास",
                   "Entrada", "Eingang", "Visitor Entry", "Exhibitor Entry", "Entry from Hall 4",
                   "Exit to Parking", "VIP Entry"],
    "icon:cargo-truck": ["Cargo Entry", "Loading Bay", "Loading Dock", "Service Entrance",
                         "Goods Entry", "Truck Entry", "Material Entry", "Service Gate (Cargo)"],
    "icon:drinking-water": ["Drinking Water", "Water Point", "Water Cooler", "पेयजल",
                            "Drinking Water Station", "RO Water"],
    "icon:circulation": ["Circulation Area", "Circulation"],
    "area:passage": ["Compulsory passage for entry/exit/services", "Gangway", "Aisle 3m wide",
                     "Gangway 4 M", "Main Aisle", "Fire Lane - keep clear", "Passage (3m clear)"],
    "area:fire_curtain": ["Fire curtain", "Smoke curtain above", "Fire curtains (No construction zone below)"],
    "area:no_build": ["No Construction Zone", "NC Zone", "No build zone", "Keep clear - no construction",
                      "निर्माण निषिद्ध क्षेत्र"],
    "area:column": ["Columns", "Pillars", "Structural Columns", "Column"],
    "area:utility": ["Electrical Panel", "Fire Hydrant", "Hose Reel", "Fire Extinguisher",
                     "Electrical Panels", "Hydrant Point", "DB Box", "Power Point"],
    "area:unavailable": ["Area not available for exhibitions", "Not available for exhibition",
                         "Reserved - not for exhibition"],
    "area:entry": ["Main entry/exit"],
    "label": ["Hall 5", "HALL 12A", "Foyer A", "Lobby", "First Aid Room", "Registration",
              "Organiser Office", "Organizer's Office", "Food Court", "Media Centre", "VIP Lounge",
              "Business Centre", "Cloak Room", "Information Desk", "Prayer Room", "Gate 3",
              "Gate No. 7", "Conference Hall 1", "Seminar Room B", "Help Desk", "Control Room",
              "Security Room", "Press Room", "हॉल 5", "Sala de conferencias", "Pre-function Area",
              "Atrium", "Concourse", "Exhibitor Lounge", "Storage Room", "Store"],
    "stall_number": ["A-12", "B12", "H5-101", "S-001", "12", "7", "AA-03", "K-11", "3B",
                     "P-04", "Stand 214", "Booth 12", "Kiosk-3", "D1-05"],
    "dimension": ["3m", "3.0 M", "4500", "6000 mm", "9 sqm", "9 m²", "12 x 6", "3x3",
                  "18.0", "25 SQM", "2.5 mtrs", "120 sq ft"],
    "title": ["GROUND FLOOR PLAN", "Hall 5 Layout - IITF 2026", "Scale 1:500", "NOT TO SCALE",
              "All dimensions in metres", "Drawing No. BM/H5/01", "Revision R2", "LEGEND",
              "Key Plan", "North", "Layout Plan - Stall Allocation"],
}
for kind, texts in GENERAL.items():
    for text in texts:
        add(text, kind, "general")

# --- holdout1: written before the first tuning. Its misses were then used to fix general flaws
# in the rules and prompt, so it is now a development set, kept to catch regressions.
HOLDOUT = {
    "icon:toilet-male": ["GENTS", "Mens Toilet Block", "Toilet for Men", "पुरुषों के लिए शौचालय",
                         "Caballeros"],
    "icon:toilet-female": ["LADIES", "Womens Toilet Block", "Toilet for Women", "Damas",
                           "महिलाओं के लिए शौचालय"],
    "icon:toilet": ["Public Toilets", "PWD Toilet", "Washrooms (Common)", "Sanitary Block"],
    "icon:stairs": ["Staircase No. 2", "STAIR-3", "Escalator to First Floor", "Steps"],
    "icon:lift": ["LIFT-1", "Lift No. 4", "Elevators (2 Nos.)", "Cargo Lift"],
    "icon:emergency-exit": ["EMERGENCY EXIT-2", "Fire Exit Door", "Emergency Evacuation Exit",
                            "Uscita di emergenza"],
    "icon:entry": ["Main Entry", "Exit Gate", "Visitors Entrance", "Way Out", "Entry Point",
                   "Ingresso"],
    "icon:cargo-truck": ["Service Entry", "Goods Entrance", "Loading/Unloading Bay", "Cargo Gate"],
    "icon:drinking-water": ["Water Dispenser", "Drinking Water Facility"],
    "area:passage": ["Clear passage 3m", "Gangways to be kept free", "Main Gangway"],
    "area:no_build": ["No-construction area", "No Construction"],
    "area:column": ["RCC Columns"],
    "area:utility": ["Electrical DB", "Fire Hose Cabinet", "Sprinkler Riser"],
    "label": ["Conference Room 2", "Organisers Office", "Medical Room", "Hall No. 3",
              "Foyer (East)", "Business Lounge 2", "Reception", "Cafeteria", "Admin Office",
              "Gate 10", "Prayer Hall"],
    "stall_number": ["C-22", "M5", "H3-17", "Stand B-14", "102 & 103"],
    "dimension": ["5.5m", "7500", "36 SQ.M", "6 x 3 m"],
    "title": ["FIRST FLOOR LAYOUT", "SCALE 1:200", "Drawing Title: Hall 3", "Rev. 04",
              "LEGENDS"],
}
for kind, texts in HOLDOUT.items():
    for text in texts:
        add(text, kind, "holdout1")

# --- holdout2: written after holdout1 was used. Its first scoring exposed a flaw in the answer
# format (a small model reciting the list of kinds), which was then fixed: now a development set.
HOLDOUT2 = {
    "icon:toilet-male": ["Toilets - Men", "MALE TOILETS", "Gents Washroom Block", "Urinals",
                         "Men's WC (Ground Floor)", "पुरुष प्रसाधन"],
    "icon:toilet-female": ["Toilets - Women", "FEMALE TOILETS", "Ladies Washroom Block",
                           "Women's WC (First Floor)", "महिला प्रसाधन"],
    "icon:toilet": ["Toilet Core", "Handicap Toilet", "Toilets (M/F)", "WASH ROOMS", "Restroom Area"],
    "icon:stairs": ["Fire Escape Staircase", "Stairwell", "Stair No.1", "Escalator Bank",
                    "STAIRCASE-A", "Ramp & Stairs"],
    "icon:lift": ["Lift Bank", "Elevator Lobby", "Freight Elevator", "LIFT B", "Service Elevator"],
    "icon:emergency-exit": ["Emergency Exit Only", "E. EXIT", "Fire Exit Route",
                            "Emergency Egress", "EMERGENCY EXIT (Push Bar)"],
    "icon:entry": ["Visitor Entry Gate", "Entrance (North)", "Exit Only", "Main Entry Point",
                   "Public Entrance", "Exhibitors Entrance"],
    "icon:cargo-truck": ["Cargo Entry Gate", "Loading Area", "Truck Bay", "Goods Receiving",
                         "Service Vehicle Entry"],
    "icon:drinking-water": ["Water Station", "Drinking Water Point", "Potable Water"],
    "area:passage": ["Gangway (min. 3m)", "Passage to be kept clear", "Cross Aisle",
                     "3m wide passage", "Fire Gangway"],
    "area:fire_curtain": ["Fire Curtain Line", "Smoke Curtain Zone"],
    "area:no_build": ["No Construction Area", "Do not build", "NC Area (Service Duct)"],
    "area:column": ["Column Grid", "Pillars (RCC)"],
    "area:utility": ["Electrical Panel Room", "Fire Hydrant Point", "Hose Reel Cabinet",
                     "MCB Panel", "Fire Extinguisher Point"],
    "area:unavailable": ["Area not for exhibition use"],
    "label": ["Hall 7A", "FOYER (West)", "Seminar Hall", "Banquet Hall", "Board Room",
              "Business Lounge", "Exhibitor Registration", "Media Room", "First Aid Post",
              "Security Office", "Ticket Counter", "Gate No. 4", "Organizer Room", "Food Plaza",
              "Kids Zone", "Smoking Room", "Help Desk 2", "Lost & Found", "Cloakroom",
              "Hall 2 (Ground Floor)"],
    "stall_number": ["C-07", "H1-23", "B12A", "E-114", "S3-05", "Stand C-9", "Booth A-17",
                     "T-12", "Kiosk 11"],
    "dimension": ["4.5m", "9.0 SQM", "3 x 3 m", "6000", "12.5 mtr"],
    "title": ["HALL 4 - STALL LAYOUT", "Second Floor Plan", "Scale 1:250", "Rev 03",
              "General Notes", "Not to Scale", "Legend:"],
    "none": ["Tata Motors", "Reliance Industries", "Sponsor", "Coca-Cola"],
}
for kind, texts in HOLDOUT2.items():
    for text in texts:
        add(text, kind, "holdout2")

# --- holdout3: written after holdout2 was used, before any scoring on it. Only ever measured;
# if a change is made to fix one of these, it stops measuring anything: write holdout4.
HOLDOUT3 = {
    "icon:toilet-male": ["Gents' Toilets", "TOILET-GENTS", "Male Restrooms", "Men WC Block"],
    "icon:toilet-female": ["Ladies' Toilets", "TOILET-LADIES", "Female Restrooms",
                           "Women WC Block"],
    "icon:toilet": ["Toilet Facility", "Common Toilets", "Accessible WC", "Baby Care & Toilet"],
    "icon:stairs": ["Staircase (Up)", "STAIR CASE", "Escalator Up/Down", "Fire Stairs"],
    "icon:lift": ["Lift Lobby (East)", "Elevator No. 3", "LIFTS", "Goods Elevator"],
    "icon:emergency-exit": ["Emergency Exit Gate", "FIRE EXIT DOOR", "Emergency Exit Route",
                            "Fire Escape Route"],
    "icon:entry": ["Entry Gate", "Exhibitor Entry Gate", "Main Exit", "Visitors Exit",
                   "Entrance Gate"],
    "icon:cargo-truck": ["Cargo Bay", "Goods Loading Bay", "Service Truck Entry", "Cargo Ramp"],
    "icon:drinking-water": ["Drinking Water Kiosk", "Water Point (RO)"],
    "area:passage": ["Gangway 5m", "Main Gangway (Keep Clear)", "Aisle (3 m)",
                     "Compulsory Passage"],
    "area:fire_curtain": ["Smoke Curtain", "Fire Curtain Above"],
    "area:no_build": ["NO CONSTRUCTION ZONE", "No-Build Area"],
    "area:column": ["Steel Columns", "Column"],
    "area:utility": ["Fire Hydrant", "Electrical Distribution Board", "Hose Reel Point"],
    "label": ["Hall 6", "FOYER-C", "Conference Room A", "Exhibitors Lounge", "Organiser's Office",
              "Registration Counter", "Medical Room", "VIP Room", "Gate 12", "Food Court Area",
              "Press Centre", "Business Center", "Store Room", "Lecture Hall", "Exhibition Hall B"],
    "stall_number": ["D-04", "H2-31", "A12", "F-101", "K-07", "Stand D-12", "Booth 23"],
    "dimension": ["3.0m", "18 sq.m", "6 x 6 m", "9000", "2.75 m"],
    "title": ["HALL 6 LAYOUT PLAN", "First Floor Plan", "Scale 1:100", "Rev. 2", "NOTES",
              "LEGEND"],
    "none": ["Infosys", "Larsen & Toubro", "Adani Group"],
}
for kind, texts in HOLDOUT3.items():
    for text in texts:
        add(text, kind, "holdout3")

# One entry per text: the first truth wins (ITPO before general).
seen, unique = set(), []
for item in items:
    if item["text"] not in seen:
        seen.add(item["text"])
        unique.append(item)

out = Path(__file__).resolve().parent.parent / "test/fixtures/plan-texts/eval.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(unique, ensure_ascii=False, indent=1) + "\n")
counts = {}
for item in unique:
    key = item["source"].split(":")[0]
    counts[key] = counts.get(key, 0) + 1
print(f"{len(unique)} texts -> {out}", counts)
