# Rebuilding the reading bank

Run with Python 3.12+ in a disposable work directory. Only the standard library is needed. Copy these scripts together into that directory, then run:

1. `python download.py` — download supporting data and initial dictionary snapshot.
2. `python refresh_sources.py` — retrieve current JMdict/KANJIDIC2 from their publisher. Check that both updates succeed; do not silently publish an outdated fallback. The publisher's documented public distribution endpoint uses HTTP; downloaded hashes and source URLs are recorded in `sources-downloaded.json`.
3. `python probe.py` — extract unambiguous, restricted reading/spelling pairs.
4. Set `KANJI_BANK_OUTPUT` to a separate staged bank directory, then run `python build_bank.py`. This checks allocations, character readings, six exact 2000-word counts and global uniqueness, and writes the manifest and data files.
5. Review the source changes and samples. Retain SOURCES.md and these tools in the published bank, update snapshot dates in the documentation, and rerun the quiz integration/browser tests against the staged data. Do not replace a live bank with an incomplete result. If a level falls below 2000 validated candidates, fail the build and investigate rather than fabricating readings.
6. Back up the private SQLite database with its online backup API. Deploy the staged bank files and run `quiz_server.py import-bank` as the dedicated quiz service account with its existing `QUIZ_DATA`. An import failure leaves the database transaction unchanged. Check the six totals in the host screen. No participant credentials or database files belong in GitHub.

`reference_levels.json` contains only factual character allocations transcribed from the official PDF and cross-checked with kyoh86/kanken. No third-party program is executed. The PDF itself is a source reference and is not parsed by this build. Sources and hashes are in the resulting manifest. Perform dictionary updates at least monthly, in accordance with EDRDG's published conditions.
