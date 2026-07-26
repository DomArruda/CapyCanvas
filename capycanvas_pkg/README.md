# capycanvas (packaging library)

Programmatically embed data into CapyCanvas HTML templates — no browser required.

```python
import capycanvas as cc
import polars as pl

template = cc.read_template("app.canvas.html")  # developer export of your app
df = pl.read_csv("large_data.csv")

for partner in df["Partner"].unique().to_list():
    filtered = df.filter(pl.col("Partner") == partner)
    out = template.copy(kind="client")
    out.embed(filtered, name="data.csv")
    out.save(f"reports/{partner}.html")
```

## Install

```bash
pip install -e ./capycanvas_pkg
# optional:
pip install polars pandas
```

## Header format

Every packaged HTML carries a deterministic comment:

```html
<!--CAPYCANVAS_HDR:v1
{"v":1,"magic":"CC01","mode":"app","packaged":true,"files":[{"name":"data.csv","ext":"csv","size":1234,"prefix_hex":"506172746e","store":"embedded-data","key":"data.csv"}]}
CAPYCANVAS_HDR_END-->
```

- **magic** `CC01` — format id  
- **prefix_hex** — first 5 bytes of the decoded file (hex) for integrity checks  
- **store** — always `embedded-data` (the JSON script the browser restores)

Data itself remains in `<script id="embedded-data">` so CapyCanvas in the browser needs no changes to load it.
