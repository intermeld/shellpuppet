import { expect, it } from 'vitest';
import * as reading from '../../src/core/reasoning.js';

const candidate = { reason: 'provider-refused', description: 'The model provider refused the turn.', identity: 'private screen identity', blockIdentity: 'private refusal identity' };
it('settles a stable candidate and publishes only fixed metadata', () => {
  const state = new reading.StallTracker();
  expect(state.observe(candidate, 1000)).toBeUndefined();
  expect(state.observe(candidate, 1999)).toBeUndefined();
  expect(state.observe(candidate, 2000)).toEqual({ reason: candidate.reason, description: candidate.description, since: new Date(1000).toISOString() });
  expect(JSON.stringify(state.observe(candidate, 4000))).not.toContain('private');
});
it('restarts settling after the block changes or disappears', () => {
  const state = new reading.StallTracker();
  state.observe(candidate, 1000);
  const changed = { ...candidate, identity: 'new block' };
  expect(state.observe(changed, 1999)).toBeUndefined();
  expect(state.observe(changed, 2000)).toBeUndefined();
  expect(state.observe(changed, 2998)).toBeUndefined();
  expect(state.observe(changed, 2999)).toEqual({ reason: changed.reason, description: changed.description, since: new Date(1999).toISOString() });
  expect(state.observe(null, 3000)).toBeUndefined();
  expect(state.observe(candidate, 3000)).toBeUndefined();
  expect(state.observe(candidate, 4000)).toBeDefined();
  expect(state.observe(null, 4001)).toBeUndefined();
});
it('clears on input and cannot reannounce the unchanged old block', () => {
  const state = new reading.StallTracker();
  state.observe(candidate, 1000);
  expect(state.observe(candidate, 2000)).toBeDefined();
  state.noteInput();
  expect(state.observe(candidate, 5000)).toBeUndefined();
  state.noteInput();
  expect(state.observe(candidate, 9000)).toBeUndefined();
  expect(state.observe(candidate, 10001)).toBeUndefined();
  state.observe(null, 10002);
  expect(state.observe(candidate, 11000)).toBeUndefined();
  expect(state.observe(candidate, 12000)).toBeDefined();
});

it('retains an established refusal when only the user-turn text changes', () => {
  const tracker = new reading.StallTracker();
  tracker.observe(candidate, 1000);
  const state = tracker.observe(candidate, 2000);
  expect(state).toBeDefined();
  const reflowed = { ...candidate, identity: 'shorter reconstructed user turn' };
  expect(tracker.observe(reflowed, 5000)).toBe(state);
  expect(tracker.observe(candidate, 9000)).toBe(state);
  tracker.noteInput();
  expect(tracker.observe(candidate, 10000)).toBeUndefined();
  expect(tracker.observe(reflowed, 11000)).toBeUndefined();
  expect(tracker.observe(reflowed, 12000)).toBeUndefined();
});

it('restarts an established notice when its refusal or footer changes', () => {
  const tracker = new reading.StallTracker();
  tracker.observe(candidate, 1000);
  const state = tracker.observe(candidate, 2000);
  const changed = { ...candidate, identity: 'different footer', blockIdentity: 'different footer' };
  expect(tracker.observe(changed, 3000)).toBeUndefined();
  expect(tracker.observe(changed, 4000)).not.toEqual(state);
});
