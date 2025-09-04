import hashlib
import json
import time
import os
import csv
import tracemalloc
from rdflib import Graph, BNode, URIRef, Literal, Namespace
from rdflib.namespace import RDF
from typing import Optional, Tuple, Set, Dict

SH = Namespace("http://www.w3.org/ns/shacl#")

def guess_format(path: str) -> str:
    p = path.lower()
    if p.endswith(".ttl"): return "turtle"
    if p.endswith(".nt"): return "nt"
    if p.endswith(".xml") or p.endswith(".rdf"): return "xml"
    if p.endswith(".jsonld"): return "json-ld"
    return "turtle"

def extract_shacl_results(report: Graph, severity: str = "Violation") -> Tuple[Set[str], Set[Tuple[str, str]]]:
    #get invalid nodes and (node, path) links from SHACL report
    invalid_nodes: Set[str] = set()
    invalid_links: Set[Tuple[str, str]] = set()
    sev = severity.upper()
    valid = {"VIOLATION", "WARNING", "INFO", "ALL"}
    if sev not in valid:
        sev = "VIOLATION"

    for res in report.subjects(RDF.type, SH.ValidationResult):
        res_sev = report.value(res, SH.resultSeverity)
        if sev != "ALL":
            target = getattr(SH, sev.capitalize())
            if res_sev is None or str(res_sev) != str(target):
                continue
        focus = report.value(res, SH.focusNode)
        if focus is not None:
            invalid_nodes.add(str(focus))
            path = report.value(res, SH.resultPath)
            if path is not None:
                invalid_links.add((str(focus), str(path)))
    return invalid_nodes, invalid_links

def hash_triple(s, p, o, graph):
    def to_str(term):
        if isinstance(term, BNode):
            neighbors = list(graph.predicate_objects(subject=term))
            sorted_repr = sorted([f"{pred.n3()}:{obj.n3()}" for pred, obj in neighbors])
            neighbor_str = "|".join(sorted_repr)
            return f"_:{hashlib.sha256(neighbor_str.encode()).hexdigest()[:10]}"
        return term.n3()
    triple_str = f"{to_str(s)} {p.n3()} {to_str(o)}"
    return hashlib.sha256(triple_str.encode()).hexdigest()

def get_label(term):
    if isinstance(term, URIRef):
        return term.split("/")[-1].split("#")[-1]
    elif isinstance(term, Literal):
        return str(term)
    elif isinstance(term, BNode):
        return "_:bnode"
    return str(term)

def single_id(term, graph):
    if isinstance(term, BNode):
        neighbors = list(graph.predicate_objects(subject=term))
        sorted_repr = sorted([f"{pred.n3()}:{obj.n3()}" for pred, obj in neighbors])
        neighbor_str = "|".join(sorted_repr)
        return f"_:{hashlib.sha256(neighbor_str.encode()).hexdigest()[:10]}"
    return str(term)

def _ensure_dir(path: str):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

def _append_metrics_csv(row: Dict[str, object], csv_path: str):
    header = [
        "label", "graph_path", "validation_path",
        "severity_used", "triples", "json_nodes", "json_links",
        "invalid_nodes_reported", "invalid_links_reported",
        "nodes_marked_invalid", "links_marked_invalid",
        "inferred_nodes", "inferred_links", "pct_inferred_links",
        "peak_mem_mb", "time_s"
    ]
    _ensure_dir(csv_path)
    write_header = not os.path.exists(csv_path)
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        if write_header:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in header})

def get_invalid_nodes(graph):
    nodes, _ = extract_shacl_results(graph, severity=os.getenv("SHACL_SEVERITY", "Violation"))
    print("Extracting invalid nodes...", flush=True)
    return nodes

def get_invalid_links(graph):
    _, links = extract_shacl_results(graph, severity=os.getenv("SHACL_SEVERITY", "Violation"))
    return links

