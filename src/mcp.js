// Remote MCP server for the garage: Streamable HTTP, stateless JSON responses (POST /mcp).
// Auth happens before this handler (OAuthProvider): ctx.props = { member_id, name, client }.
// Every write is attributed to the member ("<name> via <client>") exactly like the web UI.
import { carFull, createCar, createService, decodeVin, dueList, garageOverview, upsertScheduleItem } from './api.js';
import { KINDS, WHENS, WHERES, createSymptom, createTodo, hoursNum, itemIdsByName, resolveCar, searchHistory, setHours, setMileage, updateTodo } from './ops.js';
import { BODY_TYPES, OFFROAD_NOTE, VEHICLE_TYPES, fluidsFor, isOffroad, noun, partsSources, usesHours } from './vehicle.js';
import { recallsFor } from './recalls.js';
import { HttpError, json, todayLocal } from './util.js';
import { jobsForCar, listQueued, saveManualReport } from './research-jobs.js';
import { saveResearchBundle } from './research-bundle.js';
import { DISCLAIMER } from './disclaimer.js';
import { addExtra, brandsForCar, pickedOption, shoppingList } from './shopping.js';
import { finishDiagnosis, listSessions, recordResult, sessionView, skipStep, startDiagnosis } from './diagnosis.js';
import { WRITE_SECTIONS, saveResearch } from './research-write.js';
import { alternatesForCar } from './alternates.js';
import { confirmReceipt, createReceipt, discardReceipt, listPending } from './receipts.js';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const serverInfo = env => ({ name: 'garage', title: `${env.APP_NAME || 'Garage'} (household vehicles)`, version: '2.1.0' });
const instructions = (env, cars) => `${env.APP_NAME || 'Garage'}: a household's vehicle maintenance app (cars, trucks, vans, SUVs, and also motorcycles, side-by-sides / UTVs and ATVs). Vehicles: ${cars.length ? cars.map(c => `"${c.nickname}" (${[c.year, c.make, c.model].filter(Boolean).join(' ')})`).join(', ') : 'none yet (add one with decode_vin + add_car)'}. Vehicles can be named loosely (nickname, model, "the truck", "the bike", "the side by side") or by id. The tools say "car" for any vehicle.
Motorcycles: a wet-clutch bike needs JASO MA/MA2 oil (get_fluids flags it: never energy-conserving car oil). UTVs/ATVs are serviced by ENGINE HOURS as well as miles and dates (whichever comes first): "oil change at 145 hours" -> log_service with hours: 145; "rode it 2 hours" / "log 2 hours" -> update_hours with add_hours: 2; "it's at 150 hours" -> update_hours with hours: 150. Off-road recalls come from the CPSC (get_recalls handles it).
Workflow:
- Receipt photo or "log this": read the image yourself, call add_receipt with the fields (car, date, mileage, shop, total, line_items with part numbers) plus a transcription, show the user the returned summary and ask the listed questions, then call confirm_receipt only after they say yes. Prefer this over log_service whenever there is a receipt.
- Work done without a receipt: log_service (schedule_items marks them done). Finished a to-do: complete_todo.
- A new problem: add_symptom. What needs doing: get_due_list. Parts: get_parts / get_alternates / get_shopping_list.
- get_research holds researched recalls, TSBs and known issues; prefer it over general knowledge and say which you used.
- Troubleshooting ("walk me through", "help me figure out", "diagnose", "why is it ..."): use the guided diagnosis tools. list_diagnoses first to resume an open one; else start_diagnosis(car, symptom). Present ONE step at a time: the safety notes first (never skip or shorten them), then what to do and what to look for, then the answer options. Wait for the user's result before calling record_check_result; "can't do that now" = skip_step. Interpret results only as the tool's reply does (means / ruled out / more likely); don't jump to conclusions beyond the plan, and say so when a plan is AI-generated. To wrap up: finish_diagnosis, then create the proposed fix to-do only after a yes (create_fix_todo: true).
- Researching: list_research_requests shows symptoms waiting for research; research on the web (cite a URL for every claim, never invent part or bulletin numbers) and save with save_symptom_report. Whole-car research goes in with save_research_bundle (first load) or save_research (add entries).
- Disclaimer: when you give repair or diagnosis guidance, mention once per conversation (not in every message): "${DISCLAIMER}"
Read tools never change data. Dates are YYYY-MM-DD in the garage's time zone (${env.TIMEZONE || 'UTC'}).`;

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const CAR = S('string', 'Vehicle nickname or id (case-insensitive, forgiving: nickname, model, "the truck", "the bike")');
const DATE = S('string', 'YYYY-MM-DD', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const MILES = S('integer', 'Odometer miles', { minimum: 0, maximum: 2000000 });
const HOURS = S('number', 'Engine hours (hour meter), e.g. 145.5 (UTVs / ATVs)', { minimum: 0, maximum: 100000 });
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const LINE = { type: 'object', properties: {
  description: S('string', 'What the line is, as printed (e.g. "ACDelco oil filter", "Rotate tires")'),
  brand: S('string', 'Optional brand'), part_number: S('string', 'Part number exactly as printed (most useful field after the price)'),
  qty: S('number', 'Optional quantity (hours for labor)'), unit_price: S('number', 'Optional price each, dollars'), amount: S('number', 'Line total in dollars (negative for a discount)'),
  type: S('string', 'part | labor | service | fee | discount (default part)', { enum: ['part', 'labor', 'service', 'fee', 'discount'] }),
}, required: ['description'] };
const RECEIPT_FILE = { type: 'object', properties: { data_base64: S('string', 'File bytes, base64 (max 6 MB decoded)'), mime_type: S('string', 'image/jpeg, image/png, image/webp or application/pdf'), filename: S('string', 'Optional') }, required: ['data_base64', 'mime_type'] };
const SESSION = S('string', 'Diagnosis session id (from start_diagnosis or list_diagnoses)');
const SECTIONS = ['specs', 'recalls', 'tsbs', 'known_issues', 'recommendations', 'symptom_diagnosis', 'schedule', 'questions', 'symptom_reports'];

export const TOOLS = [
  { name: 'list_cars', title: 'List vehicles', description: 'All vehicles (cars, trucks, motorcycles, UTVs, ATVs): nickname, type, year/make/model, engine, mileage (and engine hours where tracked), fields still needing info, health score (0-100), open issue count, overdue/due-soon counts and the next service due.', inputSchema: { type: 'object', properties: {} }, annotations: RO },
  { name: 'get_car', title: 'Vehicle details', description: 'One vehicle: type, specs (trim, engine, transmission, VIN, notes), mileage, health, open to-dos and symptoms (with the mechanic\'s first-checks note), overdue and due-soon schedule items, the last 10 services and the latest scan-tool codes.', inputSchema: { type: 'object', properties: { car: CAR }, required: ['car'] }, annotations: RO },
  { name: 'get_research', title: 'Researched data for a car', description: 'Researched facts for one car (owner manuals, NHTSA, TSBs, forums), plus deep web-research reports for its symptoms (symptom_reports): specs, recalls, TSBs, known issues with a mileage-window phase relative to the car (now / ahead / behind / any), recommendations (now/soon/watch/skip), symptom diagnosis checklists, researched schedule and open questions. Optional section limits the output.', inputSchema: { type: 'object', properties: { car: CAR, section: S('string', 'Optional: one section', { enum: SECTIONS }) }, required: ['car'] }, annotations: RO },
  { name: 'get_recalls', title: 'Open recalls lookup', description: 'Looks up recalls for one vehicle online: NHTSA for cars, trucks and motorcycles (by year/make/model; the VIN check link confirms an exact vehicle), CPSC for UTVs / ATVs. Fails soft with the official search links.', inputSchema: { type: 'object', properties: { car: CAR }, required: ['car'] }, annotations: { ...RO, openWorldHint: true } },
  { name: 'get_fluids', title: 'Fluids and capacities', description: 'Fluid table for one vehicle (motorcycles: warning = wet clutch needs JASO MA/MA2 oil; sump = shared or separate gearbox oil): what to buy (spec + example brand) and how much (quarts/pints with liters) for engine oil (with filter), coolant, transmission (drain-and-fill and total), transfer case, differentials, brake, power steering and washer fluid. verify=true marks values the research could not confirm.', inputSchema: { type: 'object', properties: { car: CAR }, required: ['car'] }, annotations: RO },
  { name: 'get_parts', title: 'Parts quick reference', description: 'Parts for one car with part numbers per brand, approximate price (with as-of date), buy links and notes (filters, ignition, belts, cooling, brakes, wipers, bulbs, battery, tires, HVAC actuators, parts for open issues). Optional category filter (substring, e.g. "brakes", "filters", "HVAC").', inputSchema: { type: 'object', properties: { car: CAR, category: S('string', 'Optional category or keyword') }, required: ['car'] }, annotations: RO },
  { name: 'get_alternates', title: 'Alternate brands per part', description: 'For one car, every part with its OEM / first-choice part number and the good alternate brands (part number, tier, approximate price, where to buy with RockAuto first, verdict, sources), plus brands to avoid. Use it to answer "instead of the ACDelco part, what else could I buy?". verify_fitment=true means the number was not confirmed for this exact vehicle and engine. Optional part filter (substring of the part or category, e.g. "oil filter", "brakes").', inputSchema: { type: 'object', properties: { car: CAR, part: S('string', 'Optional part or category keyword') }, required: ['car'] }, annotations: RO },
  { name: 'get_guides', title: 'Repair guides', description: 'Step-by-step repair/diagnosis guides for one car: difficulty, time, tools, steps, safety, videos and articles. Optional topic filter (keyword such as "overheating", "HVAC", "oil"). Also returns the scan tool and coolant pressure tester notes (if the research has them) and additive verdicts when topic is "tools" or "additives".', inputSchema: { type: 'object', properties: { car: CAR, topic: S('string', 'Optional keyword, or "tools" / "additives"') }, required: ['car'] }, annotations: RO },
  { name: 'get_shopping_list', title: 'Shopping list', description: 'What to buy: brand picks (part number, price, where) for overdue/due-soon maintenance and open to-dos, split into RockAuto vs buy locally (fluids, batteries, urgent parts), with estimated totals. Due maintenance is pre-selected; parts for open problems are "only if the checks point there". Omit car for all cars.', inputSchema: { type: 'object', properties: { car: CAR } }, annotations: RO },
  { name: 'get_due_list', title: 'What needs doing', description: 'Across all cars: overdue and due-soon maintenance (overdue first), then open to-dos and symptoms by priority.', inputSchema: { type: 'object', properties: {} }, annotations: RO },
  { name: 'get_history', title: 'Service history', description: 'Service history for one car, newest first. Optional query searches title, details, parts and shop.', inputSchema: { type: 'object', properties: { car: CAR, query: S('string', 'Optional text to search for, e.g. "oil" or "brakes"'), limit: S('integer', 'Max entries (default 20, max 100)', { minimum: 1, maximum: 100 }) }, required: ['car'] }, annotations: RO },
  { name: 'add_symptom', title: 'Report a new symptom', description: 'Records a new problem the car is having (same as the "Add a new symptom" button) as a symptom to-do, then the AI mechanic adds "first things to check, cheapest first" using the car\'s research and history (appears on the to-do within about a minute; read it with get_car). Submitting the same text again returns the existing symptom instead of a duplicate.', inputSchema: { type: 'object', properties: { car: CAR, description: S('string', "What's happening, in plain words"), kind: S('array', 'Optional', { items: { type: 'string', enum: Object.keys(KINDS) } }), when: S('array', 'Optional: when it happens', { items: { type: 'string', enum: Object.keys(WHENS) } }), where: S('array', 'Optional: where it seems to come from', { items: { type: 'string', enum: Object.keys(WHERES) } }), mileage: MILES }, required: ['car', 'description'] }, annotations: RW },
  { name: 'add_todo', title: 'Add a to-do', description: 'Adds an open to-do for a car.', inputSchema: { type: 'object', properties: { car: CAR, title: S('string', 'What needs doing'), notes: S('string', 'Optional details'), priority: S('string', 'Default medium', { enum: ['high', 'medium', 'low'] }) }, required: ['car', 'title'] }, annotations: RW },
  { name: 'update_todo', title: 'Update a to-do', description: 'Changes a to-do: reopen/close (status), replace notes, append to notes, or change priority. Use complete_todo to finish one and log the work.', inputSchema: { type: 'object', properties: { todo_id: S('string', 'To-do id from get_car or get_due_list'), status: S('string', '', { enum: ['open', 'closed'] }), notes: S('string', 'Replaces the notes'), append_notes: S('string', 'Appended to the notes'), priority: S('string', '', { enum: ['high', 'medium', 'low'] }) }, required: ['todo_id'] }, annotations: RW },
  { name: 'complete_todo', title: 'Complete a to-do', description: 'Marks a to-do done. Optionally logs it to the service history at the same time (log_service: date, mileage, cost, shop, details).', inputSchema: { type: 'object', properties: { todo_id: S('string', 'To-do id'), log_service: { type: 'object', description: 'Optional history entry', properties: { date: DATE, mileage: MILES, cost: S('number', 'Dollars'), shop: S('string', 'Shop name; omit for DIY'), details: S('string', 'What was done') } } }, required: ['todo_id'] }, annotations: RW },
  { name: 'log_service', title: 'Log a service', description: 'Adds a service history entry. schedule_items (names like "oil", "tire rotation", or ids) are marked done as of this date, mileage and engine hours, which resets their next-due. For UTVs/ATVs pass hours (e.g. "oil change at 145 hours" -> hours: 145).', inputSchema: { type: 'object', properties: { car: CAR, date: DATE, mileage: MILES, hours: HOURS, title: S('string', 'What was done, e.g. "Oil & filter change"'), details: S('string', 'Optional'), cost: S('number', 'Optional dollars'), shop: S('string', 'Optional shop name; omit for DIY'), schedule_items: S('array', 'Optional schedule items this counts as', { items: { type: 'string' } }) }, required: ['car', 'date', 'title'] }, annotations: RW },
  { name: 'update_mileage', title: 'Update mileage (and/or hours)', description: "Sets the vehicle's current odometer reading, and/or its engine hours (UTVs / ATVs) if hours is given.", inputSchema: { type: 'object', properties: { car: CAR, mileage: MILES, hours: HOURS }, required: ['car'] }, annotations: { ...RW, idempotentHint: true } },
  { name: 'update_hours', title: 'Update engine hours', description: 'Sets the engine-hour reading of a vehicle with an hour meter (UTVs / ATVs). hours = the meter reading ("it\'s at 150 hours"); add_hours = hours used since the last reading ("rode it 2 hours", "log 2 hours"). Never lowers the reading by accident: hours below the current one need allow_lower.', inputSchema: { type: 'object', properties: { car: CAR, hours: HOURS, add_hours: S('number', 'Hours to add to the current reading', { minimum: 0, maximum: 1000 }), allow_lower: S('boolean', 'Allow a lower reading (meter replaced / typo fix)') }, required: ['car'] }, annotations: RW },
  { name: 'add_receipt', title: 'Add a receipt (pending until confirmed)', description: `Turns a car receipt (shop invoice, quick-lube ticket, parts-store receipt, RockAuto order) into a PENDING receipt: a draft service entry that is NOT saved to the history until confirm_receipt.
Usual flow: the user sends a photo and says "log this". You usually can't pass the image bytes, so READ THE PHOTO YOURSELF and send what you read:
- fields, most important first: car, date, mileage (the odometer printed on the receipt, never the "next service due" number; omit if not printed), line_items with part numbers and amounts, total, shop; plus tax, title, kind ("parts" for a parts-store purchase).
- transcription: the receipt's full text as a backup (the server fills any field you left out from it).
- schedule_items: optional names of maintenance items it completes ("oil", "tire rotation"); the server also matches them from the lines.
You can send only a transcription, or (if your client allows) files with base64 image/PDF bytes; the server then reads it with its own model.
Returns: id, a short summary to show the user (car · date · miles · shop, jobs it will mark done, total), questions to ask (e.g. mileage missing), fields to double-check, to-dos it might close, and a link to the receipt in the app. Show the summary, ask the questions, and get a clear yes before calling confirm_receipt. Sending the same receipt twice returns the existing one (duplicate: true).`, inputSchema: { type: 'object', properties: {
    car: S('string', 'Which car, loosely (nickname, model, "the truck"). Omit if the receipt does not say; the server matches by VIN / year-make-model.'),
    date: S('string', 'Receipt date, YYYY-MM-DD'), mileage: MILES, shop: S('string', 'Shop or store name'),
    hours: HOURS,
    total: S('number', 'Total paid, dollars'), tax: S('number', 'Optional sales tax, dollars'),
    title: S('string', 'Short summary, e.g. "Oil change + tire rotation"'), kind: S('string', 'service (a shop did the work) or parts (parts bought, DIY)', { enum: ['service', 'parts'] }),
    vin: S('string', 'Optional VIN if printed'), invoice_number: S('string', 'Optional'),
    line_items: S('array', 'Every charged line (tax goes in tax, not here)', { items: LINE, maxItems: 80 }),
    schedule_items: S('array', 'Optional: maintenance items this completes, e.g. ["oil", "tire rotation"]', { items: { type: 'string' }, maxItems: 20 }),
    not_performed: S('array', 'Optional: recommended / declined work printed on the receipt', { items: { type: 'string' }, maxItems: 20 }),
    notes: S('string', 'Optional note'),
    transcription: S('string', 'The receipt text as you read it (backup; max 20,000 characters)', { maxLength: 20000 }),
    files: S('array', 'Optional, only if you have the actual bytes: up to 4 images/PDF pages of ONE receipt', { items: RECEIPT_FILE, maxItems: 4 }),
  } }, annotations: RW },
  { name: 'confirm_receipt', title: 'Save a pending receipt', description: 'Saves a pending receipt to the car\'s service history ONLY after the user has seen the add_receipt summary and said yes. Logs the service (cost, shop, parts, odometer), marks the schedule items done (their next-due dates recalculate), raises the car\'s mileage if higher, and attaches the receipt files. edits corrects fields first (e.g. {"mileage": 87320} or {"car": "the truck"}); edits.schedule_items replaces the jobs to mark done. close_todos: ids from todo_candidates, only those the user agreed to close.', inputSchema: { type: 'object', properties: {
    id: S('string', 'Receipt id from add_receipt or list_pending_receipts'),
    edits: { type: 'object', description: 'Optional corrections', properties: { car: S('string', 'Car, loosely'), date: DATE, mileage: MILES, hours: HOURS, shop: S('string', ''), total: S('number', 'Dollars'), tax: S('number', 'Dollars'), title: S('string', ''), kind: S('string', '', { enum: ['service', 'parts'] }), line_items: S('array', 'Replaces all lines', { items: LINE }), schedule_items: S('array', 'Replaces the jobs to mark done (names)', { items: { type: 'string' } }), notes: S('string', '') } },
    close_todos: S('array', 'Optional to-do ids to close (from todo_candidates), only with the user\'s OK', { items: { type: 'string' }, maxItems: 20 }),
  }, required: ['id'] }, annotations: RW },
  { name: 'list_pending_receipts', title: 'Pending receipts', description: 'Receipts waiting to be checked and saved (from the app, email or Claude), each with its summary, questions and app link.', inputSchema: { type: 'object', properties: { car: S('string', 'Optional car filter') } }, annotations: RO },
  { name: 'discard_receipt', title: 'Discard a pending receipt', description: 'Throws away a pending receipt (and its uploaded files) without logging anything. Only when the user asks.', inputSchema: { type: 'object', properties: { id: S('string', 'Receipt id') }, required: ['id'] }, annotations: { ...RW, destructiveHint: true } },
  { name: 'start_diagnosis', title: 'Start a guided diagnosis', description: `Starts (or resumes) a step-by-step diagnosis for a car and symptom, e.g. "walk me through the overheating". Loose car names and symptom words are fine; the symptom is matched to a ready-made plan built from the car's research (cheapest and most likely checks first, with safety notes and sources). If an open session for the same plan exists it is resumed (fresh: true starts over).
Returns step 1 (or the current step): safety notes, what to do, what to look for, tools, time, and the answer options to offer, plus the causes still in play. If no plan matches it returns needs_plan with the available plans: offer them, or with the user's OK call again with generate: true to have the garage AI write one (1-3 minutes, marked "AI-generated, check before trusting").`, inputSchema: { type: 'object', properties: { car: CAR, symptom: S('string', 'What is wrong, in plain words, e.g. "overheating", "coolant loss", "tick after the oil change"'), plan_id: S('string', 'Optional: a plan id from needs_plan.available_plans'), todo_id: S('string', 'Optional: the symptom to-do this is about'), generate: S('boolean', 'Generate a plan with the garage AI if none matches (only after the user agrees)'), fresh: S('boolean', 'Start a new session even if one is open for this plan') }, required: ['car'] }, annotations: RW },
  { name: 'get_diagnosis', title: 'Get a diagnosis session', description: 'Where a diagnosis session stands: the current step (safety, what to do, options), answers so far, likely and ruled-out causes, skipped steps, or the conclusion if finished. Pass session, or car to get that car\'s most recent open session.', inputSchema: { type: 'object', properties: { session: SESSION, car: CAR } }, annotations: RO },
  { name: 'list_diagnoses', title: 'List diagnosis sessions', description: 'Diagnosis sessions, open (active) ones first so they can be resumed, then finished ones with their conclusions. Optional car and status filters.', inputSchema: { type: 'object', properties: { car: CAR, status: S('string', 'Optional', { enum: ['active', 'found', 'inconclusive', 'abandoned'] }) } }, annotations: RO },
  { name: 'record_check_result', title: 'Record a check result', description: 'Records what the user found at a step and returns what it means (from the plan: ruled out, more/less likely, or found it), then the next step. result = an option key or label from the step (loose wording and "1"/"2"/"3" work; "not sure" is always allowed). step defaults to the current step; pass an earlier step (id or number) to change that answer. notes and mileage are optional.', inputSchema: { type: 'object', properties: { session: SESSION, result: S('string', 'Option key or label, e.g. "both", "Only one fan runs", "2"'), step: S('string', 'Optional step id or number (default: current step)'), notes: S('string', 'Optional: what they saw, readings, where the leak was'), mileage: MILES }, required: ['session', 'result'] }, annotations: RW },
  { name: 'skip_step', title: 'Skip a step for now', description: '"Can\'t do that now": skips the current step (or the given one). Skipped steps are offered again at the end. Returns the next step.', inputSchema: { type: 'object', properties: { session: SESSION, step: S('string', 'Optional step id or number'), reason: S('string', 'Optional, e.g. "no block tester yet"') }, required: ['session'] }, annotations: RW },
  { name: 'finish_diagnosis', title: 'Finish a diagnosis', description: 'Ends a session: writes a summary (checks, findings, conclusion, confidence) to the car\'s service history, adds a note to related open to-dos (never closes them; also notes causes it ruled out), and returns a proposed fix to-do with matching parts. Create that to-do only after the user says yes: call again with create_fix_todo: true (works on an already finished session, once). status defaults to found (the plan pointed to a cause) or inconclusive; abandoned if they stopped. conclusion overrides the wording.', inputSchema: { type: 'object', properties: { session: SESSION, conclusion: S('string', 'Optional conclusion in plain words'), status: S('string', 'Optional', { enum: ['found', 'inconclusive', 'abandoned'] }), create_fix_todo: S('boolean', 'Create the proposed fix to-do (only after the user agreed)') }, required: ['session'] }, annotations: RW },
  { name: 'add_shopping_item', title: 'Add to a shopping list', description: 'Adds a tool, supply or part to a car\'s shopping list (shown with get_shopping_list and in the app). Skipped if the list already has it (same name or part number).', inputSchema: { type: 'object', properties: { car: CAR, name: S('string', 'What to buy'), kind: S('string', 'Default part', { enum: ['part', 'tool', 'supply'] }), brand: S('string', 'Optional'), part_number: S('string', 'Optional'), price_usd: S('string', 'Optional approximate price'), where: S('string', 'Optional store'), url: S('string', 'Optional https link'), note: S('string', 'Optional note') }, required: ['car', 'name'] }, annotations: RW },
  { name: 'decode_vin', title: 'Decode a VIN', description: 'Decodes a VIN with the public NHTSA vPIC API: year, make, model, trim, engine, transmission, drive, body class, a suggested vehicle_type (car, truck, van, suv, motorcycle, utv, atv) and body_type, and attrs it could tell (cooling, fuel_system). Motorcycles (vPIC VehicleType MOTORCYCLE) map automatically; UTV/ATV VINs are often only partly decoded or filed as motorcycles: confirm the type with the user. ok=false / manual=true means fill the details in by hand. Read-only.', inputSchema: { type: 'object', properties: { vin: S('string', '17-character VIN (or a partial one, * for unknown positions)', { pattern: '^[A-HJ-NPR-Za-hj-npr-z0-9*]{5,17}$' }) }, required: ['vin'] }, annotations: { ...RO, openWorldHint: true } },
  { name: 'add_car', title: 'Add a vehicle', description: 'Adds a vehicle to the garage: a car, truck, van, SUV, motorcycle, side-by-side (utv) or ATV (vehicle_type). body_type picks the 3D model (sedan, coupe, hatchback, minivan, suv, pickup; bikes cruiser, sport, dualsport, scooter; utv; atv); color is the paint (#rrggbb). attrs (motorcycles / off-road) shape the starter schedule: final_drive chain/shaft/belt, cooling air/oil-air/liquid, fuel_system carbureted/efi, clutch wet/dry/cvt. starter_schedule=true adds the typical schedule for that type (cars 12 items; motorcycles by final drive, cooling and fuel system; UTV/ATV by miles, engine hours or months, whichever first), each marked "typical, check your owner\'s manual" (replace them with researched ones later). Ask the user before adding.', inputSchema: { type: 'object', properties: {
    nickname: S('string', 'What the household calls it, e.g. "the Civic", "the bike"'), year: S('integer', 'Model year'), make: S('string', ''), model: S('string', ''), trim: S('string', ''), engine: S('string', ''), transmission: S('string', ''),
    vehicle_type: S('string', 'Default car (or from body_type)', { enum: Object.keys(VEHICLE_TYPES) }),
    vin: S('string', 'Optional 17-character VIN'), body_type: S('string', '3D body style (default: from vehicle_type)', { enum: BODY_TYPES }), color: S('string', 'Paint color #rrggbb'), mileage: MILES, hours: HOURS,
    attrs: { type: 'object', description: 'Optional drivetrain facts (motorcycles / off-road)', properties: { final_drive: S('string', '', { enum: ['chain', 'shaft', 'belt'] }), cooling: S('string', '', { enum: ['air', 'oil-air', 'liquid'] }), fuel_system: S('string', '', { enum: ['carbureted', 'efi'] }), clutch: S('string', '', { enum: ['wet', 'dry', 'cvt'] }), shared_sump: S('boolean', 'Engine and gearbox share one oil') } },
    notes: S('string', 'Known problems or anything else worth remembering'), starter_schedule: S('boolean', 'Add the generic starter schedule (default true)') }, required: ['nickname'] }, annotations: RW },
  { name: 'update_schedule_item', title: 'Add or change a maintenance item', description: 'Adds a maintenance schedule item to a car, or changes the one with the same name (case-insensitive): interval_miles / interval_hours / interval_months (due at whichever comes first; months only = a date-based item such as tire age), notes, source ("manual" when it comes from the owner\'s manual, "typical" for common practice), severe=true for a severe-service variant. Use it to apply researched intervals.', inputSchema: { type: 'object', properties: { car: CAR, name: S('string', 'e.g. "Oil & filter change"'), interval_miles: S('integer', 'Miles between services (omit if time only)'), interval_months: S('integer', 'Months between services (omit if miles only)'), interval_hours: S('number', 'Engine hours between services (UTVs / ATVs)', { minimum: 1, maximum: 10000 }), notes: S('string', 'Fluid spec, amount, source URL'), source: S('string', '', { enum: ['manual', 'typical', 'user'] }), severe: S('boolean', 'Severe-service variant') }, required: ['car', 'name'] }, annotations: RW },
  { name: 'list_research_requests', title: 'Symptoms waiting for research', description: 'Symptoms and to-dos queued for deep web research (each new symptom queues one; "Research this" in the app queues one). Research one on the web, then save the result with save_symptom_report. If the household runs the background research worker, it picks these up by itself.', inputSchema: { type: 'object', properties: {} }, annotations: RO },
  { name: 'save_symptom_report', title: 'Save a symptom research report', description: 'Saves a deep research report on one to-do / symptom (shown on the to-do in the app and used by the AI mechanic). Shape: {summary (3-5 plain sentences), likely_causes:[{cause, likelihood high|med|low, why, how_to_check, fix, diy_difficulty 1-5, cost_diy, cost_shop}], check_order:[cheapest first], safe_to_drive:{verdict yes|caution|no, why}, parts:[{name, part_numbers, approx_price, link}], videos:[{title, channel, url}], sources:[{title, url}] (at least one real URL), questions_for_owner:[]}. Only cite URLs you actually visited; leave part_numbers "" unless you saw them for this vehicle.', inputSchema: { type: 'object', properties: { todo_id: S('string', 'To-do id from get_car, get_due_list or list_research_requests'), report: { type: 'object', description: 'The report (see description)' } }, required: ['todo_id', 'report'] }, annotations: RW },
  { name: 'save_research_bundle', title: 'Save whole-car research', description: 'Loads researched data for one car in one go (what get_research / get_fluids / get_parts / get_guides return): research {vehicle, recalls, tsbs, schedule, known_issues, symptom_diagnosis, recommendations, questions} (see docs/research-schema.md in the kit), report_md (the written report), fluids [{fluid, buy, example, amount, liters, notes, source, verify}], parts_guides {parts, guides, ...}. Refuses to replace research that is already there unless overwrite=true (then it is a full replace; prefer save_research to add entries). dry_run=true shows what would change.', inputSchema: { type: 'object', properties: { car: CAR, research: { type: 'object' }, report_md: S('string', 'Markdown report, with source links'), fluids: S('array', 'Fluid table rows', { items: { type: 'object' } }), parts_guides: { type: 'object' }, overwrite: S('boolean', 'Replace existing sections (default false)'), dry_run: S('boolean', 'Preview only') }, required: ['car'] }, annotations: { ...RW, destructiveHint: true } },
  { name: 'save_research', title: 'Save research (owner only)', description: 'Owner only. Adds entries to one section of a car\'s researched data (what get_research returns). Entries are matched by symptom_checklists.symptom, known_issues.title, tsbs.number (or title), recalls.campaign (or summary), recommendations.item, or the question text (case-insensitive). New ones are added; existing ones are skipped unless overwrite=true, which replaces them. dry_run=true shows what would be added/replaced/skipped and saves nothing. symptom_checklists entries look like {symptom, likely_causes:[{cause, likelihood, how_to_check, fix, cost}], scan_tool_checks}.', inputSchema: { type: 'object', properties: { car: CAR, section: S('string', 'Which section to add to', { enum: Object.keys(WRITE_SECTIONS) }), entries: S('array', 'Entries to add: objects shaped like that section in get_research (strings for questions)', { minItems: 1, maxItems: 50, items: { type: ['object', 'string'] } }), overwrite: S('boolean', 'Replace entries that already exist (default false)'), dry_run: S('boolean', 'Preview only; save nothing (default false)') }, required: ['car', 'section', 'entries'] }, annotations: { ...RW, destructiveHint: true, idempotentHint: true } },
];

const carLabel = c => `${c.year ?? ''} ${c.make ?? ''} ${c.model ?? ''}`.trim();
const phaseOf = (range, M) => !range ? 'any' : (range[1] != null && range[1] < M) ? 'behind' : range[0] <= M ? 'now' : 'ahead';
function parseRange(s) {
  const t = String(s || '').toLowerCase().replace(/,/g, '');
  let m = t.match(/(\d+(?:\.\d+)?)\s*k?\s*[-–]\s*(\d+(?:\.\d+)?)\s*k(\+)?/);
  if (m) return [m[1] * 1000, m[3] ? null : m[2] * 1000];
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*k\s*\+/))) return [m[1] * 1000, null];
  const avg = [...t.matchAll(/avg\s*(\d+(?:\.\d+)?)\s*k/g)].map(x => x[1] * 1000);
  if (avg.length) return [Math.min(...avg) * 0.8, Math.max(...avg) * 1.2];
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*k\b/))) return [m[1] * 1000, null];
  return null;
}

