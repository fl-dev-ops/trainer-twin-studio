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
