#!/usr/bin/env python3
"""
Import historic Atlanta / Building C / Delaware workbooks (and the
Houston CSV) into Supabase.

USAGE:
    pip install pandas openpyxl supabase --break-system-packages
    export SUPABASE_URL="https://ygsapysqzwrpcimgvaqx.supabase.co"
    export SUPABASE_KEY="sb_publishable_..."   # anon/publishable is fine, RLS allows insert

    python3 import_historics.py --dry-run Copy_of_Atlanta_workbook_FULL.xlsx
    python3 import_historics.py Copy_of_Atlanta_workbook_FULL.xlsx
    python3 import_historics.py --location buildingc Building_C_copy_FULL.xlsx
    python3 import_historics.py --location delaware Delaware_FULL.xlsx
    python3 import_historics.py --houston --date 2026-07-04 Kroger_Houston_....csv

ALWAYS run with --dry-run first. It prints exactly what would be
imported (tab-by-tab row counts, and any tabs it can't confidently
parse) without writing anything to Supabase.
"""

import argparse
import os
import re
import sys
from datetime import date

import pandas as pd
from openpyxl import load_workbook

try:
    from supabase import create_client
except ImportError:
    create_client = None  # only required for a real (non --dry-run) run

SKIP_TAB_NAMES = {"copy only", "schedule", "schedule del", "available"}
HEADER_ROW_INDEX = 4  # 0-indexed — row 5 in Excel's own numbering

# Tabs whose names don't fit the standard pattern, confirmed by hand.
# Add more here as they come up — checked before the regex parser runs.
MANUAL_TAB_OVERRIDES = {
    # name: (location, date)
    "06-28 (Bill Schneider)": ("atlanta", "2026-06-28"),
    "5-31 C & Hostler": ("buildingc", "2026-05-31"),
    "Fathers Day (Sun)": ("atlanta", "2026-06-21"),
}

# These tabs span multiple days in one sheet — same column layout as every
# other tab, but each ROW carries its own date (column 6) instead of the
# whole tab representing a single day. Confirmed against the actual sheet
# rather than assumed.
PER_ROW_DATE_TABS = {"MTY to Kenlake Foods", "Dairy Emergency", "ATL to Murray, KY"}

def parse_row_date(row, idx=6):
    """Reads the per-row Date cell (col 6) for PER_ROW_DATE_TABS. Returns
    'YYYY-MM-DD' or None if that row has no date filled in."""
    if idx >= len(row):
        return None
    v = row[idx]
    if v is None:
        return None
    if hasattr(v, "date") and callable(getattr(v, "date")):
        return v.date().isoformat()          # datetime.datetime
    if hasattr(v, "isoformat"):
        return v.isoformat()                  # already a datetime.date
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})', str(v).strip())
    if m:
        try:
            return date(int(m.group(3)), int(m.group(1)), int(m.group(2))).isoformat()
        except ValueError:
            return None
    return None

# ---------------- tab name -> (location, date) ----------------

def parse_tab_name(name, default_location="atlanta"):
    """Returns (location_key, 'YYYY-MM-DD') or None if unrecognized."""
    n = name.strip()
    if n in MANUAL_TAB_OVERRIDES:
        return MANUAL_TAB_OVERRIDES[n]
    if n.lower() in SKIP_TAB_NAMES:
        return None

    location = default_location
    date_part = n
    m = re.match(r'^(.*?)\s*(C|DEL)$', n, re.IGNORECASE)
    if m and m.group(1).strip():
        date_part = m.group(1).strip()
        location = "buildingc" if m.group(2).upper() == "C" else "delaware"

    # MM-DD (assume year 2026, per the sheet owner's confirmation)
    m = re.match(r'^(\d{1,2})-(\d{1,2})$', date_part)
    if m:
        try:
            return location, date(2026, int(m.group(1)), int(m.group(2))).isoformat()
        except ValueError:
            return None

    # M.DD.YY
    m = re.match(r'^(\d{1,2})\.(\d{1,2})\.(\d{2})$', date_part)
    if m:
        try:
            return location, date(2000 + int(m.group(3)), int(m.group(1)), int(m.group(2))).isoformat()
        except ValueError:
            return None

    return None  # doesn't match a known pattern — flagged for manual review, not guessed at


# ---------------- header discovery for one tab ----------------
# Every field is located by its ACTUAL header text on the tab being read,
# not by an assumed fixed position. A tab missing a column, or with one
# inserted, just leaves that one field blank — nothing gets misaligned,
# and no tab needs to be skipped over one shifted column.

