# Intake Desk

A small internal tool for a home health intake team. Referrals arrive as faxed PDFs. Claude reads each one into a structured record, and a YAML file decides what every role can see and change. Every view and every change is logged.

All patient data in this repo is made up.

## What it does

- **Reads referral faxes.** Drop a PDF and Claude fills in 19 fields. Each field comes with a confidence score and a short quote from the fax showing where the value came from.
- **Catches what intake teams chase.** Unsigned orders, missing member IDs, NPIs that fail the check digit, Medicare IDs in the wrong format, ICD-10 codes with a letter where a digit belongs, and a missing face-to-face date on a Medicare referral.
- **Sends shaky fields to a person.** If the AI isn't sure about a field, the referral can't become Ready until someone checks it.
- **Runs the queue.** Statuses go New → Missing info → Ready → Scheduled. Each referral has a next action and an owner.
- **Masks field by field, per role.** Intake, billing and clinicians see the same referrals with different fields masked or left out. The server enforces this, not the screen.
- **Logs everything.** Every view and change is logged, allowed or denied. The log stores field names, never values. Postgres refuses any edit to it.
- **Builds screens from plain English.** Type "show me Medicare referrals missing a signed order." Claude writes a view config. It is checked against the YAML and your role, then opens as a new screen.
- **Measures itself.** Twelve synthetic referrals come with an answer key. `npm run eval` reports accuracy for each field, whether flags were right, and how well the confidence threshold works.

## Run it

```bash
npm install
cp .env.example .env.local     # then add your ANTHROPIC_API_KEY
docker compose up -d           # Postgres on port 5433
npm run db:setup
npm run db:seed
npm run dev
```

Open http://localhost:3000 and pick a demo user.

**No Docker?** Leave `DATABASE_URL` empty in `.env.local`. The app runs on an in-memory store that seeds itself every time it starts.

**No API key?** Everything works except extraction and the view agent. Uploads are still saved, and they're flagged "Extraction failed".

## The 2-minute demo

Seeding loads referrals 01 to 09. Referrals 10, 11 and 12 in `data/referrals/` are kept back so you can upload them live.

1. **Queue (0:00).** Pick Priya (intake). Nine referrals are in the queue and six are stuck on missing info. Each row shows a next action, like "Request signed order from Paul Wexler, DO."
2. **Upload (0:15).** Drop `referral-10.pdf`, `referral-11.pdf` and `referral-12.pdf`.
   - Referral 10 should come out Ready.
   - Referral 11 has a blank signature line, so it gets flagged: "Request signed order from Leah Morrow, NP."
   - Open one to show each field's AI confidence and the quote it came from.
3. **Roles (0:45).** Switch to Marcus (billing). The home address and clinical summary are gone, and the phone is a redaction bar. "Open original fax" isn't offered, and the API returns 403 if he tries anyway. Switch to Dana (clinician): the member ID is masked to its last four characters, and the fax opens.
4. **Describe a view (1:10).** Back as Priya, click "Medicare referrals missing a signed order." The new screen opens with the YAML the agent wrote next to it. Referral 09 is unsigned too, but it isn't in the list: it's commercial insurance, not Medicare.
5. **Audit log (1:35).** Every view is logged, including Marcus's denied attempts. Entries show field names, never values.
6. **Evals (1:50).** In a terminal, run `npm run eval -- --only 10,11,12` and show the scorecard.

A good extra moment: open `config/intake.yaml`, change billing's `phone` access from `masked` to `hidden`, and refresh. The screen changes with no code change.

## How the YAML drives everything

`config/intake.yaml` is the single source of truth. For each field it sets:

| Key | What it controls |
| --- | --- |
| `type`, `values` | The extraction schema sent to Claude, the edit controls, and the operators allowed in views |
| `required`, `required_when` | "Missing" flags. Face-to-face date and homebound status are required only for traditional Medicare |
| `rules` | Checks: NPI check digit, Medicare ID format, ICD-10 shape, past dates, US phone numbers |
| `access` | `full`, `masked` or `hidden`, per role. PHI fields must list every role, or the app won't start |
| `edit` | Which roles may change the field |
| `mask` | How it's masked: initials, last four, birth year, or fully hidden |
| `extract` | The instruction Claude gets for this field |
| `compare` | How the evals grade it. Names ignore "Dr." and "MD", phones compare digits, and so on |

Further down the file, `flags`, `next_actions`, `statuses`, `workflow` and `view_agent.hints` set the rest of the behaviour.

## Where things live

