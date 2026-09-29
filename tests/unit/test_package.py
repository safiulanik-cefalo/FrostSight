import collector
import frostsight


def test_packages_import():
    assert frostsight.__version__ == "0.1.0"
    assert collector.__doc__