def norm(h):
    if h is None:
        return ""
    return re.sub(r'\s+', ' ', str(h)).strip()

# Header text (normalized) -> internal field name, for the "preamble" zone
# before Trip #1 starts. Multiple keys can map to the same field (e.g.
# Delaware's differently-worded rate columns).
SHIFT_FIELD_BY_HEADER = {
    "Inter Change Ins": "interchange_ins_snapshot",
    "IChange Agrment": "interchange_agreement_snapshot",
    "Email": "email_snapshot",
    "Dispatcher Phone": "dispatcher_phone_snapshot",
    "Aljex Load Number": "aljex_load_number",
    "Date": "sheet_date_cell",
    "MC Number": "mc_snapshot",
    "Driver Rating": "driver_rating_snapshot",
    "Customer rate": "customer_rate",
    "Long": "long_haul_flag",
    "Carrier rate": "carrier_rate",
    "Driver": "driver_name",
    "Driver Cell": "driver_cell_snapshot",
    "Shift . Start": "shift_start",
    "Pre shift text sent": "pre_shift_text_sent",
    "ETA for Shift Report": "eta_for_shift_report",
    "Actual Shift Report": "actual_shift_report",
    "ETA for Next Dispatch": "eta_for_next_dispatch",
    "HOS Time Left": "hos_time_left",
    "Comments": "comments",
    "ETA Disp decimal": "eta_disp_decimal",
    "Waynes . Window": "waynes_window",
    "Current Route Status": "current_route_status",
    "Current Route Backhaul Status": "current_route_backhaul_status",
    "HOS Decimal": "hos_decimal",
    "Rev Level": "rev_level",
    "Next Call Time": "next_call_time",
}

# Header text (normalized) -> internal field name, within a single trip
# block's column span. Trip 1 has extra fields (time sheet, pre-shift
# call) that trips 2-5 don't — handled naturally since we only find what's
# actually present in each block's own span.
TRIP_FIELD_BY_HEADER = {
    "Route ID": "route_id", "Trip ID": "trip_id", "Trailer Out": "trailer_out",
    "Route Miles": "route_miles", "Route Stop Count": "stop_count",
    "Dispatch/ Ready Time": "dispatch_time", "Last Stop Depart": "last_stop_depart",
    "Return to DC": "return_to_dc", "Salvage": "salvage", "Backhaul": "backhaul",
    "Backhaul Location": "backhaul_location",
    "Salvage / Bhaul Refused By": "salvage_bhaul_refused_by",
    "Backhaul Trailer Number": "backhaul_trailer_number",
    "Return ETA to DC": "return_eta_to_dc", "Return Drop Location": "return_drop_location",
    "Ppwk Rec'd": "ppwk_received",
    "Time Sheet START Time": "time_sheet_start", "Time Sheet Start Time": "time_sheet_start",
    "Time Sheet Rec'd END Time": "time_sheet_end", "Time Sheet Rec'd": "time_sheet_end",
    "Drop Location text": "drop_location_text", "Return to DC text": "return_to_dc_text",
    "Backhaul Type": "backhaul_type", "45 mins after check in": "check_in_45min",
    "text not answered remind": "text_not_answered_remind", "Pre Shift Call": "pre_shift_call",
    "Route Est Hours": "route_est_hours", "Time to final stop": "time_to_final_stop",
    "ETA to final stop": "eta_to_final_stop", "Est route complete": "est_route_complete",
}

CALL_TIME_RE = re.compile(r'Trip\s*#?\s*(\d)\s*Call\s*[Tt]ime', re.IGNORECASE)


