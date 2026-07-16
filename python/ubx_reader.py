import argparse
import datetime as dt
import json
import math
import sys
from collections import defaultdict, deque
from pathlib import Path
import queue
import threading

from pyubx2 import UBXReader

C = 299792458.0
GPS_EPOCH = dt.datetime(1980, 1, 6, tzinfo=dt.timezone.utc)
# Good-enough static offset for GPS->UTC conversion in modern data.
GPS_UTC_LEAP_SECONDS = 18

GNSS_NUMERIC_FREQUENCIES = {
    "0": {0: 1575.42e6, 3: 1227.60e6, 4: 1227.60e6, 6: 1176.45e6, 7: 1176.45e6},
    "1": {0: 1575.42e6, 6: 1176.45e6, 7: 1176.45e6},
    "2": {0: 1575.42e6, 2: 1176.45e6, 3: 1176.45e6, 5: 1207.14e6, 6: 1207.14e6, 7: 1278.75e6, 8: 1278.75e6},
    "3": {0: 1561.098e6, 1: 1575.42e6, 3: 1207.14e6, 5: 1268.52e6, 7: 1176.45e6},
    "5": {0: 1575.42e6, 1: 1575.42e6, 4: 1227.60e6, 5: 1176.45e6, 6: 1278.75e6},
}


def get_wavelength(gnss_id, sig_id, freq_id=0):
    gnssid_str = str(gnss_id)
    sigid_int = int(sig_id)

    if gnssid_str == "6":
        try:
            k = int(freq_id) - 7
        except (TypeError, ValueError):
            k = 0

        if sigid_int == 0:
            return C / ((1602.0 + k * 0.5625) * 1e6)
        if sigid_int in (2, 3):
            return C / ((1246.0 + k * 0.4375) * 1e6)

        return C / 1602.0e6

    if gnssid_str in GNSS_NUMERIC_FREQUENCIES:
        freq = GNSS_NUMERIC_FREQUENCIES[gnssid_str].get(sigid_int)
        if freq:
            return C / freq

    return 0.190294


def gps_week_tow_to_iso(week, tow_seconds, fallback_timestamp):
    try:
        gps_time = GPS_EPOCH + dt.timedelta(weeks=int(week), seconds=float(tow_seconds))
        utc_time = gps_time - dt.timedelta(seconds=GPS_UTC_LEAP_SECONDS)
        return utc_time.strftime('%Y-%m-%dT%H:%M:%SZ')
    except (TypeError, ValueError):
        return fallback_timestamp


def parse_rxmrawx(parsed, s4_history):
    sats = []
    raw_rcv_tow = getattr(parsed, "rcvTow", None)
    rcvTow = round(raw_rcv_tow, 0) if raw_rcv_tow is not None else None
    week = getattr(parsed, "week", None)
    num_meas = int(getattr(parsed, "numMeas", 0) or 0)

    for i in range(1, num_meas + 1):
        suffix = f"_{i:02d}"

        svid = getattr(parsed, f"svId{suffix}", None)
        gnss = getattr(parsed, f"gnssId{suffix}", None)
        sig_id = getattr(parsed, f"sigId{suffix}", None)
        cn0 = getattr(parsed, f"cno{suffix}", None)
        freq_id = getattr(parsed, f"freqId{suffix}", None)
        pr_valid = getattr(parsed, f"prValid{suffix}", None)
        cp_valid = getattr(parsed, f"cpValid{suffix}", None)

        sat_key = (gnss, svid, sig_id)
        window = s4_history[sat_key]
        if rcvTow is not None:
            while window and (rcvTow - window[0][0]) > 60.0:
                window.popleft()

        if cn0 in (None, 0):
            cn0 = None
        else:
            intensity = 10 ** (cn0 / 10.0)
            if rcvTow is not None:
                window.append((rcvTow, float(intensity)))
        
        if rcvTow is not None and len(window) >= 30:
            mean_i = sum(x[1] for x in window) / len(window)
            mean_i_sq = sum(x[1] * x[1] for x in window) / len(window)
            variance = max(0.0, mean_i_sq - (mean_i * mean_i))
            s4 = (math.sqrt(variance) / mean_i) if mean_i > 0 else None
        else:
            s4 = None

        ccd = None
        sigma_ccd = None
        if pr_valid == 1 and cp_valid == 1:
            pr_mes = getattr(parsed, f"prMes{suffix}", None)
            cp_mes = getattr(parsed, f"cpMes{suffix}", None)
            pr_std = getattr(parsed, f"prStd{suffix}", None)
            cp_std = getattr(parsed, f"cpStd{suffix}", None)

            if None not in (pr_mes, cp_mes, pr_std, cp_std, sig_id):
                wavelength = get_wavelength(gnss, sig_id, freq_id)
                sigma_pr = float(pr_std) * 0.01
                sigma_cp = float(cp_std) * 0.004 * wavelength
                ccd = float(pr_mes) - (float(cp_mes) * wavelength)
                sigma_ccd = math.sqrt((sigma_pr ** 2) + (sigma_cp ** 2))

        sats.append(
            {
                "gnss": gnss,
                "svid": svid,
                "sigId": sig_id,
                "cn0": cn0,
                "ccd": round(ccd, 3) if ccd is not None else None,
                "sigmaCcd": round(sigma_ccd, 3) if sigma_ccd is not None else None,
                "s4": round(s4, 3) if s4 is not None else None,
            }
        )

    return (sats, rcvTow, week)

