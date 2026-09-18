def test_chrome_page_can_load_content(chrome_page):
    chrome_page.set_content("<h1 id='x'>hello</h1>")
    assert chrome_page.text_content("#x") == "hello"


def test_profile_dir_is_under_home():
    from jobscan.profile import PROFILE_DIR
    assert PROFILE_DIR.name == "chrome-profile"
    assert ".jobtracker" in str(PROFILE_DIR)