def discover_columns(header_row):
    """Scans ONE tab's own header row and returns:
       shift_map:  {field_name: col_index}
       trip_maps:  {trip_number: {field_name: col_index}}
       problems:   list of strings — empty means usable, non-empty means
                   this doesn't look like a real data tab at all (e.g. no
                   Driver column, no Route ID anywhere) and should still
                   be skipped rather than silently importing garbage.
    """
    h = [norm(x) for x in header_row]

    route_id_positions = [i for i, v in enumerate(h) if v == "Route ID"]
    driver_positions = [i for i, v in enumerate(h) if v == "Driver"]

    problems = []
    if not driver_positions:
        problems.append("no 'Driver' column found anywhere in this tab's header row")
    if not route_id_positions:
        problems.append("no 'Route ID' column found anywhere — doesn't look like a load sheet")
    if problems:
        return {}, {}, problems

    driver_col = driver_positions[0]
    preamble_end = route_id_positions[0]

    shift_map = {}
    for i in range(0, preamble_end):
        field = SHIFT_FIELD_BY_HEADER.get(h[i])
        if field:
            shift_map[field] = i
    shift_map["driver_name"] = driver_col  # guaranteed present, set explicitly

    # Call Time fields, found by their explicit trip number in the text,
    # regardless of where they physically sit in the row.
    call_times = {}
    for i, v in enumerate(h):
        m = CALL_TIME_RE.search(v)
        if m:
            call_times[int(m.group(1))] = i

    block_starts = route_id_positions[:5]
    trip_maps = {}
    for block_idx, start in enumerate(block_starts):
        trip_number = block_idx + 1
        end = block_starts[block_idx + 1] if block_idx + 1 < len(block_starts) else len(h)
        field_map = {}
        for i in range(start, end):
            field = TRIP_FIELD_BY_HEADER.get(h[i])
            if field and field not in field_map:  # first match wins within the block
                field_map[field] = i
        if trip_number in call_times:
            field_map["call_time"] = call_times[trip_number]
        trip_maps[trip_number] = field_map

    return shift_map, trip_maps, []


# ---------------- per-row extraction ----------------

def cellval(row, idx):
    if idx is None or idx >= len(row):
        return None
    v = row[idx]
    if pd.isna(v):
        return None
    if hasattr(v, "isoformat"):  # date/time/datetime objects from openpyxl
        return v.isoformat()
    return v


def extract_shift(row, location, shift_date, shift_map):
    driver_name = cellval(row, shift_map.get("driver_name"))
    if not driver_name or not str(driver_name).strip():
        return None  # blank row — nothing to import
    field_names = [
        "shift_start", "aljex_load_number", "driver_cell_snapshot", "email_snapshot",
        "dispatcher_phone_snapshot", "mc_snapshot", "interchange_ins_snapshot",
        "interchange_agreement_snapshot", "pre_shift_text_sent", "eta_for_shift_report",
        "actual_shift_report", "eta_for_next_dispatch", "hos_time_left", "comments",
        "eta_disp_decimal", "waynes_window", "current_route_status",
        "current_route_backhaul_status", "hos_decimal", "rev_level", "next_call_time",
        "driver_rating_snapshot", "long_haul_flag", "customer_rate", "carrier_rate",
    ]
    rec = {
        "location": location,
        "shift_date": shift_date,
        "driver_name_text": str(driver_name).strip(),
    }
    for f in field_names:
        rec[f] = cellval(row, shift_map.get(f))  # None if this tab doesn't have that column
    return rec


def extract_trips(row, trip_maps):
    """Returns list of (trip_number, dict) for whichever of the 5 slots
    actually have a Route ID filled in — blank slots are skipped, not
    inserted as empty trip rows. Any field this tab's header didn't have
    just comes through as None."""
    field_names = list(TRIP_FIELD_BY_HEADER.values()) + ["call_time"]
    trips = []
    for trip_number, field_map in trip_maps.items():
        if cellval(row, field_map.get("route_id")) is None:
            continue
        rec = {f: cellval(row, field_map.get(f)) for f in field_names}
        trips.append((trip_number, rec))
    return trips


# ---------------- driver lookup ----------------

def build_driver_lookup(supabase):
    resp = supabase.table("atlanta_drivers").select("id, \"Driver Name\"").execute()
    return {(r["Driver Name"] or "").strip().lower(): r["id"] for r in resp.data}


# ---------------- main workbook import ----------------

