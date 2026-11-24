---
name: diagnose
description: Walk the user through a guided diagnosis session for a car symptom, one check at a time, using the garage's diagnosis tools (MCP start_diagnosis / record_check_result / skip_step / finish_diagnosis) or the app's Diagnose screen. Use when the user says "help me figure out why ...", "walk me through ...", "diagnose ...".
---

# Guided diagnosis

Needs the garage MCP connector in this Claude Code (`/mcp` shows `garage`); if it isn't set up, send them to the app
(car page -> **Diagnose**) or set it up (setup-garage, part 7).

1. Say once: **"Not professional advice. This information comes from AI and online research, not a certified
   mechanic. Verify before acting, follow safety precautions, and do all work at your own risk."**
2. `list_diagnoses` (car) to resume an open session; otherwise `start_diagnosis(car, symptom)` with their words.
   - `needs_plan`: offer the available plans. If none fits, offer (a) researching the symptom and writing a plan
     (research-car, round 6), or (b) with their OK, `start_diagnosis(..., generate: true)`: the garage AI writes one in
     1-3 minutes, marked "AI-generated, check before trusting". Say that out loud when using it.
3. **One step at a time.** For each step show, in this order: the **safety notes first** (never skip or shorten them),
   what to do, what to look for, tools and time, then the answer options as a short numbered list. Then stop and
   wait for what they found.
4. Record it with `record_check_result(session, result, notes?, mileage?)` (their words or the option number are
   fine). Tell them what it means using the tool's reply (ruled out / more likely / found) - don't add conclusions
   beyond the plan. "Can't do that now" -> `skip_step`. To change an earlier answer, pass `step`.
5. If a step says to stop driving the car or the result sounds dangerous (brakes, steering, fuel smell, smoke,
   overheating into the red), say so plainly before anything else.
6. When it's found (or they're done): `finish_diagnosis(session)` writes the summary to the car's history and notes
   related to-dos. It proposes a fix to-do with parts: **ask** before `finish_diagnosis(session, create_fix_todo: true)`.
7. Offer next steps: parts (`get_parts`, `get_alternates`, `add_shopping_item`), a guide (`get_guides`), or the shop.
