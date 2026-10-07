# Open-source release checklist

Inedia is designed to be local-first, but a public release must be scrubbed at
two levels:

1. The checkout must contain only synthetic profiles, fixtures, URLs, and
   application examples.
2. Git history must also be scrubbed. Removing a file in a later commit does
   not remove it from earlier commits.

Before pushing a public remote:

- Replace names, email addresses, phone numbers, addresses, schools, employers,
  resume filenames, profile URLs, and exact job/application URLs.
- Remove databases, resumes, browser profiles, screenshots, saved HTML,
  daily-run artifacts, career-preparation notes, and pasted diagnostics.
- Move eligibility rules, graduation dates, company holds, and other search
  preferences into ignored private configuration.
- Use synthetic names such as Test User, Example University, and example.test
  in tests.
- Run a repository-wide secret/PII scanner against every commit.
- Rewrite history containing private material, then force-push only to a new
  public remote after reviewing the rewritten clone.