def import_workbook(path, default_location, dry_run, supabase):
    wb = load_workbook(path, read_only=True, data_only=True)
    driver_lookup = build_driver_lookup(supabase) if (supabase and not dry_run) else {}

    total_shifts = 0
    total_trips = 0
    skipped_tabs = []

    for sheet_name in wb.sheetnames:
        clean_name = sheet_name.strip()
        is_per_row_date = clean_name in PER_ROW_DATE_TABS

        if is_per_row_date:
            location = "atlanta"
        else:
            parsed = parse_tab_name(sheet_name, default_location)
            if parsed is None:
                if clean_name.lower() not in SKIP_TAB_NAMES:
                    skipped_tabs.append(sheet_name)
                continue
            location, tab_shift_date = parsed

        ws = wb[sheet_name]
        rows = list(ws.iter_rows(values_only=True))
        if len(rows) <= HEADER_ROW_INDEX:
            skipped_tabs.append(f"{sheet_name} (too few rows)")
            continue

        shift_map, trip_maps, problems = discover_columns(rows[HEADER_ROW_INDEX])
        if problems:
            skipped_tabs.append(f"{sheet_name} ({problems[0]})")
            continue

        tab_shifts, tab_trips, undated_rows = 0, 0, 0
        for row in rows[HEADER_ROW_INDEX + 1:]:
            shift_date = parse_row_date(row) if is_per_row_date else tab_shift_date
            if shift_date is None:
                # only possible when is_per_row_date — a row with no date filled in yet
                undated_rows += 1
                continue

            shift = extract_shift(row, location, shift_date, shift_map)
            if shift is None:
                continue
            name_key = shift["driver_name_text"].strip().lower()
            shift["driver_id"] = driver_lookup.get(name_key)
            if shift["driver_id"] is not None:
                shift["driver_name_text"] = None  # have a real driver_id, don't also store free text

            trips = extract_trips(row, trip_maps)
            tab_shifts += 1
            tab_trips += len(trips)

            if not dry_run:
                inserted = supabase.table("loads_shifts").insert(shift).execute()
                shift_id = inserted.data[0]["id"]
                for trip_number, trip_rec in trips:
                    trip_rec["shift_id"] = shift_id
                    trip_rec["trip_number"] = trip_number
                    supabase.table("loads_trips").insert(trip_rec).execute()

        date_label = "(multiple dates)" if is_per_row_date else tab_shift_date
        undated_note = f", {undated_rows} row(s) had no date" if undated_rows else ""
        print(f"  {sheet_name:24s} -> {location:10s} {date_label:16s}   {tab_shifts:3d} shifts, {tab_trips:3d} loads{undated_note}")
        total_shifts += tab_shifts
        total_trips += tab_trips

    wb.close()
    print(f"\nTOTAL: {total_shifts} shifts, {total_trips} loads" + (" (DRY RUN — nothing written)" if dry_run else ""))
    if skipped_tabs:
        print(f"\n{len(skipped_tabs)} tab(s) skipped / need manual review:")
        for t in skipped_tabs:
            print(f"  - {t}")


# ---------------- Houston (flat CSV, no trip blocks) ----------------

def import_houston(path, shift_date, dry_run, supabase):
    df = pd.read_csv(path)
    df.columns = [norm(c) for c in df.columns]
    col_map = {
        "Aljex #": "aljex_number", "Comments": "comments", "TTC": "ttc", "TTT": "ttt",
        "Rating": "rating", "TIME": "time", "Name": "driver_name", "Phone #": "driver_phone",
        "TIME OUT | REMARKS": "time_out_remarks", "Dispatcher Phone #": "dispatcher_phone",
        "Carrier": "carrier", "MC": "mc", "Normal Rate": "normal_rate",
    }
    count = 0
    for _, row in df.iterrows():
        name = row.get("Name")
        if pd.isna(name) or not str(name).strip():
            continue
        rec = {"shift_date": shift_date}
        for src, dest in col_map.items():
            val = row.get(src)
            rec[dest] = None if pd.isna(val) else val
        count += 1
        if not dry_run:
            supabase.table("loads_houston").insert(rec).execute()
    print(f"Houston {shift_date}: {count} rows" + (" (DRY RUN)" if dry_run else ""))


# ---------------- CLI ----------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--location", default="atlanta", choices=["atlanta", "buildingc", "delaware"],
                     help="Default location for tabs with no C/DEL suffix (Atlanta tabs have none)")
    ap.add_argument("--houston", action="store_true", help="Treat file as a Houston CSV, not a workbook")
    ap.add_argument("--date", help="Required with --houston — the CSV has no date column")
    ap.add_argument("--dry-run", action="store_true", help="Preview only, writes nothing")
    args = ap.parse_args()

    supabase = None
    if not args.dry_run:
        if create_client is None:
            sys.exit("pip install supabase --break-system-packages (only needed for a real, non-dry-run import)")
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_KEY")
        if not url or not key:
            sys.exit("Set SUPABASE_URL and SUPABASE_KEY environment variables first.")
        supabase = create_client(url, key)

    if args.houston:
        if not args.date:
            sys.exit("--houston requires --date YYYY-MM-DD (the CSV filename's date is ambiguous)")
        import_houston(args.file, args.date, args.dry_run, supabase)
    else:
        import_workbook(args.file, args.location, args.dry_run, supabase)


if __name__ == "__main__":
    main()