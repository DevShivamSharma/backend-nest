import type { EventType, RuleId, RuleValues } from '../rules/rule-catalogue';
import type { InvitationView, MemberView } from '../team/team.views';
import type { HallFloor } from '../venues/floor/hall-floor';
import type { EventKind } from './event.entity';

export interface EventView {
  id: string;
  kind: EventKind;
  name: string;
  venueEventId: string | null;
  organiserName: string | null;
  audience: EventType;
  startsOn: string;
  endsOn: string;
  buildUpOn: string | null;
  dismantleOn: string | null;
  hallCount: number;
  updatedAt: string;
}

export interface EventHallView {
  hallId: string;
  name: string;
  code: string | null;
  level: string | null;
  venue: { id: string; name: string };
  width: number;
  depth: number;
  floorArea: number;
  /** The floor version the event is drawn on. */
  floorVersion: number;
  /** The hall's newest version; differs when the venue changed the floor since. */
  latestFloorVersion: number;
  rulesOn: number;
  drawingProfile: string;
  /** Other events on this hall at overlapping dates; empty for organisers. */
  overlaps: Array<{ eventId: string; name: string; startsOn: string; endsOn: string }>;
}

export interface EventDetailView extends EventView {
  halls: EventHallView[];
}

export interface EventHallRulesView {
  switches: Record<RuleId, boolean>;
  values: RuleValues;
  drawingProfile: string;
}

export interface EventHallDetailView {
  event: { id: string; name: string; kind: EventKind; audience: EventType };
  hall: EventHallView;
  floor: HallFloor;
  rules: EventHallRulesView;
}

export interface EventPeopleView {
  members: MemberView[];
  invitations: InvitationView[];
}
