#!/usr/bin/env python3
"""Validate FHIR annotation bundles and metadata files against schemas."""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BUNDLE_SCHEMA = REPO_ROOT / "schemas" / "fhir-bundle.schema.json"
METADATA_SCHEMA = REPO_ROOT / "schemas" / "transcript-metadata.schema.json"

ALLOWED_RESOURCE_TYPES = {
    "Patient", "Encounter", "Condition", "MedicationRequest",
    "MedicationStatement", "Observation", "AllergyIntolerance",
    "Procedure", "ServiceRequest", "FamilyMemberHistory", "Composition",
}

CODE_SYSTEMS = {
    "Condition": "http://hl7.org/fhir/sid/icd-10-cm",
    "Condition-DE": "http://fhir.de/CodeSystem/bfarm/icd-10-gm",
    "MedicationStatement": "http://www.nlm.nih.gov/research/umls/rxnorm",
    "MedicationRequest": "http://www.nlm.nih.gov/research/umls/rxnorm",
    "Observation": "http://loinc.org",
    "AllergyIntolerance": "http://www.nlm.nih.gov/research/umls/rxnorm",
}


def load_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def validate_bundle(path: Path) -> list[str]:
    """Validate a FHIR Bundle annotation file. Returns list of errors."""
    errors = []
    try:
        bundle = load_json(path)
    except json.JSONDecodeError as e:
        return [f"Invalid JSON: {e}"]

    # Top-level structure
    if bundle.get("resourceType") != "Bundle":
        errors.append("resourceType must be 'Bundle'")
    if bundle.get("type") != "collection":
        errors.append("type must be 'collection'")

    meta = bundle.get("meta")
    if not meta:
        errors.append("Missing 'meta' object")
    else:
        if "source" not in meta:
            errors.append("meta.source is required")
        if "lastUpdated" not in meta:
            errors.append("meta.lastUpdated is required")

    entries = bundle.get("entry")
    if not entries:
        errors.append("Bundle must have at least one entry")
        return errors

    if not isinstance(entries, list):
        errors.append("entry must be an array")
        return errors

    resource_counts: dict[str, int] = {}
    has_patient = False
    has_encounter = False

    for i, entry in enumerate(entries):
        resource = entry.get("resource")
        if not resource:
            errors.append(f"entry[{i}]: missing 'resource'")
            continue

        rt = resource.get("resourceType")
        if not rt:
            errors.append(f"entry[{i}]: missing resourceType")
            continue

        if rt not in ALLOWED_RESOURCE_TYPES:
            errors.append(f"entry[{i}]: unknown resourceType '{rt}'")
            continue

        resource_counts[rt] = resource_counts.get(rt, 0) + 1

        if rt == "Patient":
            has_patient = True
        elif rt == "Encounter":
            has_encounter = True
        elif rt == "Condition":
            errors.extend(_validate_condition(resource, i))
        elif rt in ("MedicationStatement", "MedicationRequest"):
            errors.extend(_validate_medication(resource, i, rt))
        elif rt == "Observation":
            errors.extend(_validate_observation(resource, i))
        elif rt == "AllergyIntolerance":
            errors.extend(_validate_allergy(resource, i))

    if not has_patient:
        errors.append("Bundle must contain at least one Patient resource")
    if not has_encounter:
        errors.append("Bundle must contain at least one Encounter resource")

    return errors


def _check_coding(resource: dict, i: int, field: str) -> list[str]:
    """Check that a code field has at least one coding with system and code."""
    errors = []
    code_obj = resource.get(field)
    if not code_obj:
        errors.append(f"entry[{i}]: missing '{field}'")
        return errors
    codings = code_obj.get("coding", [])
    if not codings:
        errors.append(f"entry[{i}]: {field}.coding is empty")
        return errors
    for j, coding in enumerate(codings):
        if not coding.get("system"):
            errors.append(f"entry[{i}]: {field}.coding[{j}].system is required")
        if not coding.get("code"):
            errors.append(f"entry[{i}]: {field}.coding[{j}].code is required")
    return errors


def _validate_condition(resource: dict, i: int) -> list[str]:
    errors = []
    errors.extend(_check_coding(resource, i, "code"))
    if not resource.get("clinicalStatus"):
        errors.append(f"entry[{i}]: Condition.clinicalStatus is required")
    if not resource.get("verificationStatus"):
        errors.append(f"entry[{i}]: Condition.verificationStatus is required")
    if not resource.get("subject"):
        errors.append(f"entry[{i}]: Condition.subject is required")
    return errors


def _validate_medication(resource: dict, i: int, rt: str) -> list[str]:
    errors = []
    errors.extend(_check_coding(resource, i, "medicationCodeableConcept"))
    if not resource.get("status"):
        errors.append(f"entry[{i}]: {rt}.status is required")
    if not resource.get("subject"):
        errors.append(f"entry[{i}]: {rt}.subject is required")
    return errors


def _validate_observation(resource: dict, i: int) -> list[str]:
    errors = []
    errors.extend(_check_coding(resource, i, "code"))
    if not resource.get("status"):
        errors.append(f"entry[{i}]: Observation.status is required")
    if not resource.get("subject"):
        errors.append(f"entry[{i}]: Observation.subject is required")
    # Must have one of valueQuantity, valueString, or component
    has_value = any(
        resource.get(k) for k in ("valueQuantity", "valueString", "component")
    )
    if not has_value:
        errors.append(
            f"entry[{i}]: Observation needs valueQuantity, valueString, or component"
        )
    return errors


