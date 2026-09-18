"""Local profile provider.

Copy ``profile_data_private.py.example`` to ``profile_data_private.py`` and
customize it for local use.  The private file is ignored by Git.
"""
import json
import os

ACTIVE_PROFILE_PATH = os.path.join(os.path.dirname(__file__), "resumes", "active_profile.json")
GRAD_DATE_BY_TYPE = {"Entry": "05/2027", "Intern": "12/2027"}

STATIC_PROFILE = {
    "version": 1, "personal": {"firstName": "", "middleName": "", "lastName": "", "email": "", "phone": "", "address": "", "addressLine2": "", "city": "", "county": "", "country": "", "state": "", "zip": "", "phoneType": "", "phoneCountryCode": ""},
    "workAuthorization": {"authorizedToWork": "", "requiresSponsorship": "", "plansToUseOPT": "", "usPerson": "", "restrictedCountryStatus": ""},
    "jobPreferences": {"availableStartDate": "", "atLeast18": "", "minimumSalary": "", "compensationMax": "", "usCitizen": "", "securityClearance": "", "willingToRelocate": "", "willingToWorkOnsite": "", "canCommitInternshipTerm": ""},
    "professional": {"hasNonCompeteAgreement": "", "everTerminated": "", "highestEducation": "", "skills": ""},
    "disclosures": {"hispanicOrLatino": "", "gender": "", "raceEthnicity": "", "veteranStatus": "", "disabilityStatus": ""},
    "links": {"linkedin": "", "portfolio": "", "github": ""}, "workHistory": [], "education": [], "overrides": {},
}

try:
    from profile_data_private import STATIC_PROFILE as PRIVATE_PROFILE
except ImportError:
    PRIVATE_PROFILE = None

def _load_active_profile(path):
    if not os.path.exists(path): return {}
    with open(path) as f: return json.load(f)

def build_profile(path=ACTIVE_PROFILE_PATH):
    active = _load_active_profile(path)
    profile = json.loads(json.dumps(PRIVATE_PROFILE or STATIC_PROFILE))
    role_type = active.get("role_type", "Entry")
    if active.get("resume_name") and active.get("resume_data_url"):
        profile["resume"] = {"name": active["resume_name"], "type": "application/pdf", "dataUrl": active["resume_data_url"]}
    else: profile["resume"] = None
    if active.get("skills"): profile["professional"]["skills"] = active["skills"]
    if active.get("work_history"): profile["workHistory"] = active["work_history"]
    profile["profileLabel"] = active.get("role_label") or ""
    profile["education"] = profile.get("education", [])
    return profile

def set_active_profile(role_type, resume_name, resume_data_url, skills=None, work_history=None, role_label=None, grad_date=None, target_profile_name=None, path=ACTIVE_PROFILE_PATH):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump({"role_type": role_type, "resume_name": resume_name, "resume_data_url": resume_data_url, "skills": skills, "work_history": work_history, "role_label": role_label, "grad_date": grad_date, "target_profile_name": target_profile_name}, f)
