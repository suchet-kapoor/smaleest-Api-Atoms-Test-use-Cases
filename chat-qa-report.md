# Smallest Atoms trial: evidence notes and next steps

This is a working analysis of the six pasted call-record summaries and the candidate trial brief. It is not a submitted QA report. Treat generated post-call summaries as leads; confirm findings against the transcript/recording and a repeatable test before reporting a defect.

## Brief and constraints captured from the trial page

- Focus on one area and engineering behavior (does it match docs, fail clearly, and recover), not voice/LLM quality.
- The allowed scope includes Atoms: agent setup, call quality, turn taking, and call visibility.
- No load/stress tests; at most about five requests at once. Use only the candidate's own account/data. No security scanning or penetration testing.
- The browser voice route avoids renting a number. Trial balance shown on the page was $7.51 on 18 Nov 2026; do not rent a number.
- The report asks for scope/reason, method, findings with expected/observed/evidence/customer impact/severity, what works, top three fixes, and time spent. Deadline shown: Friday 20 Nov 2026, 3:58 pm IST.

## Pasted call-record facts

Six records were in the JSON export: five `isTest: true` outbound telephony calls and one `isTest: false` browser `webcall`. All show `status: completed`, a version 4 / main branch / revision 3, and the same agent ID. Combined reported cost is $6.233; the five marked test calls total $5.985. These are the costs recorded in this export; reconcile against the account usage page before using them in a report.

| Record | Type | Duration | Turns | Avg turn latency | Max turn latency | End reason | Summary lead |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `…42a05e` | webcall, not test | 1:58 | 5 | 1.924 s | 3.396 s | user hangup | Fragmented exchange; no clear request or outcome |
| `…102063` | outbound, test | 1:47 | 1 | 1.444 s | 1.444 s | agent hangup | Repeated wellbeing question; brief greeting; agent ended |
| `…191b5d` | outbound, test | 5:18 | 10 | 1.601 s | 2.436 s | user hangup | Agent described supportive listening and next steps |
| `…fa0afc` | outbound, test | 6:42 | 25 | 1.477 s | 1.860 s | user hangup | Crisis content; summary says agent offered emergency guidance |
| `…e24102` | outbound, test | 14:51 | 48 | 1.641 s | 3.684 s | timeout | Career/employment conversation; no concrete outcome; timeout |
| `…42776a` | outbound, test | 14:58 | 54 | 1.526 s | 3.908 s | timeout | Self-harm disclosure followed by safety response and topic change; timeout |

Across these records there are 143 turns. Mean of the six *per-call average* latency values is about 1.60 s; median is about 1.56 s. The largest per-call max-turn latency is 3.908 s. This is a small, mixed sample, not an SLO or a statistically meaningful reliability result. Two calls ended at roughly 15 minutes with `timeout`; compare that with the product's documented call limit and whether a warning/clear reason is shown before treating it as a defect.

## Strongest lead to investigate

The agent is named **“personal mental well being Agent”**, while its exported description says it is for **life-insurance death-claim intake**. The test call summaries also describe wellbeing conversations. This is a concrete configuration/metadata mismatch in the provided export, but impact and customer visibility are not yet established. Check the dashboard agent card, published version, and call details to determine whether the description is stale, the wrong agent was used, or the product displays inconsistent metadata. If it is only test metadata, report it only if the task scope and customer impact are clear.

## Other leads, not yet findings

1. **Silence / low-engagement handling:** one 1-turn test call reportedly repeated a general “how are you feeling” question and then ended. Listen to the recording/read the transcript: did the agent give a clear opening, ask one specific low-friction question, explain how to end, and close politely? Repeat with a scripted greeting-only caller. Measure turns, elapsed time to end, and end reason.
2. **Timeout clarity and recovery:** two calls ran 14:51 and 14:58 and ended with `timeout`. Check docs/UI for max duration, whether a pre-timeout warning is expected, whether the UI says the call ended, and whether the call record/transcript is available afterward. Do not use artificial long calls until the remaining trial budget and purpose justify the spend.
3. **Post-call visibility:** all six summaries show empty `dispositionMetrics` and `successMetrics`, while the record has a summary. This may be expected because the exported agent configuration shows no disposition metrics configured. Confirm configuration and docs before raising this.
4. **Latency:** observed per-call averages were 1.444–1.924 s; max-turn values were up to 3.908 s. Establish a documented expectation and collect a few controlled browser calls before asserting a latency issue.

