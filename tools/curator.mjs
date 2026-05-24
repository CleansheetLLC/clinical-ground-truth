#!/usr/bin/env node
/**
 * curator.mjs — curate a Synthea output directory into the Cleansheet
 * patient library. Lives in clinical-ground-truth as the canonical home
 * (migrated 2026-05-23 from corporate/intranet/scripts/medplum-load-library.mjs).
 *
 * The "library" has two homes:
 *   - Canonical: clinical-ground-truth/patients/   (CC BY-SA, public)
 *   - Consumer:  corporate/intranet/public/data/patients/  (synced via
 *     tools/sync-patients-to-intranet.mjs)
 *
 * Methodology (matches the existing 27-patient + peds/YA expansion plan):
 *   1. Generate a large Synthea pool (~600 per age band).
 *   2. `scan` to survey what's in the pool.
 *   3. `load-demo` selects ~14 patients to fill the demographic matrix
 *      (sex × race × age × language × comorbidity), tags each with
 *      `cleansheet-library:demo`. With `--dump`, writes trimmed bundles +
 *      clinician-readable .md summaries to disk; with `--apply`, also
 *      POSTs each bundle as a FHIR transaction to Medplum.
 *      Age band is derived client-side from Patient.birthDate — no archetype tags.
 *   4. `make-pairs` constructs CF-4 / CF-5 / CF-6 by picking a base
 *      bundle from the pool, cloning it with new internal UUIDs, flipping
 *      one demographic field on the clone, tagging both members with
 *      `cleansheet-library:counterfactual-pair-{N}-{variant}`, and creating
 *      a Group resource linking them.
 *
 * Usage:
 *   node curator.mjs scan           --dir <synthea-dir>
 *   node curator.mjs load-demo      --dir <synthea-dir> [--apply] [--dump <out-dir>]
 *   node curator.mjs make-pairs     --dir <synthea-dir> [--apply] [--dump <out-dir>]
 *   node curator.mjs dump           [--out <dir>]
 *   node curator.mjs seed-from-dump [--out <dir>] [--apply]
 *
 * `--dump <out-dir>` on load-demo / make-pairs writes selected bundles +
 * clinical-summary markdown to disk WITHOUT requiring Medplum. Pure file IO.
 * This is the canonical CGT workflow — dump into patients/, then sync into
 * the intranet. Combine with --apply to also POST to a live Medplum.
 *
 * Env (required for --apply, dump, and seed-from-dump only):
 *   MEDPLUM_BASE   e.g. https://medplum.cleansheet.life/fhir/R4
 *   MEDPLUM_TOKEN  the cs_live_<hex> edge bearer
 *
 * `dump` reads a live Medplum and writes one $everything bundle per tagged
 * patient + a summary index.json to <out>. The intranet PatientLibrary page
 * reads these JSONs directly so browsing works without a live Medplum.
 *
 * `seed-from-dump` is the inverse: reads the saved JSONs and POSTs them to
 * a fresh Medplum as transaction bundles. Use after a Medplum rebuild to
 * restore the library without re-running Synthea.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ─── Demographic matrix expansion (14 cells, peds + YA) ─────────────────────
//
// Each cell is selected for which matrix cell it fills, NOT for clinical
// archetype. `bonusConditions` is a soft preference to bias picks toward
// clinically interesting candidates; missing them doesn't disqualify.

const DEMOGRAPHIC_CELLS = [
  // ─── Pediatric (<18) ────────────────────────────────────────────────────
  { slug: "peds-1",  band: "pediatric",  ageRange: [ 6, 11], gender: "male",   race: "Black",            language: "en", bonusConditions: ["195967001","24079001","61582004"], note: "asthma+eczema+rhinitis profile" },
  { slug: "peds-2",  band: "pediatric",  ageRange: [12, 16], gender: "female", race: "White",            language: "en", bonusConditions: ["46635009"],                       note: "T1DM, well-controlled" },
  { slug: "peds-3",  band: "pediatric",  ageRange: [ 5,  9], gender: "male",   race: "Hispanic",         language: "es", bonusConditions: ["192127007","406506008"],          note: "ADHD" },
  { slug: "peds-4",  band: "pediatric",  ageRange: [ 9, 14], gender: "female", race: "Black",            language: "en", bonusConditions: ["417357006","127040003"],          note: "sickle cell SS" },
  { slug: "peds-5",  band: "pediatric",  ageRange: [ 3,  6], gender: "female", race: "Asian",            language: "zh", bonusConditions: ["65363002","232241007"],           note: "recurrent AOM" },
  { slug: "peds-6",  band: "pediatric",  ageRange: [14, 17], gender: "male",   race: "American Indian", language: "en", bonusConditions: ["110030002","62106007"],           note: "post-concussion" },
  { slug: "peds-7",  band: "pediatric",  ageRange: [11, 14], gender: "female", race: "White",            language: "en", bonusConditions: ["46635009","195967001"],          note: "polypharmacy (T1DM + asthma)" },
  // ─── Young adult (18–39) ────────────────────────────────────────────────
  { slug: "ya-1",    band: "young-adult", ageRange: [28, 36], gender: "female", race: "White",            language: "en", bonusConditions: ["77386006","118185001"],           note: "prenatal G2P1" },
  { slug: "ya-2",    band: "young-adult", ageRange: [22, 30], gender: "male",   race: "Black",            language: "en", bonusConditions: ["370143000","35489007","21897009"], note: "MDD+GAD+AUD" },
  { slug: "ya-3",    band: "young-adult", ageRange: [25, 33], gender: "female", race: "Asian",            language: "en", bonusConditions: ["24700007"],                      note: "MS" },
  { slug: "ya-4",    band: "young-adult", ageRange: [32, 39], gender: "male",   race: "Hispanic",         language: "es", bonusConditions: ["38341003","414916001","714628002"], note: "early HTN + obesity" },
  { slug: "ya-5",    band: "young-adult", ageRange: [20, 28], gender: "female", race: "White",            language: "en", bonusConditions: ["34000006"],                      note: "Crohn's" },
  { slug: "ya-6",    band: "young-adult", ageRange: [26, 36], gender: "male",   race: "Black",            language: "en", bonusConditions: ["46635009"],                      note: "T1DM poor control" },
  { slug: "ya-7",    band: "young-adult", ageRange: [22, 32], gender: "female", race: "Hispanic",         language: "es", bonusConditions: ["77386006","38341003","414916001"], note: "prenatal + cHTN + obesity" },
];

// ─── Counterfactual pair specs ───────────────────────────────────────────────
//
// Each pair: a `basePicker` chooses one patient from the pool. The first
// `variant` is the base (no flip). The second is cloned with one field
// changed. Both members tagged. Group resource links them.

const COUNTERFACTUAL_PAIRS = [
  {
    pairId: "4",
    flipAxis: "age-band",
    label: "Counterfactual Pair 4 — age-band flip (22y vs 65y, identical Crohn's)",
    basePicker: { ageRange: [20, 26], gender: "female", race: "White", language: "en", requiredConditions: [] },
    variants: [
      { variant: "young", flip: null },
      { variant: "old",   flip: { type: "birthDate", shiftYears: -43 } },
    ],
  },
  {
    pairId: "5",
    flipAxis: "pediatric-sex",
    label: "Counterfactual Pair 5 — pediatric sex flip (14y M vs F, identical asthma + eczema)",
    basePicker: { ageRange: [12, 16], gender: "male", race: "White", language: "en", requiredConditions: ["195967001","233678006"] },
    variants: [
      { variant: "male",   flip: null },
      { variant: "female", flip: { type: "gender", value: "female" } },
    ],
  },
  {
    pairId: "6",
    flipAxis: "young-adult-language",
    label: "Counterfactual Pair 6 — young-adult language flip (32y F prenatal, EN vs ES)",
    basePicker: { ageRange: [28, 36], gender: "female", race: "White", language: "en", requiredConditions: ["72892002","47200007"] },
    variants: [
      { variant: "en", flip: null },
      { variant: "es", flip: { type: "language", value: "es" } },
    ],
  },
];

// ─── Bundle inspection ──────────────────────────────────────────────────────

function patientFromBundle(bundle) {
  return bundle.entry?.find((e) => e.resource?.resourceType === "Patient")?.resource;
}

function ageFromBirthDate(bd) {
  if (!bd) return null;
  return new Date().getFullYear() - parseInt(bd.slice(0, 4), 10);
}

function extractRace(patient) {
  const ext = patient.extension?.find((e) => e.url?.includes("us-core-race"));
  const text = ext?.extension?.find((s) => s.url === "text")?.valueString;
  return text ?? "Unknown";
}

function extractEthnicity(patient) {
  const ext = patient.extension?.find((e) => e.url?.includes("us-core-ethnicity"));
  const text = ext?.extension?.find((s) => s.url === "text")?.valueString;
  return text ?? "Unknown";
}

function extractLanguage(patient) {
  return patient.communication?.[0]?.language?.coding?.[0]?.code ?? "en";
}

function bundleConditions(bundle) {
  return (bundle.entry ?? [])
    .filter((e) => e.resource?.resourceType === "Condition")
    .map((e) => e.resource.code?.coding?.[0]?.code)
    .filter(Boolean);
}

function bundleMedications(bundle) {
  return (bundle.entry ?? [])
    .filter((e) => ["MedicationRequest", "MedicationStatement"].includes(e.resource?.resourceType))
    .map((e) => e.resource.medicationCodeableConcept?.coding?.[0]?.code)
    .filter(Boolean);
}

function comorbidityProfile(bundle) {
  const conds = bundleConditions(bundle).length;
  const meds = bundleMedications(bundle).length;
  if (meds >= 5) return "polypharmacy";
  if (conds >= 3) return "multi";
  return "single";
}

// ─── Clinical-category vocabulary (12 categories + 2 derived flags) ─────────
//
// Boolean tags applied per-patient based on SNOMED codes on Condition
// resources. Used by the intranet PatientLibrary for filter chips and card
// badges. Intentionally small + tunable — extend as the library grows.
//
// Conditions clinicalStatus is checked: only "active" (and "recurrence" /
// "relapse") conditions contribute. Resolved or refuted conditions are
// ignored. Derived flags are computed off the matched-category count and
// the bundle's active medication count.

export const CLINICAL_CATEGORIES = [
  {
    id: "diabetes",
    label: "Diabetes",
    snomedCodes: [
      "44054006", "46635009", "73211009", "359642000", "237599002",
      "127013003", "90781000119102", "157141000119108", "1551000119108", "368581000119106",
    ],
  },
  {
    id: "hypertension",
    label: "Hypertension",
    snomedCodes: ["38341003", "59621000", "1201005"],
  },
  {
    id: "asthma-copd",
    label: "Asthma / COPD",
    snomedCodes: ["195967001", "13645005", "87433001", "185086009", "266361008"],
  },
  {
    id: "cardiovascular",
    label: "Cardiovascular",
    snomedCodes: [
      "53741008", "84114007", "22298006", "49436004",
      "230690007", "230691006", "56265001", "194828000",
      "230702000", "414545008", "399211009",
      "401314000", "401303003", "399261000",
    ],
  },
  {
    id: "mental-health",
    label: "Mental Health",
    snomedCodes: [
      "370143000", "35489007", "36923009", "13746004",
      "197480006", "47505003", "80583007",
      "192127007", "406506008",
      "85005007",
      "39898005",
    ],
  },
  {
    id: "substance-use",
    label: "Substance Use",
    snomedCodes: [
      "7200002", "21897009",
      "191492000", "5602001", "26416006", "6525002",
      "110483000", "191816009", "89765005",
    ],
  },
  {
    id: "prenatal",
    label: "Prenatal / OB",
    snomedCodes: ["77386006", "118185001", "169826009", "10750631000119103"],
  },
  {
    id: "oncology",
    label: "Oncology",
    snomedCodes: [
      "363346000", "254837009", "363406005", "363516008",
      "92691004", "86049000", "93143009", "109838007",
      "93761005", "94260004",
    ],
  },
  {
    id: "renal",
    label: "Renal / CKD",
    snomedCodes: [
      "709044004", "431855005", "431856006", "431857002", "433144002", "431858007",
      "129721000119106",
    ],
  },
  {
    id: "hematology",
    label: "Hematology",
    snomedCodes: ["417357006", "127040003", "70241007"],
  },
  {
    id: "gi-inflammatory",
    label: "GI Inflammatory",
    snomedCodes: ["34000006", "64766004", "24526004"],
  },
  {
    id: "neuro",
    label: "Neuro",
    snomedCodes: [
      "24700007", "84757009", "49049000",
      "26929004", "230265002",
      "110030002", "62106007",
      "128613002",
      "124171000119105", "37796009",
    ],
  },
];

/** Returns true if the patient's bundle has an ACTIVE condition matching
 *  one of the supplied SNOMED codes. */
