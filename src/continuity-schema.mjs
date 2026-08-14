export const CONTINUITY_TABLES = Object.freeze([
  "continuity_events",
  "continuity_lanes",
  "continuity_packets",
  "continuity_transfers",
]);

export const CONTINUITY_INDEXES = Object.freeze([
  "continuity_events_hook_dedup",
  "continuity_events_operation_once",
  "continuity_lanes_one_armed_per_owner",
  "continuity_packets_lane_packet",
  "continuity_packets_operation_once",
  "continuity_transfers_operation_once",
  "continuity_transfers_one_active",
  "continuity_transfers_worker_claim_once",
]);

export const CONTINUITY_COLUMNS = Object.freeze({
  continuity_lanes: [
    "lane_id",
    "project_key",
    "owner_session_id",
    "state",
    "active_packet_id",
    "version",
    "created_at",
    "updated_at",
  ],
  continuity_packets: [
    "packet_id",
    "lane_id",
    "predecessor_packet_id",
    "operation_id",
    "packet_json",
    "integrity_digest",
    "created_by_session",
    "created_by_turn",
    "created_at",
  ],
  continuity_events: [
    "event_id",
    "operation_id",
    "request_digest",
    "lane_id",
    "session_id",
    "turn_id",
    "event_type",
    "role",
    "status",
    "redacted_text",
    "payload_json",
    "absorbed_packet_id",
    "created_at",
  ],
  continuity_transfers: [
    "transfer_id",
    "operation_id",
    "lane_id",
    "source_session_id",
    "source_turn_id",
    "packet_id",
    "phase",
    "worker_claim_id",
    "target_session_id",
    "target_turn_id",
    "target_turn_status",
    "error",
    "created_at",
    "updated_at",
  ],
});