async function call(env, ctx, name, a, who) {
  const member = { id: who.member_id, name: who.actor };
  switch (name) {
    case 'list_cars': {
      const cars = await garageOverview(env);
      return { today: todayLocal(), cars: cars.map(c => ({ id: c.id, nickname: c.nickname, type: noun(c), vehicle: carLabel(c), trim: c.trim, engine: c.engine, mileage: c.mileage,
        ...(c.uses_hours ? { hours: c.hours } : {}), ...(c.needs_info.length ? { needs_info: c.needs_info.map(n => n.label) } : {}), health: c.summary.health, open_issues: c.summary.open_issues, overdue: c.summary.overdue_count, due_soon: c.summary.soon_count, next_due: c.summary.next_due && { item: c.summary.next_due.name, status: c.summary.next_due.label } })) };
    }
    case 'get_car': {
      const c = await resolveCar(env, a.car);
      const d = await carFull(env, c.id);
      const latestScan = d.scans[0];
      return {
        id: c.id, nickname: c.nickname, type: noun(c), vehicle: carLabel(c), trim: c.trim, engine: c.engine, transmission: c.transmission, vin: c.vin, notes: c.notes,
        ...(() => { const { needs_info, ...dt } = d.car.attrs || {}; return Object.keys(dt).length ? { drivetrain: dt } : {}; })(), ...(d.car.needs_info.length ? { needs_info: d.car.needs_info.map(n => n.label) } : {}),
        mileage: c.mileage, mileage_updated: c.mileage_updated_at, ...(usesHours(c) ? { hours: c.hours, hours_updated: c.hours_updated_at } : {}),
        health: d.summary.health, fluids: d.fluids, parts_sources: d.parts_sources.stores, ...(isOffroad(c) ? { water_crossing_note: OFFROAD_NOTE } : {}),
        open_todos: d.todos.filter(t => t.status === 'open').map(t => ({ id: t.id, type: t.type || 'todo', title: t.title, priority: t.priority, notes: t.notes, reported_by: t.reporter, mileage: t.mileage, dtc_code: t.dtc_code, mechanic_first_checks: t.ai_status === 'done' ? t.ai_note : t.ai_status === 'truncated' ? `${t.ai_note}\n\n(cut off; tap "Tap to continue" on the to-do in the app)` : t.ai_status === 'pending' ? '(still being written)' : undefined, deep_research: t.research ? (t.research.status === 'done' ? t.research.report : { status: t.research.status, error: t.research.error || undefined }) : undefined })),
        overdue: d.items.filter(i => i.status === 'overdue').map(i => ({ item: i.name, status: i.label })),
        due_soon: d.items.filter(i => i.status === 'soon').map(i => ({ item: i.name, status: i.label })),
        unknown_last_done: d.items.filter(i => i.status === 'unknown').map(i => i.name),
        recent_services: d.services.slice(0, 10).map(s => ({ date: s.date, mileage: s.mileage, title: s.title, details: s.details, cost: s.cost_cents != null ? s.cost_cents / 100 : null, shop: s.diy ? 'DIY' : s.shop })),
        latest_scan: latestScan ? { date: latestScan.scan_date || new Date(latestScan.received_at * 1000).toISOString().slice(0, 10), mileage: latestScan.mileage, codes: latestScan.codes.map(k => ({ code: k.code, description: k.description, module: k.module, status: k.status })) } : null,
      };
    }
    case 'get_research': {
      const c = await resolveCar(env, a.car);
      const row = await env.DB.prepare('SELECT data FROM research WHERE car_id = ?1').bind(c.id).first();
      if (!row) return { car: c.nickname, research: null, note: 'No research loaded for this car.' };
      const r = JSON.parse(row.data), M = c.mileage || 0;
      const out = {
        specs: r.vehicle,
        recalls: r.recalls, recalls_note: isOffroad(c) ? 'Off-road recalls are with the CPSC: get_recalls looks them up (also check the maker\'s VIN lookup).' : 'Check open recalls by VIN at https://www.nhtsa.gov/recalls (recall repairs are free); get_recalls looks them up live.',
        tsbs: r.tsbs,
        known_issues: (r.known_issues || []).map(k => ({ ...k, phase: phaseOf(parseRange(k.mileage_range), M) })),
        known_issues_note: `phase is relative to the car's ${M.toLocaleString('en-US')} miles: now = in its typical window, ahead = coming up, behind = window passed, any = not mileage-based`,
        recommendations: r.recommendations, symptom_diagnosis: r.symptom_diagnosis, schedule: r.schedule, questions: r.questions,
        symptom_reports: Object.entries(await jobsForCar(env, c.id)).filter(([, j]) => j.status === 'done').map(([todo_id, j]) => ({ todo_id, finished_at: j.finished_at, ...j.report })),
      };
      if (a.section) { if (!SECTIONS.includes(a.section)) throw new HttpError(400, `section must be one of ${SECTIONS.join(', ')}`); return { car: c.nickname, mileage: M, [a.section]: out[a.section], ...(a.section === 'recalls' ? { recalls_note: out.recalls_note } : a.section === 'known_issues' ? { known_issues_note: out.known_issues_note } : {}) }; }
      return { car: c.nickname, mileage: M, ...out };
    }
    case 'get_fluids': case 'get_parts': case 'get_guides': {
      const c = await resolveCar(env, a.car);
      const row = await env.DB.prepare('SELECT data, fluids FROM parts_guides WHERE car_id = ?1').bind(c.id).first();
      if (name === 'get_fluids') { const fl = fluidsFor(c, row ? JSON.parse(row.fluids) : []); return fl.length ? { car: c.nickname, fluids: fl } : { car: c.nickname, fluids: [], note: 'No fluids researched for this vehicle yet.' }; }
      if (!row) return { car: c.nickname, note: `No parts research loaded for this ${noun(c)}.`, buy_from: partsSources(c).stores };
      const d = JSON.parse(row.data);
      const kw = String(a.category || a.topic || '').toLowerCase().trim();
      if (name === 'get_parts') {
        const br = await brandsForCar(env, c.id);
        const withBrands = d.parts.map(p => { const b = br.parts.find(x => x.matched_part === p.name); return b ? { ...p, brands: { pick: b.pick, picked_option: pickedOption(b), options: b.options, avoid: b.avoid } } : p; });
        const extra = br.parts.filter(b => !b.matched_part).map(b => ({ name: b.part, category: b.category, brand_only: true, brands: { pick: b.pick, picked_option: pickedOption(b), options: b.options, avoid: b.avoid } }));
        const all = [...withBrands, ...extra];
        const parts = kw ? all.filter(p => `${p.category} ${p.name}`.toLowerCase().includes(kw)) : all;
        return { car: c.nickname, researched: d.researched || d.research_date || d.compiled || null, brand_notes: br.meta?.notes, oil_filter_tick: kw.includes('filter') || kw.includes('oil') ? br.meta?.oil_filter_tick : undefined, categories: [...new Set(all.map(p => p.category))], parts };
      }
      if (kw === 'tools' || kw === 'scan tool' || kw === 'topscan') return { car: c.nickname, scan_tool: d.scan_tool || d.topscan, pressure_tester: d.pressure_tester };
      if (kw === 'additives') return { car: c.nickname, additives: d.additives };
      const guides = kw ? d.guides.filter(g => `${g.title} ${g.related_issue || ''}`.toLowerCase().includes(kw)) : d.guides;
      return { car: c.nickname, guides, ...(kw ? {} : { titles_only_hint: 'Pass topic to filter; topic "tools" or "additives" for those sections.' }) };
    }
    case 'get_recalls': return { car: (await resolveCar(env, a.car)).nickname, ...(await recallsFor(await resolveCar(env, a.car))) };
    case 'get_alternates': {
      const c = await resolveCar(env, a.car);
      const alt = await alternatesForCar(env, c.id, c);
      const kw = String(a.part || '').toLowerCase().trim();
      const parts = kw ? alt.parts.filter(p => `${p.part} ${p.category || ''}`.toLowerCase().includes(kw)) : alt.parts;
      return { car: c.nickname, ...alt, parts, ...(kw && !parts.length ? { available_parts: alt.parts.map(p => p.part) } : {}) };
    }
    case 'get_shopping_list': {
      if (a.car) return shoppingList(env, await resolveCar(env, a.car));
      const { results: cars } = await env.DB.prepare('SELECT * FROM cars WHERE archived = 0 ORDER BY sort_order').all();
      return { cars: await Promise.all(cars.map(c => shoppingList(env, c))) };
    }
    case 'get_due_list': {
      const d = await dueList(env);
      return { today: d.today, counts: d.counts, maintenance: d.items.map(i => ({ car: i.car, item: i.name, status: i.status, detail: i.label })), readings: d.cars.map(c => ({ car: c.nickname, mileage: c.mileage, ...(c.uses_hours ? { hours: c.hours } : {}) })), todos: d.todos.map(t => ({ id: t.id, car: t.car, title: t.title, priority: t.priority, type: t.type || 'todo' })) };
    }
    case 'get_history': {
      const c = await resolveCar(env, a.car);
      return { car: c.nickname, services: await searchHistory(env, c.id, a.query, a.limit) };
    }
    case 'add_symptom': {
      const c = await resolveCar(env, a.car);
      const r = await createSymptom(env, ctx, c, a, who.actor, who.member_id);
      return { car: c.nickname, ...r, note: r.duplicate ? 'Already recorded (same text); returning the existing symptom.' : 'Recorded. The mechanic\'s first checks will appear on this symptom shortly (get_car).' };
    }
    case 'add_todo': {
      const c = await resolveCar(env, a.car);
      return { car: c.nickname, id: await createTodo(env, c.id, { ...a, reporter_id: who.member_id }, who.actor) };
    }
    case 'update_todo': return updateTodo(env, String(a.todo_id || ''), { status: a.status, notes: a.notes, append_notes: a.append_notes, priority: a.priority }, member, createService);
    case 'complete_todo': {
      const hist = a.log_service ? { date: a.log_service.date || todayLocal(), mileage: a.log_service.mileage, hours: a.log_service.hours, cost: a.log_service.cost, shop: a.log_service.shop, diy: !a.log_service.shop, ...(a.log_service.details ? { details: a.log_service.details } : {}) } : null;
      return updateTodo(env, String(a.todo_id || ''), { status: 'closed', ...(hist ? { history: hist } : {}) }, member, createService);
    }
    case 'log_service': {
      const c = await resolveCar(env, a.car);
      const items = await itemIdsByName(env, c.id, a.schedule_items);
      const id = await createService(env, c.id, { date: a.date, mileage: a.mileage, hours: a.hours, title: a.title, details: a.details, cost: a.cost, shop: a.shop, diy: !a.shop, item_ids: items.ids }, member);
      return { car: c.nickname, id, marked_done: items.ids.length, unmatched_schedule_items: items.missing, ...(items.missing.length ? { available_schedule_items: items.available } : {}) };
    }
    case 'update_mileage': {
      const c = await resolveCar(env, a.car);
      if (a.mileage == null && a.hours == null) throw new HttpError(400, 'Pass mileage and/or hours.');
      const out = { car: c.nickname };
      if (a.mileage != null) out.mileage = await setMileage(env, c.id, a.mileage, 'mcp');
      if (a.hours != null) out.hours = await setHours(env, c.id, a.hours, 'mcp');
      return out;
    }
    case 'update_hours': {
      const c = await resolveCar(env, a.car);
      const add = hoursNum(a.add_hours, 'add_hours');
      let h = hoursNum(a.hours);
      if (h == null && add == null) throw new HttpError(400, 'Pass hours (the meter reading) or add_hours (hours used).');
      if (h == null) {
        if (c.hours == null) throw new HttpError(400, `The ${c.nickname} has no hour reading yet: ask for the meter reading and pass hours.`);
        h = Math.round((Number(c.hours) + add) * 10) / 10;
      }
      if (c.hours != null && h < Number(c.hours) && !a.allow_lower) throw new HttpError(400, `${h} h is below the current ${c.hours} h. Pass allow_lower only if the meter was replaced or the old reading was wrong.`);
      return { car: c.nickname, previous: c.hours, hours: await setHours(env, c.id, h, 'mcp'), ...(usesHours(c) ? {} : { note: `Hours recorded; the ${c.nickname} is a ${noun(c)}, so most of its schedule is by miles.` }) };
    }
    case 'add_receipt': {
      // a car we can't place doesn't stop the receipt: it becomes a question in the draft
      let car = null;
      if (a.car) { try { car = await resolveCar(env, a.car); } catch { car = null; } }
      const files = [];
      for (const f of Array.isArray(a.files) ? a.files.slice(0, 4) : []) {
        const b64 = String(f?.data_base64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        if (b64.length > 8_200_000) throw new HttpError(413, `${f.filename || 'file'} is over 6 MB; send the fields and transcription instead`);
        let bin;
        try { bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { throw new HttpError(400, 'files[].data_base64 is not valid base64'); }
        files.push({ name: f.filename || 'receipt', mime: f.mime_type, data: bin.buffer });
      }
      const fieldKeys = ['date', 'mileage', 'hours', 'shop', 'total', 'tax', 'title', 'kind', 'invoice_number', 'line_items', 'schedule_items', 'not_performed', 'notes'];
      const hasFields = fieldKeys.some(k => a[k] !== undefined && a[k] !== null && !(Array.isArray(a[k]) && !a[k].length));
      const fields = hasFields ? { ...Object.fromEntries(fieldKeys.map(k => [k, a[k]])), vehicle: { vin: a.vin } } : null;
      const res = await createReceipt(env, { source: 'mcp', files, text: String(a.transcription || '').slice(0, 20000), fields, carRef: car, member: { id: who.member_id, name: who.actor } });
      return receiptForChat(res.receipt, { duplicate: res.duplicate });
    }
    case 'confirm_receipt': {
      const r = await confirmReceipt(env, String(a.id || ''), { edits: a.edits || {}, close_todo_ids: a.close_todos || [] }, member, { createService, resolveCar });
      return r.already_saved ? { ...r, note: 'This receipt was already saved; nothing was logged twice.' } : r;
    }
    case 'list_pending_receipts': {
      const car = a.car ? await resolveCar(env, a.car) : null;
      return { receipts: (await listPending(env, { carId: car?.id || null })).map(v => receiptForChat(v)) };
    }
    case 'discard_receipt': return discardReceipt(env, String(a.id || ''));
    case 'start_diagnosis': {
      const c = await resolveCar(env, a.car);
      const v = await startDiagnosis(env, c, { symptom: a.symptom, plan_id: a.plan_id, todo_id: a.todo_id, generate: !!a.generate, fresh: !!a.fresh }, member);
      return v && typeof v === 'object' ? { disclaimer: DISCLAIMER, ...v, ...(typeof v._text === 'string' ? { _text: `${DISCLAIMER}\n\n${v._text}` } : {}) } : v;
    }
    case 'get_diagnosis': {
      if (a.session) return sessionView(env, String(a.session));
      if (!a.car) throw new HttpError(400, 'Pass session, or car for its latest open diagnosis.');
      const c = await resolveCar(env, a.car);
      const open = await listSessions(env, { carId: c.id, status: 'active', limit: 1, includeTest: true });
      if (!open.length) return { car: c.nickname, note: 'No open diagnosis for this car. start_diagnosis starts one.', recent: await listSessions(env, { carId: c.id, limit: 5 }) };
      return sessionView(env, open[0].session_id);
    }
    case 'list_diagnoses': {
      const c = a.car ? await resolveCar(env, a.car) : null;
      return { sessions: await listSessions(env, { carId: c?.id || null, status: a.status || null, includeTest: !!c }) };
    }
    case 'record_check_result': return recordResult(env, String(a.session || ''), { step: a.step, result: a.result, notes: a.notes, mileage: a.mileage }, member);
    case 'skip_step': return skipStep(env, String(a.session || ''), { step: a.step, reason: a.reason }, member);
    case 'finish_diagnosis': return finishDiagnosis(env, String(a.session || ''), { conclusion: a.conclusion, status: a.status, create_fix_todo: !!a.create_fix_todo }, member, createService);
    case 'add_shopping_item': {
      const c = await resolveCar(env, a.car);
      return { car: c.nickname, ...(await addExtra(env, c, a, member)) };
    }
    case 'save_research': {
      if (!who.is_owner) throw new HttpError(403, 'save_research is limited to garage owners.');
      return saveResearch(env, await resolveCar(env, a.car), a, who);
    }
    case 'decode_vin': return decodeVin(String(a.vin || ''));
    case 'add_car': {
      const id = await createCar(env, { ...a, default_schedule: a.starter_schedule !== false });
      return { id, note: 'Added. Next: offer to research it (recalls, known issues, the owner\'s-manual schedule, fluids, parts).' };
    }
    case 'update_schedule_item': return upsertScheduleItem(env, await resolveCar(env, a.car), a);
    case 'list_research_requests': return { requests: await listQueued(env) };
    case 'save_symptom_report': return saveManualReport(env, String(a.todo_id || ''), a.report, who.actor);
    case 'save_research_bundle': {
      if (!who.is_owner) throw new HttpError(403, 'save_research_bundle is limited to garage owners.');
      return saveResearchBundle(env, await resolveCar(env, a.car), a);
    }
  }
  throw new HttpError(400, `Unknown tool ${name}`);
}

/** What Claude needs to show the user and decide: the summary first, then the details. */
function receiptForChat(v, { duplicate = false } = {}) {
  const d = v.draft;
  return {
    id: v.id, status: v.status, ...(duplicate ? { duplicate: true, note: v.status === 'saved' ? 'Already saved earlier; nothing new was created.' : 'Already pending; this is the existing receipt.' } : {}),
    summary: v.summary,
    car: v.car?.nickname || null, date: d.date, mileage: d.mileage, shop: d.shop, total: d.total, title: d.title, kind: d.kind,
    will_mark_done: v.matched.map(m => m.name),
    questions: v.questions, check: v.flags.map(f => `${f.field}: ${f.msg}`),
    todo_candidates: v.todo_candidates,
    line_items: d.line_items.map(l => [l.description, l.brand, l.part_number && `#${l.part_number}`, l.qty != null && l.qty !== 1 && `x${l.qty}`, l.amount != null && `$${l.amount.toFixed(2)}`].filter(Boolean).join(' ')),
    read_by: v.parse_status === 'fields' ? 'your fields' : v.parse_status === 'done' ? `garage AI (${v.model})` : v.parse_status, ...(v.error ? { read_error: v.error } : {}),
    app_link: v.url,
    next_step: v.status === 'pending' ? 'Show the user the summary (and ask the questions). After a clear yes, call confirm_receipt with this id (edits for any corrections, close_todos only for to-dos they agree to close).' : undefined,
  };
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleOne(env, ctx, msg, who) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
  const isNote = msg.id === undefined || msg.id === null;
  const { method, params = {} } = msg;
  if (method.startsWith('notifications/')) return null;
  let result;
  switch (method) {
    case 'initialize': {
      const { results: cars } = await env.DB.prepare('SELECT nickname, year, make, model FROM cars WHERE archived = 0 ORDER BY sort_order LIMIT 12').all();
      result = { protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: serverInfo(env), instructions: instructions(env, cars) };
      break;
    }
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools: TOOLS }; break;
    case 'resources/list': result = { resources: [] }; break;
    case 'resources/templates/list': result = { resourceTemplates: [] }; break;
    case 'prompts/list': result = { prompts: [] }; break;
    case 'tools/call': {
      const name = params.name, args = params.arguments || {};
      if (!TOOLS.some(t => t.name === name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      if (typeof args !== 'object' || Array.isArray(args)) return rpcError(msg.id, -32602, 'arguments must be an object');
      try {
        const out = await call(env, ctx, name, args, who);
        // diagnosis replies carry a short phone-friendly text; the full object stays in structuredContent
        const text = typeof out?._text === 'string' ? out._text : JSON.stringify(out, null, 1);
        if (out && typeof out === 'object') delete out._text;
        result = { content: [{ type: 'text', text }], structuredContent: out, isError: false };
        if (!TOOLS.find(t => t.name === name).annotations.readOnlyHint) console.log(`mcp write ${name} by ${who.actor}`);
      } catch (e) {
        if (!(e instanceof HttpError)) console.error('mcp tool error', name, e.stack || e);
        result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
      break;
    }
    default: return isNote ? null : rpcError(msg.id, -32601, `Method not found: ${method}`);
  }
  return isNote ? null : { jsonrpc: '2.0', id: msg.id, result };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version' };

/** POST /mcp (after OAuth). ctx.props carries the member the token was issued to. */
export async function handleMcp(req, env, ctx) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS' } });
  if (req.method === 'GET') return new Response('This server does not open an SSE stream; POST JSON-RPC to /mcp.', { status: 405, headers: { ...CORS, Allow: 'POST, DELETE' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { ...CORS, Allow: 'POST' } });
  const props = ctx.props || {};
  // the grant only lives as long as the person is still a member
  const m = props.member_id && await env.DB.prepare('SELECT id, name, email, is_owner FROM members WHERE id = ?1').bind(props.member_id).first();
  if (!m) return json(rpcError(null, -32001, 'Not a garage member any more. Ask the garage owner.'), 403, CORS);
  if (props.grant && await env.DB.prepare('SELECT 1 FROM revoked_grants WHERE nonce = ?1').bind(props.grant).first()) {
    return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'This connection was disconnected in Settings.' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer realm="OAuth", error="invalid_token", resource_metadata="${env.APP_ORIGIN || new URL(req.url).origin}/.well-known/oauth-protected-resource/mcp"` } });
  }
  // per-token rate limit (key = grant id when present, never the token itself)
  let rl = 'none';
  if (env.MCP_LIMITER) {
    const { success } = await env.MCP_LIMITER.limit({ key: `${props.member_id}:${props.grant || props.client || 'mcp'}` });
    rl = success ? 'ok' : 'limited';
    if (!success) return json(rpcError(null, -32002, 'Too many requests; slow down for a minute.'), 429, { ...CORS, 'Retry-After': '60', 'X-Garage-RL': rl });
  }
  let body;
  try { body = await req.json(); } catch { return json(rpcError(null, -32700, 'Parse error'), 400, CORS); }
  const who = { member_id: m.id, is_owner: !!m.is_owner, actor:`${m.name || m.email} via ${String(props.client || 'Claude').slice(0, 40)}` };
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).slice(0, 20).map(msg => handleOne(env, ctx, msg, who)))).filter(Boolean);
  const H = { ...CORS, 'X-Garage-RL': rl };
  if (!replies.length) return new Response(null, { status: 202, headers: H });
  return json(batch ? replies : replies[0], 200, H);
}
