#!/usr/bin/env python3
import argparse
import html as html_module
import json
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlparse
from urllib.request import Request, urlopen

DATA_URL = "https://ubntwiki.com/products/software/unifi-controller/api/cat_app_json"
PAGE_PATH = Path(__file__).with_name("unificatlijst_web.html")


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


def _fetch_source() -> str:
    req = Request(DATA_URL, headers={"User-Agent": "unificatlijst-web/1.0"})
    with urlopen(req, timeout=30) as resp:
        encoding = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(encoding, errors="replace")


def _normalize_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    categories: List[Dict[str, Any]] = []
    apps_by_id = raw["applications"]

    for cat_id, cat in raw["categories"].items():
        cid = int(cat_id)
        cat_apps = []
        for app_id in cat.get("applications", []):
            aid = int(app_id)
            app_info = apps_by_id.get(str(aid), {})
            cat_apps.append(
                {
                    "id": aid,
                    "name": app_info.get("name", "(unknown)"),
                }
            )

        categories.append(
            {
                "id": cid,
                "name": cat.get("name", "(zonder naam)"),
                "apps": cat_apps,
            }
        )

    categories.sort(key=lambda item: item["id"])
    for category in categories:
        category["apps"].sort(key=lambda item: item["id"])

    version = raw.get("version", {})
    version_text = f'{version.get("major", "?")}.{version.get("minor", "?")}'

    return {
        "source": DATA_URL,
        "version": version_text,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "categories": categories,
    }


class UnifiHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=str(PAGE_PATH.parent), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/data":
            self._handle_api_data()
            return

        if parsed.path == "/":
            self.path = f"/{PAGE_PATH.name}"
        super().do_GET()

    def _handle_api_data(self) -> None:
        try:
            html = _fetch_source()
            payload = _normalize_payload(extract_json_from_html(html))
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
        except Exception as exc:
            error = json.dumps({"error": str(exc)}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(error)))
            self.end_headers()
            self.wfile.write(error)
            return

        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Lokale UniFi website met dropdown-categorieen en zoekfunctie"
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Bind poort (default: 8765)")
    args = parser.parse_args()

    if not PAGE_PATH.exists():
        print(f"Kan pagina niet vinden: {PAGE_PATH}")
        return 1

    server = ThreadingHTTPServer((args.host, args.port), UnifiHandler)
    print(f"Open http://{args.host}:{args.port} in je browser")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
