#!/usr/bin/env python3
"""Seen-leads dedup for the daily multifamily leads run.

A lead is "seen" if ANY of these match a property that appeared in ANY prior
Google Doc (qualified, watchlist, or any other mention):
  - a platform id (zil-<zpid>, crx-<id>, lnet-<id>, rf-..., etc.)
  - a normalized street address key (house number + street name + state)

Usage:
  python3 lead_dedup.py filter runs/DATE-raw.json runs/DATE-candidates.json   # drop seen, print report
  python3 lead_dedup.py check "123 Main St, Town, TX" [zil-123 ...]            # quick lookup
  python3 lead_dedup.py record runs/DATE-shown.json DATE                       # register every lead shown in today's doc
  python3 lead_dedup.py import-index runs/prior-docs-index-*.txt               # (one-time) import doc index
  python3 lead_dedup.py stats
"""
import json, re, sys, os, datetime
REG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seen-leads.json")
SUF = {"street":"st","st":"st","avenue":"ave","ave":"ave","av":"ave","road":"rd","rd":"rd","drive":"dr","dr":"dr",
       "boulevard":"blvd","blvd":"blvd","lane":"ln","ln":"ln","court":"ct","ct":"ct","circle":"cir","cir":"cir",
       "place":"pl","pl":"pl","terrace":"ter","ter":"ter","terr":"ter","highway":"hwy","hwy":"hwy","parkway":"pkwy",
       "pkwy":"pkwy","way":"way","trail":"trl","trl":"trl","square":"sq","loop":"loop","pike":"pike","row":"row"}
DIRS = {"north":"n","south":"s","east":"e","west":"w","northeast":"ne","northwest":"nw","southeast":"se","southwest":"sw",
        "n":"n","s":"s","e":"e","w":"w","ne":"ne","nw":"nw","se":"se","sw":"sw"}
ORD = {"first":"1st","second":"2nd","third":"3rd","fourth":"4th","fifth":"5th","sixth":"6th","seventh":"7th","eighth":"8th","ninth":"9th","tenth":"10th"}
STATES = set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split())

def addr_key(addr):
    """'2009 NE 26th Street #1-3, Wilton Manors, FL 33305' -> '2009|ne 26th|fl'"""
    if not addr: return None
    a = addr.replace("&", " and ")
    first = re.split(r",", a)[0]
    st = None
    for t in re.findall(r"\b([A-Z]{2})\b", a.upper().split(",",1)[1] if "," in a else ""):
        if t in STATES: st = t.lower()
    m = re.match(r"\s*(\d+)(?:\s*[-/]\s*\d+)?\s+(.*)", first)
    if not m: return None
    num, rest = m.group(1), m.group(2).lower()
    rest = re.sub(r"\(.*?\)", " ", rest)
    rest = re.split(r"\s(#|unit|apt|ste|suite|bldg)\b|#", rest)[0]
    toks = [t for t in re.findall(r"[a-z0-9/]+", rest)]
    out = []
    for t in toks:
        t = ORD.get(t, t); t = DIRS.get(t, t)
        if t in SUF: break          # stop at street-type suffix
        if t in ("and", "plus"): break
        out.append(t)
    if not out: out = toks[:2]
    return f"{num}|{' '.join(out[:3])}|{st or ''}"

def load():
    d = json.load(open(REG)) if os.path.exists(REG) else {"seen": {}}
    d.setdefault("seen", {}); d.setdefault("addressIndex", {}); d.setdefault("idIndex", {})
    return d

def save(d):
    d["_lastUpdated"] = datetime.date.today().isoformat()
    json.dump(d, open(REG, "w"), indent=1)

def reindex(d):
    for pid, v in d["seen"].items():
        d["idIndex"].setdefault(pid, pid)
        k = addr_key(v.get("address", ""))
        if k: d["addressIndex"].setdefault(k, pid)

def is_seen(d, addr=None, ids=()):
    for i in ids:
        if i and i in d["idIndex"]: return f"id {i} (= {d['idIndex'][i]})"
    k = addr_key(addr or "")
    if k:
        if k in d["addressIndex"]: return f"address {k} (= {d['addressIndex'][k]})"
        # tolerant match: same number + state, street names share first token
        n, s, stt = k.split("|")
        for kk, pid in d["addressIndex"].items():
            n2, s2, st2 = kk.split("|")
            if n2 == n and (not stt or not st2 or st2 == stt) and s and s2 and s.split()[0] == s2.split()[0]:
                return f"address ~{kk} (= {pid})"
    return None

def register(d, pid, addr, date, bucket, extra_ids=()):
    pid = pid or ("addr-" + (addr_key(addr) or addr)[:60])
    e = d["seen"].get(pid)
    if e:
        e["lastSeen"] = date; e["runCount"] = e.get("runCount", 0) + 1
        e.setdefault("runs", []).append({"date": date, "bucket": bucket})
    else:
        d["seen"][pid] = {"address": addr, "firstSeen": date, "lastSeen": date, "runCount": 1,
                          "runs": [{"date": date, "bucket": bucket}]}
    for i in [pid, *extra_ids]:
        if i: d["idIndex"][i] = pid
    k = addr_key(addr)
    if k: d["addressIndex"].setdefault(k, pid)
    return pid

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"
    d = load(); reindex(d)
    if cmd == "import-index":
        n = 0
        for f in sys.argv[2:]:
            date = re.search(r"\d{4}-\d{2}-\d{2}", f).group(0)
            for line in open(f):
                line = line.strip()
                if not line or "|" not in line: continue
                addr, ids = line.split("|", 1); ids = [i for i in ids.split(",") if i]
                if is_seen(d, addr, ids) and not ids: continue
                register(d, ids[0] if ids else None, addr, date, "prior_doc", ids[1:]); n += 1
        save(d); print("imported", n)
    elif cmd == "filter":
        src, dst = sys.argv[2], sys.argv[3]
        C = json.load(open(src)); keep = []; drop = []
        for c in C:
            ids = [c.get("id")] + list(c.get("alt_ids") or [])
            why = is_seen(d, c.get("address"), ids)
            (drop if why else keep).append((c, why))
        json.dump([c for c, _ in keep], open(dst, "w"), indent=1)
        print(f"kept {len(keep)} new, dropped {len(drop)} previously seen")
        for c, why in drop: print(f"  SEEN  {c.get('id')}  {c.get('address')}  <- {why}")
    elif cmd == "check":
        addr = sys.argv[2]; ids = sys.argv[3:]
        print(is_seen(d, addr, ids) or "NEW")
    elif cmd == "record":
        src, date = sys.argv[2], sys.argv[3]
        rows = json.load(open(src)); n = 0
        for r in rows:
            register(d, r.get("id"), r.get("address"), date, r.get("bucket", "shown"), r.get("alt_ids") or []); n += 1
        save(d); print("recorded", n, "->", len(d["seen"]), "properties,", len(d["addressIndex"]), "address keys")
    else:
        print(len(d["seen"]), "properties;", len(d["idIndex"]), "ids;", len(d["addressIndex"]), "address keys; updated", d.get("_lastUpdated"))

if __name__ == "__main__":
    main()
