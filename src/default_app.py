import capycanvas as st
import pandas as pd
import numpy as np

st.set_page_config(page_title="Sales explorer")

st.title("Sales explorer")
st.caption("CapyCanvas is an independent project, heavily inspired by Streamlit. Not affiliated with Streamlit or Snowflake.")
st.markdown(
    "Edit the code on the left and press **Run**. "
    "Use `%pip install package` for extra packages. "
    "Upload a CSV or leave empty for sample data.\n\n"
    "Data staged in the **Data** panel (developer data dependencies) is available "
    "via `st.embedded(\"filename\")` — it is **not** auto-loaded. Reference it "
    "explicitly in your code when you want it."
)

# Example of using a staged data dependency (uncomment to try):
# f = st.embedded("stonks_data.csv")
# if f is not None:
#     df = f.dataframe()
#     st.success(f"Loaded {f.name} — {len(df)} rows")
#     st.stop()   # or continue with your own filters

# Example package install:
# %pip install seaborn
# import seaborn as sns

@st.cache_data
def load_sample(n_rows):
    rng = np.random.default_rng(7)
    return pd.DataFrame({
        "region": rng.choice(["North", "South", "East", "West"], n_rows),
        "month": rng.choice(["Jan", "Feb", "Mar", "Apr", "May", "Jun"], n_rows),
        "units": rng.integers(20, 200, n_rows),
        "revenue": rng.normal(5000, 1500, n_rows).round(2),
    })

uploaded = st.file_uploader("Upload a CSV, or leave empty for sample data", type=["csv"])
if uploaded is not None:
    df = uploaded.dataframe()
    st.success("Loaded " + uploaded.name + " — " + str(len(df)) + " rows")
else:
    df = load_sample(st.slider("Sample rows", 50, 1000, 300, step=50))

st.subheader("Filters")
left, right = st.columns(2)
with left:
    regions = st.multiselect("Region", sorted(df["region"].unique()),
                             default=sorted(df["region"].unique()))
with right:
    min_units = st.number_input("Minimum units", min_value=0, max_value=200, value=0, step=10)

view = df[df["region"].isin(regions) & (df["units"] >= min_units)]

a, b, c = st.columns(3)
a.metric("Rows", len(view))
b.metric("Revenue", "$" + format(view["revenue"].sum(), ",.0f"))
c.metric("Avg units", round(view["units"].mean(), 1) if len(view) else 0)

st.divider()

if view.empty:
    st.warning("No rows match those filters.")
    st.stop()

st.subheader("Revenue by month")
st.bar_chart(view.groupby("month", sort=False)["revenue"].sum())

with st.expander("Show the filtered table"):
    st.dataframe(view.head(50))

st.download_button("Download filtered CSV", view, file_name="filtered.csv", mime="text/csv")

if st.button("Say hello"):
    st.info("Buttons are True only on the run they trigger, then flip back.")
