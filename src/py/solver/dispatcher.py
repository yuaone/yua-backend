# 🔒 Solver Dispatcher (SSOT)

from typing import Dict, Any, Tuple
from .registry import SOLVER_REGISTRY

def _resolve_solver(name: str):
    entry = SOLVER_REGISTRY[name]
    if entry["solver"] is None:
        entry["solver"] = entry["factory"]()
    return entry["solver"]

def dispatch(query: str, options: Dict[str, Any]) -> Tuple[str, callable]:
    q = query.strip().lower()

    # 1️⃣ domain explicit
    domain = (options or {}).get("domain")
    if domain:
        domain_key = str(domain).lower()
        if domain_key in SOLVER_REGISTRY:
            return domain_key, _resolve_solver(domain_key)

    # 2️⃣ keyword match
    for name, entry in SOLVER_REGISTRY.items():
        for kw in entry["keywords"]:
            if kw in q:
                return name, _resolve_solver(name)

    # 3️⃣ fallback
    return "math", _resolve_solver("math")
