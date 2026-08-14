START=lodestar start --cwd <cwd>
WORK=lodestar work start "<scope>"; lodestar work done "<result>"
HANDOFF=lodestar handoff status --cwd <cwd>; lodestar handoff save --file <packet.json> --cwd <cwd> --session <id>
APPLY=required[]
