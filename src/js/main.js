window.addEventListener("DOMContentLoaded", function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const appRoot = $("appRoot");
    const statusEl = $("status");
    const statusText = $("statusText");

    let pyodide = null;
    let editor = null;
    let running = false;
    let queued = false;
    let pendingClick = null;
    let appState = {};

    // filename -> { b64, ext, size }
    let embeddedFiles = {};

    const MODE = (() => {
        try { return (JSON.parse($("app-mode").textContent || "{}").mode) || "edit"; }
        catch (e) { return "edit"; }
    })();

    function b64Encode(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }
    function b64Decode(b64) {
        const bin = atob(b64);
        return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    function bytesToBase64(bytes) {
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }
    function formatBytes(n) {
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / (1024 * 1024)).toFixed(1) + " MB";
    }

    function sanitize(html) {
        if (typeof DOMPurify === "undefined") return "";
        return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    function mdToHtml(src) {
        if (typeof marked === "undefined") return sanitize("<p>" + String(src) + "</p>");
        return sanitize(marked.parse(String(src)));
    }
    function setStatus(message, kind) {
        statusEl.className = "status show" + (kind === "error" ? " error" : "");
        $("spinner").style.display = kind ? "none" : "block";
        statusText.textContent = message;
    }
    function hideStatus() { statusEl.className = "status"; }

    function download(text, filename, mime) {
        const url = URL.createObjectURL(new Blob([text], { type: mime }));
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function initialSource() {
        const el = $("app-source");
        const raw = (el.textContent || "").trim();
        if (!raw) return ($("default-app").textContent || "").replace(/^\n/, "");
        return el.dataset.encoding === "base64" ? b64Decode(raw) : raw;
    }
    const currentSource = () => (editor ? editor.getValue() : initialSource());

    // ---- Data panel helpers ----
    function refreshDataList() {
        const list = $("dataList");
        const names = Object.keys(embeddedFiles);
        if (!names.length) {
            list.innerHTML = '<div class="panel-empty">No files staged</div>';
            return;
        }
        list.innerHTML = names.map(name => {
            const f = embeddedFiles[name];
            return `<div class="panel-list-item">
                <div>
                    <div class="name">${name}</div>
                    <div class="meta">${formatBytes(f.size)} · .${f.ext}</div>
                </div>
                <button class="btn btn-sm" data-rm-file="${name}">Remove</button>
            </div>`;
        }).join("");
        list.querySelectorAll("[data-rm-file]").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                delete embeddedFiles[btn.dataset.rmFile];
                refreshDataList();
            });
        });
    }

    // ---- Dependencies panel helpers ----
    const installed = new Set();
    function refreshDepsList() {
        const list = $("depsList");
        const names = Array.from(installed).sort();
        if (!names.length) {
            list.innerHTML = '<div class="panel-empty">None yet</div>';
            return;
        }
        list.innerHTML = names.map(name => {
            return `<div class="panel-list-item">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span class="status-dot on"></span>
                    <span class="name">${name}</span>
                </div>
                <button class="btn btn-sm" data-rm-pkg="${name}">Remove</button>
            </div>`;
        }).join("");
        list.querySelectorAll("[data-rm-pkg]").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                installed.delete(btn.dataset.rmPkg);
                refreshDepsList();
            });
        });
    }

    // ---- Widgets / render (unchanged core) ----
    function commit(key, value) {
        appState[key] = value;
        runApp();
    }

    function labelFor(el, forId) {
        const l = document.createElement("label");
        l.className = "st-label";
        l.textContent = el.label || "";
        if (forId) l.setAttribute("for", forId);
        return l;
    }
    function helpFor(el) {
        if (!el.help) return null;
        const d = document.createElement("div");
        d.className = "st-help";
        d.textContent = el.help;
        return d;
    }

    function buildWidget(el) {
        const wrap = document.createElement("div");
        wrap.className = "st-w";
        const id = "w_" + Math.random().toString(36).slice(2, 9);
        const t = el.type;

        if (t === "button") {
            const b = document.createElement("button");
            b.className = "btn " + (el.variant === "primary" ? "btn-accent" : "");
            b.textContent = el.label;
            b.dataset.key = el.key;
            b.addEventListener("click", () => { pendingClick = el.key; runApp(); });
            wrap.appendChild(b);
            return wrap;
        }

        if (t === "checkbox" || t === "toggle") {
            const lab = document.createElement("label");
            lab.className = "st-check";
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = !!el.value;
            input.dataset.key = el.key;
            input.addEventListener("change", () => commit(el.key, input.checked));
            lab.appendChild(input);
            lab.appendChild(document.createTextNode(el.label || ""));
            wrap.appendChild(lab);
            const h = helpFor(el); if (h) wrap.appendChild(h);
            return wrap;
        }

        wrap.appendChild(labelFor(el, id));

        if (t === "text_input" || t === "date_input") {
            const input = document.createElement("input");
            input.id = id; input.className = "st-input";
            input.type = t === "date_input" ? "date" : "text";
            input.value = el.value == null ? "" : el.value;
            input.placeholder = el.placeholder || "";
            input.dataset.key = el.key;
            input.addEventListener("change", () => commit(el.key, input.value));
            wrap.appendChild(input);
        } else if (t === "text_area") {
            const ta = document.createElement("textarea");
            ta.id = id; ta.className = "st-textarea";
            ta.style.height = (el.height || 130) + "px";
            ta.value = el.value == null ? "" : el.value;
            ta.placeholder = el.placeholder || "";
            ta.dataset.key = el.key;
            ta.addEventListener("change", () => commit(el.key, ta.value));
            wrap.appendChild(ta);
        } else if (t === "number_input") {
            const input = document.createElement("input");
            input.id = id; input.className = "st-input"; input.type = "number";
            if (el.min != null) input.min = el.min;
            if (el.max != null) input.max = el.max;
            if (el.step != null) input.step = el.step;
            input.value = el.value; input.dataset.key = el.key;
            input.addEventListener("change", () => commit(el.key, input.value));
            wrap.appendChild(input);
        } else if (t === "slider") {
            const row = document.createElement("div");
            row.className = "st-range-row";
            const input = document.createElement("input");
            input.id = id; input.className = "st-range"; input.type = "range";
            input.min = el.min; input.max = el.max; input.step = el.step || 1;
            input.value = el.value; input.dataset.key = el.key;
            const out = document.createElement("span");
            out.className = "st-range-val"; out.textContent = el.value;
            input.addEventListener("input", () => { out.textContent = input.value; });
            input.addEventListener("change", () => commit(el.key, input.value));
            row.appendChild(input); row.appendChild(out);
            wrap.appendChild(row);
        } else if (t === "selectbox") {
            const sel = document.createElement("select");
            sel.id = id; sel.className = "st-select"; sel.dataset.key = el.key;
            (el.options || []).forEach((opt) => {
                const o = document.createElement("option");
                o.value = opt; o.textContent = opt;
                if (opt === el.value) o.selected = true;
                sel.appendChild(o);
            });
            sel.addEventListener("change", () => commit(el.key, sel.value));
            wrap.appendChild(sel);
        } else if (t === "radio") {
            const group = document.createElement("div");
            group.className = "st-radio-group";
            (el.options || []).forEach((opt) => {
                const lab = document.createElement("label");
                lab.className = "st-check";
                const input = document.createElement("input");
                input.type = "radio"; input.name = el.key; input.value = opt;
                input.checked = opt === el.value; input.dataset.key = el.key;
                input.addEventListener("change", () => commit(el.key, opt));
                lab.appendChild(input);
                lab.appendChild(document.createTextNode(opt));
                group.appendChild(lab);
            });
            wrap.appendChild(group);
        } else if (t === "multiselect") {
            const chosen = Array.isArray(el.value) ? el.value.slice() : [];
            const chips = document.createElement("div");
            chips.className = "st-chips";
            (el.options || []).forEach((opt) => {
                const lab = document.createElement("label");
                lab.className = "st-chip" + (chosen.indexOf(opt) >= 0 ? " on" : "");
                const input = document.createElement("input");
                input.type = "checkbox";
                input.checked = chosen.indexOf(opt) >= 0;
                input.addEventListener("change", () => {
                    const next = input.checked ? chosen.concat([opt]) : chosen.filter((x) => x !== opt);
                    commit(el.key, next);
                });
                lab.appendChild(input);
                lab.appendChild(document.createTextNode(opt));
                chips.appendChild(lab);
            });
            wrap.appendChild(chips);
        } else if (t === "color_picker") {
            const input = document.createElement("input");
            input.id = id; input.type = "color"; input.className = "st-color";
            input.value = el.value || "#4f46e5"; input.dataset.key = el.key;
            input.addEventListener("change", () => commit(el.key, input.value));
            wrap.appendChild(input);
        } else if (t === "file_uploader") {
            const drop = document.createElement("div");
            drop.className = "st-file-drop";
            const input = document.createElement("input");
            input.id = id; input.type = "file"; input.className = "st-file";
            if (el.accept) input.accept = el.accept;
            input.dataset.key = el.key;
            input.addEventListener("change", () => {
                if (input.files && input.files[0]) putUpload(el.key, input.files[0]);
            });

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "st-file-btn";
            btn.textContent = "Choose file";
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                input.click();
            });

            const hint = document.createElement("div");
            hint.className = "st-file-hint";
            hint.textContent = "or drag and drop here";

            drop.appendChild(input);
            drop.appendChild(btn);
            drop.appendChild(hint);

            // Click anywhere on the drop zone opens the picker
            drop.addEventListener("click", (e) => {
                if (e.target === btn || btn.contains(e.target)) return;
                input.click();
            });
            // Basic drag-and-drop
            drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
            drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
            drop.addEventListener("drop", (e) => {
                e.preventDefault();
                drop.classList.remove("dragover");
                const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                if (f) putUpload(el.key, f);
            });

            if (el.value) {
                const name = document.createElement("div");
                name.className = "st-file-name";
                name.textContent = "Loaded: " + el.value;
                drop.appendChild(name);
            }
            wrap.appendChild(drop);
        } else {
            const p = document.createElement("div");
            p.className = "st-text";
            p.textContent = "Unsupported widget: " + t;
            wrap.appendChild(p);
        }

        const h = helpFor(el); if (h) wrap.appendChild(h);
        return wrap;
    }

    async function putUpload(key, file) {
        setStatus("Reading " + file.name + "\u2026");
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const b64 = bytesToBase64(bytes);
        const ext = (file.name.split(".").pop() || "").toLowerCase();

        // Track for packaging (Data Canvas style)
        embeddedFiles[file.name] = { b64, ext, size: bytes.length };
        refreshDataList();

        pyodide.globals.set("__st_up_key", key);
        pyodide.globals.set("__st_up_name", file.name);
        pyodide.globals.set("__st_up_b64", b64);
        pyodide.runPython(
            "import capycanvas\n" +
            "capycanvas._put_upload(__st_up_key, __st_up_name, __st_up_b64)"
        );
        ["__st_up_key", "__st_up_name", "__st_up_b64"].forEach((k) => {
            try { pyodide.globals.delete(k); } catch (e) {}
        });
        hideStatus();
        runApp();
    }

    function buildElement(el) {
        let node;
        switch (el.kind) {
            case "markdown":
                node = document.createElement("div");
                node.className = "st-md";
                node.innerHTML = mdToHtml(el.body);
                return node;
            case "text":
                node = document.createElement("pre");
                node.className = "st-text";
                node.textContent = el.body;
                return node;
            case "caption":
                node = document.createElement("div");
                node.className = "st-caption";
                node.textContent = el.body;
                return node;
            case "code":
                node = document.createElement("pre");
                node.className = "st-code";
                node.textContent = el.body;
                return node;
            case "json":
                node = document.createElement("pre");
                node.className = "st-json";
                node.textContent = el.body;
                return node;
            case "divider":
                return document.createElement("hr");
            case "html":
                node = document.createElement("div");
                node.className = "st-md";
                node.innerHTML = sanitize(el.html);
                return node;
            case "image":
                node = document.createElement("img");
                node.className = "st-img";
                if (typeof el.src === "string" && /^data:image\//.test(el.src)) node.src = el.src;
                return node;
            case "alert":
                node = document.createElement("div");
                node.className = "st-alert " + el.level;
                node.innerHTML = mdToHtml(el.body);
                return node;
            case "metric": {
                node = document.createElement("div");
                node.className = "st-metric" + (el.hero ? " hero" : "");
                const l = document.createElement("div"); l.className = "m-label"; l.textContent = el.label;
                const v = document.createElement("div"); v.className = "m-value"; v.textContent = el.value;
                node.appendChild(l); node.appendChild(v);
                if (el.delta != null) {
                    const d = document.createElement("div"); d.className = "m-delta"; d.textContent = el.delta;
                    node.appendChild(d);
                }
                return node;
            }
            case "dataframe": {
                node = document.createElement("div");
                const box = document.createElement("div");
                box.className = "st-df-wrap";
                box.innerHTML = sanitize(el.html);
                node.appendChild(box);
                if (el.note) {
                    const n = document.createElement("div");
                    n.className = "st-caption";
                    n.textContent = el.note;
                    node.appendChild(n);
                }
                return node;
            }
            case "download": {
                node = document.createElement("button");
                node.className = "btn";
                node.style.marginBottom = "13px";
                node.textContent = el.label;
                node.addEventListener("click", () => {
                    const bin = atob(el.b64);
                    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
                    download(bytes, el.file_name, el.mime);
                });
                return node;
            }
            case "container":
                node = document.createElement("div");
                renderList(el.children || [], node);
                return node;
            case "columns": {
                node = document.createElement("div");
                node.className = "st-cols";
                const total = (el.widths || []).reduce((a, b) => a + b, 0) || 1;
                (el.cols || []).forEach((col, i) => {
                    const c = document.createElement("div");
                    c.className = "st-col";
                    c.style.flex = (el.widths[i] / total) + " 1 0";
                    renderList(col.children || [], c);
                    node.appendChild(c);
                });
                return node;
            }
            case "expander": {
                node = document.createElement("details");
                node.className = "st-expander";
                node.open = !!el.expanded;
                const s = document.createElement("summary");
                s.textContent = el.label;
                node.appendChild(s);
                const body = document.createElement("div");
                body.className = "st-exp-body";
                renderList(el.children || [], body);
                node.appendChild(body);
                return node;
            }
            case "widget":
                return buildWidget(el);
            default:
                node = document.createElement("div");
                node.className = "st-caption";
                node.textContent = "Unknown element: " + el.kind;
                return node;
        }
    }

    function renderList(list, parent) {
        for (const el of list) {
            try { parent.appendChild(buildElement(el)); }
            catch (e) {
                const err = document.createElement("div");
                err.className = "st-fatal";
                err.textContent = "Failed to render " + el.kind + ": " + e;
                parent.appendChild(err);
            }
        }
    }

    function captureFocus() {
        const a = document.activeElement;
        if (!a || !a.dataset || !a.dataset.key) return null;
        let start = null, end = null;
        try { start = a.selectionStart; end = a.selectionEnd; } catch (e) {}
        return { key: a.dataset.key, start, end };
    }
    function restoreFocus(saved) {
        if (!saved) return;
        const el = appRoot.querySelector('[data-key="' + CSS.escape(saved.key) + '"]');
        if (!el) return;
        el.focus();
        if (saved.start != null) {
            try { el.setSelectionRange(saved.start, saved.end); } catch (e) {}
        }
    }

    function isClientMode() {
        return document.body.classList.contains("mode-app") || MODE === "app";
    }

    const CLIENT_ERROR_MSG =
        "Looks like the app encountered an error. Please try refreshing your page and changing your inputs.";

    function showError(parent, fullText) {
        const box = document.createElement("div");
        if (isClientMode()) {
            box.className = "st-alert error";
            box.textContent = CLIENT_ERROR_MSG;
        } else {
            box.className = "st-fatal";
            box.textContent = fullText;
        }
        parent.appendChild(box);
    }

    function renderApp(result) {
        appRoot.innerHTML = "";
        document.body.classList.toggle("layout-wide",
            result.config && result.config.layout === "wide");
        if (result.config && result.config.title) {
            document.title = result.config.title + " · CapyCanvas";
        }
        renderList(result.elements || [], appRoot);
        if (result.error) {
            showError(appRoot, result.error);
        }
        if (!(result.elements || []).length && !result.error) {
            const empty = document.createElement("div");
            empty.className = "st-empty";
            empty.textContent = "This app didn't render anything yet.";
            appRoot.appendChild(empty);
        }
    }

    async function runApp() {
        if (!pyodide) return;
        if (running) { queued = true; return; }
        running = true;
        const focus = captureFocus();
        try {
            const rawSource = currentSource();
            await installFor(rawSource);
            const source = cleanMagicCommands(rawSource);
            const payload = JSON.stringify({ state: appState, clicked: pendingClick });
            pendingClick = null;
            pyodide.globals.set("__st_payload", payload);
            pyodide.globals.set("__st_source", source);
            const raw = pyodide.runPython(
                "import capycanvas\ncapycanvas._run(__st_payload, __st_source)"
            );
            renderApp(JSON.parse(raw));
        } catch (err) {
            appRoot.innerHTML = "";
            showError(appRoot, String((err && err.message) || err));
        } finally {
            running = false;
            restoreFocus(focus);
            if (queued) { queued = false; runApp(); }
        }
    }

    // ---- packages + %pip ----
    const LAZY_PACKAGES = {
        seaborn: "seaborn", openpyxl: "openpyxl", scipy: "scipy",
        sklearn: "scikit-learn", statsmodels: "statsmodels", duckdb: "duckdb",
        pyarrow: "pyarrow", plotly: "plotly", PIL: "pillow"
    };

    function detectPipPackages(source) {
        const pkgs = new Set();
        const re = /^[ \t]*[%!]{1,2}pip\s+install\s+([^\n#]+)/gm;
        let m;
        while ((m = re.exec(source)) !== null) {
            m[1].trim().split(/\s+/).forEach(tok => {
                if (tok.startsWith('-')) return;
                const clean = tok.replace(/^['"]|['"]$/g, '');
                if (clean) pkgs.add(clean);
            });
        }
        return Array.from(pkgs);
    }

    function cleanMagicCommands(source) {
        return source.replace(/^[ \t]*[%!]{1,2}pip\s+install\s+[^\n]+$/gm, (line) => {
            return "# Intercepted (CapyCanvas): " + line.trim();
        });
    }

    async function installFor(source) {
        const wanted = new Set();
        const re = /^[ \t]*(?:import|from)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;
        let m;
        while ((m = re.exec(source)) !== null) {
            const pkg = LAZY_PACKAGES[m[1]];
            if (pkg && !installed.has(pkg)) wanted.add(pkg);
        }
        if (/\b(?:to_excel|read_excel)\s*\(/.test(source) && !installed.has("openpyxl")) {
            wanted.add("openpyxl");
        }
        detectPipPackages(source).forEach(p => {
            if (!installed.has(p)) wanted.add(p);
        });
        if (!wanted.size) return;
        setStatus("Installing " + Array.from(wanted).join(", ") + "\u2026");
        const micropip = pyodide.pyimport("micropip");
        for (const pkg of wanted) {
            try {
                await micropip.install(pkg);
                installed.add(pkg);
                const bare = pkg.split(/[=<>!~]/)[0];
                installed.add(bare);
            } catch (e) {
                console.warn("Failed to install " + pkg + ":", e);
                setStatus("Failed to install " + pkg + ": " + ((e && e.message) || e), "error");
            }
        }
        refreshDepsList();
        hideStatus();
    }

    // ---- bootstrap ----
    async function boot() {
        setStatus("Downloading the Python runtime\u2026 (first load only)");
        pyodide = await loadPyodide();

        setStatus("Installing pandas, numpy and matplotlib\u2026");
        await pyodide.loadPackage("micropip");
        const micropip = pyodide.pyimport("micropip");
        await micropip.install(["pandas", "numpy", "matplotlib"]);
        installed.add("pandas"); installed.add("numpy"); installed.add("matplotlib");

        setStatus("Wiring up capycanvas\u2026");
        pyodide.FS.mkdirTree("/sl_lib");
        pyodide.FS.writeFile("/sl_lib/capycanvas.py",
            $("capycanvas-py").textContent, { encoding: "utf8" });
        pyodide.runPython(
            "import sys\n" +
            "if '/sl_lib' not in sys.path: sys.path.insert(0, '/sl_lib')\n" +
            "import matplotlib\n" +
            "matplotlib.use('Agg')\n" +
            "import capycanvas"
        );

        // Restore packaged data if present (Data Canvas style)
        try {
            const raw = ($("embedded-data").textContent || "{}").trim();
            const data = JSON.parse(raw || "{}");
            const names = Object.keys(data);
            if (names.length) {
                setStatus("Restoring packaged data\u2026");
                for (const name of names) {
                    const entry = data[name];
                    if (!entry || !entry.b64) continue;
                    embeddedFiles[name] = {
                        b64: entry.b64,
                        ext: entry.ext || (name.split(".").pop() || "").toLowerCase(),
                        size: entry.size || Math.floor((entry.b64.length * 3) / 4)
                    };
                    pyodide.globals.set("__st_emb_name", name);
                    pyodide.globals.set("__st_emb_b64", entry.b64);
                    pyodide.runPython(
                        "import capycanvas\n" +
                        "capycanvas._restore_embedded(__st_emb_name, __st_emb_b64)"
                    );
                }
                ["__st_emb_name", "__st_emb_b64"].forEach(k => {
                    try { pyodide.globals.delete(k); } catch (e) {}
                });
                refreshDataList();
            }
        } catch (e) {
            console.warn("Could not restore embedded data:", e);
        }

        $("runBtn").disabled = false;
        refreshDepsList();
        hideStatus();
        await installFor(currentSource());
        await runApp();
    }

    // ---- chrome ----
    editor = CodeMirror.fromTextArea($("editor"), {
        mode: "python",
        lineNumbers: true,
        indentUnit: 4,
        viewportMargin: Infinity,
        theme: document.documentElement.getAttribute("data-theme") === "dark" ? "ayu-dark" : "default"
    });
    editor.setValue(initialSource());
    editor.setSize("100%", "100%");

    $("runBtn").addEventListener("click", async () => {
        await installFor(currentSource());
        appState = {};
        pendingClick = null;
        runApp();
    });
    editor.setOption("extraKeys", {
        "Ctrl-Enter": () => $("runBtn").click(),
        "Cmd-Enter": () => $("runBtn").click()
    });

    $("editToggle").addEventListener("click", () => {
        const hidden = document.body.classList.toggle("mode-app");
        $("editToggle").textContent = hidden ? "Show editor" : "Hide editor";
        if (!hidden) setTimeout(() => editor.refresh(), 0);
    });

    $("themeBtn").addEventListener("click", () => {
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
        editor.setOption("theme", dark ? "default" : "ayu-dark");
        try { localStorage.setItem("sl-theme", dark ? "light" : "dark"); } catch (e) {}
    });

    // Menu open/close helpers
    function setupMenu(menuId, btnId) {
        const menu = $(menuId);
        const btn = $(btnId);
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            // close others
            document.querySelectorAll(".menu.open").forEach(m => {
                if (m !== menu) m.classList.remove("open");
            });
            menu.classList.toggle("open");
        });
    }
    setupMenu("depsMenu", "depsBtn");
    setupMenu("dataMenu", "dataBtn");
    setupMenu("shareMenu", "shareBtn");
    document.addEventListener("click", () => {
        document.querySelectorAll(".menu.open").forEach(m => m.classList.remove("open"));
    });
    // Prevent panel clicks from closing
    ["depsPanel", "dataPanel"].forEach(id => {
        const el = $(id);
        if (el) el.addEventListener("click", e => e.stopPropagation());
    });
    $("shareMenu").querySelector(".menu-panel").addEventListener("click", e => e.stopPropagation());

    // Dependencies install
    $("depsInstallBtn").addEventListener("click", async () => {
        const name = ($("depsInput").value || "").trim();
        if (!name) return;
        setStatus("Installing " + name + "\u2026");
        try {
            const micropip = pyodide.pyimport("micropip");
            await micropip.install(name);
            installed.add(name);
            const bare = name.split(/[=<>!~]/)[0];
            installed.add(bare);
            refreshDepsList();
            $("depsInput").value = "";
            hideStatus();
        } catch (e) {
            setStatus("Failed to install " + name + ": " + ((e && e.message) || e), "error");
        }
    });

    // Multi-file "data dependencies" — staged by devs, not auto-injected into the app UI
    $("dataAddBtn").addEventListener("click", (e) => {
        e.stopPropagation();
        $("dataFileInput").click();
    });
    $("dataFileInput").addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        setStatus("Reading " + files.length + " file(s)\u2026");
        for (const file of files) {
            try {
                const buf = await file.arrayBuffer();
                const bytes = new Uint8Array(buf);
                const b64 = bytesToBase64(bytes);
                const ext = (file.name.split(".").pop() || "").toLowerCase();
                embeddedFiles[file.name] = { b64, ext, size: bytes.length };
                // Also restore into Python so st.embedded("name") works immediately
                if (pyodide) {
                    pyodide.globals.set("__st_emb_name", file.name);
                    pyodide.globals.set("__st_emb_b64", b64);
                    pyodide.runPython(
                        "import capycanvas\n" +
                        "capycanvas._restore_embedded(__st_emb_name, __st_emb_b64)"
                    );
                    try { pyodide.globals.delete("__st_emb_name"); } catch (err) {}
                    try { pyodide.globals.delete("__st_emb_b64"); } catch (err) {}
                }
            } catch (err) {
                console.warn("Failed to read " + file.name + ":", err);
            }
        }
        refreshDataList();
        hideStatus();
        e.target.value = "";
        // Re-run only so apps that already call st.embedded(...) can see new files.
        // Staging here does NOT auto-load data into the app — the author must reference it.
        if (pyodide) runApp();
    });

    $("dataClearBtn").addEventListener("click", () => {
        if (!Object.keys(embeddedFiles).length) return;
        if (!confirm("Clear all tracked files? They will no longer be embedded on export.")) return;
        embeddedFiles = {};
        refreshDataList();
    });

    // Export choice toggles (visual)
    function wireChoice(groupId, name) {
        const group = $(groupId);
        group.querySelectorAll("label").forEach(lab => {
            lab.addEventListener("click", () => {
                group.querySelectorAll("label").forEach(l => l.classList.remove("on"));
                lab.classList.add("on");
            });
        });
    }
    wireChoice("audienceChoice", "audience");
    wireChoice("packageChoice", "packaging");

    // Export rename modal
    function suggestedExportName() {
        const audience = (document.querySelector('input[name="audience"]:checked') || {}).value || "client";
        const packaging = (document.querySelector('input[name="packaging"]:checked') || {}).value || "packaged";
        return "capycanvas-" + audience + "-" + packaging + ".canvas.html";
    }
    function openExportModal() {
        const modal = $("exportModal");
        const input = $("exportFileName");
        input.value = suggestedExportName();
        modal.hidden = false;
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }
    function closeExportModal() {
        $("exportModal").hidden = true;
    }
    function sanitizeExportName(name) {
        let filename = (name || "").trim() || suggestedExportName();
        if (!/\.html?$/i.test(filename)) filename += ".html";
        filename = filename.replace(/[\\\/]+/g, "-");
        return filename;
    }
    // Build machine-readable header comment for Python packaging tools
    function buildHdrComment(mode, dataPayload) {
        const files = Object.keys(dataPayload || {}).map((name) => {
            const e = dataPayload[name] || {};
            let prefixHex = "";
            try {
                const bin = atob(e.b64 || "");
                const n = Math.min(5, bin.length);
                for (let i = 0; i < n; i++) {
                    prefixHex += bin.charCodeAt(i).toString(16).padStart(2, "0");
                }
            } catch (err) {}
            return {
                name,
                ext: e.ext || (name.split(".").pop() || "").toLowerCase(),
                size: e.size || 0,
                prefix_hex: prefixHex,
                store: "embedded-data",
                key: name
            };
        });
        const meta = {
            v: 1,
            magic: "CC01",
            mode: mode,
            packaged: files.length > 0,
            files
        };
        return "<!--CAPYCANVAS_HDR:v1\n" + JSON.stringify(meta) + "\nCAPYCANVAS_HDR_END-->";
    }

    function replaceHdr(html, mode, dataPayload) {
        const block = buildHdrComment(mode, dataPayload);
        const re = /<!--CAPYCANVAS_HDR:v1\n[\s\S]*?\nCAPYCANVAS_HDR_END-->/;
        if (re.test(html)) return html.replace(re, block);
        // Insert after <title>...</title> if missing
        return html.replace(/<\/title>/i, "</title>\n\n" + block);
    }

    // Export
    function doCanvasExport(filename) {
        const audience = (document.querySelector('input[name="audience"]:checked') || {}).value || "client";
        const packaging = (document.querySelector('input[name="packaging"]:checked') || {}).value || "packaged";
        const mode = audience === "client" ? "app" : "edit";

        const LT = "<", GT = ">", CLOSE = LT + "/script" + GT;
        const openTag = (attrs) => LT + "script " + attrs + GT;
        const tagPattern = (id) => new RegExp(
            LT + 'script id="' + id + '"[^' + GT + ']*' + GT + '[\\s\\S]*?' + CLOSE
        );

        let html = window.__SL_PRISTINE__;
        html = html.replace(
            tagPattern("app-source"),
            openTag('id="app-source" type="text/x-python" data-encoding="base64"') +
            b64Encode(currentSource()) + CLOSE
        );
        html = html.replace(
            tagPattern("app-mode"),
            openTag('id="app-mode" type="application/json"') +
            JSON.stringify({ mode }) + CLOSE
        );

        const dataPayload = packaging === "packaged" ? embeddedFiles : {};
        let dataJson = JSON.stringify(dataPayload);
        dataJson = dataJson.replace(/<\//g, "<\\/");
        html = html.replace(
            tagPattern("embedded-data"),
            openTag('id="embedded-data" type="application/json"') +
            dataJson + CLOSE
        );

        html = replaceHdr(html, mode, dataPayload);
        download(html, filename, "text/html");
    }

    $("exportGoBtn").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        $("shareMenu").classList.remove("open");
        openExportModal();
    });

    $("exportConfirmBtn").addEventListener("click", () => {
        const filename = sanitizeExportName($("exportFileName").value);
        closeExportModal();
        doCanvasExport(filename);
    });

    $("exportFileName").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            $("exportConfirmBtn").click();
        } else if (e.key === "Escape") {
            closeExportModal();
        }
    });

    document.querySelectorAll("[data-close-export]").forEach((el) => {
        el.addEventListener("click", () => closeExportModal());
    });

    $("exportPyBtn").addEventListener("click", () => {
        download(currentSource(), "app.py", "text/x-python");
        $("shareMenu").classList.remove("open");
    });

    // Resizer
    const paneEditor = $("paneEditor");
    let dragging = false;
    $("resizer").addEventListener("mousedown", (e) => { dragging = true; e.preventDefault(); });
    window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const pct = Math.min(75, Math.max(20, (e.clientX / window.innerWidth) * 100));
        paneEditor.style.width = pct + "%";
    });
    window.addEventListener("mouseup", () => {
        if (dragging) { dragging = false; editor.refresh(); }
    });

    // Init
    try {
        const saved = localStorage.getItem("sl-theme");
        if (saved) {
            document.documentElement.setAttribute("data-theme", saved);
            editor.setOption("theme", saved === "dark" ? "ayu-dark" : "default");
        }
    } catch (e) {}

    if (MODE === "app") {
        document.body.classList.add("mode-app");
        $("editToggle").textContent = "Show editor";
    }

    boot().catch((err) => {
        console.error(err);
        setStatus(
            "The Python runtime didn't load: " + ((err && err.message) || err) +
            ". It downloads from a CDN on first open — check your connection and reload.",
            "error"
        );
    });
});
