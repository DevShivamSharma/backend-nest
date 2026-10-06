import { scopeAllows } from './membership-scope';

describe('scopeAllows', () => {
  it('allows everything for a whole-organisation scope', () => {
    expect(scopeAllows({}, { eventId: 'e1', hallId: 'h1' })).toBe(true);
  });

  it('limits to the listed events and halls', () => {
    const scope = { eventIds: ['e1'], hallIds: ['h5'] };
    expect(scopeAllows(scope, { eventId: 'e1', hallId: 'h5' })).toBe(true);
    expect(scopeAllows(scope, { eventId: 'e2' })).toBe(false);
    expect(scopeAllows(scope, { hallId: 'h6' })).toBe(false);
  });
});
