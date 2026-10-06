/**
 * Where a membership applies inside its organisation. Empty lists mean the whole organisation.
 * Event and hall ids are checked by the modules that own them, through `scopeAllows`.
 */
export interface MembershipScope {
  eventIds?: string[];
  hallIds?: string[];
}

export function scopeAllows(
  scope: MembershipScope,
  target: { eventId?: string; hallId?: string },
): boolean {
  if (target.eventId && scope.eventIds?.length && !scope.eventIds.includes(target.eventId)) {
    return false;
  }
  if (target.hallId && scope.hallIds?.length && !scope.hallIds.includes(target.hallId)) {
    return false;
  }
  return true;
}
