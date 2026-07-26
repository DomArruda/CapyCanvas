"""capycanvas - a small, Streamlit-shaped API for single-file data apps.

The execution model is Streamlit's: the whole script runs top to bottom again
on every interaction. A widget call returns whatever the user currently has
selected, so ordinary control flow *is* the render pass - no reactive graph,
no callbacks.

The cost of that model is that everything runs again on every click, so wrap
anything slow in @st.cache_data.

Widget identity: a widget with no key= gets one from its call order. Create
widgets inside an if/else and the ordering shifts, which silently resets the
ones after it. Pass key= for anything conditional.
"""

import base64
import io
import json as _json
import traceback

# ------------------------------------------------------------ runtime state
_elements = []
_stack = []
_state = {}
_clicked = None
_counter = 0
_uploads = {}
_embedded = {}   # name -> bytes  (restored from packaged export)
_cache = {}
_config = {}


class _SessionState(dict):
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)
    def __setattr__(self, name, value):
        self[name] = value
    def __delattr__(self, name):
        del self[name]


session_state = _SessionState()


class StopApp(Exception):
    pass


def stop():
    raise StopApp()


def _emit(element):
    (_stack[-1] if _stack else _elements).append(element)
    return element


def _next_key(kind, label):
    global _counter
    _counter += 1
    return "auto:" + kind + ":" + str(_counter)


def _widget(wtype, label, key, default, **props):
    k = key or _next_key(wtype, label)
    value = _state.get(k, default)
    element = {"kind": "widget", "type": wtype, "key": k, "label": label, "value": value}
    element.update(props)
    _emit(element)
    return value


def _as_number(raw, fallback, step):
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return fallback
    if isinstance(step, int) and isinstance(fallback, int):
        return int(round(value))
    return value


class Container:
    def __init__(self, element):
        object.__setattr__(self, "_element", element)
    def __enter__(self):
        _stack.append(self._element["children"])
        return self
    def __exit__(self, *exc_info):
        _stack.pop()
        return False
    def __getattr__(self, name):
        fn = globals().get(name)
        if not callable(fn):
            raise AttributeError(name)
        def scoped(*args, **kwargs):
            with self:
                return fn(*args, **kwargs)
        return scoped


def container():
    return Container(_emit({"kind": "container", "children": []}))


def columns(spec, gap="medium"):
    widths = [1.0] * spec if isinstance(spec, int) else [float(w) for w in spec]
    cols = [{"children": []} for _ in widths]
    _emit({"kind": "columns", "widths": widths, "gap": gap, "cols": cols})
    return [Container(c) for c in cols]


def expander(label, expanded=False):
    return Container(_emit({
        "kind": "expander", "label": str(label),
        "expanded": bool(expanded), "children": []
    }))


def markdown(body):
    _emit({"kind": "markdown", "body": str(body)})


def title(body):
    markdown("# " + str(body))


def header(body):
    markdown("## " + str(body))


def subheader(body):
    markdown("### " + str(body))


def caption(body):
    _emit({"kind": "caption", "body": str(body)})


def text(body):
    _emit({"kind": "text", "body": str(body)})


def code(body, language="python"):
    _emit({"kind": "code", "body": str(body), "language": language})


def divider():
    _emit({"kind": "divider"})


def json(obj):
    try:
        body = _json.dumps(obj, indent=2, default=str)
    except Exception:
        body = str(obj)
    _emit({"kind": "json", "body": body})


def _alert(level, body):
    _emit({"kind": "alert", "level": level, "body": str(body)})


def info(body):
    _alert("info", body)


def success(body):
    _alert("success", body)


def warning(body):
    _alert("warning", body)


def error(body):
    _alert("error", body)


def metric(label, value, delta=None, hero=False):
    _emit({"kind": "metric", "label": str(label), "value": str(value),
           "delta": None if delta is None else str(delta), "hero": bool(hero)})


def dataframe(data, use_container_width=True, max_rows=200):
    try:
        frame = data.head(max_rows)
        html = frame.to_html(classes="st-df", border=0, index=True)
        truncated = len(data) > max_rows
    except AttributeError:
        _emit({"kind": "text", "body": str(data)})
        return
    _emit({"kind": "dataframe", "html": html, "full_width": bool(use_container_width),
           "note": ("showing first " + str(max_rows) + " of " + str(len(data)) + " rows")
                   if truncated else None})


table = dataframe


def pyplot(fig=None, clear=True):
    import matplotlib.pyplot as plt
    if fig is None:
        fig = plt.gcf()
    if hasattr(fig, "get_figure") and not hasattr(fig, "savefig"):
        fig = fig.get_figure()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=96)
    src = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    buf.close()
    if clear:
        plt.close(fig)
    _emit({"kind": "image", "src": src, "caption": None})


