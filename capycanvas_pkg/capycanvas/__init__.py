"""CapyCanvas packaging API — embed data into templates without opening a browser.

Typical workflow::

    import capycanvas as cc
    import polars as pl

    template = cc.read_template("app.canvas.html")
    df = pl.read_csv("large_data.csv")

    for partner in df["Partner"].unique().to_list():
        filtered = df.filter(pl.col("Partner") == partner)
        out = template.copy(kind="client")
        out.embed(filtered, name="data.csv")
        out.save(f"reports/{partner}.html")

This package is independent of the in-browser ``capycanvas`` Pyodide module.
"""

from .template import Template, read_template, HDR_START, HDR_END, MAGIC

__all__ = ["Template", "read_template", "HDR_START", "HDR_END", "MAGIC"]
__version__ = "0.1.0"
