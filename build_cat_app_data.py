#!/usr/bin/env python3
import argparse
import html as html_module
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from urllib.request import Request, urlopen

SOURCE_URL = "https://ubntwiki.com/products/software/unifi-controller/api/cat_app_json"


def _extract_balanced_json(text: str, needle: str) -> Dict[str, Any]:
    idx = text.find(needle)
    if idx == -1:
        raise ValueError(f'Kon "{needle}" niet vinden in tekst.')

    start = text.rfind("{", 0, idx)
    if start == -1:
        raise ValueError("Kon begin '{' van JSON niet vinden.")

    depth = 0
    in_str = False
    escaped = False
    end = None

    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
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

    return json.loads(text[start:end])


def _looks_like_cat_app_json(data: Any) -> bool:
    return (
        isinstance(data, dict)
        and isinstance(data.get("categories"), dict)
        and isinstance(data.get("applications"), dict)
    )


def extract_json_from_html(html: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(html)
        if _looks_like_cat_app_json(parsed):
            return parsed
    except json.JSONDecodeError:
        pass

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


def fetch_source() -> str:
    req = Request(SOURCE_URL, headers={"User-Agent": "unificatlijst-build/1.0"})
    with urlopen(req, timeout=30) as resp:
        encoding = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(encoding, errors="replace")


def normalize_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    categories: List[Dict[str, Any]] = []
    apps_by_id = raw["applications"]

    for cat_id, cat in raw["categories"].items():
        cid = int(cat_id)
        apps = []
        for app_id in cat.get("applications", []):
            aid = int(app_id)
            info = apps_by_id.get(str(aid), {})
            apps.append({"id": aid, "name": info.get("name", "(unknown)")})

        apps.sort(key=lambda x: x["id"])
        categories.append(
            {
                "id": cid,
                "name": cat.get("name", "(zonder naam)"),
                "apps": apps,
            }
        )

    categories.sort(key=lambda x: x["id"])
    version = raw.get("version", {})
    version_text = f'{version.get("major", "?")}.{version.get("minor", "?")}'

    return {
        "source": SOURCE_URL,
        "version": version_text,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "categories": categories,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Bouw statische data voor GitHub Pages (cat_app_data.json)."
    )
    parser.add_argument(
        "--output",
        default="data/cat_app_data.json",
        help="Pad voor output JSON (default: data/cat_app_data.json)",
    )
    args = parser.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    raw_html = fetch_source()
    payload = normalize_payload(extract_json_from_html(raw_html))
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Geschreven: {output} ({len(payload['categories'])} categorieen)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
