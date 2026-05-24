# Clinical Ground Truth

Open ground-truth data for clinical NLP evaluation, demo population, and prompt assessment. Covers the full chain: **audio → transcript → structured FHIR data**, plus longitudinal **patient bundles** to provide context for any of the above.

Formerly published as `clinical-extraction-benchmark`; renamed to reflect the broader scope. The extraction benchmark is one use of this data.

## What This Is

Existing medical speech datasets (MultiMed, n2c2, United-MedSyn) provide audio and transcripts, but none provide verified FHIR R4 extraction ground truth. Existing clinical NER datasets annotate entities but don't produce valid FHIR resources. Existing synthetic patient generators (Synthea) produce longitudinal bundles but with no curation guarantees for demographic coverage or bias evaluation.

This repo fills those gaps:

- **Human-verified expected FHIR R4 Bundles for clinical transcripts** — reproducible evaluation of any extraction pipeline against a common standard.
- **Curated longitudinal patient bundles with clinician-readable summaries** — usable as prompt context, demo data, or bias-evaluation cohorts. Generated from Synthea, selected against a demographic matrix, with counterfactual pairs for controlled bias probes.

## Repository Structure

```
clinical-ground-truth/
├── transcripts/               Verified clinical text (input to extraction)
│   ├── en/                   English
│   ├── de/                   German
│   └── fr/                   French
├── annotations/               Expected FHIR R4 Bundles (ground truth output)
│   ├── en/
│   ├── de/
│   └── fr/
├── audio/                     Audio files (where available)
│   ├── en/
│   ├── de/
│   └── fr/
├── patients/                  Longitudinal synthea bundles + clinical summaries
│   ├── <patient-id>.json     Trimmed FHIR Bundle
│   ├── <patient-id>.md       Clinician-readable summary (paste into prompts)
│   └── index.json             Demographic catalog + counterfactual pair manifest
├── schemas/                   JSON schemas for validation
├── tools/                     Scoring, evaluation, and curation scripts
└── docs/                      Methodology, annotation guidelines, data sources
```

## Data Layers

### Layer 1: Transcripts

Clinical text from multiple sources:

