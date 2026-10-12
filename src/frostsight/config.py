"""Load config/*.yml: from --config-dir in a job (the bundle syncs config/), else the repo's config/."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

REPO_CONFIG = Path(__file__).resolve().parents[2] / "config"


def load_yaml(name: str, explicit_dir: str | None = None) -> dict[str, Any]:
    base = Path(explicit_dir) if explicit_dir else REPO_CONFIG
    return yaml.safe_load((base / name).read_text())


def risk_config(explicit_dir: str | None = None) -> dict[str, Any]:
    cfg = load_yaml("risk_weights.yml", explicit_dir)
    total = sum(cfg["weights"].values())
    if abs(total - 1.0) > 1e-6:
        raise ValueError(f"risk weights must sum to 1.0, got {total}")
    for k, pts in cfg["breakpoints"].items():
        xs = [p[0] for p in pts]
        if xs != sorted(xs):
            raise ValueError(f"breakpoints for {k} must be sorted by x")
    lv = cfg["levels"]
    if not (0.0 < lv["MEDIUM"] < lv["HIGH"] < lv["VERY_HIGH"] <= 1.0):
        raise ValueError("levels must increase 0 < MEDIUM < HIGH < VERY_HIGH <= 1")
    inf = cfg["precipitation_inference"]
    if not inf["snow_max_air_c"] < inf["sleet_max_air_c"]:
        raise ValueError("precipitation_inference: snow_max_air_c must be below sleet_max_air_c")
    return cfg