def _validate_allergy(resource: dict, i: int) -> list[str]:
    errors = []
    errors.extend(_check_coding(resource, i, "code"))
    if not resource.get("patient"):
        errors.append(f"entry[{i}]: AllergyIntolerance.patient is required")
    return errors


def validate_metadata(path: Path) -> list[str]:
    """Validate a transcript metadata file. Returns list of errors."""
    errors = []
    try:
        meta = load_json(path)
    except json.JSONDecodeError as e:
        return [f"Invalid JSON: {e}"]

    required = ["id", "language", "workflow", "source", "verified"]
    for field in required:
        if field not in meta:
            errors.append(f"Missing required field: {field}")

    if "id" in meta:
        import re
        if not re.match(r"^[a-z]{2}-[a-z]+-[0-9]{3}$", meta["id"]):
            errors.append(
                f"id '{meta['id']}' does not match pattern "
                "'^[a-z]{{2}}-[a-z]+-[0-9]{{3}}$'"
            )

    valid_languages = {"en", "de", "fr", "vi", "zh", "pl"}
    if "language" in meta and meta["language"] not in valid_languages:
        errors.append(f"language '{meta['language']}' not in {valid_languages}")

    valid_workflows = {
        "general", "soap", "hp", "emergency", "samplers",
        "intake", "followup", "discharge", "procedure",
        "radiology", "lab_review", "cardiology", "neurology",
        "pediatrics", "icu", "respiratory", "consult",
        "progress", "recommendations", "handoff", "dialogue",
        "psych_intake", "psych_medmgmt", "psychotherapy", "psych_crisis",
    }
    if "workflow" in meta and meta["workflow"] not in valid_workflows:
        errors.append(f"workflow '{meta['workflow']}' not in valid set")

    valid_sources = {"original", "multimed", "n2c2", "united-medsyn", "contributed"}
    if "source" in meta and meta["source"] not in valid_sources:
        errors.append(f"source '{meta['source']}' not in {valid_sources}")

    valid_difficulties = {"simple", "moderate", "complex"}
    if "difficulty" in meta and meta["difficulty"] not in valid_difficulties:
        errors.append(f"difficulty '{meta['difficulty']}' not in {valid_difficulties}")

    # audio_files (new shape) — validate path existence and required fields
    if "audio_files" in meta:
        if not isinstance(meta["audio_files"], list):
            errors.append("audio_files must be an array")
        else:
            for i, af in enumerate(meta["audio_files"]):
                if not isinstance(af, dict):
                    errors.append(f"audio_files[{i}]: must be an object")
                    continue
                if "path" not in af:
                    errors.append(f"audio_files[{i}]: missing required 'path'")
                    continue
                audio_path = REPO_ROOT / af["path"]
                if not audio_path.exists():
                    errors.append(f"audio_files[{i}]: path '{af['path']}' does not exist on disk")

    # audio_file (legacy single field) — warn only, not fatal
    if meta.get("audio_file") and not meta.get("audio_files"):
        print(
            f"  warning: 'audio_file' is deprecated; migrate to 'audio_files' via "
            f"tools/migrate-audio-layout.py",
            file=sys.stderr,
        )

    # Check entity_counts match annotation if annotation_file is specified
    if meta.get("annotation_file") and "entity_counts" in meta:
        annotation_path = REPO_ROOT / meta["annotation_file"]
        if annotation_path.exists():
            try:
                bundle = load_json(annotation_path)
                actual_counts: dict[str, int] = {}
                for entry in bundle.get("entry", []):
                    rt = entry.get("resource", {}).get("resourceType", "")
                    if rt in ("Patient", "Encounter", "Composition"):
                        continue
                    actual_counts[rt] = actual_counts.get(rt, 0) + 1
                declared = meta["entity_counts"]
                for rt, count in declared.items():
                    actual = actual_counts.get(rt, 0)
                    if actual != count:
                        errors.append(
                            f"entity_counts.{rt}: declared {count}, "
                            f"found {actual} in annotation"
                        )
                for rt, count in actual_counts.items():
                    if rt not in declared:
                        errors.append(
                            f"entity_counts missing {rt} "
                            f"(found {count} in annotation)"
                        )
            except (json.JSONDecodeError, KeyError):
                errors.append(
                    f"Could not validate entity_counts against "
                    f"{meta['annotation_file']}"
                )

    return errors


def main():
    if len(sys.argv) < 2:
        print("Usage: python validate.py <file.json> [file2.json ...]")
        print("  Validates FHIR Bundle annotations (.json) and metadata (.meta.json)")
        sys.exit(1)

    exit_code = 0
    for arg in sys.argv[1:]:
        path = Path(arg)
        if not path.exists():
            print(f"MISSING  {path}")
            exit_code = 1
            continue

        if path.name.endswith(".meta.json"):
            errors = validate_metadata(path)
            kind = "metadata"
        else:
            errors = validate_bundle(path)
            kind = "bundle"

        if errors:
            print(f"FAIL  {path} ({kind})")
            for err in errors:
                print(f"  - {err}")
            exit_code = 1
        else:
            print(f"OK    {path} ({kind})")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
