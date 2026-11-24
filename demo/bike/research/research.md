# 2007 Yamaha V Star 650 (variant unknown), mileage unknown

Research date: Nov 24, 2026. Research only. Nobody has inspected the bike. The scope was cut to a demo/test vehicle partway through, so this is a short report.

**Tags used in this report**
- **[src]**: backed by a URL in Sources.
- **[gk]**: general knowledge, not checked against a source for this bike.
- **[verify]**: a source exists but it's weak, or it's for a different market or year.

**Main source:** the Yamaha XVS650Y/XVS650AY owner's manual (2009 model year, publication 3B7-28199-23). The public copy is on cyclechaos.com, whose robots.txt allows reference use. It covers the Custom and the Classic. It is a **non-US edition**: it lists an immobilizer, a carburetor heater fuse and km-based intervals. The engine and drivetrain are the same for 1998–2016 [gk], so I flag only the US-specific details to verify.

---

## Bottom line

1. **Confirm the variant first.** A 19 in front wheel means a Custom (XVS650). A fat 16 in front tire with floorboards means a Classic (XVS650A). A Classic with a factory windshield and bags is a Silverado (XVS650AT). Front tire pressure depends on it: 29 psi on the Custom, 33 psi on the Classic.
2. **Read the tire DOT date codes.** Replace any tire older than about 5–6 years [gk].
3. **Recalls:** NHTSA lists **none** for the 2007 "V STAR". Still run the VIN at nhtsa.gov/recalls.
4. **Most likely problem on a stored bike:** gummed carburetors and clogged pilot jets. It runs only on choke, or won't idle. See the guided diagnosis plan "hard starting / will not idle" (`diagnosis-plans.json`).
5. **The battery is a GT12B-4 (12 V, 10 Ah)**, not a YTX14-BS. That's from the 2009 manual; check the battery actually fitted.

---

## Specs (manual pages 9-1 to 9-3 unless noted)

| Item | Value |
|---|---|
| Engine | 649 cc, air-cooled, 4-stroke, SOHC 70° V-twin, 2 valves per cylinder. Bore × stroke 81 × 63 mm, compression 9.0:1. The 70° angle and 2 valves come from moto-data.net. [src] |
| Carburetors | Mikuni **BDS28** × 2 (not BSR28). [src, verify on a US 2007] |
| Fuel | Unleaded, RON 91+. Tank 16.0 L (4.23 gal), reserve 3.0 L (0.79 gal). |
| Fuel cock | **Manual OFF / ON / RES lever**, not a vacuum petcock. Turn it OFF whenever the engine is stopped (p.4-11). [src, verify on a US 2007] |
| Choke | Starter knob. Don't use it for more than 3 minutes (p.4-12). |
| Clutch / gearbox | Wet multi-plate clutch, 5-speed, **shaft final drive** (3.071 ratio). |
| Ignition / charging | TCI (digital). AC magneto (stator) feeding a regulator/rectifier. |
| Battery | GT12B-4, 12 V 10 Ah, sealed (VRLA). The aftermarket YT12B-BS is a likely cross [gk, verify]. |
| Spark plugs | NGK **DPR7EA-9** or Denso X22EPR-U9, gap **0.8–0.9 mm** (0.031–0.035 in). |
| Idle speed | **1150–1250 rpm**, engine warm (p.7-14). |
| Throttle free play | 4–6 mm at the grip. |
| Valve clearance (cold) | **Not verified.** The figure usually quoted is intake 0.07–0.12 mm, exhaust 0.12–0.17 mm [gk]. Check the service manual. |
| Brakes | Single disc in front, **drum at the rear** (Custom and Classic). DOT 4 fluid. |
| Wheels / tires | Spoked wheels, tube-type tires. Custom: 100/90-19 front, 170/80-15 rear. Classic: 130/90-16 front, 170/80-15 rear. |
| Tire pressure (cold) | Front: Custom 29 psi, Classic 33 psi. Rear: 33 psi solo (0–90 kg / 0–198 lb), 36 psi loaded. |
| Wet weight | Custom 233 kg (514 lb). Classic 247 kg (545 lb). These are 2009 non-US figures. |

### Fluids

| Fluid | Spec | Capacity |
|---|---|---|
| Engine oil (**shared with the gearbox and clutch**) | API SG+, **JASO MA**. SAE 10W-30, 10W-40, 15W-40, 20W-40 or 20W-50, by temperature. **Don't use "Energy Conserving II" or "CD" diesel oils**, which cause clutch slip. | **2.60 L (2.75 US qt) without a filter change; 2.80 L (2.96 US qt) with one.** The owner's manual doesn't give a total dry capacity. |
| Oil filter | Cartridge under a cover held by 2 bolts, with an O-ring. **Hiflofiltro HF145** or **K&N KN-145**. I couldn't confirm the OEM part number [verify]. | — |
| Final gear (shaft drive) | **SAE 80 API GL-4 hypoid** (GL-5 or GL-6 also OK) | **0.19 L (0.20 US qt)**, filled to the brim of the filler hole with the bike upright and cold |
| Fork oil | 10W [verify] | 454 cc per leg, level 114 mm. This comes from a search snippet of the service manual that I couldn't read in full [verify]. |
| Brake fluid | **DOT 4** | — |

