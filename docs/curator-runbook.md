# Curator Runbook — Synthea → CGT → intranet

End-to-end workflow for expanding `clinical-ground-truth/patients/` and
syncing into the corporate intranet's static patient library.

## What the curator does

`tools/curator.mjs` operates against a Synthea output directory and writes:

- **Trimmed FHIR transaction bundles** per selected patient (`<id>.json`)
- **Clinician-readable summaries** in markdown (`<id>.md`)
- **`index.json`** — a manifest of patients + counterfactual pairs

Two subcommands fill the library:

- `load-demo` — picks one patient per demographic-matrix cell (sex × race × age × language × comorbidity), tags `cleansheet-library:demo`
- `make-pairs` — picks a base from the pool, clones with fresh UUIDs, flips one demographic axis on the clone, tags both with `cleansheet-library:counterfactual-pair-{N}-{variant}`, links via a `Group` resource

With `--dump <dir>` the writes are pure file IO — no Medplum needed. With `--apply` plus `MEDPLUM_BASE` + `MEDPLUM_TOKEN`, the bundles are also POSTed to a live Medplum.

## Mac install (one-time)

```bash
# Java (Synthea needs JDK 11+; we use 21)
brew install openjdk@21

# openjdk@21 is keg-only; either symlink it system-wide:
sudo ln -sfn /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk \
  /Library/Java/JavaVirtualMachines/openjdk-21.jdk

# …or just use the full path in commands below:
JAVA=/opt/homebrew/opt/openjdk@21/bin/java
$JAVA -version
```

Stage Synthea inside CGT (gitignored via `.synthea/`):

```bash
cd ~/github/clinical-ground-truth
mkdir -p .synthea && cd .synthea
curl -L -o synthea-with-dependencies.jar \
  https://github.com/synthetichealth/synthea/releases/latest/download/synthea-with-dependencies.jar
```

## Generate pools

Larger pools than the original 27-patient build because we need both
demographic-cell hits AND viable CF-pair bases. ~600 per band; bump to
~1000 if any cell reports `NO MATCH` during dry-run.

```bash
cd ~/github/clinical-ground-truth/.synthea
JAVA=/opt/homebrew/opt/openjdk@21/bin/java   # or just `java` if symlinked

$JAVA -jar synthea-with-dependencies.jar \
  -p 600 -a 0-17 \
  --exporter.fhir.export true \
  --exporter.fhir.transaction_bundle true \
  --exporter.years_of_history 12 \
  --exporter.baseDirectory ./output-peds

$JAVA -jar synthea-with-dependencies.jar \
  -p 600 -a 18-39 \
  --exporter.fhir.export true \
  --exporter.fhir.transaction_bundle true \
  --exporter.years_of_history 20 \
  --exporter.baseDirectory ./output-ya
```

Output lands at `.synthea/output-peds/fhir/*.json` and `.synthea/output-ya/fhir/*.json`. Walltime ~15–25 min total on M-series Mac.

## Survey (optional)

```bash
cd ~/github/clinical-ground-truth
node tools/curator.mjs scan --dir .synthea/output-peds/fhir | head -40
node tools/curator.mjs scan --dir .synthea/output-ya/fhir   | head -40
```

One row per patient with gender / age / race / language / comorbidity profile / condition count / med count. Spot-check the distribution.

## Dry-run the demo-cell picker

```bash
node tools/curator.mjs load-demo --dir .synthea/output-peds/fhir
node tools/curator.mjs load-demo --dir .synthea/output-ya/fhir
```

Prints which Synthea bundle was picked per cell. `NO MATCH` for a cell means insufficient demographic coverage in the pool — regenerate with `-p 1000` for that band.

## Dry-run the CF-pair base picker

```bash
node tools/curator.mjs make-pairs --dir .synthea/output-peds/fhir
node tools/curator.mjs make-pairs --dir .synthea/output-ya/fhir
```

The peds pool yields the CF-5 base (pediatric-sex flip); the YA pool yields CF-4 (age-band flip) and CF-6 (YA-language flip). Each pool will skip the pair(s) it can't satisfy.

## Apply — dump into CGT/patients/

```bash
cd ~/github/clinical-ground-truth

# 14 demo patients: peds 7 + YA 7
node tools/curator.mjs load-demo  --dir .synthea/output-peds/fhir --dump patients/
node tools/curator.mjs load-demo  --dir .synthea/output-ya/fhir   --dump patients/

# 6 CF patients (3 pairs): CF-5 from peds, CF-4 + CF-6 from YA
node tools/curator.mjs make-pairs --dir .synthea/output-peds/fhir --dump patients/
node tools/curator.mjs make-pairs --dir .synthea/output-ya/fhir   --dump patients/
```

Each invocation merges into the existing `patients/index.json` — patients are unioned by `id`, pairs are unioned by `pairId`. Re-running is safe.

Commit the curated bundles to CGT:

```bash
git add patients/
git commit -m "patients: add peds + YA matrix (7+7 demo + 6 CF pairs)"
git push
```

## Sync into intranet

From the corporate repo:

```bash
cd ~/github/corporate
( cd ../clinical-ground-truth && git pull )
node ../clinical-ground-truth/tools/sync-patients-to-intranet.mjs

git add intranet/public/data/patients
git commit -m "intranet: sync peds + YA patients from clinical-ground-truth"
```

## Verify

```bash
node -e "
const idx = require('./intranet/public/data/patients/index.json');
const bands = { '0-17':0,'18-39':0,'40-64':0,'65+':0,unknown:0 };
for (const p of idx.patients) {
  if (p.age==null) bands.unknown++;
  else if (p.age<=17) bands['0-17']++;
  else if (p.age<=39) bands['18-39']++;
  else if (p.age<=64) bands['40-64']++;
  else bands['65+']++;
}
console.log('total:', idx.patients.length);
console.log(bands);
"
```

Expected: peds and YA buckets non-zero; total grows by 20 from the starting count.

## Apply to live Medplum (optional)

If a live Medplum is also reachable:

```bash
export MEDPLUM_BASE="https://medplum.cleansheet.life/fhir/R4"
export MEDPLUM_TOKEN="cs_live_<paste-bearer-here>"

node tools/curator.mjs load-demo  --dir .synthea/output-peds/fhir --apply
node tools/curator.mjs load-demo  --dir .synthea/output-ya/fhir   --apply
node tools/curator.mjs make-pairs --dir .synthea/output-peds/fhir --apply
node tools/curator.mjs make-pairs --dir .synthea/output-ya/fhir   --apply
```

`--apply` and `--dump` can be combined to do both in one pass.
