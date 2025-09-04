import rdflib
from rdflib import Graph
from owlrl import DeductiveClosure, RDFS_Semantics
from pyshacl.inference import CustomRDFSOWLRLSemantics
import time
import tracemalloc
import logging
import os
import traceback
import hashlib
import sys

# Logging
log_formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
file_handler = logging.FileHandler("reasoning_progress.log", mode='w', encoding='utf-8')
file_handler.setFormatter(log_formatter)
console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)
logging.basicConfig(level=logging.INFO, handlers=[file_handler, console_handler])

def format(file_path):
    ext = os.path.splitext(file_path)[1].lower()
    return {
        '.ttl': 'turtle',
        '.nt': 'nt',        # <-- fix
        '.rdf': 'xml',
        '.xml': 'xml',
        '.jsonld': 'json-ld',
        '.n3': 'n3',
    }.get(ext, 'turtle')

def _file_size_mb(path):
    try:
        return os.path.getsize(path) / (1024 * 1024)
    except Exception:
        return None

def _sha256(path):
    # using hashlib to compute the SHA-256 hash of a file
    try:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None

def run_entailment(rdf_file, output_file):
    py_ver = sys.version.split()[0]
    rdflib_ver = getattr(rdflib, "__version__", "")
    try:
        import pkg_resources
        owlrl_ver = pkg_resources.get_distribution("owlrl").version
    except Exception:
        owlrl_ver = ""
    try:
        import pkg_resources
        pyshacl_ver = pkg_resources.get_distribution("pyshacl").version
    except Exception:
        pyshacl_ver = ""

    logging.info(f"Environment: Python={py_ver}, rdflib={rdflib_ver}, owlrl={owlrl_ver}, pyshacl={pyshacl_ver}")

    start_time_total = time.perf_counter()
    tracemalloc.start()

    g = Graph()
    rdf_format = format(rdf_file)

    # input file info
    in_size = _file_size_mb(rdf_file)
    in_hash = _sha256(rdf_file)
    logging.info(f"Input file: {rdf_file} (format={rdf_format}, size={in_size:.2f} MB if known)")
    if in_hash:
        logging.info(f"Input sha256: {in_hash}")

    # analyze input file
    logging.info("Parsing RDF data ...")
    t0_parse = time.perf_counter()
    g.parse(rdf_file, format=rdf_format)
    parse_time = time.perf_counter() - t0_parse
    logging.info(f"Total triples before reasoning: {len(g)}")
    logging.info(f"Parse time: {parse_time:.2f} seconds")

    # if sample_n > 0, we will sample new triples
    sample_n = int(os.getenv("LOG_SAMPLE_NEW_TRIPLES", "0"))  # 默认不打印
    before_set = set(g) if sample_n > 0 else None

    try:
        semantics = CustomRDFSOWLRLSemantics
        engine_name = getattr(semantics, "__name__", str(semantics))
        logging.info(f"Starting RDFS reasoning ... (engine={engine_name})")

        t0_reason = time.perf_counter()
        triples_before = len(g)

        closure = DeductiveClosure(semantics)
        closure.expand(g)

        reason_time = time.perf_counter() - t0_reason
        triples_after = len(g)
        new_triples = triples_after - triples_before

        logging.info(f"Total triples after reasoning: {triples_after}")
        logging.info(f"New triples added: {new_triples}")
        logging.info(f"Reasoning time: {reason_time:.2f} seconds")
        if reason_time > 0:
            logging.info(f"Throughput: {new_triples / reason_time:.1f} triples/sec")

        if sample_n > 0 and before_set is not None:
            try:
                added = list(set(g) - before_set)
                logging.info(f"Sample of added triples (up to {sample_n}):")
                nm = g.namespace_manager
                for t in added[:sample_n]:
                    s, p, o = t
                    logging.info("  %s %s %s .", s.n3(nm), p.n3(nm), o.n3(nm))
            except Exception as _:
                logging.warning("Sampling added triples failed (ignored).")

    except Exception as e:
        logging.error(f"Error: {e}")
        logging.error(traceback.format_exc())

    finally:
        logging.info(f"Saving entailed graph to {output_file} ...")
        t0_ser = time.perf_counter()
        g.serialize(destination=output_file, format="turtle")
        serialize_time = time.perf_counter() - t0_ser
        logging.info("Saving complete.")
        out_size = _file_size_mb(output_file)
        logging.info(f"Serialize time: {serialize_time:.2f} seconds")
        if out_size is not None:
            logging.info(f"Output file size: {out_size:.2f} MB")
            out_hash = _sha256(output_file)
            if out_hash:
                logging.info(f"Output sha256: {out_hash}")

        current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        logging.info(f"Peak memory usage: {peak / 10**6:.2f} MB")
        total_time = time.perf_counter() - start_time_total
        logging.info(f"Total time: {total_time:.2f} seconds")

if __name__ == "__main__":
    rdf_file = "data/base.ttl"
    output_file = "rdfdata_entailed.ttl"
    run_entailment(rdf_file, output_file)
