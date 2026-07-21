# Annotation Guidelines

How to create verified FHIR R4 ground truth annotations for clinical transcripts.

## Principles

1. **Annotate what's stated, not what's implied.** If the transcript says "patient is on metformin," annotate a MedicationStatement. Don't infer diabetes unless it's explicitly stated.
2. **Use the most specific code available.** "Hypertension" → I10 (Essential hypertension), not R03.0 (Elevated blood-pressure reading).
3. **Two reviewers minimum.** Every annotation must be created by one person and verified by another.
4. **Valid FHIR or nothing.** Every annotation must be a valid FHIR R4 Bundle. Use `tools/validate.py` before submitting.

## Workflow

### Step 1: Read the transcript

Read the full transcript. Identify:
- Conditions / diagnoses (stated and historical)
- Medications (current and newly ordered)
- Allergies
- Vitals and lab results
- Orders (lab, imaging, procedure, referral)
- Family history
- Social history observations

### Step 2: Create the FHIR Bundle

Start from the template in `schemas/template-bundle.json`. For each identified entity:

1. Choose the correct FHIR resource type
2. Assign the appropriate code system and code
3. Fill required attributes (status, severity, dose, etc.)
4. Reference the common Patient and Encounter resources

### Step 3: Validate

```bash
python tools/validate.py annotations/en/soap-001.json
```

### Step 4: Create metadata

Create a metadata JSON file alongside the annotation (see `schemas/transcript-metadata.schema.json`):

```json
{
  "id": "en-soap-001",
  "language": "en",
  "workflow": "soap",
  "source": "original",
  "verified": true,
  "audio_file": "audio/en/soap-001.wav",
  "annotation_file": "annotations/en/soap-001.json",
  "specialty": ["internal-medicine"],
  "entity_counts": {
    "Condition": 3,
    "MedicationStatement": 2,
    "MedicationRequest": 1,
    "Observation": 4,
    "AllergyIntolerance": 1
  },
  "annotators": ["annotator-a", "reviewer-b"],
  "difficulty": "moderate",
  "notes": "Standard SOAP encounter with hypertension management"
}
```

### Step 5: Peer review

A second annotator reviews the FHIR Bundle against the transcript and either:
- Approves (sets `verified: true`)
- Returns with comments for revision

## Coding Conventions

### Conditions

| Field | Convention |
| ----- | ---------- |
| code.system | `http://hl7.org/fhir/sid/icd-10-cm` (US) or `http://fhir.de/CodeSystem/bfarm/icd-10-gm` (DE) |
| clinicalStatus | `active`, `resolved`, `inactive` |
| verificationStatus | `confirmed` (stated), `provisional` (suspected) |
| severity | Only if explicitly stated in transcript |

### Medications

| Field | Convention |
| ----- | ---------- |
| code.system | `http://www.nlm.nih.gov/research/umls/rxnorm` |
| status | `active` (current), `completed` (discontinued) |
| dosageInstruction | Only if dose/route/frequency stated |
| Use MedicationStatement for current meds, MedicationRequest for new orders |

### Observations (Vitals)

| Field | Convention |
| ----- | ---------- |
| code.system | `http://loinc.org` |
| valueQuantity | Numeric value + UCUM unit |
| component | Use for multi-part vitals (e.g., systolic/diastolic BP) |

### Allergies

| Field | Convention |
| ----- | ---------- |
| code.system | `http://www.nlm.nih.gov/research/umls/rxnorm` (drug) or SNOMED CT (substance) |
| reaction.severity | `mild`, `moderate`, `severe` — only if stated |
| type | `allergy` or `intolerance` based on transcript language |

## What NOT to Annotate

- **Implied conditions.** If the patient is on insulin but diabetes is never mentioned, do not add a Condition for diabetes.
- **Clinician reasoning.** "I think this might be..." is not a confirmed diagnosis unless the clinician states it as one.
- **Administrative data.** Appointment scheduling, insurance information, etc. are out of scope.
- **Normal findings.** "Lungs clear" is not an Observation unless it's clinically relevant in context (e.g., ruling out pneumonia in an ED visit).

## File Naming

```
{lang}-{workflow}-{sequence}.{ext}

Examples:
  en-soap-001.txt          (transcript)
  en-soap-001.json         (FHIR annotation)
  en-soap-001.meta.json    (metadata)
  en-soap-001.wav          (audio, if available)
```

## Behavioral-health conventions (psychiatry and psychotherapy)

Behavioral-health encounters add two properties that general-medicine annotations
do not exercise. Both are part of the ground truth, not stylistic choices.

### 1. Two note classes, encoded on `Composition`

Each behavioral-health bundle carries the note as a `Composition` resource (excluded
from `entity_counts`, like Patient and Encounter). Two classes exist:

| Class | `Composition.confidentiality` | Security label | Where it goes |
| ----- | ----------------------------- | -------------- | ------------- |
| Psychiatry / medical note (med-mgmt, intake, crisis) | `N` (normal) | none | The chart |
| Psychotherapy / process note | `R` (restricted) | v3 ActCode `PSY` on `Composition.meta.security` | A separate, specially protected compartment (45 CFR 164.501) |

A psychotherapy session's therapeutic content (process, themes, interventions) is
recorded **only** in the protected `Composition`. It is not mined into coded
resources. A faithful extraction of a therapy transcript yields a thin coded set,
the established billing diagnosis (`Condition`) and the billable service
(`Procedure`, CPT psychotherapy code), plus the protected note, and **never** a pile
of billing codes derived from process material. Over-coding a therapy transcript is a
scoring error, not a bonus.

### 2. Safety context is not coerced into ICD codes

In crisis / risk encounters, code only what is explicitly stated and codeable:
suicidal ideation (`R45.851`), the risk-instrument result (e.g. C-SSRS as an
`Observation`), depression severity (PHQ-9), continued medications, and the crisis
service (`Procedure`). The **risk formulation, means-restriction, and safety plan**
are carried as attested narrative in the `Composition`. Do not invent Conditions to
represent a safety plan or a monitoring decision, that context resists coding and
belongs in the note.

### Service and billing codes

Rendered, billable services (E/M, psychotherapy, crisis psychotherapy) are annotated
as `Procedure` with a CPT code (`http://www.ama-assn.org/go/cpt`). Orders and
referrals (labs, imaging) are `ServiceRequest`. Continued medications are
`MedicationStatement`; new starts and dose changes are `MedicationRequest`.

### Terminology verification

RxNorm, LOINC, and ICD-10-CM codes in this set were verified against RxNav
(`rxnav.nlm.nih.gov`) and the NLM Clinical Table Search Service
(`clinicaltables.nlm.nih.gov`) rather than transcribed from memory. Verify, do not
recall: RxNorm strength CUIs in particular are easy to transpose (e.g. sertraline
100 mg is `312938`, not `312940`, which is the 25 mg tablet).

## Quality Checklist

Before submitting an annotation:

- [ ] Bundle passes `tools/validate.py`
- [ ] Every Condition has a valid ICD-10 code
- [ ] Every Medication has a valid RxNorm code
- [ ] Every Observation has a valid LOINC code
- [ ] Entity counts in metadata match actual bundle contents
- [ ] No entities annotated that aren't explicitly stated in transcript
- [ ] Second reviewer has verified
