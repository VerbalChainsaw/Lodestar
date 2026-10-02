import { createHash } from "node:crypto";
import { validateResearchReview } from "./validate.mjs";

const operations = new Set(["put", "delete", "decision.set", "pending.drop"]);
const required = (value, label) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error(`${label} must be supplied as plain text.`);
  return text;
};
const suppliedText = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000")) {
    throw new Error(`${label} must be supplied as text.`);
  }
  return value;
};
const targetKey = ({ kind, id, scope, key }) => kind === "record" ? `record:${id}` : `decision:${scope}:${key}`;
const basisFrom = (read) => read?.data?.write_basis ??
  (read?.error?.code === "record_not_found" ? read.error.identifiers?.write_basis : null);

// Only combine independently observed targets from one database state. A missing get
// has no envelope revision; its absent-target precondition still guards admission.
export function combineReadBases(reads) {
  if (!Array.isArray(reads) || !reads.length) throw new Error("Fresh read evidence is required.");
  const [primary] = reads;
  const first = basisFrom(primary);
  if (!first || !Array.isArray(first.targets)) throw new Error("The project read has no write basis.");
  const observedRevision = primary.revision;
  const targets = new Map();
  for (const read of reads) {
    const basis = basisFrom(read);
    if (!basis || !Array.isArray(basis.targets) ||
      basis.database_instance_id !== first.database_instance_id ||
      basis.database_epoch !== first.database_epoch ||
      (read.database_instance_id && read.database_instance_id !== first.database_instance_id) ||
      (read.database_epoch && read.database_epoch !== first.database_epoch)) {
      throw new Error("Read evidence changed database identity; refresh the action.");
    }
    if (Number.isSafeInteger(observedRevision) && Number.isSafeInteger(read.revision) &&
      read.revision !== observedRevision) throw new Error("Read revision changed; refresh the action.");
    if (read.revision === null && read !== primary &&
      (read.error?.code !== "record_not_found" ||
        basis.targets.some((target) => target.expected_revision !== null))) {
      throw new Error("A target read has no comparable revision; refresh the action.");
    }
    for (const target of basis.targets) {
      const key = targetKey(target);
      const prior = targets.get(key);
      if (prior && prior.expected_revision !== target.expected_revision) {
        throw new Error("Target revision changed; refresh the action.");
      }
      targets.set(key, target);
    }
  }
  return { database_instance_id: first.database_instance_id,
    database_epoch: first.database_epoch, project_scope: first.project_scope,
    checkout: first.checkout, targets: [...targets.values()] };
}

export function buildHumanRequest(operation, input, basis, author, requestId) {
  if (!operations.has(operation)) throw new Error("Unsupported human action operation.");
  const name = required(author, "Human author");
  const id = required(requestId, "Request ID");
  if (!basis || !Array.isArray(basis.targets) || !basis.database_instance_id || !basis.database_epoch) {
    throw new Error("A fresh complete write basis is required.");
  }
  return { v: 5, request_id: id, database_instance_id: basis.database_instance_id,
    database_epoch: basis.database_epoch, project_scope: basis.project_scope ?? null,
    checkout: basis.checkout ?? null,
    actor: { id: `user:${name}`, agent: "human", harness: "manager", session: null },
    preconditions: basis.targets.map(({ expected_revision, ...target }) =>
      ({ target, expected_revision })), input };
}

export function researchReviewFields(fields) {
  const reviewed_at = required(fields.reviewed_at, "Source observation date");
  return validateResearchReview({ reviewed_at, reviewed_by: required(fields.reviewed_by, "Review author"),
    review_qualifiers: suppliedText(fields.review_qualifiers, "Review qualifiers"),
    source_version: fields.source_version === undefined || fields.source_version === null || fields.source_version === ""
      ? null : required(fields.source_version, "Applicable source version"),
    review_acquisition: "operator_attested" });
}

export function buildOperatorRecord(kind, fields) {
  if (!["project", "note", "research", "rejection"].includes(kind)) {
    throw new Error("Unsupported record action.");
  }
  const { id, name, scope, checkout = null } = fields;
  const author = required(fields.author, "Human author");
  let data;
  if (kind === "project") data = { roots: [required(fields.root, "Project root")], author };
  if (kind === "note") data = { body: suppliedText(fields.body, "Note body"), author };
  if (kind === "research") {
    const body = suppliedText(fields.body, "Research body");
    data = { body, acquisition: "operator_supplied",
      source_reference: required(fields.source, "Research source reference"),
      claim: suppliedText(fields.claim, "Research claim"),
      limitations: suppliedText(fields.limitations, "Research limitations"),
      body_sha256: createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"),
      author, ...(Object.hasOwn(fields, "reviewed_at") ? researchReviewFields({ ...fields,
        reviewed_by: fields.reviewed_by ?? author }) : {}) };
  }
  if (kind === "rejection") data = { subject: required(fields.subject, "Rejection subject"),
    reason: suppliedText(fields.reason, "Rejection reason"), verdict: "rejected", author };
  return { id: required(id, "Record ID"), kind, name: required(name, "Record name"),
    scope: required(scope, "Project scope"), availability: "known", priority: 0, data,
    aliases: [], links: [], sources: [], semantics: { lifecycle: "current",
      context_role: kind === "project" ? "on_demand" : "orientation",
      basis: "asserted", applicability: { project: scope, checkout } } };
}