export const CONTINUITY_SCHEMA_SQL = String.raw`
CREATE TABLE continuity_lanes (
  lane_id TEXT PRIMARY KEY
    CHECK(length(CAST(lane_id AS BLOB)) BETWEEN 1 AND 256),
  project_key TEXT NOT NULL
    CHECK(length(CAST(project_key AS BLOB)) BETWEEN 1 AND 512),
  owner_session_id TEXT NOT NULL
    CHECK(length(CAST(owner_session_id AS BLOB)) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('armed', 'inert')),
  active_packet_id TEXT NULL
    CHECK(
      active_packet_id IS NULL
      OR length(CAST(active_packet_id AS BLOB)) BETWEEN 1 AND 256
    ),
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at TEXT NOT NULL
    CHECK(
      length(CAST(created_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at,
        0
      )
    ),
  updated_at TEXT NOT NULL
    CHECK(
      length(CAST(updated_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at,
        0
      )
    ),
  FOREIGN KEY (lane_id, active_packet_id)
    REFERENCES continuity_packets(lane_id, packet_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE TABLE continuity_packets (
  packet_id TEXT PRIMARY KEY
    CHECK(length(CAST(packet_id AS BLOB)) BETWEEN 1 AND 256),
  lane_id TEXT NOT NULL
    REFERENCES continuity_lanes(lane_id) ON DELETE RESTRICT
    CHECK(length(CAST(lane_id AS BLOB)) BETWEEN 1 AND 256),
  predecessor_packet_id TEXT NULL
    CHECK(
      predecessor_packet_id IS NULL
      OR length(CAST(predecessor_packet_id AS BLOB)) BETWEEN 1 AND 256
    ),
  operation_id TEXT NOT NULL
    CHECK(length(CAST(operation_id AS BLOB)) = 64)
    CHECK(operation_id NOT GLOB '*[^0-9a-f]*'),
  packet_json TEXT NOT NULL
    CHECK(
      length(CAST(packet_json AS BLOB)) <= 262144
      AND CASE WHEN json_valid(packet_json) THEN
        json_type(packet_json) = 'object'
      ELSE 0 END
    ),
  integrity_digest TEXT NOT NULL
    CHECK(length(CAST(integrity_digest AS BLOB)) = 64)
    CHECK(integrity_digest NOT GLOB '*[^0-9a-f]*'),
  created_by_session TEXT NOT NULL
    CHECK(length(CAST(created_by_session AS BLOB)) BETWEEN 1 AND 256),
  created_by_turn TEXT NOT NULL
    CHECK(length(CAST(created_by_turn AS BLOB)) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL
    CHECK(
      length(CAST(created_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at,
        0
      )
    ),
  FOREIGN KEY (lane_id, predecessor_packet_id)
    REFERENCES continuity_packets(lane_id, packet_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE TABLE continuity_events (
  event_id TEXT PRIMARY KEY
    CHECK(length(CAST(event_id AS BLOB)) BETWEEN 1 AND 256),
  operation_id TEXT NULL
    CHECK(
      operation_id IS NULL
      OR (
        length(CAST(operation_id AS BLOB)) = 64
        AND operation_id NOT GLOB '*[^0-9a-f]*'
      )
    ),
  request_digest TEXT NULL
    CHECK(
      request_digest IS NULL
      OR (
        length(CAST(request_digest AS BLOB)) = 64
        AND request_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
  lane_id TEXT NOT NULL
    REFERENCES continuity_lanes(lane_id) ON DELETE RESTRICT
    CHECK(length(CAST(lane_id AS BLOB)) BETWEEN 1 AND 256),
  session_id TEXT NOT NULL
    CHECK(length(CAST(session_id AS BLOB)) BETWEEN 1 AND 256),
  turn_id TEXT NOT NULL
    CHECK(length(CAST(turn_id AS BLOB)) BETWEEN 1 AND 256),
  event_type TEXT NOT NULL
    CHECK(length(CAST(event_type AS BLOB)) BETWEEN 1 AND 64),
  role TEXT NULL CHECK(role IS NULL OR role IN ('user', 'assistant', 'worker')),
  status TEXT NOT NULL
    CHECK(length(CAST(status AS BLOB)) BETWEEN 1 AND 64),
  redacted_text TEXT NOT NULL DEFAULT ''
    CHECK(length(CAST(redacted_text AS BLOB)) <= 262144),
  payload_json TEXT NOT NULL DEFAULT '{}'
    CHECK(
      length(CAST(payload_json AS BLOB)) <= 262144
      AND CASE WHEN json_valid(payload_json) THEN
        json_type(payload_json) = 'object'
      ELSE 0 END
    ),
  absorbed_packet_id TEXT NULL
    CHECK(
      absorbed_packet_id IS NULL
      OR length(CAST(absorbed_packet_id AS BLOB)) BETWEEN 1 AND 256
    ),
  created_at TEXT NOT NULL
    CHECK(
      length(CAST(created_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at,
        0
      )
    ),
  CHECK((operation_id IS NULL) = (request_digest IS NULL)),
  FOREIGN KEY (lane_id, absorbed_packet_id)
    REFERENCES continuity_packets(lane_id, packet_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE TABLE continuity_transfers (
  transfer_id TEXT PRIMARY KEY
    CHECK(length(CAST(transfer_id AS BLOB)) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL
    CHECK(length(CAST(operation_id AS BLOB)) = 64)
    CHECK(operation_id NOT GLOB '*[^0-9a-f]*'),
  lane_id TEXT NOT NULL
    REFERENCES continuity_lanes(lane_id) ON DELETE RESTRICT
    CHECK(length(CAST(lane_id AS BLOB)) BETWEEN 1 AND 256),
  source_session_id TEXT NOT NULL
    CHECK(length(CAST(source_session_id AS BLOB)) BETWEEN 1 AND 256),
  source_turn_id TEXT NOT NULL
    CHECK(length(CAST(source_turn_id AS BLOB)) BETWEEN 1 AND 256),
  packet_id TEXT NOT NULL
    CHECK(length(CAST(packet_id AS BLOB)) BETWEEN 1 AND 256),
  phase TEXT NOT NULL CHECK(phase IN (
    'scheduled', 'claimed', 'creating', 'created', 'injecting',
    'injected', 'continuing', 'accepted', 'completed', 'failed'
  )),
  worker_claim_id TEXT NULL
    CHECK(
      worker_claim_id IS NULL
      OR length(CAST(worker_claim_id AS BLOB)) BETWEEN 1 AND 256
    ),
  target_session_id TEXT NULL
    CHECK(
      target_session_id IS NULL
      OR length(CAST(target_session_id AS BLOB)) BETWEEN 1 AND 256
    ),
  target_turn_id TEXT NULL
    CHECK(
      target_turn_id IS NULL
      OR length(CAST(target_turn_id AS BLOB)) BETWEEN 1 AND 256
    ),
  target_turn_status TEXT NULL
    CHECK(
      target_turn_status IS NULL
      OR target_turn_status IN ('completed', 'interrupted', 'failed')
    ),
  error TEXT NULL CHECK(error IS NULL OR length(CAST(error AS BLOB)) <= 65536),
  created_at TEXT NOT NULL
    CHECK(
      length(CAST(created_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at,
        0
      )
    ),
  updated_at TEXT NOT NULL
    CHECK(
      length(CAST(updated_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at,
        0
      )
    ),
  FOREIGN KEY (lane_id, packet_id)
    REFERENCES continuity_packets(lane_id, packet_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX continuity_lanes_one_armed_per_owner
  ON continuity_lanes(owner_session_id)
  WHERE state = 'armed';

CREATE UNIQUE INDEX continuity_packets_lane_packet
  ON continuity_packets(lane_id, packet_id);

CREATE UNIQUE INDEX continuity_packets_operation_once
  ON continuity_packets(operation_id);

CREATE UNIQUE INDEX continuity_events_operation_once
  ON continuity_events(operation_id)
  WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX continuity_events_hook_dedup
  ON continuity_events(lane_id, session_id, turn_id, event_type)
  WHERE event_type IN ('prompt.tail', 'assistant.tail');

CREATE UNIQUE INDEX continuity_transfers_one_active
  ON continuity_transfers(lane_id)
  WHERE phase NOT IN ('completed', 'failed');

CREATE UNIQUE INDEX continuity_transfers_operation_once
  ON continuity_transfers(operation_id);

CREATE UNIQUE INDEX continuity_transfers_worker_claim_once
  ON continuity_transfers(worker_claim_id)
  WHERE worker_claim_id IS NOT NULL;
`;