- `src/lib/extract.ts` builds the JSON schema from the YAML. It sends the PDF to Claude with structured outputs (`output_config.format`) and uses `claude-sonnet-5-5`, falling back to `claude-haiku-4-5-20251001`. The SDK retries with backoff. Logs carry the referral number only.
- `src/lib/workflow.ts` works out flags, status and the next action.
- `src/lib/access.ts` does the masking. It is the only path referral data takes out of the server.
- `src/lib/service.ts` handles every action the same way: check the role, do the thing, write the audit entry.
- `src/lib/views.ts` holds the view agent, the checks on what it writes, and the filters.
- `src/lib/store-pg.ts` and `db/schema.sql` are the Postgres side:
  - JSONB with GIN indexes
  - a unique file hash, so the same fax uploaded twice opens the existing referral
  - a trigger that makes the audit log append-only
- `scripts/` holds the synthetic-data generator, the eval runner, and the database setup and seed scripts.

## Who sees what

| Field | Intake | Billing | Clinician |
| --- | --- | --- | --- |
| Home address | full | hidden | full |
| Phone | full | masked | full |
| Clinical summary | full | hidden | full |
| Member ID | full | full | masked to last 4 |
| Everything else | full | full | full |

Intake can do everything. Billing can edit the insurance fields only. Clinicians can read referrals and open the original fax. Only intake can read the audit log or schedule visits.

A few rules that matter:

- **Hidden means hidden.** Hidden fields are dropped on the server. They never reach the browser, not even in the page's data.
- **Quotes follow the fax.** Each quote is a slice of the original fax, so only roles allowed to open the fax see quotes.
- **No editing blind.** You can't edit a field you can only see masked.
- **Views can't leak.** A view can only filter on fields your role fully sees, and roles that can't run a view never see it. Otherwise "everyone whose notes mention a fall" would leak the notes to billing.
- **Ready can't be forced.** It's what's left once every flag is cleared.
- **No patient data in the schema.** The schema sent to Claude holds field names only. Anthropic's docs require this for HIPAA-eligible use of structured outputs. It also avoids nullable unions and optional properties, to stay inside the structured outputs limits.

## Evals

```bash
npm run eval                                       # all 12 referrals
npm run eval -- --only 10,11,12                    # just the live-demo ones
npm run eval -- --model claude-haiku-4-5-20251001  # compare models
npm run eval -- --out evals/results/sonnet.json    # save the full run
```

The report shows:

- accuracy for each field, with every miss listed
- precision and recall for each kind of flag
- how accurate the auto-accepted fields were compared with the ones sent to a person
- latency, and how often the fallback model was used

Each synthetic referral tests something specific:

| # | Layout | What it tests |
| --- | --- | --- |
| 01 | Discharge form | Clean Medicare referral, should be Ready |
| 02 | Physician order | Blank signature line |
| 03 | Letter | Clean Medicaid letter, seeded with a low-confidence address |
| 04 | Discharge form | No member ID |
| 05 | Physician order | Clean, seeded as already scheduled |
| 06 | Letter | Unsigned, and the face-to-face note "will follow" |
| 07 | Discharge form | NPI with a typo that fails the check digit |
| 08 | Physician order | ICD-10 code faxed as `NI8.4` (letter I for 1). It must be flagged, not quietly fixed |
| 09 | Letter | Unsigned, but commercial insurance, so a Medicare view should leave it out |
| 10 | Discharge form | Live upload, clean |
| 11 | Physician order | Live upload, unsigned Medicare order |
| 12 | Letter | Live upload, two-digit birth year, and the phone number is the daughter's |

`npm run referrals:generate` rebuilds the PDFs and `data/answer-key.json` from `scripts/fixtures.ts`. The output is byte-identical every time.

## Tests

```bash
npm test
```

There are 56 tests: masking per role, out-of-scope actions that must fail and get logged, workflow, uploads, views, sessions, config checks and eval scoring.

Six more run against real Postgres when `TEST_DATABASE_URL` points at a throwaway database. They wipe it, so never use your demo database for this. They cover the append-only audit log, two uploads of the same file at once, and SQL queries on flags.

```bash
docker compose exec db createdb -U intake intake_desk_test
TEST_DATABASE_URL=postgres://intake:intake@localhost:5433/intake_desk_test npm test
```

## Deploy

- **Cloud Run.** The `Dockerfile` is ready. Use Cloud SQL for Postgres and set `DATABASE_URL`, `ANTHROPIC_API_KEY`, `SESSION_SECRET` and `APP_TIMEZONE`.
- **Vercel.** Use a hosted Postgres such as Neon and set the same variables.

Either way, run `npm run db:setup` and `npm run db:seed` once against the new database.

## What a production version would add

- **Real sign-in.** The role switcher is for the demo. The session cookie is signed and the role always comes from the YAML, but production would use SSO.
- **HIPAA groundwork.** Business associate agreements with every vendor, plus retention rules and encryption-key management.
- **A full ICD-10 lookup.** Today's check is on the code's shape, so it catches `NI8.4` but not a well-formed code that doesn't exist.
- **Several documents per referral.** For example, an insurance card arriving after the referral.