### Torque values (owner's manual)

| Fastener | Torque | Manual page |
|---|---|---|
| Oil drain bolt | **43 Nm (31 ft-lb)** | p.7-10 |
| Oil filter cover bolts | 10 Nm (7.2 ft-lb) | p.7-10 |
| Final gear drain and filler bolts | 23 Nm (17 ft-lb) each | p.7-11 |

I didn't verify the spark plug or axle nut torques.

### Variants

| | Custom XVS650 | Classic XVS650A | Silverado XVS650AT |
|---|---|---|---|
| Front wheel | 19 in, 100/90-19 | 16 in, 130/90-16 | Same as Classic |
| Feet | Pegs [gk] | Floorboards [gk] | Floorboards [gk] |
| Fenders | Short [gk] | Deep valanced [gk] | Deep valanced [gk] |
| Extras | — | — | Windshield, saddlebags, backrest [gk] |
| Rear brake | Drum | Drum | Drum [gk, verify] |
| Wet weight | 233 kg | 247 kg | Heavier [verify] |

---

## Maintenance schedule

**Where the intervals come from:** maintenanceschedule.com says its table is taken from the US owner's manual. Its columns are 4,000 / 8,000 / 12,000 / 16,000 / 20,000 mi, matching 6 / 12 / 18 / 24 / 30 months. The non-US manual uses 600 mi for the first service, then every 6,000 mi plus an annual check. A new bike gets its first service at 600 mi [gk for the US].

| Item | Interval |
|---|---|
| Engine oil | Every 4,000 mi / 6 mo |
| Oil filter | Every 8,000 mi / 12 mo (every second oil change) |
| Spark plugs | Check and clean every 4,000 mi. Replace every 8,000 mi. |
| Carb sync, idle, choke operation, air filter clean | Every 4,000 mi / 6 mo |
| Final gear oil | Check for leaks **before each ride**. Change every 16,000 mi / 24 mo. |
| Valve clearance | 26,600 mi according to maintenanceschedule.com. That looks long, so verify it. |
| Brake fluid, plus master cylinder and caliper seals | Every **2 years** |
| Brake hoses | Every **4 years** |
| Pads, rear drum shoes, clutch, fork, steering and wheel bearings, side stand and switch, fuel hoses, breather hose, exhaust, cables, lights, tires | Check every 4,000 mi / 6 mo |
| Steering bearings and swingarm pivot | Repack every 16,000 mi (the non-US manual says steering every 12,000 mi) |
| Fuel filter | Replace at 20,000 mi |
| Fork oil | Not in the manual's chart. About every 2 years is common practice [gk]. |
| Tire age | Replace at about 5–6 years from the DOT date code (date only) [gk] |
| Battery storage | If the bike sits more than a month, remove the battery or keep it on a tender, and charge it monthly (p.7-26) |
| Long-term storage | Fuel cock OFF, drain both float bowls, add stabilizer, put a little oil in each plug bore (p.8-3, 8-4) |

---

## Recalls, bulletins and NHTSA complaints

**Recalls: none found.** NHTSA files every 2007 V Star, whatever the engine size, under the single model name "V STAR". The query `recallsByVehicle?make=YAMAHA&model=V STAR&modelYear=2007` returned Count 0. These model names also returned 0: V STAR 650, XVS650, XVS650A, V STAR 650 CLASSIC, V STAR 650 CUSTOM, V STAR 650 SILVERADO, V-STAR 650 and VSTAR 650.

**Service bulletins (TSBs):** I didn't search for them, so treat these as unknown rather than as "none exist".

**Complaints: 2 under the 2007 "V STAR".** Neither says which engine size the bike had.
- **10627874:** the final drive was leaking oil out of the housing.
- **10548475:** the engine shut off at 50 mph and would crank but not restart. No cause was given.

---

## Common problems

| Problem | When | Symptoms | Fix | Cost (DIY / shop) | Sources |
|---|---|---|---|---|---|
| **Gummed carbs and clogged pilot jets** from ethanol fuel in storage | Age and storage, not miles | Hard to start, runs only on choke, won't idle, dies after 3–4 seconds | Fresh fuel. Drain the float bowls. Clean the pilot jets and passages. Then sync the carbs and set idle. | $20–60 [gk] / $50–150+ | motoryk, yamahaclub, RevZilla |
| **Regulator/rectifier failure**, sometimes with a melted connector | Age | Flat battery, slow cranking | Test the charging voltage and the R/R diodes. Replace the R/R or the connector. | $50–120 part | motoryk, yamahaclub |
| **Cracked neutral switch housing** leaking oil | Age and heat | Oil on the left side and the kickstand | Replace the switch and its O-ring (3 Torx bolts) | About $20 | Motorcycle Cruiser |
| **Final drive oil leak** | Unknown | Oil on the gear case or the tire | Check the level and the bolt washers. A leaking seal is a dealer job. | $10–30 / $150–400 [gk] | NHTSA, manual |
| **Fork seal leaks** | Higher mileage | Oil film on the fork tubes | New seals, wipers and fork oil | $40–80 [gk] / $100–250 | motoryk |
| **Rear drum brake wear** | Any | Long pedal travel, weak rear brake | Adjust the brake. Replace the shoes once the wear indicator reaches its limit. | $40–100 | motoryk, manual |

