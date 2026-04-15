# 🔒 Solver Bootstrap (SSOT)
# - solver는 여기서만 등록
# - lazy import 안전하게 수행

from .registry import register_solver

def _lazy_math():
    from .math import solve_math
    return solve_math

def _lazy_physics():
    from .physics import solve_physics
    return solve_physics

def _lazy_chemistry():
    from .chemistry import solve_chemistry
    return solve_chemistry

def _lazy_statistics():
    from .stats_solver import solve_statistics
    return solve_statistics

register_solver("math", _lazy_math, ["=", "solve", "diff", "integrate"])
register_solver("physics", _lazy_physics, ["force", "energy", "velocity", "물리"])
register_solver("chemistry", _lazy_chemistry, ["reaction", "mole", "화학", "->"])
register_solver("statistics", _lazy_statistics, ["mean", "variance", "probability", "통계"])
