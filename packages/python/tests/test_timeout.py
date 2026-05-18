from codespar import CodeSparError
from codespar import TimeoutError as CsTimeoutError


def test_timeout_error_is_codespar_error() -> None:
    e = CsTimeoutError("slow")
    assert isinstance(e, CodeSparError)
    assert str(e) == "slow"
