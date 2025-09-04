# Visualising the Effects of Reasoning on KG Validation


## Features
- Compare Before vs After reasoning graphs
- Pick a class to view class-specific changes and validation results
- Node status coloring: valid / invalid / inferred
- Toggle collapse mode to expand/collapse subnodes
- Zoom / pan / drag with a smooth D3 force layout

## Prerequisites
- Python 3.12
- Recommended: a virtual environment

## Quick Start
```bash
# 1) Activate a virtual environment
python -m venv .venv
source .venv/bin/activate            #Windows: .venv\Scripts\activate

# 2) Install dependencies
pip install -U flask rdflib owlrl pyshacl

# 3) Run entailment (rdfdata_entailed.ttl)
python entailment.py

# 4) Run validation (get validation_report_*.ttl in validation_report/)
python validation/Validation.py

# 5) Build visualization JSON
python comparison/toJson.py
python comparison/group_by_class.py

# 6) Start the Flask server (serves API + index.html)
python app.py
```

## Customizing the Dataset

- Replace data/base.ttl with your RDF data.
- Update data/shape.ttl with your SHACL shapes.
- Re-run the full pipeline (entailment → validation → JSON) before launching the UI.