| Source | Languages | Type | License | Status |
| ------ | --------- | ---- | ------- | ------ |
| Original (this repo) | EN, DE | Scripted synthetic clinical scenarios | CC BY-SA 4.0 | In progress |
| [MultiMed](https://github.com/leduckhai/MultiMed) | EN, DE, FR, VI, ZH | Real clinical audio + transcripts | Research license | Reference (not redistributed) |
| [n2c2](https://n2c2.dbmi.hms.harvard.edu/data-sets) | EN | Deidentified clinical notes | DUA required | Reference (not redistributed) |

Transcripts from external datasets are **referenced, not redistributed**. Follow the links above to obtain them under their respective licenses. This repo provides the FHIR extraction annotations that layer on top.

### Layer 2: FHIR R4 Annotations (Novel Contribution)

Each transcript has a corresponding verified FHIR R4 Bundle in `annotations/`. The bundle contains the expected extraction output:

- **Condition** (ICD-10-CM / SNOMED-CT)
- **MedicationRequest** / **MedicationStatement** (RxNorm)
- **Observation** (LOINC) -- vitals, lab results
- **AllergyIntolerance** (RxNorm / SNOMED-CT)
- **Procedure** (CPT / SNOMED-CT)
- **ServiceRequest** (lab orders, imaging, referrals)
- **FamilyMemberHistory**

### Layer 3: Audio (Where Available)

Audio recorded for original scenarios is committed to `audio/` under CC BY-SA 4.0. Audio from external datasets (MultiMed, n2c2) is not included — obtain it from the original sources under their respective licenses.

### Layer 4: Patient Bundles (Curated Synthea)

Flat directory of longitudinal FHIR R4 Bundles drawn from a Synthea pool, selected against a demographic matrix (sex × race × age × language × comorbidity) plus a set of counterfactual pairs constructed by clone-and-edit (sex flip, race flip, language flip, age-band shift). Each bundle is paired with a clinician-readable markdown summary that surfaces demographics, active problems, medications, allergies, recent vitals, and recent encounters — directly pasteable into a prompt as patient context.

| Field | Value |
| ----- | ----- |
| Source | Synthea (open-source synthetic generator) |
| License | CC BY-SA 4.0 |
| Patient data | Synthetic — no PHI, no real patients |
| Curation methodology | `docs/patient-curation.md` (planned) |
| Tools | `tools/curator.mjs` |
| Counterfactual axes | sex, race, language, age-band, pediatric-sex, young-adult-language |

All Patient resources are tagged `cleansheet-library:demo`; counterfactual pair members carry an additional `cleansheet-library:counterfactual-pair-{N}-{variant}` tag. A `Group` resource links each pair.

Why bundles here vs. a separate repo: extraction benchmark scenarios are most useful when anchored to a real-feeling longitudinal patient history. Same data shape, same licensing, same audience. Keeping ground truth co-located avoids fragmentation.

## Annotation Format

Each annotation is a valid FHIR R4 Bundle (JSON) that could be submitted to a FHIR server. This means:

- Valid resource types with required fields
- Coded values use standard terminologies (ICD-10-CM, RxNorm, LOINC, SNOMED-CT)
- Resources reference a common Patient and Encounter
- Bundle type is `collection` (not `transaction`, since this is ground truth, not a submission)

See `schemas/` for JSON Schema validation and `docs/annotation-guidelines.md` for the annotation methodology.

## Evaluation

### Scoring

The `tools/` directory contains scripts for comparing pipeline output against ground truth:

```bash
# Compare a single extraction against ground truth
python tools/score.py annotations/en/en-soap-001.json output.json

# Batch score all matching files in a directory
python tools/batch_score.py results/ --lang en
```

### Metrics

| Metric | What It Measures |
| ------ | ---------------- |
| **Entity F1** | Per-resource-type precision/recall/F1 (did the pipeline find the right conditions, meds, etc.?) |
| **Code accuracy** | Of correctly identified entities, did the pipeline assign the right ICD-10/RxNorm/LOINC code? |
| **Attribute completeness** | Of correctly identified entities, were attributes (dose, severity, status) extracted? |
| **Bundle validity** | Is the output a valid FHIR R4 Bundle? |

## Scenario Coverage

Transcripts are organized by clinical workflow:

| Workflow | Tag | Description |
| -------- | --- | ----------- |
| General | `general` | Unstructured clinical encounter |
| SOAP | `soap` | Subjective/Objective/Assessment/Plan format |
| H&P | `hp` | History and Physical |
| Emergency | `emergency` | ED encounter, high acuity |
| SAMPLER+S | `samplers` | Pre-hospital / emergency (includes German Schmerz variant) |
| Intake | `intake` | New patient intake |
| Follow-up | `followup` | Return visit |
| Discharge | `discharge` | Discharge summary |
| Specialty | `cardiology`, `neurology`, etc. | Specialty-specific encounters |

## Contributing

We need help building this benchmark. The easiest way to contribute audio is through the **[web recorder](https://cleansheet.life/#contribute)** — pick a transcript, read it aloud, and submit. No GitHub account needed. You can also contribute through **GitHub Issues** — no git expertise required.

### Contribute via GitHub Issues

Use our issue templates to submit contributions directly from your browser:

| What you have | Issue template | Notes |
| ------------- | -------------- | ----- |
| A recorded clinical scenario | [Audio Contribution](../../issues/new?template=audio-contribution.yml) | Upload audio + transcript, or link to an existing transcript by ID |
| A scripted clinical transcript | [Transcript Contribution](../../issues/new?template=transcript-contribution.yml) | Paste or upload a .txt file |
| A FHIR R4 annotation for an existing transcript | [Annotation Contribution](../../issues/new?template=annotation-contribution.yml) | The most valuable contribution -- reference a transcript ID and submit the FHIR Bundle |

Audio submissions can be paired with an existing transcript (e.g., record yourself reading `en-soap-001`) or submitted with a new transcript.

### Other ways to contribute

- **Add languages**: Extend coverage beyond EN/DE/FR
- **Improve tooling**: Scoring scripts, validation, visualization
- **Review annotations**: Flag errors in existing FHIR Bundles by opening an issue
- **Extend patient cohort**: Propose new demographic cells, counterfactual pair axes, or specialty archetypes for the Layer-4 synthea library

For larger contributions (tooling, batch annotations), see `docs/contributing.md` for the PR workflow.

## Roadmap

The Layer-4 patient bundles are an active area. Curator now lives here as the canonical public location:

- [x] Migrate `medplum-load-library.mjs` → `tools/curator.mjs` (2026-05-23)
- [x] Migrate runbook (Synthea pool generation + curator workflow) → `docs/curator-runbook.md` (2026-05-23)
- [ ] Migrate demographic-matrix + counterfactual methodology writeup → `docs/patient-curation.md`
- [ ] Migrate Synthea generator configs (state × age × sex bands) → `tools/synthea-configs/`
- [ ] Initial seed of curated bundles under `patients/` (extracted from current Medplum or regenerated from Synthea)

### Quality requirements

- All transcripts must be **synthetic** (scripted scenarios, never real patient data)
- All FHIR annotations must be **independently verified** by a second reviewer
- All coded values must be **valid** in their respective terminology (ICD-10-CM, RxNorm, LOINC)
- Audio must be **clearly recorded** with metadata (language, accent, noise level, equipment)

## License

- **Original content** (transcripts, annotations, audio, tools): [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- **External datasets**: Referenced only, subject to their own licenses

## Citation

If you use this data in research, please cite:

```
@misc{clinical-ground-truth,
  title={Clinical Ground Truth: FHIR R4 Ground Truth, Audio, and Curated Patient Bundles for Clinical NLP Evaluation},
  author={Cleansheet LLC},
  year={2026},
  url={https://github.com/CleansheetLLC/clinical-ground-truth}
}
```
