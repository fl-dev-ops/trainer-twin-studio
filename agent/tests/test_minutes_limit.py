import pytest

from agent import seconds_until_end


def test_no_limit_without_ends_at():
    assert seconds_until_end({}, 1000.0) is None
    assert seconds_until_end({"ends_at": None}, 1000.0) is None
    assert seconds_until_end({"ends_at": "1600"}, 1000.0) is None
    assert seconds_until_end({"ends_at": True}, 1000.0) is None
    assert seconds_until_end({"ends_at": 0}, 1000.0) is None


def test_seconds_left_until_deadline():
    assert seconds_until_end({"ends_at": 1600}, 1000.0) == 600.0
    # deadline already passed: end right away
    assert seconds_until_end({"ends_at": 900}, 1000.0) == 0.0


def test_goodbye_comes_shortly_before_the_end():
    from agent import GOODBYE_LEAD_SECONDS, goodbye_delay

    assert goodbye_delay(600.0) == 600.0 - GOODBYE_LEAD_SECONDS
    # too short to fit a goodbye: just end at the limit
    assert goodbye_delay(GOODBYE_LEAD_SECONDS * 2) is None
    assert goodbye_delay(5.0) is None


def test_goodbye_is_the_clients_own_in_a_role_play():
    from agent import GOODBYE_LINE, ROLEPLAY_GOODBYE_LINE, goodbye_line

    assert goodbye_line({"agent_kind": "ROLEPLAY"}) == ROLEPLAY_GOODBYE_LINE
    assert goodbye_line({"agent_kind": "TWIN"}) == GOODBYE_LINE
    assert goodbye_line({}) == GOODBYE_LINE
    assert "minute" not in ROLEPLAY_GOODBYE_LINE.lower()


@pytest.mark.parametrize("ends_at", [-1, False, [], {}, "", None])
def test_invalid_deadlines_do_not_meter_studio_calls(ends_at):
    assert seconds_until_end({"ends_at": ends_at}, 1000.0) is None


def test_fractional_deadlines_keep_subsecond_precision_and_expire_at_zero():
    assert seconds_until_end({"ends_at": 1000.75}, 1000.25) == 0.5
    assert seconds_until_end({"ends_at": 1000.75}, 1000.75) == 0.0


def test_goodbye_threshold_is_strict_and_always_leaves_the_lead_time():
    from agent import GOODBYE_LEAD_SECONDS, goodbye_delay

    threshold = GOODBYE_LEAD_SECONDS * 2
    assert goodbye_delay(threshold - 0.1) is None
    assert goodbye_delay(threshold) is None
    delay = goodbye_delay(threshold + 0.1)
    assert delay is not None
    assert delay + GOODBYE_LEAD_SECONDS == pytest.approx(threshold + 0.1)
    assert goodbye_delay(0) is None
    assert goodbye_delay(-1) is None


@pytest.mark.parametrize("kind", [None, "", "UNKNOWN", "roleplay"])
def test_unknown_agent_kinds_use_the_twin_goodbye(kind):
    from agent import GOODBYE_LINE, goodbye_line

    assert goodbye_line({"agent_kind": kind}) == GOODBYE_LINE
