from pyshacl import validate
from rdflib import Graph, Namespace, RDF
from pathlib import Path
import time

SH = Namespace("http://www.w3.org/ns/shacl#")

def summarize_results(results_graph: Graph):
    counts = {"Violation": 0, "Warning": 0, "Info": 0}
    for res in results_graph.subjects(RDF.type, SH.ValidationResult):
        sev = results_graph.value(res, SH.resultSeverity)
        if sev == SH.Violation:
            counts["Violation"] += 1
        elif sev == SH.Warning:
            counts["Warning"] += 1
        elif sev == SH.Info:
            counts["Info"] += 1
    return counts

def validate_and_report(data_graph: Graph, shapes_graph: Graph, output_path: str, label: str, inference='none'):
    t0 = time.perf_counter()
    conforms, results_graph, results_text = validate(
        data_graph,
        shacl_graph=shapes_graph,
        inference=inference,
        advanced=True,
        abort_on_first=False,
        allow_infos=True,
        allow_warnings=True,
    )

    out_dir = Path(output_path).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    results_graph.serialize(destination=output_path, format="turtle")

    counts = summarize_results(results_graph)
    elapsed = time.perf_counter() - t0
    print(f"SHACL Validation for {label} (inference={inference}): conforms={conforms} | "
          f"violations={counts['Violation']}, warnings={counts['Warning']}, infos={counts['Info']} | "
          f"time={elapsed:.2f}s")
    print("-" * 80)
    return conforms, counts

# Load SHACL shapes
shapes_graph = Graph().parse("data/shape.ttl", format="turtle")

# Dataset 1: Before reasoning
g1 = Graph().parse("data/base.ttl", format="turtle")
c1, m1 = validate_and_report(g1, shapes_graph,
                             "../validation_report/validation_report_before.ttl",
                             "Base Graph", inference='none')

# Dataset 2: After reasoning
g2 = Graph().parse("rdfdata_entailed.ttl", format="turtle")
c2, m2 = validate_and_report(g2, shapes_graph,
                             "../validation_report/validation_report_after.ttl",
                             "Entailed Graph", inference='none')

print(f"Δ violations after reasoning: {m2['Violation'] - m1['Violation']}")