def _chart(data, kind):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import pandas as pd

    if isinstance(data, pd.Series):
        frame = data.to_frame()
    elif isinstance(data, pd.DataFrame):
        frame = data
    else:
        frame = pd.DataFrame(data)

    plt.style.use("default")
    fig, ax = plt.subplots(figsize=(7.2, 3.4))
    numeric = frame.select_dtypes("number")
    if numeric.empty:
        plt.close(fig)
        warning("Nothing numeric to chart.")
        return

    if kind == "bar":
        numeric.plot(kind="bar", ax=ax, width=.78)
    elif kind == "area":
        numeric.plot(kind="area", ax=ax, alpha=.45)
    elif kind == "scatter" and numeric.shape[1] >= 2:
        ax.scatter(numeric.iloc[:, 0], numeric.iloc[:, 1], s=18, alpha=.75)
        ax.set_xlabel(numeric.columns[0])
        ax.set_ylabel(numeric.columns[1])
    else:
        numeric.plot(ax=ax)

    ax.grid(True, alpha=.25, linewidth=.7)
    ax.set_facecolor("#ffffff")
    fig.patch.set_facecolor("#ffffff")
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    if kind != "scatter" and (numeric.shape[1] > 1 or kind in ("bar", "area")):
        ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    pyplot(fig)


def line_chart(data):
    _chart(data, "line")


def bar_chart(data):
    _chart(data, "bar")


def area_chart(data):
    _chart(data, "area")


def scatter_chart(data):
    _chart(data, "scatter")


def button(label, key=None, type="secondary"):
    k = key or _next_key("button", label)
    _emit({"kind": "widget", "type": "button", "key": k, "label": str(label),
           "value": False, "variant": type})
    return _clicked == k


def text_input(label, value="", key=None, placeholder="", help=None):
    return str(_widget("text_input", label, key, str(value),
                       placeholder=placeholder, help=help))


def text_area(label, value="", key=None, height=130, placeholder="", help=None):
    return str(_widget("text_area", label, key, str(value),
                       height=height, placeholder=placeholder, help=help))


def number_input(label, min_value=None, max_value=None, value=0, step=1, key=None, help=None):
    raw = _widget("number_input", label, key, value,
                  min=min_value, max=max_value, step=step, help=help)
    return _as_number(raw, value, step)


def slider(label, min_value=0, max_value=100, value=None, step=1, key=None, help=None):
    default = min_value if value is None else value
    raw = _widget("slider", label, key, default,
                  min=min_value, max=max_value, step=step, help=help)
    return _as_number(raw, default, step)


def checkbox(label, value=False, key=None, help=None):
    return bool(_widget("checkbox", label, key, bool(value), help=help))


def toggle(label, value=False, key=None, help=None):
    return bool(_widget("toggle", label, key, bool(value), help=help))


def _pick_one(wtype, label, options, index, key, help):
    opts = list(options)
    labels = [str(o) for o in opts]
    if not labels:
        _widget(wtype, label, key, "", options=[], help=help)
        return None
    index = max(0, min(int(index), len(labels) - 1))
    raw = _widget(wtype, label, key, labels[index], options=labels, help=help)
    return opts[labels.index(raw)] if raw in labels else opts[index]


def selectbox(label, options, index=0, key=None, help=None):
    return _pick_one("selectbox", label, options, index, key, help)


def radio(label, options, index=0, key=None, help=None):
    return _pick_one("radio", label, options, index, key, help)


def multiselect(label, options, default=None, key=None, help=None):
    opts = list(options)
    labels = [str(o) for o in opts]
    chosen = [str(d) for d in (default or [])]
    raw = _widget("multiselect", label, key, chosen, options=labels, help=help)
    if not isinstance(raw, list):
        raw = []
    return [opts[labels.index(r)] for r in raw if r in labels]


def color_picker(label, value="#4f46e5", key=None, help=None):
    return str(_widget("color_picker", label, key, str(value), help=help))


def date_input(label, value="", key=None, help=None):
    return str(_widget("date_input", label, key, str(value), help=help))


