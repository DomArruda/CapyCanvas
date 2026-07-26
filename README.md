# CapyCanvas

A single-file, browser-native data app runtime with a **Streamlit-inspired** API.  
Edit Python on the left, see the app on the right. No server required.

**CapyCanvas is an independent project, heavily inspired by [Streamlit](https://streamlit.io/). It is not affiliated with Streamlit or Snowflake.**

Built for analytics teams that need to **ship interactive dashboards with data** as one HTML file — useful inside a department or with trusted partner companies.

---

## Features

- **Streamlit-inspired API** — `st.title`, widgets, columns, charts, `@st.cache_data`, `session_state`, etc.
- **Full re-run model** — the script runs top-to-bottom on every interaction (same mental model as Streamlit).
- **`%pip` / `%%pip` / `!pip`** — install packages on demand from the source (version pins supported).
- **Dependencies panel** — see what's loaded, install more, remove from tracking.
- **Data panel** — stage files as *data dependencies* even without a `st.file_uploader` in the app. Files are available via `st.embedded("name")` / `st.list_embedded()`.
- **Packaged export** — embed staged files as a JSON map (`name → { b64, ext, size }`) inside the same HTML.
- **Two-axis export**
  - **Audience**: Client (editor + developer chrome hidden) vs Developer (full UI)
  - **Packaging**: Packaged (data embedded) vs Logic only (code only)
- **Client chrome** — in Client mode only **Run** and **Theme** remain visible.
- **Friendly errors for clients** — full tracebacks only in developer mode.

---

## Quick start

1. Open `capycanvas.html` in a modern browser (Chrome / Firefox / Edge / Safari).
2. First load downloads the Pyodide runtime + pandas / numpy / matplotlib (needs network once).
3. Edit the Python on the left, press **Run** (or `Ctrl/Cmd+Enter`).
4. Use **Share / Export** to produce a `.canvas.html` for stakeholders.

### Using embedded data in your app

```python
# Prefer packaged data when present
names = st.list_embedded()
if names:
    f = st.embedded(names[0])
    df = f.dataframe()
else:
    uploaded = st.file_uploader("CSV", type=["csv"])
    df = uploaded.dataframe() if uploaded else load_sample(...)
```

### Installing packages

```python
%pip install seaborn
import seaborn as sns
```

Or use the **Dependencies** dropdown in the navbar.

---

## Export matrix

| Audience   | Packaging   | Result                                      |
|------------|-------------|---------------------------------------------|
| Client     | Packaged    | Minimal UI + data baked in                  |
| Client     | Logic only  | Minimal UI, no data                         |
| Developer  | Packaged    | Full editor + data baked in                 |
| Developer  | Logic only  | Full editor, no data                        |

Filenames look like: `capycanvas-client-packaged.canvas.html`.

**Security note:** Packaged data is base64-embedded, not encrypted. Anyone with the file can extract it. Suitable for internal / trusted-partner distribution only.

---

## Development (split / build)

The single HTML is the shippable artifact. For day-to-day editing you can split it into a modular tree and rebuild.

Requires [Bun](https://bun.sh).

```bash
# Extract regions into src/
bun split.ts
# or: bun split.ts capycanvas.html src

# Edit files under src/ (styles.css, capycanvas.py, default_app.py, js/main.js, …)

# Reassemble back into capycanvas.html
bun build.ts

# Write to a different output file
bun build.ts -o capycanvas-built.html
# or: bun build.ts capycanvas-built.html
```

Package scripts:

```bash
bun run split
bun run build
```

### Region markers (Data Canvas style)

| Context | Open                                      | Close              |
|---------|-------------------------------------------|--------------------|
| HTML    | `<!-- #region file: path/to/file -->`     | `<!-- #endregion -->` |
| CSS     | `/* #region file: path/to/file */`        | `/* #endregion */`    |
| JS      | `//#region file: path/to/file`            | `//#endregion`        |
| Python  | `# pyregion file: path/to/file.py`        | (until `</script>`) |

Add more regions as the codebase grows; `split.ts` / `build.ts` already understand all four forms. Order is preserved via `src/manifest.json`.

---

## Project layout

```
capycanvas.html          # The single-file app (source of truth for shipping)
split.ts                 # Extract regions → src/
build.ts                 # Rebuild HTML from src/
package.json             # bun scripts
src/                     # Modular sources (after split)
  styles.css
  capycanvas.py          # The st.* runtime
  default_app.py         # Demo app shipped in the box
  js/main.js             # Browser host (widgets, export, packages, …)
  manifest.json
.gitignore
README.md
```

---

## Attribution

CapyCanvas's API and execution model are **heavily inspired by Streamlit**.  
This is an independent implementation (browser-native via Pyodide), not a fork of Streamlit, and is **not affiliated with Streamlit or Snowflake**.

---

## Design notes

- **Why single-file?** Zero backend, zero deploy. Hand someone one HTML and it runs.
- **Why the re-run model?** Same mental model as Streamlit: ordinary Python control flow *is* the render pass.
- **Why package data in the HTML?** So a complete interactive dashboard (logic + client data) can travel as one artifact inside a trust boundary.
- **Client vs Developer** lets you ship the same app two ways: a clean stakeholder view and a full editable canvas.

---



---

## Programmatic packaging (Python)

Ship partner-specific HTML reports without opening the browser.

```bash
pip install -e ./capycanvas_pkg
```

```python
import capycanvas as cc
import polars as pl

template = cc.read_template("app.canvas.html")  # export of your finished app
df = pl.read_csv("large_data.csv")

for partner in df["Partner"].unique().to_list():
    filtered = df.filter(pl.col("Partner") == partner)
    out = template.copy(kind="client")   # client = editor hidden
    out.embed(filtered, name="data.csv")
    out.save(f"reports/{partner}.html")
```

Embedded data is stored in `<script id="embedded-data">` (same as the UI export).
A deterministic HTML comment header indexes each file:

```html
<!--CAPYCANVAS_HDR:v1
{"v":1,"magic":"CC01","mode":"app","packaged":true,"files":[...]}
CAPYCANVAS_HDR_END-->
```

Each file entry includes `prefix_hex` (first 5 decoded bytes) for validation.

