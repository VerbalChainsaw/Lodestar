import { Readable } from 'node:stream';
import { dispatch } from '../src/agent-state.mjs';
import { directInterfaceSelection } from '../src/interface-config.mjs';
import { prepareCliJournal } from '../src/recovery-journal.mjs';

// Exercise the production preparation and core dispatch, then stop at the real
// interruption boundary before a response is saved or delivered. This retains
// an actual committed receipt and its original exact journal, without inventing
// a missing response by deleting evidence from an acknowledged success.
export async function commitBeforeResponse(f, operation, body, {
  arguments: args = operation.split('.'), options = {},
  positionals = operation.includes('.') ? [operation.split('.')[1]] : [],
} = {}) {
  const parsed = { options: { ...options }, positionals };
  const selection = await directInterfaceSelection(f.database);
  const journal = await prepareCliJournal(selection, operation, parsed, args,
    { stdin: Readable.from([JSON.stringify(body)]) });
  const result = await dispatch(operation.split('.')[0], parsed, f.database, {});
  return { code: 0, value: { v: 5, ok: true, operation, ...result }, journal, folder: journal.folder };
}

export async function unansweredCreate(f, id, data) {
  const body = await f.request({ mode: 'create', record: { id, name: id, kind: 'note', scope: 'global',
    availability: 'known', data, aliases: [], links: [], sources: [] } }, [{ kind: 'record', id }]);
  return commitBeforeResponse(f, 'put', body);
}
