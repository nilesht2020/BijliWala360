---
name: phase-docs-update
description: Keep Bijli Wala's design docs in sync after finishing a feature or phase - DEVELOPMENT_PLAN progress and delivery notes, SRS acceptance-criteria status and traceability, API.md, DATABASE.md and TEST_PLAN traceability - checked against the requirement document "docs/bijli wala .docx". Use when a phase/module is completed, when asked to "update the docs/plan/progress", or when the requirement document changes.
---

# Phase docs update

`docs/bijli wala .docx` is the **primary requirement document**. `docs/SRS.md` v2 maps it onto the code. Never contradict the .docx silently. If the code deliberately differs (the stack, for example), record the reason in SRS §2.3 or ARCHITECTURE §10 (T-xx).

## Reading the .docx
It is binary, and is often open in Word (`docs/~$jli wala .docx` is the lock file; never commit it). Extract the text with:
```bash
python -c "import zipfile,re,sys;x=zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf8');[print(''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>',p))) for p in re.findall(r'<w:p[ >].*?</w:p>',x,re.S)]" "docs/bijli wala .docx" > "$TMPDIR/bijli-docx.txt"
```
Then read the text file with the Read tool. It is about 1,200 lines, sections §1–§19.

## What to update
| File | What changes |
|---|---|
| `docs/DEVELOPMENT_PLAN.md` | Set the **Progress** table row to `✅ Done (YYYY-MM-DD)` and mark the next phase `⏭ Next`. Add a "Phase N delivery notes" section: what was built, deviations, and follow-ups. Update the **Gap analysis** table. |
| `docs/SRS.md` | §19.3 acceptance criteria status (AC-01…AC-23). §20.1 traceability status column. §20.2 open items once decided. Add or adjust FR rows only when behaviour changed. |
| `docs/API.md` | Endpoints in §4.x, permission catalogue §2, error codes §3. Bump the header version. |
| `docs/DATABASE.md` | Collection fields and indexes, and §13/§15.7 transaction boundaries. |
| `docs/ARCHITECTURE.md` | Only for new mechanisms or decisions (§6, §11, T-xx table). |
| `docs/TEST_PLAN.md` | Scenario IDs for new tests, and the §3A acceptance coverage table. |
| `README.md` | Only when commands, setup or env vars change. |

## Rules
- **Section numbers and FR/BR/AC IDs are stable.** Code comments cite them (for example `SRS §10.3`, `ARCHITECTURE §6.3`, `DATABASE §13`). Append new sections instead of renumbering. Check before moving anything: `grep -rn "SRS §\|ARCHITECTURE §\|DATABASE §" apps packages`.
- Write absolute dates (`2026-11-18`), never "today" or "last week".
- Status words: `Built`, `Partial` (say what is missing), `Phase N`, `New`.
- Use the product name **Bijli Wala**. "SkillConnect" may appear only in the notes that record the rename.
- Keep doc edits in the same change as the code they describe.
- **Shell gotcha:** heredocs that contain backticks break in this Bash tool. Write long additions to a scratch file with the Write tool and append with `cat`, or use the Edit tool.