function bundleHasActiveCode(bundle, codes) {
  const codeSet = new Set(codes);
  for (const e of bundle.entry ?? []) {
    const r = e.resource;
    if (r?.resourceType !== "Condition") continue;
    const status = r.clinicalStatus?.coding?.[0]?.code;
    if (status && status !== "active" && status !== "recurrence" && status !== "relapse") continue;
    for (const coding of r.code?.coding ?? []) {
      if (codeSet.has(coding.code)) return true;
    }
  }
  return false;
}

/** Returns the count of active Conditions and active Medications for derived flags. */
function activeMedicationCount(bundle) {
  let n = 0;
  for (const e of bundle.entry ?? []) {
    const r = e.resource;
    if (r?.resourceType !== "MedicationRequest" && r?.resourceType !== "MedicationStatement") continue;
    const status = r.status;
    // Synthea uses "active" / "completed" / "stopped" / "on-hold". Count
    // active + on-hold (current/ongoing); skip completed/stopped/cancelled.
    if (status === "active" || status === "on-hold" || status == null) n++;
  }
  return n;
}

/** Returns { categories: string[], flags: string[] } for one bundle. */
export function categorizeBundle(bundle) {
  const categories = [];
  for (const cat of CLINICAL_CATEGORIES) {
    if (bundleHasActiveCode(bundle, cat.snomedCodes)) categories.push(cat.id);
  }
  const flags = [];
  if (activeMedicationCount(bundle) >= 5) flags.push("polypharmacy");
  if (categories.length >= 3) flags.push("multi-system");
  return { categories, flags };
}

