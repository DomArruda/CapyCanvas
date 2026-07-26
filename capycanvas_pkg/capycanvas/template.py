"""Template reader / writer for CapyCanvas single-file HTML apps.

Data store
----------
Embedded files live in ``<script id="embedded-data" type="application/json">``
as ``{ name: { b64, ext, size } }`` — the same shape the browser runtime
already restores on boot.

Header (machine index)
----------------------
A deterministic HTML comment near the top of the file::

    <!--CAPYCANVAS_HDR:v1
    {"v":1,"magic":"CC01","mode":"app","packaged":true,"files":[...]}
    CAPYCANVAS_HDR_END-->

Each file entry includes ``prefix_hex`` (first 5 raw bytes as hex) so external
tools can validate without decoding the full base64 payload.
"""

from __future__ import annotations

import base64
import io
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

HDR_START = "<!--CAPYCANVAS_HDR:v1"
HDR_END = "CAPYCANVAS_HDR_END-->"
MAGIC = "CC01"
HDR_RE = re.compile(
    re.escape(HDR_START) + r"\n(?P<meta>.*?)\n" + re.escape(HDR_END),
    re.DOTALL,
)

SCRIPT_RE = re.compile(
    r'(<script\s+id="(?P<id>[^"]+)"[^>]*>)(?P<body>.*?)(</script>)',
    re.DOTALL | re.IGNORECASE,
)

PathLike = Union[str, Path]


def _prefix_hex(raw: bytes, n: int = 5) -> str:
    return raw[:n].hex()


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _ext_of(name: str) -> str:
    return (name.rsplit(".", 1)[-1] if "." in name else "").lower()


def _to_file_bytes(data: Any, name: Optional[str] = None) -> tuple[str, bytes, str]:
    """Normalize various inputs into (filename, raw_bytes, ext)."""
    # Path / existing file (only if it actually exists on disk)
    if isinstance(data, Path) or (isinstance(data, str) and "\n" not in data and len(data) < 4096):
        try:
            path = Path(data)
            if path.is_file():
                raw = path.read_bytes()
                fname = name or path.name
                return fname, raw, _ext_of(fname)
        except OSError:
            pass

    # raw bytes
    if isinstance(data, (bytes, bytearray, memoryview)):
        raw = bytes(data)
        fname = name or "data.bin"
        return fname, raw, _ext_of(fname)

    # Polars DataFrame
    if type(data).__module__.startswith("polars") and hasattr(data, "write_csv"):
        buf = io.BytesIO()
        # polars write_csv accepts a path or StringIO in some versions; use encode
        try:
            data.write_csv(buf)
            raw = buf.getvalue()
            if isinstance(raw, str):
                raw = raw.encode("utf-8")
        except TypeError:
            s = io.StringIO()
            data.write_csv(s)
            raw = s.getvalue().encode("utf-8")
        fname = name or "data.csv"
        if not fname.lower().endswith(".csv"):
            fname = fname + ".csv"
        return fname, raw, "csv"

    # Pandas DataFrame
    if hasattr(data, "to_csv") and hasattr(data, "columns"):
        raw = data.to_csv(index=False).encode("utf-8")
        fname = name or "data.csv"
        if not fname.lower().endswith(".csv"):
            fname = fname + ".csv"
        return fname, raw, "csv"

    # plain string treated as file contents
    if isinstance(data, str):
        raw = data.encode("utf-8")
        fname = name or "data.txt"
        return fname, raw, _ext_of(fname)

    raise TypeError(
        f"Cannot embed object of type {type(data).__name__}. "
        "Pass a path, bytes, pandas/polars DataFrame, or str."
    )


def _replace_script(html: str, script_id: str, body: str, extra_attrs: str = "") -> str:
    """Replace the body of <script id="script_id">...</script>."""
    pattern = re.compile(
        rf'(<script\s+id="{re.escape(script_id)}"[^>]*>)(.*?)(</script>)',
        re.DOTALL | re.IGNORECASE,
    )
    if not pattern.search(html):
        raise ValueError(f'Could not find <script id="{script_id}"> in template')
    # Escape </ in JSON bodies so we never close the script early
    safe = body.replace("</", "<\\/")
    attrs_suffix = f" {extra_attrs}" if extra_attrs and extra_attrs not in html else ""
    # Keep existing opening tag attributes as-is; only replace body
    return pattern.sub(rf"\g<1>{safe}\g<3>", html, count=1)


def _set_script_attrs_and_body(
    html: str, script_id: str, body: str, open_tag: str
) -> str:
    pattern = re.compile(
        rf'<script\s+id="{re.escape(script_id)}"[^>]*>.*?</script>',
        re.DOTALL | re.IGNORECASE,
    )
    if not pattern.search(html):
        raise ValueError(f'Could not find <script id="{script_id}"> in template')
    safe = body.replace("</", "<\\/")
    return pattern.sub(f"{open_tag}{safe}</script>", html, count=1)