## Suggested focused scope

**Atoms browser-call lifecycle and customer-visible call records** — verify that the browser call starts, produces transcripts, ends with an understandable reason, and leaves a retrievable record. The export already includes one browser call and five telephony calls; keep additional runs in the browser to avoid number-rental charges and to align with the cookbook.

## Small, controlled method

1. Record the exact agent/version and UI state before a call. Keep timestamps in Asia/Calcutta.
2. Run up to three short browser calls (one normal conversation, one greeting/silence case, one explicit “end call” case). Do not run them concurrently.
3. For each, note whether the UI shows connecting/connected/ended, the `session_started` call ID, transcript arrival, disconnect reason, and whether the call appears in the dashboard. Save redacted request/call IDs and exact times.
4. Compare the results to the handbook and the API reference. Use `GET`/read-only operations for inspection. Avoid outbound calls, number rental, mutating live config, or any stress/security tests.
5. Inspect the two near-15-minute calls only if the recordings/transcripts are accessible and needed; otherwise note them as a hypothesis and do not spend more credit reproducing them.

## Evidence still needed before writing a finding

- Transcript/recording check for the agent's exact words and call ending behavior.
- Dashboard check for which description/version the customer actually sees.
- One or more repeat runs for any suspected reproducible behavior.
- Documentation or UI expectation for timeout, end reasons, and call-record availability.
- Current remaining credits after these calls; the pasted account snapshot is dated 18 Nov 2026.

## Analytics page snapshot (user-provided text, Nov 18, 2026)

This is a second, stronger lead for a focused report on **Analytics accuracy and decision support**. The screenshot/text says the selected date is Nov 18, 2026; record the page timezone as IST and verify that no filters were active.

### Directly visible values

- Daily summary: 13 total calls, 11 answered, 2 unanswered, 0 failed, 0 in progress; 84.6% pickup rate; 54m48s total duration; peak concurrency 2.
- Per-agent table lists 5 rows with call totals 7, 1, 5, 6, and 4 (sum = 23), which does not equal the summary's 13 total calls.
- Retry section says 1 unique number, max 5 attempts, average attempts to pickup 3.0, and recommended max attempts 1.
- Retry cohort rows show attempt 1: 0/1 answered; attempt 2: 0/1; attempts 3, 4, and 5: each 1/1 answered. Cumulative reach rises from 0% after attempts 1–2 to 100% at attempt 3, while the recommendation says stop after attempt 1 because marginal gain is under 2%.

### Candidate findings (verify first)

1. **Daily total and per-agent totals disagree.** If both widgets use the same Nov 18 date, filters, and call population, the per-agent rows sum to 23 while the headline says 13. This could mislead customer reporting and staffing/capacity decisions. Before reporting it, refresh once, confirm filter state, and compare the dashboard with a read-only call list/export for that date. Record whether test calls are included consistently.
2. **Retry recommendation conflicts with its own cohort data.** The displayed data says attempts 1 and 2 yielded no pickup, attempt 3 brought cumulative reach to 100%, and yet the recommendation is 1. The displayed “marginal gain below 2%” rationale also conflicts with the shown +100 percentage-point gain at attempt 3. With only one unique number, the recommendation may be statistically unreliable; at minimum the UI should communicate sample size and avoid presenting a misleading confident recommendation. Confirm whether the recommendation uses another period/filter or stale cached data before filing.

### How to make this report-ready

Capture the date, timezone, all filter selections, refresh time, the five visible per-agent counts, and the retry cohort rows. Then perform only read-only verification (refresh, switch away/back to the date, and compare the call list). If the arithmetic still conflicts, document the exact displayed numbers and customer impact; avoid a root-cause claim. Do not include phone numbers or names from account data. Use the retry issue as the primary finding if it reproduces; the total-count mismatch can be a second finding if confirmed.

Do not include phone numbers, API keys, access tokens, or raw recordings in a report or shared notes. The report form allows call IDs and timestamps; redact any request headers/secrets.
