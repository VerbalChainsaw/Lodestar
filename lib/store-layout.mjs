import path from "node:path";

export function statePaths(home) {
  return {
    home,
    current: path.join(home, "current.json"),
    generations: path.join(home, "generations"),
    backups: path.join(home, "backups"),
    events: path.join(home, "events.jsonl"),
    lock: path.join(home, ".write-lock"),
    snapshots: path.join(home, "snapshots"),
    quarantine: path.join(home, "quarantine"),
  };
}

export function generationPaths(home, generation) {
  const root = path.join(statePaths(home).generations, generation);
  return {
    root,
    catalog: path.join(root, "catalog.json"),
    schema: path.join(root, "schema", "store.json"),
    records: path.join(root, "records"),
    globalRecords: path.join(root, "records", "global.jsonl"),
    projectRecords: path.join(root, "records", "projects"),
    indexes: path.join(root, "indexes"),
    integrity: path.join(root, "integrity.json"),
  };
}

export function projectFileStem(projectId) {
  return projectId.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function projectShardPath(projectId) {
  return `records/projects/${projectFileStem(projectId)}.jsonl`;
}