class Template:
    """An in-memory CapyCanvas HTML document."""

    def __init__(self, html: str, path: Optional[PathLike] = None):
        self.html = html
        self.path = Path(path) if path else None
        # Working copy of embedded files: name -> {b64, ext, size}
        self._files: Dict[str, Dict[str, Any]] = {}
        self._mode = "edit"  # "edit" (developer) | "app" (client)
        self._load_from_html()

    # ---- construction ----
    @classmethod
    def read(cls, path: PathLike) -> "Template":
        path = Path(path)
        return cls(path.read_text(encoding="utf-8"), path=path)

    def copy(self, kind: str = "client") -> "Template":
        """Return a deep copy. kind: 'client' | 'developer' (aliases: app/edit)."""
        kind = (kind or "client").lower()
        if kind in ("client", "app"):
            mode = "app"
        elif kind in ("developer", "dev", "edit"):
            mode = "edit"
        else:
            raise ValueError("kind must be 'client' or 'developer'")
        t = Template(self.html, path=None)
        t._files = {k: dict(v) for k, v in self._files.items()}
        t._mode = mode
        return t

    # ---- inspection ----
    def header(self) -> dict:
        """Parse the CAPYCANVAS_HDR block (or synthesize from current state)."""
        m = HDR_RE.search(self.html)
        if m:
            try:
                return json.loads(m.group("meta"))
            except json.JSONDecodeError:
                pass
        return self._build_meta()

    def list_files(self) -> List[str]:
        return list(self._files.keys())

    # ---- mutation ----
    def embed(self, data: Any, name: Optional[str] = None) -> "Template":
        """Embed a DataFrame, file path, or bytes under ``name``.

        Default names:
          - path → original filename
          - DataFrame → data.csv
          - bytes → data.bin
        """
        fname, raw, ext = _to_file_bytes(data, name)
        self._files[fname] = {
            "b64": _b64(raw),
            "ext": ext,
            "size": len(raw),
            # kept only in memory for header; not written into embedded-data
            "_prefix_hex": _prefix_hex(raw),
        }
        return self

    def embed_file(self, path: PathLike, name: Optional[str] = None) -> "Template":
        return self.embed(Path(path), name=name)

    def clear_data(self) -> "Template":
        self._files.clear()
        return self

    def set_mode(self, kind: str) -> "Template":
        kind = (kind or "client").lower()
        if kind in ("client", "app"):
            self._mode = "app"
        elif kind in ("developer", "dev", "edit"):
            self._mode = "edit"
        else:
            raise ValueError("kind must be 'client' or 'developer'")
        return self

    # ---- persist ----
    def render(self) -> str:
        """Return the full HTML with mode, embedded-data, and header applied."""
        html = self.html

        # app-mode
        html = _replace_script(html, "app-mode", json.dumps({"mode": self._mode}))

        # embedded-data payload (strip internal keys)
        payload = {
            name: {"b64": e["b64"], "ext": e["ext"], "size": e["size"]}
            for name, e in self._files.items()
        }
        data_json = json.dumps(payload, separators=(",", ":"))
        html = _replace_script(html, "embedded-data", data_json)

        # header comment
        meta = self._build_meta()
        block = f"{HDR_START}\n{json.dumps(meta, separators=(',', ':'))}\n{HDR_END}"
        if HDR_RE.search(html):
            html = HDR_RE.sub(block, html, count=1)
        else:
            html = re.sub(
                r"</title>",
                f"</title>\n\n{block}",
                html,
                count=1,
                flags=re.IGNORECASE,
            )

        return html

    def save(self, path: PathLike) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.render(), encoding="utf-8")
        return path

    # ---- internals ----
    def _load_from_html(self) -> None:
        # mode
        m = re.search(
            r'<script\s+id="app-mode"[^>]*>(.*?)</script>',
            self.html,
            re.DOTALL | re.IGNORECASE,
        )
        if m:
            try:
                self._mode = json.loads(m.group(1).strip() or "{}").get("mode") or "edit"
            except json.JSONDecodeError:
                self._mode = "edit"

        # embedded files
        m = re.search(
            r'<script\s+id="embedded-data"[^>]*>(.*?)</script>',
            self.html,
            re.DOTALL | re.IGNORECASE,
        )
        if m:
            raw = m.group(1).strip() or "{}"
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = {}
            for name, entry in (data or {}).items():
                if not isinstance(entry, dict) or not entry.get("b64"):
                    continue
                b64 = entry["b64"]
                try:
                    decoded = base64.b64decode(b64)
                    prefix = _prefix_hex(decoded)
                    size = entry.get("size") or len(decoded)
                except Exception:
                    prefix = ""
                    size = entry.get("size") or 0
                self._files[name] = {
                    "b64": b64,
                    "ext": entry.get("ext") or _ext_of(name),
                    "size": size,
                    "_prefix_hex": prefix,
                }

    def _build_meta(self) -> dict:
        files = []
        for name, e in self._files.items():
            files.append(
                {
                    "name": name,
                    "ext": e.get("ext") or _ext_of(name),
                    "size": e.get("size") or 0,
                    "prefix_hex": e.get("_prefix_hex") or "",
                    "store": "embedded-data",
                    "key": name,
                }
            )
        return {
            "v": 1,
            "magic": MAGIC,
            "mode": self._mode,
            "packaged": len(files) > 0,
            "files": files,
        }


def read_template(path: PathLike) -> Template:
    """Load a CapyCanvas HTML template from disk."""
    return Template.read(path)