class UploadedFile:
    def __init__(self, name, data):
        self.name = name
        self.size = len(data)
        self._data = data
    def getvalue(self):
        return self._data
    def read(self):
        return self._data
    def dataframe(self, **kwargs):
        import pandas as pd
        lower = self.name.lower()
        buf = io.BytesIO(self._data)
        if lower.endswith(".csv") or lower.endswith(".txt"):
            return pd.read_csv(buf, **kwargs)
        if lower.endswith(".tsv"):
            return pd.read_csv(buf, sep="\t", **kwargs)
        if lower.endswith(".json"):
            return pd.read_json(buf, **kwargs)
        if lower.endswith(".xlsx") or lower.endswith(".xls"):
            return pd.read_excel(buf, **kwargs)
        if lower.endswith(".parquet"):
            return pd.read_parquet(buf, **kwargs)
        raise ValueError("Don't know how to read " + self.name + " as a table.")
    def __repr__(self):
        return "<UploadedFile " + self.name + " (" + str(self.size) + " bytes)>"


def file_uploader(label, type=None, key=None, help=None):
    k = key or _next_key("file_uploader", label)
    accept = ",".join("." + str(t).lstrip(".") for t in type) if type else ""
    current = _uploads.get(k)
    _emit({"kind": "widget", "type": "file_uploader", "key": k, "label": str(label),
           "value": current[0] if current else None, "accept": accept, "help": help})
    if not current:
        return None
    return UploadedFile(current[0], current[1])


def embedded(name):
    """Return an UploadedFile for a file that was embedded via packaged export, or None."""
    data = _embedded.get(name)
    if data is None:
        return None
    return UploadedFile(name, data)


def list_embedded():
    """Return the list of filenames that were restored from a packaged export."""
    return list(_embedded.keys())


def download_button(label, data, file_name="download.txt", mime="text/plain", key=None):
    if isinstance(data, bytes):
        raw = data
    elif isinstance(data, str):
        raw = data.encode("utf-8")
    elif hasattr(data, "to_csv"):
        raw = data.to_csv(index=False).encode("utf-8")
    else:
        raw = str(data).encode("utf-8")
    _emit({"kind": "download", "key": key or _next_key("download", label),
           "label": str(label), "file_name": str(file_name), "mime": str(mime),
           "b64": base64.b64encode(raw).decode("ascii")})


def write(*args):
    for arg in args:
        _write_one(arg)


def _write_one(obj):
    if obj is None:
        text("None")
        return
    if isinstance(obj, str):
        markdown(obj)
        return
    if isinstance(obj, bool) or isinstance(obj, (int, float)):
        text(str(obj))
        return
    if isinstance(obj, (dict, list, tuple, set)):
        json(list(obj) if isinstance(obj, set) else obj)
        return
    type_name = str(type(obj))
    if "matplotlib.figure.Figure" in type_name:
        pyplot(obj)
        return
    if "matplotlib.axes" in type_name:
        pyplot(obj.get_figure())
        return
    if hasattr(obj, "to_html"):
        dataframe(obj)
        return
    if hasattr(obj, "_repr_html_"):
        _emit({"kind": "html", "html": obj._repr_html_()})
        return
    text(str(obj))


def cache_data(func=None, **_kwargs):
    def wrap(fn):
        def inner(*args, **kwargs):
            try:
                token = fn.__name__ + repr(args) + repr(sorted(kwargs.items()))
            except Exception:
                return fn(*args, **kwargs)
            if token not in _cache:
                _cache[token] = fn(*args, **kwargs)
            return _cache[token]
        inner.clear = _cache.clear
        inner.__name__ = getattr(fn, "__name__", "cached")
        return inner
    return wrap if func is None else wrap(func)


cache_resource = cache_data


def set_page_config(page_title=None, layout="centered", **_kwargs):
    if page_title:
        _config["title"] = str(page_title)
    _config["layout"] = layout


def _put_upload(key, name, b64):
    _uploads[key] = (name, base64.b64decode(b64))


def _clear_upload(key):
    _uploads.pop(key, None)


def _restore_embedded(name, b64):
    _embedded[name] = base64.b64decode(b64)


def _run(payload_json, source):
    global _elements, _stack, _state, _clicked, _counter
    payload = _json.loads(payload_json)
    _state = payload.get("state") or {}
    _clicked = payload.get("clicked")
    _elements = []
    _stack = []
    _counter = 0
    _config.clear()
    _config.update({"title": "CapyCanvas app", "layout": "centered"})

    import sys
    namespace = {"__name__": "__capycanvas_app__", "st": sys.modules[__name__]}
    for alias, module_name in (("pd", "pandas"), ("np", "numpy")):
        try:
            namespace[alias] = __import__(module_name)
        except Exception:
            pass

    error_text = None
    try:
        exec(compile(source, "app.py", "exec"), namespace)
    except StopApp:
        pass
    except Exception:
        error_text = traceback.format_exc()

    return _json.dumps({"elements": _elements, "error": error_text, "config": _config},
                       default=str)