I found no V Star 650-specific source for **starter clutch** or **stator** failures, so I left them out.

---

## Recommendations

| Priority | What to do |
|---|---|
| Now | Confirm the variant and read the model code from the VIN label. |
| Now | Read the tire DOT dates. |
| Now | Run the VIN recall check. |
| Now | Do a pre-ride check: tire pressure, final gear leak, brakes, lights, oil level. |
| Soon | If the service history is unknown, do a baseline service: oil and HF145 filter, final gear oil, DOT 4 brake fluid, DPR7EA-9 plugs, clean the air filter. |
| Soon | Test the battery and the charging voltage. |
| Decision | Clean the carbs if it still runs only on choke after you've put in fresh fuel. |
| Watch | Left-side oil (neutral switch), fork seals, final drive leaks, rear drum wear. |
| Skip | "Energy Conserving II" car oils and "CD" diesel oils, which cause clutch slip. |

## Questions for the owner

- What are the VIN and the model code?
- Which variant is it?
- What's the mileage and the color?
- When were the oil, the oil filter and the final gear oil last changed?
- How is it stored? Stabilizer in the fuel? Float bowls drained? Battery on a tender?
- What are the tire DOT dates?
- Any aftermarket exhaust or rejetting?
- Any current symptoms?
- Is the fuel cock a manual OFF/ON/RES lever?

## Not verified

- Valve clearance values and their interval.
- Fork oil volume and level (I only saw a search snippet).
- Battery model and carburetor type on a **US** 2007 bike.
- The OEM oil filter part number. I found no source for 5GH-13440.
- Silverado weight and equipment.
- Charging voltage, stator resistance and spark plug torque (I didn't read the service manual).
- Starter clutch and stator failures.

## Sources

- Yamaha XVS650Y/AY owner's manual, 2009, non-US edition. Pages cited: 4-10 to 4-12, 7-2 to 7-5, 7-10 to 7-14, 7-22, 7-26, 8-3 to 8-4, 9-1 to 9-3. https://www.cyclechaos.com/images/2/26/2009_Yamaha_XVS650_Owners_Manual.pdf
- US maintenance chart summary: https://maintenanceschedule.com/?p=1749
- NHTSA recalls: https://api.nhtsa.gov/recalls/recallsByVehicle?make=YAMAHA&model=V%20STAR&modelYear=2007
- NHTSA complaints: https://api.nhtsa.gov/complaints/complaintsByVehicle?make=YAMAHA&model=V%20STAR&modelYear=2007
- NHTSA 2007 Yamaha model list: https://api.nhtsa.gov/products/vehicle/models?modelYear=2007&make=YAMAHA&issueType=r
- Engine details: https://moto-data.net/yamaha/xvs-650-v-star-custom-2006-2007 · https://cyclechaos.com/wiki/Yamaha_-Star_Custom
- 2007 model pages: https://www.totalmotorcycle.com/photos/2007models/2007models-Yamaha-V-Star-650Custom/ · https://www.totalmotorcycle.com/photos/2007models/2007models-Yamaha-V-Star-650Classic
- Oil filters: https://www.sportsbikeshop.co.uk/motorcycle_parts/content_prod/50820 (HF145, search snippet) · https://www.knfilters.com/yamaha/xvs650-v-star-custom/650/2009
- Service manual pages (snippets only): https://www.manualslib.com/manual/833178/Yamaha-Xvs650.html?page=356 (fork oil) · https://manualslib.com/manual/833178/Yamaha-Xvs650.html?page=66 (valve clearance)
- Common problems: https://www.motoryk.com/bikes/yamaha/v-star-650/problems (short, cites no sources) · https://www.motorcyclecruiser.com/yamaha-v-star-650-common-oil-leak-fix/
- Forums and carb cleaning: https://yamahaclub.com/forums/topic/46314-650-v-star-crank-no-start · https://yamahaclub.com/forums/topic/25322-xvs650-wont-start (search snippet) · https://www.revzilla.com/common-tread/spring-carb-cleaning-101 (search snippet)
- Tire aging: https://www.nhtsa.gov/equipment/tires
- Sites skipped: manuals.online and manualowl.com (both returned 403). The ManualsLib pages were used only from search snippets.
