import json, os, time
from dataclasses import dataclass
from typing import Dict, Set
from collections import defaultdict
from rdflib import Graph
from rdflib.namespace import RDF

@dataclass
class DataObject:
    class_map: Dict[str, Set[str]]  # node IRI -> set of class IRIs
    node_map: Dict[str, dict]       # node IRI -> label, status, type
    graph: Graph                    # full RDF graph

def build_data_object(rdf_path: str, json_path: str) -> DataObject:
    g = Graph()
    g.parse(rdf_path, format="nt" if rdf_path.endswith(".nt") else "turtle")

    class_map = defaultdict(set)
    for s, p, o in g.triples((None, RDF.type, None)):
        class_map[str(s)].add(str(o))

    with open(json_path, "r", encoding="utf-8") as f:
        json_data = json.load(f)

    node_map = {}
    for node in json_data["nodes"]:
        node_map[node["id"]] = {
            "label": node.get("label"),
            "status": node.get("status"),
            "type": node.get("type")
        }

    return DataObject(class_map=class_map, node_map=node_map, graph=g)

def get_short_name(uri: str) -> str:
    if "#" in uri:
        return uri.split("#")[-1]
    return uri.rstrip("/").split("/")[-1]

def grouping(data_obj: DataObject, json_data: dict):
    status_map = {node_id: data.get("status") for node_id, data in data_obj.node_map.items()}
    class_grouped = defaultdict(lambda: {"nodes": [], "links": []})

    valid_nodes = set()
    invalid_nodes = set()
    inferred_nodes = set()
    valid_links = []
    invalid_links = []
    inferred_links = []

    # Group nodes per class
    for node_id, data in data_obj.node_map.items():
        node_info = {
            "id": node_id,
            "label": data.get("label"),
            "type": data.get("type"),
            "status": data.get("status", "unknown"),
            "inferred": data.get("inferred", False)
        }
        classes = data_obj.class_map.get(node_id, {"Unknown"})
        for full_class in classes:
            class_name = get_short_name(full_class)
            class_grouped[class_name]["nodes"].append(node_info)

        if data.get("status") == "valid":
            valid_nodes.add(node_id)
        else:
            invalid_nodes.add(node_id)

        if data.get("inferred", False):
            inferred_nodes.add(node_id)

    # Group links per class
    for link in json_data["links"]:
        subj, obj = link["subject"], link["object"]
        subj_status = status_map.get(subj, "unknown")
        obj_status = status_map.get(obj, "unknown")
        is_inferred = link.get("inferred", False)


        link_clean = {
            "subject": subj,
            "predicate": link["predicate"],
            "object": obj,
            "status": link.get("status", "unknown"),
            "inferred": link.get("inferred", False)
        }
        # Union of classes of subject and object
        related_classes = data_obj.class_map.get(subj, set()) | data_obj.class_map.get(obj, set())
        if not related_classes:
            related_classes = {"Unknown"}

        for full_class in related_classes:
            class_name = get_short_name(full_class)
            class_grouped[class_name]["links"].append(link_clean)

        # check validity/inference
        if is_inferred:
            inferred_links.append(link)
        elif subj_status == "valid" and obj_status == "valid":
            valid_links.append(link)
        else:
            invalid_links.append(link)


    validity_index = {
        "valid_nodes": sorted(valid_nodes),
        "invalid_nodes": sorted(invalid_nodes),
        "inferred_nodes": sorted(inferred_nodes),
        "valid_links": valid_links,
        "invalid_links": invalid_links,
        "inferred_links": inferred_links
    }

    return class_grouped, validity_index

def _ensure_dir(p):
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)

def save_all(class_grouped: Dict[str, dict], validity_index: Dict,
             output_path="../comparison_result/grouped_by_class.json",
             index_path="../comparison_result/class_index.json",
             validity_path="../comparison_result/validity_index.json"):

    for p in (output_path, index_path, validity_path):
        _ensure_dir(p)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(class_grouped, f, indent=2, ensure_ascii=False)
    print(f"Saved grouped data to: {output_path}")

    class_list = sorted(class_grouped.keys())
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(class_list, f, indent=2, ensure_ascii=False)
    print(f"Saved class index to: {index_path}")

    with open(validity_path, "w", encoding="utf-8") as f:
        json.dump(validity_index, f, indent=2, ensure_ascii=False)
    print(f"Saved validity index to: {validity_path}")


if __name__ == "__main__":
    start = time.time()
    rdf_path = "rdfdata_entailed.ttl"
    json_path = "../comparison_result/after_graph.json"

    data_obj = build_data_object(rdf_path, json_path)
    print("Data object built successfully.")

    with open(json_path, "r", encoding="utf-8") as f:
        json_data = json.load(f)
    class_grouped, validity_index = grouping(data_obj, json_data)
    print("Grouping nodes and links by class.")

    save_all(
        class_grouped,
        validity_index,
        output_path="../comparison_result/grouped_by_class.json",
        index_path="../comparison_result/class_index.json",
        validity_path="../comparison_result/validity_index.json"
    )
    print("Grouping completed.")

    end = time.time()
    print(f"Total Time taken: {end - start:.2f} seconds")
    print(f"Total Number of classes: {len(class_grouped)}")
