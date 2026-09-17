// Shares the worker's env preflight: some of these modules reach
// shopify.server, which validates its configuration at module scope.
import "./bootstrap";
import { isUndoable } from "../app/lib/rollback.server";

/**
 * Undo coverage.
 *
 * The app promises every change is reversible, and the History page renders an
 * Undo button from `isUndoable`. This asserts the two halves agree: every field
 * a module writes is either undoable and handled by `rollbackItem`, or
 * deliberately excluded. A module that starts writing a new field without a
 * rollback case should fail here rather than in a merchant's shop.
 *
 *   npx tsx worker/rollback-test.ts
 */

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
}

/** Every field written by a processor, and whether undo should be offered. */
const WRITTEN_FIELDS: Array<{ field: string; undoable: boolean; why: string }> = [
  { field: "image", undoable: true, why: "fileUpdate back to the stored original URL" },
  { field: "alt", undoable: true, why: "fileUpdate with the previous alt text" },
  { field: "seo.title", undoable: true, why: "productUpdate with the previous title" },
  { field: "seo.description", undoable: true, why: "productUpdate with the previous description" },
  { field: "geo.faq", undoable: true, why: "metafieldsDelete — there was no FAQ before" },
  { field: "geo.faq.pending", undoable: true, why: "discards a draft that was never published" },
  { field: "geo.description", undoable: true, why: "productUpdate with the previous descriptionHtml" },
  { field: "speed.report", undoable: false, why: "a measurement, not a change" },
];

console.log("── Undo is offered exactly where it works ──");
for (const { field, undoable, why } of WRITTEN_FIELDS) {
  check(
    `${field} → ${undoable ? "undoable" : "not undoable"}`,
    isUndoable(field, "done") === undoable,
    why,
  );
}

console.log("\n── Only applied changes can be undone ──");
for (const status of ["skipped", "failed", "rolled_back", "queued"]) {
  check(`a ${status} item offers no undo`, isUndoable("image", status) === false);
}

console.log("\n── Every written field has a rollback case ──");
{
  // Read the source rather than trusting the list above to stay in sync.
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../app/lib/rollback.server.ts", import.meta.url),
    "utf8",
  );

  for (const { field } of WRITTEN_FIELDS) {
    check(
      `rollback.server.ts handles "${field}"`,
      source.includes(`case "${field}"`),
      undefined,
    );
  }

  check(
    "an unknown field is refused rather than silently succeeding",
    source.includes("default:") && source.includes("Cannot undo"),
  );
}

console.log("\n── Processors write nothing rollback does not know about ──");
{
  const fs = await import("node:fs/promises");
  const known = new Set(WRITTEN_FIELDS.map((f) => f.field));
  const found = new Set<string>();

  for (const name of ["images", "seo", "geo", "speed"]) {
    const source = await fs.readFile(
      new URL(`./processors/${name}.ts`, import.meta.url),
      "utf8",
    );
    for (const match of source.matchAll(/field:\s*"([^"]+)"/g)) {
      found.add(match[1]);
    }
  }

  const unknown = [...found].filter((f) => !known.has(f));
  check(
    "no processor writes an unlisted field",
    unknown.length === 0,
    unknown.length ? `unhandled: ${unknown.join(", ")}` : `${found.size} fields, all covered`,
  );
}

console.log(
  failures === 0 ? "\n✓ undo coverage verified" : `\n✗ ${failures} check(s) failed`,
);
process.exitCode = failures === 0 ? 0 : 1;
