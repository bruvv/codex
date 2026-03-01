#!/usr/bin/env python3
import argparse
import csv
import html as html_module
import json
import textwrap
from typing import Dict, Any, Tuple, List, Optional

import requests

URL = "https://ubntwiki.com/products/software/unifi-controller/api/cat_app_json"


def _extract_balanced_json(text: str, needle: str) -> Dict[str, Any]:
    idx = text.find(needle)
    if idx == -1:
        raise ValueError(f'Kon "{needle}" niet vinden in tekst.')

    start = text.rfind("{", 0, idx)
    if start == -1:
        raise ValueError("Kon begin '{' van JSON niet vinden.")

    depth = 0
    in_str = False
    esc = False
    end = None

    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue

        if ch == '"':
            in_str = True
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    if end is None:
        raise ValueError("Kon einde van JSON niet vinden via bracket counting.")

    raw = text[start:end]
    return json.loads(raw)


def _looks_like_cat_app_json(data: Any) -> bool:
    return (
        isinstance(data, dict)
        and isinstance(data.get("categories"), dict)
        and isinstance(data.get("applications"), dict)
    )


def extract_json_from_html(html: str) -> Dict[str, Any]:
    # 1) Sommige mirrors geven direct pure JSON terug.
    try:
        parsed = json.loads(html)
        if _looks_like_cat_app_json(parsed):
            return parsed
    except json.JSONDecodeError:
        pass

    # 2) Probeer eerst ongewijzigde HTML en daarna ge-unescape-te HTML.
    for candidate in (html, html_module.unescape(html)):
        for needle in ('"version"', '"categories"'):
            try:
                parsed = _extract_balanced_json(candidate, needle)
            except (ValueError, json.JSONDecodeError):
                continue
            if _looks_like_cat_app_json(parsed):
                return parsed

    raise ValueError(
        'Kon cat_app JSON niet vinden. Verwachtte keys "categories" en "applications".'
    )


def build_category_mapping(data: Dict[str, Any]) -> Dict[int, Tuple[str, List[int]]]:
    cats = {}
    for k, v in data["categories"].items():
        cid = int(k)
        cats[cid] = (v["name"], [int(x) for x in v.get("applications", [])])
    return cats


def app_name(data: Dict[str, Any], compound_id: int) -> str:
    entry = data["applications"].get(str(compound_id))
    if not entry:
        return "(unknown)"
    return entry.get("name", "(unknown)")


def _join_natural(items: List[str]) -> str:
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} en {items[1]}"
    return ", ".join(items[:-1]) + f" en {items[-1]}"


def build_readable_report(
    data: Dict[str, Any],
    categories: Dict[int, Tuple[str, List[int]]],
    *,
    category_id: Optional[int] = None,
    sentence_size: int = 8,
) -> str:
    if sentence_size < 1:
        raise ValueError("--sentence-size moet minimaal 1 zijn.")

    if category_id is not None:
        selected = [(category_id, categories[category_id])]
    else:
        selected = sorted(categories.items())

    total_apps = sum(len(apps) for _, (_, apps) in selected)
    lines: List[str] = [
        f"Uitgebreid overzicht voor {len(selected)} categorieen en {total_apps} apps."
    ]

    for cid, (cname, apps) in selected:
        lines.append("")
        lines.append(f"Categorie {cid} ({cname}) bevat {len(apps)} apps.")
        if not apps:
            lines.append("Er staan momenteel geen apps in deze categorie.")
            continue

        entries = [f"{comp}: {app_name(data, comp)}" for comp in apps]
        for i in range(0, len(entries), sentence_size):
            chunk = entries[i : i + sentence_size]
            start = i + 1
            end = i + len(chunk)
            sentence = (
                f"Apps {start} t/m {end} in categorie {cid} zijn: "
                f"{_join_natural(chunk)}."
            )
            lines.append(
                textwrap.fill(
                    sentence,
                    width=110,
                    subsequent_indent="    ",
                    break_long_words=False,
                    break_on_hyphens=False,
                )
            )

    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", type=int, help="Dump alleen deze category id")
    ap.add_argument(
        "--search", type=str, help="Zoek op (deel van) app-naam (case-insensitive)"
    )
    ap.add_argument(
        "--csv", type=str, help="Schrijf volledige mapping naar CSV bestand"
    )
    ap.add_argument(
        "--report",
        action="store_true",
        help="Toon uitgebreid en leesbaar overzicht in zinnen per categorie",
    )
    ap.add_argument(
        "--report-file",
        type=str,
        help="Schrijf uitgebreid en leesbaar overzicht in zinnen naar tekstbestand",
    )
    ap.add_argument(
        "--sentence-size",
        type=int,
        default=8,
        help="Aantal apps per zin in rapportmodus (standaard: 8)",
    )
    args = ap.parse_args()

    html = requests.get(URL, timeout=30).text
    data = extract_json_from_html(html)
    categories = build_category_mapping(data)

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["category_id", "category_name", "compound_id", "app_name"])
            for cid, (cname, apps) in sorted(categories.items()):
                for comp in apps:
                    w.writerow([cid, cname, comp, app_name(data, comp)])
        print(f"CSV geschreven: {args.csv}")
        return 0

    if args.report or args.report_file:
        if args.category is not None and args.category not in categories:
            print("Onbekende category id.")
            return 2
        report = build_readable_report(
            data,
            categories,
            category_id=args.category,
            sentence_size=args.sentence_size,
        )
        if args.report_file:
            with open(args.report_file, "w", encoding="utf-8") as f:
                f.write(report)
                f.write("\n")
            print(f"Rapport geschreven: {args.report_file}")
        if args.report or not args.report_file:
            print(report)
        return 0

    if args.search:
        q = args.search.casefold()
        hits = []
        for cid, (cname, apps) in categories.items():
            for comp in apps:
                nm = app_name(data, comp)
                if q in nm.casefold():
                    hits.append((cid, cname, comp, nm))
        for cid, cname, comp, nm in sorted(hits):
            print(f"{cid} ({cname})  {comp}: {nm}")
        return 0

    if args.category is not None:
        if args.category not in categories:
            print("Onbekende category id.")
            return 2
        cname, apps = categories[args.category]
        print(f"{args.category}: {cname} ({len(apps)} apps)")
        for comp in apps:
            print(f"  {comp}: {app_name(data, comp)}")
        return 0

    # Default: compact overzicht per categorie
    for cid, (cname, apps) in sorted(categories.items()):
        print(f"{cid}: {cname} ({len(apps)} apps)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
