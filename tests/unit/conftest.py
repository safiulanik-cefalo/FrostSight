import shutil
import subprocess

import pytest


def _java_ok() -> bool:
    if not shutil.which("java"):
        return False
    return subprocess.run(["java", "-version"], capture_output=True).returncode == 0


@pytest.fixture(scope="session")
def spark():
    """Local Spark for the Spark twins of the pure functions; skipped where no Java runtime is installed."""
    if not _java_ok():
        pytest.skip("no Java runtime: Spark twins are checked against the pure functions in the workspace")
    from pyspark.sql import SparkSession

    s = SparkSession.builder.master("local[1]").config("spark.sql.session.timeZone", "UTC").getOrCreate()
    yield s
    s.stop()