function matchesRace(patient, raceHint) {
  if (!raceHint) return true;
  if (raceHint === "Hispanic") {
    return extractEthnicity(patient).includes("Hispanic") && !extractEthnicity(patient).includes("Not");
  }
  if (raceHint === "American Indian") {
    return extractRace(patient).includes("American Indian") || extractRace(patient).includes("Alaska");
  }
  return extractRace(patient).includes(raceHint);
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreForCell(bundle, cell) {
  const p = patientFromBundle(bundle);
  if (!p) return -Infinity;
  const age = ageFromBirthDate(p.birthDate);
  if (age == null) return -Infinity;
  const [minA, maxA] = cell.ageRange;
  if (age < minA || age > maxA) return -Infinity;
  if (cell.gender && p.gender !== cell.gender) return -Infinity;

  let s = 100; // base score for satisfying hard requirements
  if (cell.race && matchesRace(p, cell.race)) s += 50;
  if (cell.language && extractLanguage(p).startsWith(cell.language)) s += 20;

  const conds = new Set(bundleConditions(bundle));
  for (const c of cell.bonusConditions ?? []) if (conds.has(c)) s += 15;

  return s;
}

function scoreForPicker(bundle, picker) {
  const p = patientFromBundle(bundle);
  if (!p) return -Infinity;
  const age = ageFromBirthDate(p.birthDate);
  if (age == null) return -Infinity;
  const [minA, maxA] = picker.ageRange;
  if (age < minA || age > maxA) return -Infinity;
  if (picker.gender && p.gender !== picker.gender) return -Infinity;
  if (picker.race && !matchesRace(p, picker.race)) return -Infinity;
  if (picker.language && !extractLanguage(p).startsWith(picker.language)) return -Infinity;

  const conds = new Set(bundleConditions(bundle));
  const requiredHit = (picker.requiredConditions ?? []).some((c) => conds.has(c));
  if ((picker.requiredConditions ?? []).length > 0 && !requiredHit) return -Infinity;

  let s = 100;
  for (const c of picker.requiredConditions ?? []) if (conds.has(c)) s += 100;
  return s;
}

// ─── Tagging ─────────────────────────────────────────────────────────────────

function ensureTag(patient, code) {
  patient.meta = patient.meta ?? {};
  patient.meta.tag = patient.meta.tag ?? [];
  if (!patient.meta.tag.some((t) => t.code === code)) {
    patient.meta.tag.push({ system: "cleansheet-library", code });
  }
}

// ─── Pool loader ─────────────────────────────────────────────────────────────

async function loadDir(dir) {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith("hospitalInformation") && !f.startsWith("practitionerInformation"));
  const bundles = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.resourceType === "Bundle" && patientFromBundle(parsed)) {
        bundles.push({ file: f, bundle: parsed });
      }
    } catch { /* skip malformed */ }
  }
  return bundles;
}

// ─── Medplum POST helpers ────────────────────────────────────────────────────

// Synthea bundles include billing/admin resources (Claim, EOB, etc.) that bloat
// the transaction well past typical proxy body limits. Strip them before posting.
const STRIP_RESOURCE_TYPES = new Set([
  "Claim", "ExplanationOfBenefit", "SupplyDelivery", "DocumentReference",
  "Procedure", "DiagnosticReport", "ImagingStudy", "Device", "Provenance",
]);

function trimBundle(bundle) {
  bundle.entry = (bundle.entry ?? []).filter((e) => !STRIP_RESOURCE_TYPES.has(e.resource?.resourceType));
  return bundle;
}

