from jobscan.adapters.jobright import _role_from_real_jd


def test_role_from_real_jd_uses_the_real_postings_own_first_line():
    # detail_fetch._assemble() always puts the real ATS title as the first
    # line of the JD text it returns -- jobright's own email/card title is
    # often a paraphrase or reordering of it (Tencent, 2026-09-24: card said
    # "Site Reliability Engineer - SRE Intern — AI Infrastructure", the real
    # posting's own title was "Site Reliability Engineer (SRE) Intern — AI
    # Infrastructure"). Prefer the real title whenever the real JD was read.
    desc = "Site Reliability Engineer (SRE) Intern — AI Infrastructure\nLocation: Palo Alto, CA\nPosted: 2026-09-20\nBody text here."
    assert _role_from_real_jd(desc, card_role="Site Reliability Engineer - SRE Intern") \
        == "Site Reliability Engineer (SRE) Intern — AI Infrastructure"


def test_role_from_real_jd_falls_back_to_card_role_when_description_is_empty():
    assert _role_from_real_jd("", card_role="Firmware Engineer Intern") == "Firmware Engineer Intern"


def test_role_from_real_jd_falls_back_to_card_role_when_first_line_is_blank():
    assert _role_from_real_jd("\nLocation: Austin, TX\nBody.", card_role="Firmware Engineer Intern") \
        == "Firmware Engineer Intern"


def test_role_from_real_jd_rejects_cookie_and_nav_chrome_as_a_title():
    # A handful of ATS pages (2026-09-26 batch: SPX Technologies, ESCO
    # Automation, Karma Automotive, Amazon, Adobe) rendered a cookie banner
    # or nav chrome as the extracted page text instead of the real JD, so
    # the "first line" was junk like "Skip to main content" or "Privacy
    # Policy" -- trusting it as a title wrongly failed RELEVANT and dropped
    # otherwise-good roles. Reject known boilerplate and fall back to
    # card_role instead.
    for junk in [
        "Skip to main content\nMore text.",
        "Skip to Main Content\nMore text.",
        "Privacy Policy\nMore text.",
        "By continuing to use and navigate this website, you are agreeing "
        "to the use of cookies.\nMore text.",
        "Terms of Use\nMore text.",
    ]:
        assert _role_from_real_jd(junk, card_role="Firmware Engineer Intern") \
            == "Firmware Engineer Intern", junk
