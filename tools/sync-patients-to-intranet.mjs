#!/usr/bin/env node
/**
 * Sync curated patient bundles from clinical-ground-truth (canonical) into
 * the corporate intranet's static patient library.
 *
 * Source:      clinical-ground-truth/patients/      (canonical home)
 * Destination: corporate/intranet/public/data/patients/   (consumer)
 *
 * Per-file behavior:
 *   - <patient-id>.json and <patient-id>.md are copied (overwriting any
 *     existing destination copy — CGT wins).
 *   - index.json is merged: patients are unioned by `id`; counterfactualPairs
 *     are unioned by `pairId`. Anything already in the intranet index but
 *     absent from CGT is preserved (so legacy adult-only patients still
 *     appear until they're migrated to CGT too).
 *   - `source` and `dumpedAt` are taken from CGT's index. `patientCount` is
 *     recomputed from the merged patients array.
 *
 * Usage (from the corporate repo, with CGT checked out as a sibling):
 *
 *   node ../clinical-ground-truth/tools/sync-patients-to-intranet.mjs \
 *     --src ../clinical-ground-truth/patients \
 *     --dst intranet/public/data/patients
 *
 * Both flags are optional. Defaults assume the standard layout:
 *   --src  <CGT-repo>/patients
 *   --dst  <corporate-repo>/intranet/public/data/patients
 * where <CGT-repo> is the directory containing this script's parent (tools/).
 *
 * Runbook for the full flow (peds + YA expansion):
 *
 *   # 1. On Argus — generate curated dumps into CGT's patients/ dir.
 *   #    Requires Synthea output at /srv/medplum/synthea/output.
 *   cd ~/github/clinical-ground-truth
 *   git pull
 *   node ~/github/corporate/intranet/scripts/medplum-load-library.mjs load-demo \
 *     --dir /srv/medplum/synthea/output \
 *     --dump patients/
 *   node ~/github/corporate/intranet/scripts/medplum-load-library.mjs make-pairs \
 *     --dir /srv/medplum/synthea/output \
 *     --dump patients/
 *   git add patients/
 *   git commit -m "patients: add peds + YA matrix (7+7 demo + 6 CF pairs)"
 *   git push
 *
 *   # 2. On any host with both repos — sync into the intranet.
 *   cd ~/github/corporate
 *   git pull
 *   ( cd ../clinical-ground-truth && git pull )
 *   node ../clinical-ground-truth/tools/sync-patients-to-intranet.mjs
 *   git add intranet/public/data/patients
 *   git commit -m "intranet: pull peds + YA patients from clinical-ground-truth"
 *   git push
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tools/ → repo root → patients/
const CGT_ROOT = path.resolve(__dirname, "..");
const CORPORATE_ROOT = path.resolve(__dirname, "..", "..", "corporate");

const DEFAULT_SRC = path.join(CGT_ROOT, "patients");
const DEFAULT_DST = path.join(CORPORATE_ROOT, "intranet", "public", "data", "patients");

function parseArgs(argv) {
  const out = { src: DEFAULT_SRC, dst: DEFAULT_DST };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") out.src = path.resolve(argv[++i]);
    else if (argv[i] === "--dst") out.dst = path.resolve(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${argv[i]}`); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: sync-patients-to-intranet.mjs [--src <dir>] [--dst <dir>]

  --src   Source directory in clinical-ground-truth   (default: ${DEFAULT_SRC})
  --dst   Destination in corporate/intranet           (default: ${DEFAULT_DST})
`);
}

async function readJsonOrEmpty(file, fallback) {
  try {
    const txt = await fs.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function unionById(existing, incoming) {
  const byId = new Map();
  for (const p of existing) byId.set(p.id, p);
  for (const p of incoming) byId.set(p.id, p); // incoming wins on conflict
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function unionPairsByPairId(existing, incoming) {
  const byPair = new Map();
  for (const p of existing) byPair.set(p.pairId, p);
  for (const p of incoming) byPair.set(p.pairId, p); // incoming wins
  return [...byPair.values()].sort((a, b) => String(a.pairId).localeCompare(String(b.pairId)));
}

async function main() {
  const { src, dst } = parseArgs(process.argv.slice(2));

  // Verify source has the expected layout.
  let srcEntries;
  try {
    srcEntries = await fs.readdir(src);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`Source directory not found: ${src}`);
      console.error("Did you run the generation step on Argus first?");
      process.exit(3);
    }
    throw err;
  }

  const srcIndexPath = path.join(src, "index.json");
  const srcIndex = await readJsonOrEmpty(srcIndexPath, null);
  if (!srcIndex) {
    console.error(`No index.json in source ${src}. Nothing to sync.`);
    process.exit(3);
  }

  await ensureDir(dst);
  const dstIndexPath = path.join(dst, "index.json");
  const dstIndex = await readJsonOrEmpty(dstIndexPath, {
    dumpedAt: new Date().toISOString(),
    source: "",
    patientCount: 0,
    patients: [],
    counterfactualPairs: [],
  });

  // 1. Copy every .json/.md from source to destination (skip index.json — handled separately).
  let copied = 0;
  for (const name of srcEntries) {
    if (name === "index.json") continue;
    if (!name.endsWith(".json") && !name.endsWith(".md")) continue;
    const srcFile = path.join(src, name);
    const dstFile = path.join(dst, name);
    const stat = await fs.stat(srcFile);
    if (!stat.isFile()) continue;
    await fs.copyFile(srcFile, dstFile);
    copied++;
  }

  // 2. Merge index.json — union patients by id, union pairs by pairId.
  const mergedPatients = unionById(dstIndex.patients ?? [], srcIndex.patients ?? []);
  const mergedPairs = unionPairsByPairId(
    dstIndex.counterfactualPairs ?? [],
    srcIndex.counterfactualPairs ?? [],
  );

  const merged = {
    dumpedAt: srcIndex.dumpedAt ?? new Date().toISOString(),
    source: srcIndex.source ?? dstIndex.source ?? "",
    patientCount: mergedPatients.length,
    patients: mergedPatients,
    counterfactualPairs: mergedPairs,
  };

  await fs.writeFile(dstIndexPath, JSON.stringify(merged, null, 2));

  // 3. Report.
  const addedPatients = srcIndex.patients?.length ?? 0;
  const totalPatients = mergedPatients.length;
  const addedPairs = srcIndex.counterfactualPairs?.length ?? 0;
  const totalPairs = mergedPairs.length;
  console.log(`Synced ${copied} file(s) from ${src} → ${dst}`);
  console.log(`Index: ${addedPatients} patient(s) from source merged into ${totalPatients} total.`);
  console.log(`Pairs: ${addedPairs} from source merged into ${totalPairs} total.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
