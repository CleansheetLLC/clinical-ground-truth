# Reference Data for Code Validation

Download these files into this directory, then run `generate_code_sets.py` to produce TypeScript lookup sets.

## ICD-10-CM (CMS)

1. Go to https://www.cms.gov/medicare/coding-billing/icd-10-codes/2026-icd-10-cm
2. Download "2026 Code Descriptions in Tabular Order" (ZIP)
3. Extract `icd10cm_order_2026.txt` into this directory

Expected: ~72,000 diagnosis codes. Fixed-width format, ~20MB.

## LOINC (Regenstrief Institute)

1. Go to https://loinc.org/downloads/
2. Create a free account if needed
3. Download "LOINC Table File" (CSV)
4. Extract `Loinc.csv` into this directory

Expected: ~100,000 observation codes. CSV format, ~100MB.

## RxNorm (NLM)

1. Go to https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html
2. Download "RxNorm Full Monthly Release" (requires UMLS license, free)
3. Extract `RXNCONSO.RRF` from the `rrf/` folder into this directory

Expected: ~300,000 concept identifiers (CUIs). Pipe-delimited, ~500MB.

## Generating TypeScript Files

```bash
cd clinical-ground-truth/tools

python generate_code_sets.py \
  --icd10 reference-data/icd10cm_order_2026.txt \
  --loinc reference-data/Loinc.csv \
  --rxnorm reference-data/RXNCONSO.RRF \
  --outdir ../../corporate/intranet/src/demo/data/generated/
```

Each flag is optional. Generate only the systems you have source files for.

## .gitignore

The source files in this directory are large and subject to license restrictions.
They are excluded from version control. Only this README is tracked.