def parse_navsat(parsed):
    sats = []
    iTOW = getattr(parsed, "iTOW", None)
    rcvTow = round(iTOW / 1000.0, 0) if iTOW is not None else None
    num_svs = int(getattr(parsed, "numSvs", 0) or 0)

    for i in range(1, num_svs + 1):
        suffix = f'_{i:02d}'
        sats.append({
            'svid': getattr(parsed, f'svId{suffix}', None),
            'gnss': getattr(parsed, f'gnssId{suffix}', None),
            'elevation': getattr(parsed, f'elev{suffix}', None),
            'sigId': None
        })

    return (sats, rcvTow)


def pick_ubx_file(raw_root, device, explicit_file):
    if explicit_file:
        candidate = Path(explicit_file)
        if not candidate.exists() or not candidate.is_file():
            raise FileNotFoundError(f"UBX file not found: {candidate}")
        return candidate

    device_dir = Path(raw_root) / device
    files = sorted(device_dir.glob("*.ubx"))
    if not files:
        raise FileNotFoundError(f"No .ubx file found in {device_dir}")
    return files[-1]


def iter_payload_records(device, ubx_file, gnss_id=None):
    s4_history = defaultdict(lambda: deque(maxlen=60))
    packet_queue = queue.Queue(maxsize=2048)
    result_queue = queue.Queue(maxsize=2048)
    error_queue = queue.Queue()
    stop_token = object()

    def reader_worker():
        try:
            with ubx_file.open("rb") as stream:
                ubr = UBXReader(stream)
                for _, parsed in ubr:
                    identity = getattr(parsed, "identity", None)
                    if parsed is None or identity not in ("RXM-RAWX", "NAV-SAT"):
                        continue
                    packet_queue.put(parsed)
        except Exception as exc:
            error_queue.put(exc)
        finally:
            packet_queue.put(stop_token)

    def parser_worker():
        week_hint = None
        try:
            while True:
                item = packet_queue.get()
                if item is stop_token:
                    break

                week = None

                identity = getattr(item, "identity", None)
                if identity == "RXM-RAWX":
                    sats, rcvTow, week = parse_rxmrawx(item, s4_history)
                    if week is not None:
                        week_hint = week
                else:
                    sats, rcvTow = parse_navsat(item)
                    week = week_hint

                if gnss_id is not None:
                    sats = [sat for sat in sats if sat.get('gnss') == gnss_id]

                if week is not None and rcvTow is not None and sats:
                    fallback_timestamp = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
                    timestamp = gps_week_tow_to_iso(week, rcvTow, fallback_timestamp)
                    result_queue.put((sats, timestamp))
        except Exception as exc:
            error_queue.put(exc)
        finally:
            result_queue.put(stop_token)

    reader_thread = threading.Thread(target=reader_worker, name="ubx-reader", daemon=True)
    parser_thread = threading.Thread(target=parser_worker, name="ubx-parser", daemon=True)

    reader_thread.start()
    parser_thread.start()

    current_record = None

    while True:
        if not error_queue.empty():
            raise error_queue.get()

        item = result_queue.get()
        if item is stop_token:
            break

        sats, timestamp = item

        if current_record is None or current_record["timestamp"] != timestamp:
            if current_record is not None:
                yield current_record
            current_record = {"timestamp": timestamp, "sats": []}

        current_record["sats"].extend(sats)

    reader_thread.join()
    parser_thread.join()

    if not error_queue.empty():
        raise error_queue.get()

    if current_record is not None:
        yield current_record


def stream_payload(device, ubx_file, out_stream, indent, gnss_id):
    separators = (",", ": ") if indent else (",", ":")
    newline = "\n" if indent else ""
    child_prefix = " " * indent if indent else ""
    first_record = True

    out_stream.write("[")
    if indent:
        out_stream.write("\n")
    out_stream.flush()

    for record in iter_payload_records(device, ubx_file, gnss_id):
        if not first_record:
            out_stream.write(",")
            if indent:
                out_stream.write("\n")
        if indent:
            out_stream.write(child_prefix)
        out_stream.write(json.dumps(record, indent=indent, separators=separators))
        out_stream.flush()
        first_record = False

    if indent and not first_record:
        out_stream.write("\n")
    out_stream.write("]")
    out_stream.write(newline)
    out_stream.flush()


def parse_args():
    parser = argparse.ArgumentParser(
        description="Read UBX raw file and emit telemetry JSON in latest.json format."
    )
    parser.add_argument("--device", default="GNSS_01", help="Device ID (e.g. GNSS_01)")
    parser.add_argument(
        "--raw-root",
        default=str(Path(__file__).resolve().parent.parent / "raw"),
        help="Root raw folder containing device subfolders",
    )
    parser.add_argument("--file", help="Explicit UBX file path. If omitted, use newest in raw/device")
    parser.add_argument("--indent", type=int, default=2, help="JSON indentation")
    parser.add_argument("--gnss", type=int, help="Optional GNSS ID filter for sats")
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        ubx_file = pick_ubx_file(args.raw_root, args.device, args.file)
        stream_payload(args.device, ubx_file, sys.stdout, args.indent, args.gnss)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
