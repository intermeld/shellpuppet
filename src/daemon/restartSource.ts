import path from 'node:path';
import type { Logger } from '../core/types.js';
import {
  HomeIdentityError, isDaemonInstanceId, readHomeRecord, restartSourceId, writePrivateRecord, type VerifiedHome,
  type DaemonStateFile, type RestartHandoff,
} from './paths.js';

export function snapshotSourceId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 ||
      !('sessions' in value) || !Array.isArray(value.sessions) || !('outgoingInstanceId' in value)) return null;
  return isDaemonInstanceId(value.outgoingInstanceId) ? value.outgoingInstanceId : null;
}

// null means absent, undefined means the evidence could not be inspected.
function readId(home: VerifiedHome, file: string, id: (record: unknown) => string | null, logger?: Logger): string | null | undefined {
  try {
    const value = id(JSON.parse(readHomeRecord(home, file)));
    if (value === null) throw new Error('Invalid restart record.');
    return value;
  } catch (error) {
    if (error instanceof HomeIdentityError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    logger?.warn(`Could not read ${file}.`, { code });
    return undefined;
  }
}

function resolve(handoff: RestartHandoff, saved: string | null | undefined, snapshot: string | null | undefined): RestartHandoff {
  let owners = handoff.restartCandidates ?? [];
  let inherited = handoff.restartFrom ?? null;
  let pendingSource = handoff.restartSourcePending;
  if (saved === undefined) {
    // An explicit handoff comes after the source. A crashed owner may have
    // written a newer source, so retain both possibilities until it can be read.
    if (owners.length || !pendingSource) return handoff;
  } else if (saved) {
    const index = owners.indexOf(saved);
    if (index >= 0) {
      // The write-ahead source rules out snapshots from every earlier owner.
      inherited = saved;
      owners = owners.slice(index + 1);
      pendingSource = false;
    } else if (!pendingSource && saved !== inherited) {
      return { restartFrom: saved };
    }
  }
  if (owners.length && snapshot === undefined) {
    return { restartFrom: inherited, restartCandidates: owners, restartSourcePending: pendingSource };
  }
  return { restartFrom: snapshot && owners.includes(snapshot) ? snapshot : inherited };
}

/** Recover from a credential-free handoff or from a crashed owner's live record. */
export function restoreRestartSource(home: VerifiedHome, file: DaemonStateFile, logger: Logger): RestartHandoff {
  const prior = file.kind === 'record' ? file.state : file.kind === 'restart-handoff' ? file.handoff : undefined;
  const owners = Array.isArray(prior?.restartCandidates) ? prior.restartCandidates.filter(isDaemonInstanceId) : [];
  if (file.kind === 'record' && isDaemonInstanceId(file.state.instanceId)) owners.push(file.state.instanceId);
  const handoff: RestartHandoff = { restartFrom: restartSourceId(prior), restartCandidates: owners };
  if (prior?.restartSourcePending === true || (file.kind === 'restart-handoff' && !prior?.restartCandidates)) {
    handoff.restartSourcePending = true;
  }
  const saved = readId(home, 'restart-source.json', restartSourceId, logger);
  const snapshot = owners.length ? readId(home, 'previous-sessions.json', snapshotSourceId, logger) : null;
  return recover(home, handoff, saved, snapshot, logger);
}

/** Retry verification when a granted read supplies a readable snapshot. */
export function retryRestartSource(home: VerifiedHome, handoff: RestartHandoff, snapshot: string,
  logger: Logger, beforePublish: () => void): RestartHandoff {
  const saved = readId(home, 'restart-source.json', restartSourceId);
  return recover(home, handoff, saved, snapshot, logger, beforePublish);
}

function recover(home: VerifiedHome, handoff: RestartHandoff, saved: string | null | undefined,
  snapshot: string | null | undefined, logger: Logger, beforePublish?: () => void): RestartHandoff {
  const result = resolve(handoff, saved, snapshot);
  const selected = result.restartFrom;
  if (result.restartCandidates || !selected || selected === saved) return result;
  if (saved !== undefined) {
    try {
      writePrivateRecord(path.join(home.homePath, 'restart-source.json'), { restartFrom: selected }, beforePublish);
      return result;
    } catch (error) {
      logger.warn('Could not update restart-source.json.', { code: (error as NodeJS.ErrnoException).code });
    }
  }
  result.restartSourcePending = true;
  return result;
}
