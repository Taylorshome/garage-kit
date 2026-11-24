// Built-in guided-diagnosis plans that are not tied to one vehicle: they match every vehicle of their type
// (plan.vehicle.type, car_id null), so a side-by-side gets them as soon as it is added, on either runtime.
// Researched from the Polaris owner's / service manuals and owner forums (sources on every step); generic, so check
// the specifics (belt width limits, coolant type, fan fuse) in your own machine's manual.
// A plan in the database with the same id (e.g. loaded by scripts/load-research.mjs) replaces the built-in copy.
export const GENERIC_PLANS = [
 {
  "id": "utv-cvt-belt-slip",
  "car_id": null,
  "vehicle": {
   "type": "utv"
  },
  "version": 1,
  "symptom": "CVT belt slipping, burning smell, loss of power or belt squeal",
  "title": "UTV CVT belt slip / burning smell / loss of power",
  "aliases": [
   "belt slip",
   "belt slipping",
   "burning belt",
   "burning rubber smell",
   "belt smell",
   "belt squeal",
   "cvt slipping",
   "clutch slipping",
   "loss of power",
   "no power",
   "bogging",
   "revs but doesn't go",
   "belt burned",
   "glazed belt",
   "pvt slipping"
  ],
  "todo_match": [
   "belt",
   "cvt",
   "clutch",
   "pvt"
  ],
  "intro": "Twelve checks, cheapest first. The first four need no tools: how and where it was driven (Polaris lists high-range loading, climbing, slow crawling and towing as the main belt burners), water in the CVT housing, and blocked CVT cooling ducts. Then the cover comes off for the belt, the inside of the housing and the clutch faces. Clutch internals and belt deflection come last; they're dealer-level on many machines.",
  "safety_overview": "Do all CVT work with the engine off, key out, transmission in PARK and the parking brake set, on level ground. Let the machine cool completely first: the clutches, belt and nearby exhaust get hot enough to burn. Never run the engine with the CVT cover off: a belt or clutch can come apart at high speed. When testing for slip in PARK, don't hold wide-open throttle more than 10 seconds (Polaris).",
  "causes": [
   {
    "id": "worn_belt",
    "name": "Worn, glazed or damaged drive belt",
    "likelihood": "high",
    "fix": "Replace the drive belt with the OEM-specified belt and follow the belt break-in procedure in the manual",
    "cost": "$100-250 belt (verify for your model)",
    "parts": [
     "Drive belt"
    ],
    "keywords": [
     "belt",
     "glazed",
     "hourglass",
     "cords",
     "worn belt"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000792067"
    ]
   },
   {
    "id": "contaminated",
    "name": "Water, mud or oil in the CVT housing (belt contaminated)",
    "likelihood": "medium-high",
    "fix": "Drain the housing, dry the belt and clutches (PVT drying), clean the housing; replace the belt if it was damaged; find the leak (cover seal, duct, clutch seals)",
    "cost": "$0 if drying fixes it; belt and seals if not",
    "parts": [
     "CVT cover seal",
     "Drive belt"
    ],
    "keywords": [
     "water",
     "mud",
     "wet",
     "drain plug",
     "oil"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000861862"
    ]
   },
   {
    "id": "misuse",
    "name": "Driving style: high range at low speed, towing, climbing, loading, or skipped belt break-in",
    "likelihood": "high",
    "fix": "Use low range for loading, towing, climbing, crawling under about 7 mph, mud and plowing; warm the belt up; break in new belts. Usually the belt that suffered still needs replacing.",
    "cost": "$0 (plus a belt if already glazed)",
    "parts": [],
    "keywords": [
     "high range",
     "low range",
     "towing",
     "trailer",
     "break-in",
     "crawling"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000870499"
    ]
   },
   {
    "id": "primary_clutch",
    "name": "Primary (drive) clutch dirty or worn: rollers/weights, buttons, bushings, glazed sheaves",
    "likelihood": "medium",
    "fix": "Clean the sheaves; rebuild or replace worn rollers/weights, buttons and bushings (dealer item on many machines)",
    "cost": "$50-400 (verify)",
    "parts": [
     "Primary clutch rollers/weights",
     "Primary clutch buttons/bushings"
    ],
    "keywords": [
     "primary",
     "drive clutch",
     "rollers",
     "weights",
     "buttons"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000883575"
    ]
   },
   {
    "id": "secondary_clutch",
    "name": "Secondary (driven) clutch worn: helix/cam, spring, rollers or buttons, glazed sheaves",
    "likelihood": "medium",
    "fix": "Clean the sheaves; replace worn helix/cam, spring, rollers or buttons",
    "cost": "$50-400 (verify)",
    "parts": [
     "Secondary clutch helix/cam",
     "Secondary clutch spring",
     "Secondary clutch rollers/buttons"
    ],
    "keywords": [
     "secondary",
     "driven clutch",
     "helix",
     "spring",
     "cam"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000883575"
    ]
   },
   {
    "id": "cvt_cooling",
    "name": "CVT cooling air blocked: intake/outlet duct, pre-filter or screen clogged, crushed or disconnected",
    "likelihood": "medium",
    "fix": "Clear, reconnect or replace the duct/pre-filter; keep the intake out of mud and water",
    "cost": "$0-60",
    "parts": [
     "CVT intake duct",
     "CVT intake pre-filter"
    ],
    "keywords": [
     "duct",
     "intake",
     "pre-filter",
     "screen",
     "cooling"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000870499"
    ]
   },
   {
    "id": "alignment",
    "name": "Belt deflection or clutch alignment out of spec (often after a belt or clutch job, or a non-OEM belt)",
    "likelihood": "low",
    "fix": "Set deflection to spec (shims/spacers on the driven clutch on many machines); check clutch alignment; fit the recommended belt",
    "cost": "$0-50 DIY; dealer labor otherwise",
    "parts": [
     "Driven clutch shims/spacers"
    ],
    "keywords": [
     "deflection",
     "alignment",
     "shim",
     "spacer",
     "wrong belt"
    ],
    "sources": [
     "https://shopeastcentralsports.com/blog/measuring-cvt-belts-odes"
    ]
   },
   {
    "id": "engine_power",
    "name": "Engine itself down on power (clogged air filter, fuel problem), felt as belt slip",
    "likelihood": "low",
    "fix": "Clean/replace the air filter; check the fuel filter and fuel for water/contamination; further engine diagnosis if needed",
    "cost": "$20-60 for filters",
    "parts": [
     "Air filter",
     "Fuel filter"
    ],
    "keywords": [
     "air filter",
     "fuel",
     "bogging",
     "power"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000870499"
    ]
   }
  ],
  "steps": [
   {
    "id": "when_it_happens",
    "title": "When does it slip or smell?",
    "minutes": 2,
    "tools": [],
    "safety": [],
    "do": "Think back over the last ride or two. Pick the situation where the slip, squeal or burning smell showed up first.",
    "look_for": "The pattern: right after water or a wash, under load (towing, climbing, loading, crawling, stuck), with a brand-new belt, or all the time.",
    "tests": [
     "contaminated",
     "misuse",
     "worn_belt",
     "alignment"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000870499",
     "https://publications.polaris.com/owner/owners-manuals/0000867967.xml/$/0000346592"
    ],
    "options": [
     {
      "key": "after_water",
      "label": "After a water crossing, deep mud or a wash",
      "means": "Water in the CVT is the classic cause of sudden slip. The drain-plug check is next.",
      "effects": {
       "contaminated": "up"
      }
     },
     {
      "key": "under_load",
      "label": "Under load: towing, climbing, loading on a trailer, crawling or stuck",
      "means": "Polaris lists these as the main belt-burn situations when done in high range. Range use is next.",
      "effects": {
       "misuse": "up",
       "worn_belt": "up"
      }
     },
     {
      "key": "new_belt",
      "label": "Started soon after a new belt or clutch work",
      "means": "Skipped break-in, the wrong belt, or deflection/alignment set wrong are now more likely.",
      "effects": {
       "misuse": "up",
       "alignment": "up"
      }
     },
     {
      "key": "all_the_time",
      "label": "All the time / getting gradually worse",
      "means": "Points to a worn belt or worn clutches rather than one bad moment.",
      "effects": {
       "worn_belt": "up",
       "primary_clutch": "up",
       "secondary_clutch": "up"
      }
     }
    ]
   },
   {
    "id": "range_use",
    "title": "High vs low range habits",
    "minutes": 2,
    "tools": [],
    "safety": [],
    "do": "Be honest about how the machine is usually driven: is low range used for loading onto a trailer, towing, steep climbs from a stop, crawling under about 7 mph, mud and plowing? Was the last belt broken in per the manual? Is the belt warmed up in cold weather?",
    "look_for": "Whether slow, loaded work is regularly done in high range.",
    "tests": [
     "misuse"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000870499"
    ],
    "options": [
     {
      "key": "high_range_work",
      "label": "Yes, slow or loaded work often happens in high",
      "means": "That's the most common belt killer. Change the habit; the belt may already be glazed, so keep going and inspect it.",
      "effects": {
       "misuse": "up"
      }
     },
     {
      "key": "low_range_used",
      "label": "No, low range is used for that work",
      "means": "Driving style is less likely the cause.",
      "effects": {
       "misuse": "down"
      }
     }
    ]
   },
   {
    "id": "drain_plug",
    "title": "Drain the CVT housing and dry it",
    "minutes": 10,
    "tools": [
     "socket or wrench for the clutch cover drain plug"
    ],
    "safety": [
     "Engine off, key out, PARK, parking brake on, machine cool before touching the cover.",
     "For the drying run: in PARK with brakes applied, varying throttle 10-15 seconds, never wide open for more than 10 seconds."
    ],
    "do": "Find the drain plug at the bottom of the CVT/clutch cover (see the manual). Remove it over a pan and see what comes out, then reinstall it. If water came out, do the manual's PVT drying: in PARK with brakes on, start the engine, vary the throttle 10-15 seconds, let it idle, shift to low range and drive forward slowly to test for slip. Repeat once if it still slips.",
    "look_for": "Water or muddy water out of the drain, and whether the slip is gone after drying.",
    "tests": [
     "contaminated"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000861862",
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000865008"
    ],
    "options": [
     {
      "key": "water_fixed",
      "label": "Water came out, and it stopped slipping after drying",
      "means": "Water in the CVT was the cause. Find how it got in (duct, cover seal, clutch seals) and avoid spraying water at the CVT intake.",
      "effects": {
       "contaminated": "confirm"
      },
      "found": "contaminated",
      "confidence": "high"
     },
     {
      "key": "water_still_slips",
      "label": "Water came out, but it still slips after drying twice",
      "means": "Water got in, and the belt or clutches may now be damaged or coated. Pull the cover and inspect.",
      "effects": {
       "contaminated": "up",
       "worn_belt": "up"
      }
     },
     {
      "key": "dry",
      "label": "Nothing or only a few drops",
      "means": "Water in the housing is unlikely.",
      "effects": {
       "contaminated": "down"
      }
     }
    ]
   },
   {
    "id": "cvt_ducts",
    "title": "CVT intake and outlet ducts, pre-filter",
    "minutes": 10,
    "tools": [
     "flashlight",
     "screwdriver for duct clamps"
    ],
    "safety": [
     "Engine off, key out, cool machine."
    ],
    "do": "Follow the CVT intake duct from its inlet (often under the bed or behind the seats) to the clutch cover, and the outlet duct away from it. Check any intake pre-filter or screen. Squeeze along the hoses and check the clamps.",
    "look_for": "Clogged pre-filter or screen, mud or water in the duct, crushed or kinked hose, loose clamp or disconnected duct.",
    "tests": [
     "cvt_cooling",
     "contaminated"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000870499",
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000792067"
    ],
    "options": [
     {
      "key": "blocked",
      "label": "Clogged, crushed or disconnected",
      "means": "The CVT isn't getting cooling air, which overheats and glazes the belt. Fix it; inspect the belt before trusting it again.",
      "effects": {
       "cvt_cooling": "confirm",
       "worn_belt": "up"
      }
     },
     {
      "key": "wet_duct",
      "label": "Mud or water inside the duct",
      "means": "That's how water or mud is getting into the CVT.",
      "effects": {
       "contaminated": "up",
       "cvt_cooling": "up"
      }
     },
     {
      "key": "clear",
      "label": "Clear, connected, clamps tight",
      "means": "CVT cooling airflow is fine.",
      "effects": {
       "cvt_cooling": "rule_out"
      }
     }
    ]
   },
   {
    "id": "air_filter",
    "title": "Engine air filter",
    "minutes": 10,
    "tools": [
     "flashlight"
    ],
    "safety": [
     "Engine off. Don't let dirt fall into the intake with the filter out."
    ],
    "do": "Open the airbox and look at the engine air filter and the airbox for dirt, water or a badly seated filter.",
    "look_for": "Filter caked with dust or mud, water in the airbox, filter not sealed.",
    "tests": [
     "engine_power"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000870499",
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000865008"
    ],
    "options": [
     {
      "key": "clogged",
      "label": "Clogged, wet or not sealing",
      "means": "A choked engine feels a lot like belt slip. Replace the filter and retest before spending on belt or clutch parts.",
      "effects": {
       "engine_power": "up"
      }
     },
     {
      "key": "clean",
      "label": "Clean and seated",
      "means": "Air filter isn't the problem. Fuel problems remain possible but less likely.",
      "effects": {
       "engine_power": "down"
      }
     }
    ]
   },
   {
    "id": "belt_visual",
    "title": "Remove the CVT cover and look at the belt",
    "minutes": 30,
    "tools": [
     "sockets/driver for the cover fasteners",
     "clutch spreader tool (in the vehicle tool kit on many machines)",
     "flashlight"
    ],
    "safety": [
     "Only after the machine has completely cooled. Level ground, PARK, key out.",
     "Note the belt's direction of rotation if it might go back in.",
     "Never start the engine with the cover off."
    ],
    "do": "Remove the CVT intake duct and the outer clutch cover (check the cover seal). Open the driven clutch with the spreader tool, walk the belt off, and inspect it all the way round under good light.",
    "look_for": "Glazed (shiny, hard) sides, hourglassing or flat spots, burned spots, frayed edges, loose or exposed cords, missing cogs, cracks.",
    "tests": [
     "worn_belt",
     "misuse"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000792067",
     "https://www.gates.com/content/dam/gates/home/solutions/gates-g-force/g-force-cvt-belt-failure-analysis.pdf"
    ],
    "options": [
     {
      "key": "glazed_flat",
      "label": "Glazed sides, hourglass or flat/burned spots",
      "means": "Heat damage: the belt slipped against the sheaves, typically from loading or crawling in high range, or a stuck machine. Replace it, and keep checking the cause so the new one doesn't go the same way.",
      "effects": {
       "worn_belt": "confirm",
       "misuse": "up"
      }
     },
     {
      "key": "cords_cogs",
      "label": "Frayed, cords showing, missing cogs or cracked",
      "means": "The belt is done and close to breaking. Replace it before riding again.",
      "effects": {
       "worn_belt": "confirm"
      },
      "found": "worn_belt",
      "confidence": "medium",
      "stop": "Don't ride on it: a belt that lets go can damage the clutches and cover."
     },
     {
      "key": "looks_good",
      "label": "Looks good all the way round",
      "means": "No visible damage. Measure the width next to be sure.",
      "effects": {
       "worn_belt": "down"
      }
     }
    ]
   },
   {
    "id": "belt_width",
    "title": "Measure belt width against spec",
    "minutes": 10,
    "tools": [
     "caliper",
     "two straight edges",
     "owner's/service manual for the belt width spec"
    ],
    "safety": [
     "Engine off, key out."
    ],
    "do": "Look up the new-belt width and service limit for your machine (owner's or service manual). Measure across the top of the belt at a few points, using straight edges along the sides so trimmed edges don't read low.",
    "look_for": "Width at or below the service limit, or uneven width around the belt.",
    "tests": [
     "worn_belt"
    ],
    "sources": [
     "https://shopeastcentralsports.com/blog/measuring-cvt-belts-odes",
     "https://www.cyclepedia.com/manuals/online/cpp-153/periodic-maintenance/belt-inspection/"
    ],
    "options": [
     {
      "key": "under_limit",
      "label": "At or under the service limit",
      "means": "The belt is worn out; a narrow belt rides low in the primary and slips. Replace it.",
      "effects": {
       "worn_belt": "confirm"
      },
      "found": "worn_belt",
      "confidence": "high"
     },
     {
      "key": "in_spec",
      "label": "Within spec, even all round",
      "means": "The belt itself is OK. Look at the housing and clutches.",
      "effects": {
       "worn_belt": "rule_out"
      }
     }
    ]
   },
   {
    "id": "housing_inside",
    "title": "Inside of the CVT housing",
    "minutes": 5,
    "tools": [
     "flashlight",
     "phone camera to look behind the clutches"
    ],
    "safety": [
     "Engine off, key out."
    ],
    "do": "With the belt out, look inside the cover and around both clutches (a phone camera helps behind them).",
    "look_for": "Heavy black rubber dust or belt chunks, mud, standing water marks, oil film (oil means a seal leak and trapped debris).",
    "tests": [
     "contaminated",
     "worn_belt",
     "primary_clutch"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000792067"
    ],
    "options": [
     {
      "key": "heavy_dust",
      "label": "Lots of rubber dust or belt chunks",
      "means": "The belt has been slipping and shedding. Clean everything out; the sheave check is next. (Rubber dust as a clutch-fault sign is forum lore: verify.)",
      "effects": {
       "worn_belt": "up",
       "primary_clutch": "up"
      }
     },
     {
      "key": "mud_oil",
      "label": "Mud, water marks or oil film",
      "means": "The belt is running contaminated. Clean the housing with the cleaner the belt maker recommends, fix the leak or seal, and expect to replace the belt.",
      "effects": {
       "contaminated": "confirm"
      }
     },
     {
      "key": "clean",
      "label": "Light dust only, dry",
      "means": "Normal. Contamination unlikely.",
      "effects": {
       "contaminated": "down"
      }
     }
    ]
   },
   {
    "id": "sheaves",
    "title": "Clutch sheave faces",
    "minutes": 10,
    "tools": [
     "flashlight",
     "clean rag",
     "alcohol or acetone (not brake cleaner, per Gates)"
    ],
    "safety": [
     "Engine off, key out, clutches cool."
    ],
    "do": "Look at the belt contact faces of both clutches (primary/drive and secondary/driven). Wipe a spot with alcohol or acetone to see the bare surface.",
    "look_for": "Shiny glazed rings or baked-on belt residue, grooves or a step worn into the faces, scoring, rust.",
    "tests": [
     "primary_clutch",
     "secondary_clutch"
    ],
    "sources": [
     "https://www.gates.com/content/dam/gates/home/solutions/gates-g-force/g-force-cvt-belt-failure-analysis.pdf"
    ],
    "options": [
     {
      "key": "glazed",
      "label": "Glazed or coated with residue (cleans off)",
      "means": "Residue makes a new belt slip too. Clean both clutches before fitting a belt.",
      "effects": {
       "primary_clutch": "up",
       "secondary_clutch": "up"
      }
     },
     {
      "key": "grooved",
      "label": "Grooved, stepped or scored",
      "means": "Worn sheaves. The clutch needs parts or replacing; a dealer or clutch shop can confirm which.",
      "effects": {
       "primary_clutch": "up",
       "secondary_clutch": "up"
      }
     },
     {
      "key": "smooth",
      "label": "Smooth and clean",
      "means": "Sheave faces are fine.",
      "effects": {
       "primary_clutch": "down",
       "secondary_clutch": "down"
      }
     }
    ]
   },
   {
    "id": "deflection",
    "title": "Belt deflection (and alignment)",
    "minutes": 15,
    "tools": [
     "straight edge",
     "ruler or deflection tool",
     "manual for the deflection spec"
    ],
    "safety": [
     "Engine off, key out, PARK. Belt back on and seated (rotate the clutches several turns)."
    ],
    "do": "With the belt installed and both clutches at rest in neutral position, lay a straight edge across the belt midway between the clutches, press down and measure how far it moves. Compare with the manual's spec.",
    "look_for": "Deflection outside the spec range (worn belts read higher).",
    "tests": [
     "alignment"
    ],
    "sources": [
     "https://shopeastcentralsports.com/blog/measuring-cvt-belts-odes",
     "https://www.cyclepedia.com/manuals/online/cpp-153/periodic-maintenance/belt-inspection/"
    ],
    "options": [
     {
      "key": "out_of_spec",
      "label": "Outside the spec",
      "means": "Belt sits wrong in the clutches. Adjust (usually shims on the driven clutch) or have alignment checked.",
      "effects": {
       "alignment": "confirm"
      },
      "found": "alignment",
      "confidence": "medium"
     },
     {
      "key": "in_spec",
      "label": "Within spec",
      "means": "Deflection is fine.",
      "effects": {
       "alignment": "down"
      }
     }
    ]
   },
   {
    "id": "primary_internals",
    "title": "Primary clutch internals (dealer-level on many machines)",
    "minutes": 60,
    "tools": [
     "clutch puller and holder for your model",
     "service manual"
    ],
    "safety": [
     "Clutches are spring-loaded: use the correct tools and the service manual. Many owners leave this to a dealer."
    ],
    "do": "Remove and open the primary clutch per the service manual (or have a dealer do it). Inspect rollers/weights, pins, buttons and bushings.",
    "look_for": "Flat-spotted rollers, worn weights or pins, worn buttons, sloppy bushings, sticking movement.",
    "tests": [
     "primary_clutch"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000883575"
    ],
    "options": [
     {
      "key": "worn",
      "label": "Worn rollers/weights, buttons or bushings",
      "means": "The primary isn't clamping or shifting right. Rebuild it.",
      "effects": {
       "primary_clutch": "confirm"
      },
      "found": "primary_clutch",
      "confidence": "high"
     },
     {
      "key": "good",
      "label": "All within spec, moves freely",
      "means": "Primary clutch is fine.",
      "effects": {
       "primary_clutch": "rule_out"
      }
     }
    ]
   },
   {
    "id": "secondary_internals",
    "title": "Secondary clutch internals (dealer-level on many machines)",
    "minutes": 60,
    "tools": [
     "clutch tools for your model",
     "service manual"
    ],
    "safety": [
     "The driven clutch spring is under load: use the correct compressor and the service manual."
    ],
    "do": "Remove and open the secondary clutch per the service manual (or have a dealer do it). Inspect the helix/cam, rollers or buttons, and the spring.",
    "look_for": "Worn or notched helix/cam ramps, worn rollers or buttons, a tired or broken spring (compare free length to spec).",
    "tests": [
     "secondary_clutch"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000883575"
    ],
    "options": [
     {
      "key": "worn",
      "label": "Worn helix/cam, rollers/buttons or weak spring",
      "means": "The secondary isn't holding belt tension. Replace the worn parts.",
      "effects": {
       "secondary_clutch": "confirm"
      },
      "found": "secondary_clutch",
      "confidence": "high"
     },
     {
      "key": "good",
      "label": "All within spec",
      "means": "Secondary clutch is fine.",
      "effects": {
       "secondary_clutch": "rule_out"
      }
     }
    ]
   }
  ]
 },
 {
  "id": "utv-overheating",
  "car_id": null,
  "vehicle": {
   "type": "utv"
  },
  "version": 1,
  "symptom": "Overheating, hot light on, or coolant boiling over",
  "title": "UTV overheating / hot light / boil-over",
  "aliases": [
   "overheating",
   "overheats",
   "running hot",
   "hot light",
   "temp light",
   "temperature warning",
   "boiling over",
   "coolant boil over",
   "puking coolant",
   "steam",
   "fan not coming on",
   "temp bars high"
  ],
  "todo_match": [
   "overheat",
   "running hot",
   "coolant",
   "radiator",
   "fan"
  ],
  "intro": "Twelve checks, cheapest and most likely first. On side-by-sides the usual suspects are a radiator packed with mud (often hidden between the fan shroud and the core), low coolant or trapped air, and a fan that doesn't come on (fuse, relay, connector, sensor or motor). Then how it was driven, the cap, thermostat and water pump; head gasket last.",
  "safety_overview": "Never open the radiator or pressure cap while the engine is warm or hot: escaping steam and coolant burn (Polaris). Let it cool fully first. The electric fan can start with the key on even when the engine is off: keep hands, tools and loose clothing clear. If the hot light comes on, stop and shut the engine off. Don't use a high-pressure washer on radiator fins. Coolant is toxic: wipe spills and keep pets away.",
  "causes": [
   {
    "id": "mud_radiator",
    "name": "Radiator clogged with mud or debris (often packed between fan and core)",
    "likelihood": "high",
    "fix": "Clean the radiator from the back side with a garden hose (no pressure washer); remove the fan shroud if mud is packed behind it; consider a radiator screen or relocation kit for mud riding",
    "cost": "$0",
    "parts": [
     "Radiator"
    ],
    "keywords": [
     "mud",
     "radiator",
     "clogged",
     "debris",
     "fins"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000409686"
    ]
   },
   {
    "id": "low_coolant",
    "name": "Low coolant or air trapped in the system (needs bleeding)",
    "likelihood": "high",
    "fix": "Top up with the specified coolant, find any leak, and bleed air per the owner's/service manual procedure",
    "cost": "$0-40 plus any leak repair",
    "parts": [
     "Coolant"
    ],
    "keywords": [
     "coolant",
     "low coolant",
     "air pocket",
     "bleed",
     "leak"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000791855"
    ]
   },
   {
    "id": "fan",
    "name": "Cooling fan not running (fuse, relay, temp sensor, connector water damage, or fan motor)",
    "likelihood": "medium-high",
    "fix": "Replace the blown fuse (and find why it blew), relay, sensor, dried/cleaned connector, or the fan motor",
    "cost": "$5-250",
    "parts": [
     "Fan motor",
     "Fan fuse",
     "Fan relay",
     "Coolant temperature sensor"
    ],
    "keywords": [
     "fan",
     "fuse",
     "relay",
     "sensor",
     "connector"
    ],
    "sources": [
     "https://cararac.com/blog/can-am-overheating-problems-solutions.html"
    ]
   },
   {
    "id": "usage",
    "name": "Driving load: slow crawling, mud or heavy loads in high range, long idling",
    "likelihood": "medium",
    "fix": "Use low range for slow, loaded work; give it airflow and cool-down stops; a fan override switch helps for mud",
    "cost": "$0",
    "parts": [],
    "keywords": [
     "low speed",
     "high range",
     "idling",
     "load",
     "mud"
    ],
    "sources": [
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine"
    ]
   },
   {
    "id": "cap",
    "name": "Radiator / pressure cap not holding pressure",
    "likelihood": "low-medium",
    "fix": "Replace the cap",
    "cost": "$15-40",
    "parts": [
     "Radiator cap"
    ],
    "keywords": [
     "cap",
     "pressure cap",
     "radiator cap"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000791855"
    ]
   },
   {
    "id": "thermostat",
    "name": "Thermostat stuck closed or partly closed",
    "likelihood": "low-medium",
    "fix": "Replace the thermostat (don't delete it)",
    "cost": "$20-60",
    "parts": [
     "Thermostat"
    ],
    "keywords": [
     "thermostat"
    ],
    "sources": [
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine"
    ]
   },
   {
    "id": "water_pump",
    "name": "Water pump leaking or impeller worn (not circulating)",
    "likelihood": "low-medium",
    "fix": "Rebuild or replace the water pump (seal, impeller)",
    "cost": "$50-300 (verify)",
    "parts": [
     "Water pump"
    ],
    "keywords": [
     "water pump",
     "impeller",
     "weep hole"
    ],
    "sources": [
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine"
    ]
   },
   {
    "id": "head_gasket",
    "name": "Head gasket leaking combustion gas into the coolant",
    "likelihood": "low",
    "fix": "Head gasket repair (big job); decide if it's worth it",
    "cost": "$300-1500+ (verify)",
    "parts": [
     "Head gasket"
    ],
    "keywords": [
     "head gasket",
     "combustion",
     "bubbles",
     "milky"
    ],
    "sources": [
     "https://www.superatv.com/offroad-atlas/utv-over-heating"
    ]
   }
  ],
  "steps": [
   {
    "id": "when_it_happens",
    "title": "When does it overheat?",
    "minutes": 2,
    "tools": [],
    "safety": [],
    "do": "Think back to when the hot light or boil-over happened.",
    "look_for": "The pattern: slow/mud/loaded/idling, at speed on open trail, or soon after coolant work.",
    "tests": [
     "usage",
     "mud_radiator",
     "fan",
     "low_coolant",
     "thermostat"
    ],
    "sources": [
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine",
     "https://fatboysoffroad.com/can-am-maverick-overheating/"
    ],
    "options": [
     {
      "key": "slow_load",
      "label": "Slow crawling, mud, heavy load or idling",
      "means": "Little airflow, so the fan does all the work: a mud-packed radiator, dead fan or high-range crawling are the likely causes.",
      "effects": {
       "usage": "up",
       "fan": "up",
       "mud_radiator": "up"
      }
     },
     {
      "key": "at_speed",
      "label": "At speed, with plenty of airflow",
      "means": "Airflow should be cooling it here, so blockage, low coolant, thermostat or pump are more likely than the fan.",
      "effects": {
       "mud_radiator": "up",
       "low_coolant": "up",
       "thermostat": "up",
       "fan": "down",
       "usage": "down"
      }
     },
     {
      "key": "after_service",
      "label": "Soon after a coolant change or cooling repair",
      "means": "Trapped air from incomplete bleeding is the top suspect.",
      "effects": {
       "low_coolant": "up"
      }
     }
    ]
   },
   {
    "id": "radiator_look",
    "title": "Look at the radiator, front and back (cold)",
    "minutes": 10,
    "tools": [
     "flashlight"
    ],
    "safety": [
     "Key out so the fan can't start. Engine cool."
    ],
    "do": "Look through the grille at the radiator face, then from behind with a flashlight between the fan/shroud and the core. Mud often packs there while the front looks clean.",
    "look_for": "Fins packed with dried mud, grass or debris; bent/flattened fins; mud caked on the fan blades.",
    "tests": [
     "mud_radiator"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000409686",
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine"
    ],
    "options": [
     {
      "key": "packed",
      "label": "Packed with mud/debris (front or behind the fan)",
      "means": "That alone causes overheating. Clean it with a garden hose from the back (no pressure washer) and retest.",
      "effects": {
       "mud_radiator": "confirm"
      },
      "found": "mud_radiator",
      "confidence": "medium"
     },
     {
      "key": "partial",
      "label": "Some dirt, partly blocked",
      "means": "It's contributing. Clean it anyway and keep checking.",
      "effects": {
       "mud_radiator": "up"
      }
     },
     {
      "key": "clean",
      "label": "Clean all the way through",
      "means": "Airflow through the radiator isn't the problem.",
      "effects": {
       "mud_radiator": "rule_out"
      }
     }
    ]
   },
   {
    "id": "coolant_level",
    "title": "Coolant level, cold",
    "minutes": 5,
    "tools": [
     "flashlight"
    ],
    "safety": [
     "Engine fully cold. Never open the cap warm or hot."
    ],
    "do": "Check the level in the coolant reservoir/pressure tank against the cold mark the manual specifies. If the manual says to, also check the radiator itself when cold.",
    "look_for": "Level vs the cold mark; color (should be clean; brown, oily or milky is bad).",
    "tests": [
     "low_coolant",
     "head_gasket"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000791855",
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000776278"
    ],
    "options": [
     {
      "key": "full",
      "label": "At the cold mark, clean color",
      "means": "Coolant is full right now.",
      "effects": {
       "low_coolant": "down"
      }
     },
     {
      "key": "low",
      "label": "Below the mark",
      "means": "It's losing coolant (or it was never bled). Top up with the specified coolant and look for the leak next.",
      "effects": {
       "low_coolant": "up"
      }
     },
     {
      "key": "empty",
      "label": "Empty / can't see coolant",
      "means": "Very low coolant explains overheating. Refill and bleed before riding.",
      "effects": {
       "low_coolant": "confirm"
      },
      "stop": "Don't ride it until it's refilled and bled."
     },
     {
      "key": "milky_oily",
      "label": "Oily or milky coolant",
      "means": "Oil and coolant mixing points toward a head gasket (verify with a combustion leak test).",
      "effects": {
       "head_gasket": "up"
      }
     }
    ]
   },
   {
    "id": "leaks",
    "title": "Look for leaks",
    "minutes": 15,
    "tools": [
     "flashlight",
     "rag"
    ],
    "safety": [
     "Engine cool, key out."
    ],
    "do": "Follow the hoses from the radiator (usually up front) back to the engine (usually mid/rear on side-by-sides), and check the water pump area, the radiator end tanks and the reservoir.",
    "look_for": "Wet spots, dried coolant crust, a drip from the water pump weep hole, soft or cracked hoses, loose clamps.",
    "tests": [
     "low_coolant",
     "water_pump"
    ],
    "sources": [
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine",
     "https://www.superatv.com/offroad-atlas/utv-over-heating"
    ],
    "options": [
     {
      "key": "hose_leak",
      "label": "Leak at a hose, clamp, radiator or tank",
      "means": "That's where the coolant goes. Fix it, refill and bleed.",
      "effects": {
       "low_coolant": "confirm"
      }
     },
     {
      "key": "pump_weep",
      "label": "Coolant from the water pump weep hole",
      "means": "The pump seal is failing: the pump is due.",
      "effects": {
       "water_pump": "confirm",
       "low_coolant": "up"
      }
     },
     {
      "key": "dry",
      "label": "Dry everywhere",
      "means": "No external leak found.",
      "effects": {
       "water_pump": "down"
      }
     }
    ]
   },
   {
    "id": "fan_runs",
    "title": "Does the fan come on when hot?",
    "minutes": 15,
    "tools": [],
    "safety": [
     "PARK, parking brake on, outdoors (exhaust).",
     "Keep hands and clothing away from the fan: it starts on its own.",
     "If the hot light comes on before the fan does, shut it off."
    ],
    "do": "Idle the machine in PARK and watch the temperature display and the fan. On most machines the fan should start before the gauge reaches the hot zone.",
    "look_for": "Fan starts and pulls air through the radiator before it gets to the hot light.",
    "tests": [
     "fan",
     "thermostat"
    ],
    "sources": [
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine",
     "https://cararac.com/blog/can-am-overheating-problems-solutions.html"
    ],
    "options": [
     {
      "key": "runs",
      "label": "Fan comes on and temperature drops",
      "means": "The fan circuit works.",
      "effects": {
       "fan": "rule_out"
      }
     },
     {
      "key": "never",
      "label": "Fan never comes on, temperature keeps climbing",
      "means": "Fan circuit problem. Check the fuse, connector and relay next.",
      "effects": {
       "fan": "up"
      }
     },
     {
      "key": "never_warms",
      "label": "Temperature barely rises at idle, but it overheats on the trail",
      "means": "Possibly a sticking thermostat or a load problem rather than the fan.",
      "effects": {
       "thermostat": "up",
       "usage": "up"
      }
     }
    ]
   },
   {
    "id": "fan_fuse",
    "title": "Fan fuse, relay and connector",
    "minutes": 15,
    "tools": [
     "fuse puller",
     "multimeter or test light",
     "dielectric grease"
    ],
    "safety": [
     "Key off while pulling fuses and relays."
    ],
    "do": "Find the fan fuse and relay in the fuse box (map is in the manual or on the cover). Check the fuse, swap the relay with an identical one, and unplug the fan connector to look for water, mud or green corrosion.",
    "look_for": "Blown fuse, relay that clicks/doesn't, corroded or wet pins, burnt connector.",
    "tests": [
     "fan"
    ],
    "sources": [
     "https://cararac.com/blog/can-am-overheating-problems-solutions.html",
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000865008"
    ],
    "options": [
     {
      "key": "fuse_blown",
      "label": "Fuse blown",
      "means": "Replace it. If it blows again when the fan kicks on, the fan motor (often mud-damaged) is drawing too much and needs replacing.",
      "effects": {
       "fan": "confirm"
      },
      "found": "fan",
      "confidence": "medium"
     },
     {
      "key": "connector_bad",
      "label": "Connector wet, muddy or corroded / relay bad",
      "means": "Clean and dry the connector (dielectric grease), replace a bad relay, and retest.",
      "effects": {
       "fan": "confirm"
      },
      "found": "fan",
      "confidence": "medium"
     },
     {
      "key": "all_ok",
      "label": "Fuse, relay and connector all good",
      "means": "Test the motor directly next.",
      "effects": {}
     }
    ]
   },
   {
    "id": "fan_direct",
    "title": "Power the fan motor directly",
    "minutes": 10,
    "tools": [
     "fused jumper leads",
     "12 V battery"
    ],
    "safety": [
     "Use a fused lead. Keep fingers clear: the fan spins up at once."
    ],
    "do": "Unplug the fan and feed it 12 V straight from the battery with fused jumper leads (watch polarity; follow the service manual if it gives a procedure).",
    "look_for": "Whether the fan spins freely and strongly.",
    "tests": [
     "fan"
    ],
    "sources": [
     "https://cararac.com/blog/can-am-overheating-problems-solutions.html"
    ],
    "options": [
     {
      "key": "dead",
      "label": "Doesn't spin, or spins weakly / grinds",
      "means": "The fan motor is bad. Replace it.",
      "effects": {
       "fan": "confirm"
      },
      "found": "fan",
      "confidence": "high"
     },
     {
      "key": "spins",
      "label": "Spins strongly",
      "means": "Motor is fine. If it still won't come on by itself, the temperature sensor or ECU fan control is next (dealer scan tool helps).",
      "effects": {
       "fan": "down"
      }
     }
    ]
   },
   {
    "id": "hose_temps",
    "title": "Radiator hoses once warm (thermostat check)",
    "minutes": 15,
    "tools": [
     "infrared thermometer (optional)"
    ],
    "safety": [
     "Touch hoses carefully: they get hot. Don't open the cap. Keep clear of the fan."
    ],
    "do": "Warm it up to normal temperature in PARK. Feel or IR-read the hose into the radiator and the hose out of it, and the radiator core.",
    "look_for": "Engine hot but the radiator and its hoses stay cool = coolant not flowing (thermostat or pump).",
    "tests": [
     "thermostat",
     "water_pump"
    ],
    "sources": [
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine",
     "https://www.superatv.com/offroad-atlas/utv-over-heating"
    ],
    "options": [
     {
      "key": "radiator_cold",
      "label": "Engine hot, radiator stays cool",
      "means": "Coolant isn't reaching the radiator: thermostat stuck closed most likely, or the pump isn't moving it.",
      "effects": {
       "thermostat": "up",
       "water_pump": "up"
      }
     },
     {
      "key": "both_hot",
      "label": "Radiator inlet and core get hot",
      "means": "Thermostat is opening and coolant is flowing.",
      "effects": {
       "thermostat": "rule_out",
       "water_pump": "down"
      }
     }
    ]
   },
   {
    "id": "cap_check",
    "title": "Radiator / pressure cap",
    "minutes": 10,
    "tools": [
     "cooling-system pressure tester with cap adapter (optional)"
    ],
    "safety": [
     "Only on a cold engine."
    ],
    "do": "Remove the cap cold. Look at the rubber seal and spring. If you have a tester and the right adapter, check it holds the pressure stamped on it.",
    "look_for": "Cracked, hard or missing seal; weak spring; cap won't hold rated pressure.",
    "tests": [
     "cap"
    ],
    "sources": [
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000791855"
    ],
    "options": [
     {
      "key": "bad",
      "label": "Seal damaged or won't hold pressure",
      "means": "A weak cap lowers the boiling point and lets coolant escape. Replace it.",
      "effects": {
       "cap": "confirm"
      },
      "found": "cap",
      "confidence": "medium"
     },
     {
      "key": "good",
      "label": "Seal good / holds pressure",
      "means": "Cap is fine.",
      "effects": {
       "cap": "rule_out"
      }
     }
    ]
   },
   {
    "id": "bleed",
    "title": "Refill and bleed the air out",
    "minutes": 45,
    "tools": [
     "specified coolant",
     "funnel",
     "service manual for the bleed procedure"
    ],
    "safety": [
     "Start cold. Never open bleed screws or the cap on a hot system.",
     "Some procedures raise one end of the machine: support it securely."
    ],
    "do": "Top up and bleed exactly as the manual describes (bleed screw, raising the front, several warm-up/cool-down cycles). Then test ride the way it overheated before.",
    "look_for": "Bubbles out of the bleeder or filler, the level dropping as air leaves, and whether the overheating stops afterwards.",
    "tests": [
     "low_coolant"
    ],
    "sources": [
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine",
     "https://publications.polaris.com/owner/owners-manuals/0000881301.xml/$/0000791855"
    ],
    "options": [
     {
      "key": "fixed",
      "label": "Lots of air came out, and it stays cool now",
      "means": "Trapped air / low coolant was the problem. Recheck the cold level after the next few rides.",
      "effects": {
       "low_coolant": "confirm"
      },
      "found": "low_coolant",
      "confidence": "high"
     },
     {
      "key": "still_hot",
      "label": "Bled it properly, still overheats",
      "means": "Air wasn't the (only) problem. Keep going.",
      "effects": {
       "low_coolant": "down"
      }
     }
    ]
   },
   {
    "id": "pump_check",
    "title": "Water pump circulation",
    "minutes": 60,
    "tools": [
     "service manual",
     "drain pan",
     "hand tools"
    ],
    "safety": [
     "Engine cold. Catch and dispose of coolant properly."
    ],
    "do": "With hose temps suggesting poor flow and the thermostat ruled out, inspect the pump per the service manual: wobble in the shaft, leaks, and the impeller vanes (worn, broken or eroded).",
    "look_for": "Worn or broken impeller, shaft play, seal leak.",
    "tests": [
     "water_pump"
    ],
    "sources": [
     "https://www.everythingcanamoffroad.com/ecc-blog/tips-and-tricks-for-cooling-your-maverick-engine"
    ],
    "options": [
     {
      "key": "worn",
      "label": "Impeller worn/broken or shaft loose",
      "means": "The pump can't move enough coolant. Rebuild or replace it.",
      "effects": {
       "water_pump": "confirm"
      },
      "found": "water_pump",
      "confidence": "high"
     },
     {
      "key": "good",
      "label": "Impeller and shaft fine",
      "means": "Water pump is fine.",
      "effects": {
       "water_pump": "rule_out"
      }
     }
    ]
   },
   {
    "id": "block_test",
    "title": "Combustion leak (block) test",
    "minutes": 20,
    "tools": [
     "combustion leak tester kit (parts-store loaner or about $40-60)"
    ],
    "safety": [
     "Start cold with the cap off only as the kit directs; stop if coolant rises toward the tester."
    ],
    "do": "Follow the kit's instructions: draw air from above the coolant through the test fluid with the engine running, cold and again warm.",
    "look_for": "Blue fluid turning yellow/green = exhaust gas in the coolant.",
    "tests": [
     "head_gasket"
    ],
    "sources": [
     "https://www.superatv.com/offroad-atlas/utv-over-heating"
    ],
    "options": [
     {
      "key": "blue",
      "label": "Stays blue",
      "means": "No combustion gas in the coolant. Head gasket unlikely.",
      "effects": {
       "head_gasket": "rule_out"
      }
     },
     {
      "key": "yellow",
      "label": "Turns yellow / green",
      "means": "Exhaust gas is getting into the coolant: head gasket or cracked head. Big repair.",
      "effects": {
       "head_gasket": "confirm"
      },
      "found": "head_gasket",
      "confidence": "high"
     }
    ]
   }
  ]
 }
];