def compute(graph_path: str,
           validation_path: str,
           output_path: str,
           original_graph_paths: Optional[list] = None,
           label: Optional[str] = None):

    t0 = time.perf_counter()
    tracemalloc.start()

    severity_used = os.getenv("SHACL_SEVERITY", "Violation")

    data_graph = Graph().parse(graph_path, format=guess_format(graph_path))
    print("Graph loaded.")
    validation_graph = Graph().parse(validation_path, format=guess_format(validation_path))
    print("Validation graph parsed.", flush=True)

    # original graph triples & terms
    orig_hashes: Set[str] = set()
    orig_terms: Set = set()
    if original_graph_paths:
        g_orig = Graph()
        for p in original_graph_paths:
            g_orig.parse(p, format=guess_format(p))
        orig_hashes = {hash_triple(s, p, o, g_orig) for s, p, o in g_orig}
        orig_terms = set(g_orig.subjects()) | set(g_orig.objects())

    invalid_nodes_report, invalid_links_report = extract_shacl_results(validation_graph, severity_used)
    print(f"Invalid nodes (report): {len(invalid_nodes_report)}, Invalid links (report): {len(invalid_links_report)}", flush=True)

    nodes = {}
    links = []
    node_cache = {}

    nodes_marked_invalid = 0
    links_marked_invalid = 0
    inferred_nodes_cnt = 0
    inferred_links_cnt = 0

    def check_node(term):
        nonlocal nodes_marked_invalid, inferred_nodes_cnt
        if term in node_cache:
            return node_cache[term]
        node_id = single_id(term, data_graph)
        label = get_label(term)
        is_inferred_node = bool(original_graph_paths) and (term not in orig_terms)
        if is_inferred_node:
            inferred_nodes_cnt += 1
        is_invalid_node = (str(term) in invalid_nodes_report)
        if is_invalid_node:
            nodes_marked_invalid += 1
        nodes[node_id] = {
            "id": node_id,
            "label": label,
            "type": (
                "BNode" if isinstance(term, BNode)
                else "Literal" if isinstance(term, Literal)
                else "URI"
            ),
            "status": "invalid" if is_invalid_node else "valid",
            "inferred": is_inferred_node
        }
        node_cache[term] = node_id
        return node_id

    triples_seen = 0
    for s, p, o in data_graph:
        triples_seen += 1
        if triples_seen % 100000 == 0:
            print(f"Processed {triples_seen} triples...")

        h = hash_triple(s, p, o, data_graph)
        inferred_link = bool(orig_hashes) and (h not in orig_hashes)
        if inferred_link:
            inferred_links_cnt += 1

        sid = check_node(s)
        oid = check_node(o)

        is_invalid_link = ((str(s), str(p)) in invalid_links_report)
        if is_invalid_link:
            links_marked_invalid += 1

        links.append({
            "subject": sid,
            "object": oid,
            "predicate": str(p),
            "inferred": inferred_link,
            "status": "invalid" if is_invalid_link else "valid"
        })

    result = {
        "nodes": list(nodes.values()),
        "links": links
    }
    _ensure_dir(output_path)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"Saved JSON to {output_path}")

    tracemalloc.stop()
    elapsed = time.perf_counter() - t0

    print(f"Done in {elapsed:.2f} seconds")

if __name__ == "__main__":
    compute(
        graph_path="/Users/zhoujy/PycharmProjects/Visu of Reasoning on Validation/data/base.ttl",
        validation_path="/Users/zhoujy/PycharmProjects/Visu of Reasoning on Validation/validation_report/validation_report_before.ttl",
        output_path="/Users/zhoujy/PycharmProjects/Visu of Reasoning on Validation/comparison_result/before_graph.json",
        label="before_none"
    )
    compute(
        graph_path="/Users/zhoujy/PycharmProjects/Visu of Reasoning on Validation/rdfdata_entailed.ttl",
        validation_path="/Users/zhoujy/PycharmProjects/Visu of Reasoning on Validation/validation_report/validation_report_after.ttl",
        output_path="/Users/zhoujy/PycharmProjects/Visu of Reasoning on Validation/comparison_result/after_graph.json",
        original_graph_paths=["/Users/zhoujy/PycharmProjects/Visu of Reasoning on Validation/data/base.ttl"],
        label="after_entailed"
    )