async function postTransaction(base, token, bundle) {
  trimBundle(bundle);
  if (bundle.type !== "transaction") bundle.type = "transaction";
  const res = await fetch(base, {
    method: "POST",
    headers: {
      "Content-Type": "application/fhir+json",
      Authorization: `Bearer ${token}`,
      Accept: "application/fhir+json",
    },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) throw new Error(`Medplum POST failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

async function findPatientIdByTag(base, token, tagCode) {
  const url = `${base}/Patient?_tag=${encodeURIComponent(tagCode)}&_count=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" } });
  if (!res.ok) throw new Error(`Medplum GET failed: ${res.status}`);
  const body = await res.json();
  return body.entry?.[0]?.resource?.id ?? null;
}

// ─── Bundle clone (deep copy + UUID remap) ───────────────────────────────────

function cloneBundleWithFreshIds(bundle) {
  const cloned = JSON.parse(JSON.stringify(bundle));
  // Map bare UUIDs → bare UUIDs. Bare-uuid replacement also fixes the
  // urn:uuid: form (since `urn:uuid:<bare>` contains <bare> as a substring),
  // AND the resource.id field (which carries the bare uuid without prefix).
  // Skipping bare-uuid rewriting was the original bug — clone variants kept
  // the base patient.id and overwrote each other on disk.
  const uuidMap = new Map();
  for (const entry of cloned.entry ?? []) {
    if (entry.fullUrl?.startsWith("urn:uuid:")) {
      const oldBare = entry.fullUrl.slice("urn:uuid:".length);
      const newBare = crypto.randomUUID();
      uuidMap.set(oldBare, newBare);
    }
  }
  let s = JSON.stringify(cloned);
  for (const [oldBare, newBare] of uuidMap) {
    s = s.split(oldBare).join(newBare);
  }
  return JSON.parse(s);
}

// ─── Flip operators ──────────────────────────────────────────────────────────

function applyFlip(patient, flip) {
  if (!flip) return;
  if (flip.type === "gender") {
    patient.gender = flip.value;
  } else if (flip.type === "language") {
    patient.communication = [{
      language: { coding: [{ system: "urn:ietf:bcp:47", code: flip.value }] },
      preferred: true,
    }];
  } else if (flip.type === "birthDate" && typeof flip.shiftYears === "number") {
    const bd = new Date(patient.birthDate);
    bd.setFullYear(bd.getFullYear() + flip.shiftYears);
    patient.birthDate = bd.toISOString().slice(0, 10);
  }
}

// ─── Clinical summary (markdown) ─────────────────────────────────────────────
//
// Pure function: takes a FHIR bundle, returns a clinician-readable markdown
// narrative. Designed to be pasted into a prompt as patient context, or read
// directly. Filters out the noise (Claim/EOB/Provenance) and surfaces what
// a clinician actually wants in the first 30 seconds: demographics, active
// problems, current meds, allergies, recent vitals, recent encounters.

function codingDisplay(c) {
  return c?.text || c?.coding?.[0]?.display || c?.coding?.[0]?.code || "—";
}

function codingCode(c) {
  return c?.coding?.[0]?.code ?? "";
}

function patientNameStr(patient) {
  const n = patient.name?.[0] ?? {};
  return `${(n.given ?? []).join(" ")} ${n.family ?? ""}`.trim() || "Unnamed Patient";
}

function clinicalSummary(bundle) {
  const patient = patientFromBundle(bundle);
  if (!patient) return "# (no Patient in bundle)\n";

  const age = ageFromBirthDate(patient.birthDate);
  const race = extractRace(patient);
  const ethnicity = extractEthnicity(patient);
  const lang = extractLanguage(patient);
  const tags = (patient.meta?.tag ?? []).map((t) => t.code).filter(Boolean);

  const byType = {};
  for (const e of bundle.entry ?? []) {
    const r = e.resource;
    if (!r?.resourceType) continue;
    (byType[r.resourceType] ??= []).push(r);
  }

  const conditions = byType.Condition ?? [];
  const meds = [...(byType.MedicationRequest ?? []), ...(byType.MedicationStatement ?? [])];
  const allergies = byType.AllergyIntolerance ?? [];
  const observations = byType.Observation ?? [];
  const encounters = byType.Encounter ?? [];
  const immunizations = byType.Immunization ?? [];
  const procedures = byType.Procedure ?? [];
  const carePlans = byType.CarePlan ?? [];

  const lines = [];
  lines.push(`# ${patientNameStr(patient)}`);
  lines.push("");
  lines.push(`**Demographics:** ${age ?? "?"}y ${patient.gender ?? "?"}, ${race}, ${ethnicity}, language: ${lang}`);
  if (patient.birthDate) lines.push(`**DOB:** ${patient.birthDate}`);
  lines.push(`**Patient ID:** ${patient.id ?? "—"}`);
  if (tags.length) lines.push(`**Library tags:** ${tags.join(", ")}`);
  lines.push("");

  // Active problems
  const activeC = conditions.filter((c) => (c.clinicalStatus?.coding?.[0]?.code ?? "active") === "active");
  const inactiveC = conditions.filter((c) => (c.clinicalStatus?.coding?.[0]?.code ?? "active") !== "active");
  if (activeC.length) {
    lines.push("## Active Problems");
    lines.push("");
    for (const c of activeC) {
      const onset = c.onsetDateTime?.slice(0, 10);
      lines.push(`- ${codingDisplay(c.code)}${codingCode(c.code) ? ` (${codingCode(c.code)})` : ""}${onset ? ` — onset ${onset}` : ""}`);
    }
    lines.push("");
  }
  if (inactiveC.length) {
    lines.push("## Past / Resolved Conditions");
    lines.push("");
    for (const c of inactiveC) {
      lines.push(`- ${codingDisplay(c.code)}${codingCode(c.code) ? ` (${codingCode(c.code)})` : ""}`);
    }
    lines.push("");
  }

  // Medications
  if (meds.length) {
    lines.push("## Medications");
    lines.push("");
    for (const m of meds) {
      const status = m.status ?? "";
      const code = codingCode(m.medicationCodeableConcept);
      lines.push(`- ${codingDisplay(m.medicationCodeableConcept)}${code ? ` (RxNorm ${code})` : ""}${status ? ` — ${status}` : ""}`);
    }
    lines.push("");
  }

  // Allergies
  if (allergies.length) {
    lines.push("## Allergies");
    lines.push("");
    for (const a of allergies) {
      const crit = a.criticality ? ` (${a.criticality})` : "";
      lines.push(`- ${codingDisplay(a.code)}${crit}`);
    }
    lines.push("");
  }

  // Most-recent vitals (one per LOINC code)
  const vitals = observations.filter((o) =>
    (o.category ?? []).some((cat) => (cat.coding ?? []).some((c) => c.code === "vital-signs")),
  );
  if (vitals.length) {
    const latest = new Map();
    for (const o of vitals) {
      const code = codingCode(o.code);
      if (!code) continue;
      const dt = o.effectiveDateTime ?? "";
      const prev = latest.get(code);
      if (!prev || dt > (prev.effectiveDateTime ?? "")) latest.set(code, o);
    }
    if (latest.size) {
      lines.push("## Most Recent Vitals");
      lines.push("");
      for (const o of latest.values()) {
        const value = o.valueQuantity
          ? `${o.valueQuantity.value} ${o.valueQuantity.unit ?? o.valueQuantity.code ?? ""}`.trim()
          : o.valueString
          ? o.valueString
          : o.component?.length
          ? o.component
              .map((c) => `${codingDisplay(c.code)}: ${c.valueQuantity ? `${c.valueQuantity.value} ${c.valueQuantity.unit ?? ""}`.trim() : "—"}`)
              .join(" / ")
          : "—";
        const dt = o.effectiveDateTime?.slice(0, 10) ?? "";
        lines.push(`- ${codingDisplay(o.code)}: ${value}${dt ? ` (${dt})` : ""}`);
      }
      lines.push("");
    }
  }

  // Recent labs (non-vital observations, last 10 by date)
  const labs = observations.filter((o) =>
    !(o.category ?? []).some((cat) => (cat.coding ?? []).some((c) => c.code === "vital-signs")),
  );
  if (labs.length) {
    const sorted = [...labs]
      .filter((o) => o.effectiveDateTime)
      .sort((a, b) => (b.effectiveDateTime ?? "").localeCompare(a.effectiveDateTime ?? ""))
      .slice(0, 10);
    if (sorted.length) {
      lines.push("## Recent Labs / Observations (latest 10)");
      lines.push("");
      for (const o of sorted) {
        const value = o.valueQuantity
          ? `${o.valueQuantity.value} ${o.valueQuantity.unit ?? o.valueQuantity.code ?? ""}`.trim()
          : codingDisplay(o.valueCodeableConcept) !== "—"
          ? codingDisplay(o.valueCodeableConcept)
          : o.valueString ?? "—";
        const dt = o.effectiveDateTime?.slice(0, 10) ?? "";
        lines.push(`- ${dt}: ${codingDisplay(o.code)} — ${value}`);
      }
      lines.push("");
    }
  }

  // Immunizations
  if (immunizations.length) {
    lines.push("## Immunizations");
    lines.push("");
    const sorted = [...immunizations].sort((a, b) => (b.occurrenceDateTime ?? "").localeCompare(a.occurrenceDateTime ?? ""));
    for (const i of sorted.slice(0, 12)) {
      const dt = i.occurrenceDateTime?.slice(0, 10) ?? "";
      lines.push(`- ${dt}: ${codingDisplay(i.vaccineCode)}`);
    }
    if (sorted.length > 12) lines.push(`- … (${sorted.length - 12} more)`);
    lines.push("");
  }

  // Procedures
  if (procedures.length) {
    lines.push("## Procedures");
    lines.push("");
    const sorted = [...procedures]
      .sort((a, b) => ((b.performedDateTime ?? b.performedPeriod?.start ?? "") .localeCompare(a.performedDateTime ?? a.performedPeriod?.start ?? "")));
    for (const p of sorted.slice(0, 10)) {
      const dt = (p.performedDateTime ?? p.performedPeriod?.start ?? "").slice(0, 10);
      lines.push(`- ${dt}: ${codingDisplay(p.code)}`);
    }
    if (sorted.length > 10) lines.push(`- … (${sorted.length - 10} more)`);
    lines.push("");
  }

  // Care plans
  if (carePlans.length) {
    lines.push("## Care Plans");
    lines.push("");
    for (const cp of carePlans) {
      const title = cp.title ?? codingDisplay(cp.category?.[0]);
      const status = cp.status ?? "";
      lines.push(`- ${title}${status ? ` (${status})` : ""}`);
    }
    lines.push("");
  }

  // Recent encounters
  if (encounters.length) {
    const sorted = [...encounters]
      .filter((e) => e.period?.start)
      .sort((a, b) => (b.period.start ?? "").localeCompare(a.period.start ?? ""));
    if (sorted.length) {
      lines.push("## Recent Encounters");
      lines.push("");
      for (const e of sorted.slice(0, 5)) {
        const type = codingDisplay(e.type?.[0]) !== "—" ? codingDisplay(e.type?.[0]) : (e.class?.display ?? e.class?.code ?? "—");
        const dt = e.period?.start?.slice(0, 10) ?? "";
        lines.push(`- ${dt}: ${type}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── Dump-to-disk helper (shared by load-demo and make-pairs in --dump mode) ─

function patientSummaryFromSynthea(patient, bundle, filename) {
  const nameObj = patient.name?.[0] ?? {};
  const given = (nameObj.given ?? []).join(" ");
  const family = nameObj.family ?? "";
  const { categories, flags } = categorizeBundle(bundle);
  return {
    id: patient.id,
    filename,
    summaryFilename: filename.replace(/\.json$/, ".md"),
    name: `${given} ${family}`.trim(),
    gender: patient.gender ?? "unknown",
    birthDate: patient.birthDate ?? null,
    age: ageFromBirthDate(patient.birthDate),
    race: extractRace(patient),
    ethnicity: extractEthnicity(patient),
    language: extractLanguage(patient),
    tags: (patient.meta?.tag ?? []).map((t) => t.code).filter(Boolean),
    clinicalCategories: categories,
    clinicalFlags: flags,
    conditionCount: (bundle.entry ?? []).filter((e) => e.resource?.resourceType === "Condition").length,
    medicationCount: (bundle.entry ?? []).filter((e) => ["MedicationRequest", "MedicationStatement"].includes(e.resource?.resourceType)).length,
    observationCount: (bundle.entry ?? []).filter((e) => e.resource?.resourceType === "Observation").length,
    encounterCount: (bundle.entry ?? []).filter((e) => e.resource?.resourceType === "Encounter").length,
    allergyCount: (bundle.entry ?? []).filter((e) => e.resource?.resourceType === "AllergyIntolerance").length,
    procedureCount: (bundle.entry ?? []).filter((e) => e.resource?.resourceType === "Procedure").length,
    carePlanCount: (bundle.entry ?? []).filter((e) => e.resource?.resourceType === "CarePlan").length,
    immunizationCount: (bundle.entry ?? []).filter((e) => e.resource?.resourceType === "Immunization").length,
    lastSeen: null,
  };
}

/** Write one patient: trimmed bundle, summary markdown. Returns the index entry. */
async function dumpOnePatient(outDir, bundle) {
  // Trim claims/EOBs/etc and clone so we don't mutate the original.
  const trimmed = trimBundle(JSON.parse(JSON.stringify(bundle)));
  const patient = patientFromBundle(trimmed);
  if (!patient || !patient.id) throw new Error("bundle has no Patient or Patient.id");
  const filename = `${patient.id}.json`;
  await fs.writeFile(path.join(outDir, filename), JSON.stringify(trimmed, null, 2));
  await fs.writeFile(path.join(outDir, `${patient.id}.md`), clinicalSummary(trimmed));
  return patientSummaryFromSynthea(patient, trimmed, filename);
}

async function writeDumpIndex(outDir, patients, counterfactualPairs, source) {
  const index = {
    dumpedAt: new Date().toISOString(),
    source,
    patientCount: patients.length,
    patients: patients.sort((a, b) => a.name.localeCompare(b.name)),
    counterfactualPairs,
  };
  await fs.writeFile(path.join(outDir, "index.json"), JSON.stringify(index, null, 2));
}

// ─── Subcommand: scan ────────────────────────────────────────────────────────

async function cmdScan(dir) {
  const bundles = await loadDir(dir);
  console.log(`Scanned ${bundles.length} bundles in ${dir}\n`);
  console.log("─".repeat(120));
  console.log("file".padEnd(50), "gender".padEnd(7), "age".padEnd(4), "race".padEnd(22), "lang".padEnd(5), "comorb".padEnd(13), "conds", "meds");
  console.log("─".repeat(120));
  for (const { file, bundle } of bundles) {
    const p = patientFromBundle(bundle);
    console.log(
      file.padEnd(50),
      (p.gender ?? "?").padEnd(7),
      String(ageFromBirthDate(p.birthDate) ?? "?").padEnd(4),
      (extractRace(p).slice(0, 20)).padEnd(22),
      extractLanguage(p).padEnd(5),
      comorbidityProfile(bundle).padEnd(13),
      String(bundleConditions(bundle).length).padStart(5),
      String(bundleMedications(bundle).length).padStart(5),
    );
  }
  console.log("─".repeat(120));
}

// ─── Subcommand: load-demo ───────────────────────────────────────────────────

async function cmdLoadDemo(dir, apply, dumpDir) {
  const bundles = await loadDir(dir);
  console.log(`Scanned ${bundles.length} bundles in ${dir}\n`);

  const picks = [];
  const usedFiles = new Set();
  for (const cell of DEMOGRAPHIC_CELLS) {
    let best = null;
    let bestScore = -Infinity;
    for (const cand of bundles) {
      if (usedFiles.has(cand.file)) continue;
      const s = scoreForCell(cand.bundle, cell);
      if (s > bestScore) { bestScore = s; best = cand; }
    }
    if (best && bestScore > -Infinity) usedFiles.add(best.file);
    picks.push({ cell, pick: best, score: bestScore });
  }

  console.log("Demographic-cell picks:");
  console.log("─".repeat(140));
  for (const { cell, pick, score } of picks) {
    if (!pick || score === -Infinity) {
      console.log(`  [${cell.band.padEnd(11)}] ${cell.slug.padEnd(8)} ─ NO MATCH ─ wants ${cell.gender}, ${cell.ageRange.join("–")}, ${cell.race}, ${cell.language} (${cell.note})`);
      continue;
    }
    const p = patientFromBundle(pick.bundle);
    const name = `${(p.name?.[0]?.given ?? []).join(" ")} ${p.name?.[0]?.family ?? ""}`.trim();
    const age = ageFromBirthDate(p.birthDate);
    console.log(`  [${cell.band.padEnd(11)}] ${cell.slug.padEnd(8)} ─ score=${String(score).padStart(4)} ─ ${name} (${p.gender}, ${age}y, ${extractRace(p).slice(0, 16)}, ${extractLanguage(p)}) ─ ${pick.file}`);
  }
  console.log("─".repeat(140));

  // Tag picks (in-memory) — both POST and dump paths want the tag applied.
  for (const { pick } of picks) {
    if (!pick) continue;
    ensureTag(patientFromBundle(pick.bundle), "cleansheet-library:demo");
  }

  // Dump to disk if requested
  if (dumpDir) {
    await fs.mkdir(dumpDir, { recursive: true });
    console.log(`\nDumping bundles + summaries to ${dumpDir}...`);
    const summaries = [];
    for (const { cell, pick, score } of picks) {
      if (!pick || score === -Infinity) { console.log(`  skip: ${cell.slug} (no match)`); continue; }
      try {
        const entry = await dumpOnePatient(dumpDir, pick.bundle);
        summaries.push(entry);
        console.log(`  dumped: ${cell.slug.padEnd(8)} → ${entry.filename}`);
      } catch (e) {
        console.log(`  FAILED: ${cell.slug} ─ ${e.message}`);
      }
    }
    // Merge with any existing index.json so re-running on a second pool
    // (or re-running make-pairs first) doesn't drop prior dumps.
    const indexPath = path.join(dumpDir, "index.json");
    let existing = { patients: [], counterfactualPairs: [] };
    try { existing = JSON.parse(await fs.readFile(indexPath, "utf-8")); } catch { /* no prior index */ }
    const allPatients = [...existing.patients, ...summaries];
    const allPairs = existing.counterfactualPairs ?? [];
    const dedupedPatients = Array.from(new Map(allPatients.map((p) => [p.id, p])).values());
    await writeDumpIndex(dumpDir, dedupedPatients, allPairs, `synthea:${dir}`);
    console.log(`Wrote ${summaries.length} bundles + summaries + updated index.json (${dedupedPatients.length} total patients).`);
  }

  if (!apply) {
    if (!dumpDir) console.log("\nDry run. Re-run with --apply to POST, or --dump <dir> to write to disk.");
    return;
  }

  const base = process.env.MEDPLUM_BASE;
  const token = process.env.MEDPLUM_TOKEN;
  if (!base || !token) { console.error("Missing MEDPLUM_BASE or MEDPLUM_TOKEN"); process.exit(3); }

  console.log(`\nApplying to ${base}...`);
  let ok = 0, fail = 0;
  for (const { cell, pick, score } of picks) {
    if (!pick || score === -Infinity) { console.log(`  skip: ${cell.slug} (no match)`); fail++; continue; }
    try {
      await postTransaction(base, token, pick.bundle);
      console.log(`  loaded: ${cell.slug}`);
      ok++;
    } catch (e) {
      console.log(`  FAILED: ${cell.slug} ─ ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} loaded, ${fail} failed/skipped.`);
}

// ─── Subcommand: make-pairs ──────────────────────────────────────────────────

async function cmdMakePairs(dir, apply, dumpDir) {
  const bundles = await loadDir(dir);
  console.log(`Scanned ${bundles.length} bundles in ${dir}\n`);

  // Pick a distinct base per pair (no reuse across pairs).
  const picks = [];
  const usedFiles = new Set();
  for (const pair of COUNTERFACTUAL_PAIRS) {
    let best = null;
    let bestScore = -Infinity;
    for (const cand of bundles) {
      if (usedFiles.has(cand.file)) continue;
      const s = scoreForPicker(cand.bundle, pair.basePicker);
      if (s > bestScore) { bestScore = s; best = cand; }
    }
    if (best && bestScore > -Infinity) usedFiles.add(best.file);
    picks.push({ pair, base: best, score: bestScore });
  }

  console.log("CF pair base picks:");
  console.log("─".repeat(140));
  for (const { pair, base, score } of picks) {
    if (!base || score === -Infinity) {
      console.log(`  CF-${pair.pairId} ─ NO BASE FOUND ─ ${pair.label}`);
      continue;
    }
    const p = patientFromBundle(base.bundle);
    const name = `${(p.name?.[0]?.given ?? []).join(" ")} ${p.name?.[0]?.family ?? ""}`.trim();
    console.log(`  CF-${pair.pairId} ─ ${pair.label}\n      base: ${name} (${p.gender}, ${ageFromBirthDate(p.birthDate)}y, ${extractRace(p).slice(0,16)}, ${extractLanguage(p)}) ─ ${base.file}`);
  }
  console.log("─".repeat(140));

  // Dump-only mode (no Medplum)
  if (dumpDir && !apply) {
    await fs.mkdir(dumpDir, { recursive: true });
    console.log(`\nDumping cloned variants + summaries to ${dumpDir}...`);
    const summaries = [];
    const counterfactualPairs = [];
    const flipLabels = { "1": "sex", "2": "race", "3": "language", "4": "age-band", "5": "pediatric-sex", "6": "young-adult-language" };
    for (const { pair, base: chosen, score } of picks) {
      if (!chosen || score === -Infinity) { console.log(`  skip: CF-${pair.pairId} (no base)`); continue; }
      const memberIds = [];
      try {
        for (const v of pair.variants) {
          const variant = cloneBundleWithFreshIds(chosen.bundle);
          const patient = patientFromBundle(variant);
          applyFlip(patient, v.flip);
          ensureTag(patient, "cleansheet-library:demo");
          ensureTag(patient, `cleansheet-library:counterfactual-pair-${pair.pairId}-${v.variant}`);
          const entry = await dumpOnePatient(dumpDir, variant);
          summaries.push(entry);
          memberIds.push(entry.id);
        }
        counterfactualPairs.push({
          pairId: pair.pairId,
          flipAxis: flipLabels[pair.pairId] ?? pair.flipAxis ?? "unknown",
          label: pair.label,
          memberPatientIds: memberIds,
        });
        console.log(`  dumped: CF-${pair.pairId} (${pair.flipAxis}) — ${memberIds.length} variants`);
      } catch (e) {
        console.log(`  FAILED: CF-${pair.pairId} ─ ${e.message}`);
      }
    }
    // Merge with any existing index.json (load-demo writes one too)
    const indexPath = path.join(dumpDir, "index.json");
    let existing = { patients: [], counterfactualPairs: [] };
    try { existing = JSON.parse(await fs.readFile(indexPath, "utf-8")); } catch { /* ok, no prior index */ }
    const allPatients = [...existing.patients, ...summaries];
    const allPairs = [...(existing.counterfactualPairs ?? []), ...counterfactualPairs];
    // Dedupe by id (last write wins)
    const dedupedPatients = Array.from(new Map(allPatients.map((p) => [p.id, p])).values());
    await writeDumpIndex(dumpDir, dedupedPatients, allPairs, `synthea:${dir}`);
    console.log(`Wrote ${summaries.length} CF variants + updated index.json (${dedupedPatients.length} total patients).`);
    return;
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to POST to Medplum, or --dump <dir> to write to disk.");
    return;
  }

  const base = process.env.MEDPLUM_BASE;
  const token = process.env.MEDPLUM_TOKEN;
  if (!base || !token) { console.error("Missing MEDPLUM_BASE or MEDPLUM_TOKEN"); process.exit(3); }

  console.log(`\nApplying to ${base}...`);
  let ok = 0, fail = 0;
  for (const { pair, base: chosen, score } of picks) {
    if (!chosen || score === -Infinity) { console.log(`  skip: CF-${pair.pairId} (no base)`); fail++; continue; }
    try {
      // Build variant-A: post the base bundle with the pair tag.
      const variantA = cloneBundleWithFreshIds(chosen.bundle); // fresh UUIDs even for "base"
      const patientA = patientFromBundle(variantA);
      applyFlip(patientA, pair.variants[0].flip);
      ensureTag(patientA, "cleansheet-library:demo");
      ensureTag(patientA, `cleansheet-library:counterfactual-pair-${pair.pairId}-${pair.variants[0].variant}`);
      await postTransaction(base, token, variantA);

      // Build variant-B: clone again, apply flip, tag.
      const variantB = cloneBundleWithFreshIds(chosen.bundle);
      const patientB = patientFromBundle(variantB);
      applyFlip(patientB, pair.variants[1].flip);
      ensureTag(patientB, "cleansheet-library:demo");
      ensureTag(patientB, `cleansheet-library:counterfactual-pair-${pair.pairId}-${pair.variants[1].variant}`);
      await postTransaction(base, token, variantB);

      // Look up server-assigned Patient IDs by their pair tags.
      const idA = await findPatientIdByTag(base, token, `cleansheet-library:counterfactual-pair-${pair.pairId}-${pair.variants[0].variant}`);
      const idB = await findPatientIdByTag(base, token, `cleansheet-library:counterfactual-pair-${pair.pairId}-${pair.variants[1].variant}`);
      if (!idA || !idB) throw new Error(`could not locate posted variants (A=${idA}, B=${idB})`);

      // Create the linking Group resource as its own transaction.
      const groupBundle = {
        resourceType: "Bundle",
        type: "transaction",
        entry: [{
          fullUrl: `urn:uuid:${crypto.randomUUID()}`,
          resource: {
            resourceType: "Group",
            type: "person",
            actual: true,
            name: pair.label,
            meta: { tag: [
              { system: "cleansheet-library", code: `cleansheet-library:counterfactual-pair-${pair.pairId}-group` },
            ] },
            member: [
              { entity: { reference: `Patient/${idA}` } },
              { entity: { reference: `Patient/${idB}` } },
            ],
          },
          request: { method: "POST", url: "Group" },
        }],
      };
      await postTransaction(base, token, groupBundle);

      console.log(`  built: CF-${pair.pairId} (${pair.flipAxis}) ─ Patient/${idA} ↔ Patient/${idB}`);
      ok++;
    } catch (e) {
      console.log(`  FAILED: CF-${pair.pairId} ─ ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} pairs built, ${fail} failed/skipped.`);
}

// ─── Subcommand: dump-synthea ────────────────────────────────────────────────
//
// "Just give me everything" — recurse a Synthea output tree, dump every Bundle
// with a Patient resource, tag each with `cleansheet-library:demo`, write
// summary markdown, build index.json. No demographic matrix matching, no
// Medplum required. Use when the cell-based curation in load-demo doesn't
// match the pools on disk, or when you just want a broad set for browsing.

async function walkBundles(rootDir) {
  const out = [];
  async function recur(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await recur(full); continue; }
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".json")) continue;
      if (e.name.startsWith("hospitalInformation")) continue;
      if (e.name.startsWith("practitionerInformation")) continue;
      out.push(full);
    }
  }
  await recur(rootDir);
  return out;
}

async function cmdDumpSynthea(rootDir, outDir) {
  if (!outDir) { console.error("dump-synthea requires --dump <out-dir>"); process.exit(2); }
  await fs.mkdir(outDir, { recursive: true });

  const files = await walkBundles(rootDir);
  console.log(`Found ${files.length} JSON files under ${rootDir}\n`);

  const summaries = [];
  let ok = 0, skip = 0, fail = 0;
  for (const f of files) {
    try {
      const raw = await fs.readFile(f, "utf-8");
      const bundle = JSON.parse(raw);
      if (bundle.resourceType !== "Bundle") { skip++; continue; }
      const patient = patientFromBundle(bundle);
      if (!patient) { skip++; continue; }
      ensureTag(patient, "cleansheet-library:demo");
      const entry = await dumpOnePatient(outDir, bundle);
      summaries.push(entry);
      const display = entry.name.padEnd(40);
      console.log(`  dumped: ${display}  ${entry.age ?? "?"}y ${entry.gender}  ${entry.race}`);
      ok++;
    } catch (e) {
      console.log(`  FAILED: ${path.basename(f)} ─ ${e.message}`);
      fail++;
    }
  }

  await writeDumpIndex(outDir, summaries, [], `synthea:${rootDir}`);
  console.log(`\nDone. ${ok} dumped, ${skip} skipped (not patient bundles), ${fail} failed. Index at ${outDir}/index.json`);
}

// ─── Subcommand: dump ────────────────────────────────────────────────────────
//
// Fetch every Patient tagged cleansheet-library:demo, pull $everything per
// patient, and write one bundle per file + a summary index.json. Output is
// browseable by the intranet PatientLibrary page without a live Medplum.

const DEFAULT_DUMP_OUT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "public",
  "data",
  "patients",
);

async function fhirGet(base, token, urlSuffix) {
  const url = urlSuffix.startsWith("http") ? urlSuffix : `${base}${urlSuffix}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" },
  });
  if (!res.ok) throw new Error(`GET ${urlSuffix} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

function countResources(bundle, type) {
  return (bundle.entry ?? []).filter((e) => e.resource?.resourceType === type).length;
}

function mostRecentObservationDate(bundle) {
  let latest = null;
  for (const e of bundle.entry ?? []) {
    if (e.resource?.resourceType !== "Observation") continue;
    const dt = e.resource.effectiveDateTime || e.resource.effectivePeriod?.start;
    if (dt && (latest == null || dt > latest)) latest = dt;
  }
  return latest;
}

function patientSummary(patient, everything) {
  const nameObj = patient.name?.[0] ?? {};
  const given = (nameObj.given ?? []).join(" ");
  const family = nameObj.family ?? "";
  const lastSeen = mostRecentObservationDate(everything);
  return {
    id: patient.id,
    filename: `${patient.id}.json`,
    name: `${given} ${family}`.trim(),
    gender: patient.gender ?? "unknown",
    birthDate: patient.birthDate ?? null,
    age: ageFromBirthDate(patient.birthDate),
    race: extractRace(patient),
    ethnicity: extractEthnicity(patient),
    language: extractLanguage(patient),
    tags: (patient.meta?.tag ?? []).map((t) => t.code).filter(Boolean),
    conditionCount: countResources(everything, "Condition"),
    medicationCount:
      countResources(everything, "MedicationRequest") +
      countResources(everything, "MedicationStatement"),
    observationCount: countResources(everything, "Observation"),
    encounterCount: countResources(everything, "Encounter"),
    allergyCount: countResources(everything, "AllergyIntolerance"),
    procedureCount: countResources(everything, "Procedure"),
    carePlanCount: countResources(everything, "CarePlan"),
    immunizationCount: countResources(everything, "Immunization"),
    lastSeen: lastSeen ? lastSeen.slice(0, 10) : null,
  };
}

async function cmdDump(outDir) {
  const base = process.env.MEDPLUM_BASE;
  const token = process.env.MEDPLUM_TOKEN;
  if (!base || !token) { console.error("Missing MEDPLUM_BASE or MEDPLUM_TOKEN"); process.exit(3); }

  await fs.mkdir(outDir, { recursive: true });
  console.log(`Dump target: ${outDir}\nSource: ${base}\n`);

  // Page through Patient?_tag=cleansheet-library:demo
  const patients = [];
  let next = `/Patient?_tag=cleansheet-library:demo&_count=50`;
  while (next) {
    const page = await fhirGet(base, token, next);
    for (const entry of page.entry ?? []) {
      if (entry.resource?.resourceType === "Patient") patients.push(entry.resource);
    }
    const nextLink = (page.link ?? []).find((l) => l.relation === "next");
    next = nextLink?.url ?? null;
  }
  console.log(`Found ${patients.length} tagged patients.\n`);

  const summaries = [];
  let ok = 0, fail = 0;
  for (const patient of patients) {
    try {
      const everything = await fhirGet(base, token, `/Patient/${patient.id}/$everything?_count=500`);
      const filePath = path.join(outDir, `${patient.id}.json`);
      await fs.writeFile(filePath, JSON.stringify(everything, null, 2));
      const summary = patientSummary(patient, everything);
      summaries.push(summary);
      console.log(`  dumped: ${summary.name.padEnd(28)} ${patient.id}  (${summary.conditionCount}c/${summary.medicationCount}m/${summary.observationCount}o)`);
      ok++;
    } catch (e) {
      console.log(`  FAILED: ${patient.id} ─ ${e.message}`);
      fail++;
    }
  }

  // Counterfactual pair Groups (best-effort — Medplum may not return them all in one go)
  const counterfactualPairs = [];
  try {
    const groupBundle = await fhirGet(base, token, `/Group?_count=50`);
    const flipLabels = { "1": "sex", "2": "race", "3": "language", "4": "age-band", "5": "pediatric-sex", "6": "young-adult-language" };
    for (const entry of groupBundle.entry ?? []) {
      const g = entry.resource;
      if (g?.resourceType !== "Group") continue;
      const tag = (g.meta?.tag ?? []).find((t) => /^cleansheet-library:counterfactual-pair-\d+-group$/.test(t.code ?? ""));
      if (!tag) continue;
      const pairId = tag.code.match(/counterfactual-pair-(\d+)-group/)[1];
      counterfactualPairs.push({
        pairId,
        flipAxis: flipLabels[pairId] ?? "unknown",
        label: g.name ?? `Counterfactual Pair ${pairId}`,
        memberPatientIds: (g.member ?? []).map((m) => m.entity?.reference?.replace(/^Patient\//, "")).filter(Boolean),
      });
    }
    counterfactualPairs.sort((a, b) => a.pairId.localeCompare(b.pairId, undefined, { numeric: true }));
    console.log(`\nFound ${counterfactualPairs.length} counterfactual pair groups.`);
  } catch (e) {
    console.log(`\n(skipped Group dump: ${e.message})`);
  }

  const index = {
    dumpedAt: new Date().toISOString(),
    source: base,
    patientCount: summaries.length,
    patients: summaries.sort((a, b) => a.name.localeCompare(b.name)),
    counterfactualPairs,
  };
  await fs.writeFile(path.join(outDir, "index.json"), JSON.stringify(index, null, 2));

  console.log(`\nDone. ${ok} bundles dumped, ${fail} failed. Index written to ${outDir}/index.json.`);
}

// ─── Subcommand: seed-from-dump ──────────────────────────────────────────────
//
// Reads the saved $everything bundles and POSTs them to a fresh Medplum as
// transaction bundles. Re-establishes the library after a Medplum rebuild
// without re-running Synthea.
//
// Transform: $everything returns a searchset Bundle with absolute URLs.
// Re-build as a transaction Bundle:
//   - Each entry's fullUrl becomes urn:uuid:<new-uuid>
//   - All internal references are rewritten to point at the new UUIDs
//   - Each entry gets request.method=POST + url=<ResourceType>
//   - Patient meta.tag is preserved so the library-by-tag query still works

function rebuildAsTransaction(everything) {
  const stripped = trimBundle(JSON.parse(JSON.stringify(everything)));
  const entries = stripped.entry ?? [];

  // Map old absolute reference → new urn:uuid
  const refMap = new Map();
  for (const entry of entries) {
    const r = entry.resource;
    if (!r?.resourceType || !r.id) continue;
    const oldRef = `${r.resourceType}/${r.id}`;
    refMap.set(oldRef, `urn:uuid:${crypto.randomUUID()}`);
  }

  // Rewrite references everywhere via string replace (safe because URN form is unique)
  let s = JSON.stringify(stripped);
  for (const [oldRef, newRef] of refMap) {
    s = s.split(`"${oldRef}"`).join(`"${newRef}"`);
  }
  const rewritten = JSON.parse(s);

  const txEntries = (rewritten.entry ?? []).map((e) => {
    const r = e.resource;
    const oldRef = `${r.resourceType}/${r.id}`;
    delete r.id; // let the server assign new IDs
    return {
      fullUrl: refMap.get(oldRef) ?? `urn:uuid:${crypto.randomUUID()}`,
      resource: r,
      request: { method: "POST", url: r.resourceType },
    };
  });

  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: txEntries,
  };
}

async function cmdSeedFromDump(outDir, apply) {
  const indexPath = path.join(outDir, "index.json");
  let index;
  try {
    index = JSON.parse(await fs.readFile(indexPath, "utf-8"));
  } catch (e) {
    console.error(`Cannot read ${indexPath}: ${e.message}`);
    process.exit(3);
  }

  console.log(`Seeding from ${outDir} (${index.patientCount} patients, dumped ${index.dumpedAt})`);

  if (!apply) {
    for (const p of index.patients) {
      console.log(`  would post: ${p.name.padEnd(28)} ${p.id}  → ${p.filename}`);
    }
    console.log("\nDry run. Re-run with --apply to POST.");
    return;
  }

  const base = process.env.MEDPLUM_BASE;
  const token = process.env.MEDPLUM_TOKEN;
  if (!base || !token) { console.error("Missing MEDPLUM_BASE or MEDPLUM_TOKEN"); process.exit(3); }

  console.log(`\nApplying to ${base}...`);
  let ok = 0, fail = 0;
  for (const p of index.patients) {
    try {
      const everything = JSON.parse(await fs.readFile(path.join(outDir, p.filename), "utf-8"));
      const tx = rebuildAsTransaction(everything);
      await postTransaction(base, token, tx);
      console.log(`  seeded: ${p.name.padEnd(28)} (${tx.entry.length} resources)`);
      ok++;
    } catch (e) {
      console.log(`  FAILED: ${p.name} ─ ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} patients seeded, ${fail} failed.`);
}

// ─── Subcommand: recategorize ────────────────────────────────────────────────
//
// Walks every patient bundle referenced in index.json, recomputes
// clinicalCategories + clinicalFlags from the bundle's Conditions and
// Medications, and writes the updated entries back. Use after editing the
// CLINICAL_CATEGORIES vocabulary to refresh existing dumps without
// regenerating bundles.

async function cmdRecategorize(outDir) {
  const indexPath = path.join(outDir, "index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf-8"));
  let changed = 0;
  for (const p of index.patients) {
    const bundlePath = path.join(outDir, p.filename);
    let bundle;
    try { bundle = JSON.parse(await fs.readFile(bundlePath, "utf-8")); }
    catch (e) { console.log(`  skip: ${p.id} (${e.message})`); continue; }
    const { categories, flags } = categorizeBundle(bundle);
    const prevCats = JSON.stringify(p.clinicalCategories ?? []);
    const prevFlags = JSON.stringify(p.clinicalFlags ?? []);
    p.clinicalCategories = categories;
    p.clinicalFlags = flags;
    if (prevCats !== JSON.stringify(categories) || prevFlags !== JSON.stringify(flags)) changed++;
  }
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  console.log(`Recategorized ${index.patients.length} patients (${changed} changed).`);

  // Summary stats — handy for sanity-checking vocabulary tuning.
  const catCounts = new Map();
  const flagCounts = new Map();
  for (const p of index.patients) {
    for (const c of p.clinicalCategories ?? []) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
    for (const f of p.clinicalFlags ?? []) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  }
  console.log("\nCategory counts:");
  for (const [c, n] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(20)} ${n}`);
  }
  console.log("\nFlag counts:");
  for (const [f, n] of [...flagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${f.padEnd(20)} ${n}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const dirIdx = rest.indexOf("--dir");
  const dir = dirIdx === -1 ? null : rest[dirIdx + 1];
  const outIdx = rest.indexOf("--out");
  const out = outIdx === -1 ? DEFAULT_DUMP_OUT : rest[outIdx + 1];
  const dumpIdx = rest.indexOf("--dump");
  const dump = dumpIdx === -1 ? null : (rest[dumpIdx + 1] ?? DEFAULT_DUMP_OUT);
  const apply = rest.includes("--apply");

  const usage = () => {
    console.error("usage:");
    console.error("  curator.mjs scan           --dir <synthea-dir>");
    console.error("  curator.mjs load-demo      --dir <synthea-dir> [--apply] [--dump <out-dir>]");
    console.error("  curator.mjs make-pairs     --dir <synthea-dir> [--apply] [--dump <out-dir>]");
    console.error("  curator.mjs dump-synthea   --dir <synthea-root> --dump <out-dir>");
    console.error("  curator.mjs dump           [--out <dir>]");
    console.error("  curator.mjs seed-from-dump [--out <dir>] [--apply]");
    console.error("  curator.mjs recategorize   [--out <dir>]");
  };

  if (!cmd) { usage(); process.exit(2); }

  if (cmd === "dump") return cmdDump(out);
  if (cmd === "seed-from-dump") return cmdSeedFromDump(out, apply);
  if (cmd === "recategorize") return cmdRecategorize(out);

  if (!dir) { usage(); process.exit(2); }
  if (cmd === "scan") return cmdScan(dir);
  if (cmd === "load-demo") return cmdLoadDemo(dir, apply, dump);
  if (cmd === "make-pairs") return cmdMakePairs(dir, apply, dump);
  if (cmd === "dump-synthea") return cmdDumpSynthea(dir, dump);

  console.error(`unknown command: ${cmd}`);
  usage();
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
