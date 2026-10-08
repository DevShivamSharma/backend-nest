import type { EventType } from '../rules/rule-catalogue';
import type { EventKind, EventStatus } from './event.entity';

export interface EventView {
  id: string;
  name: string;
  code: string | null;
  kind: EventKind;
  eventType: EventType;
  status: EventStatus;
  startsOn: string;
  endsOn: string;
  venue: { id: string; name: string };
  organiser: { name: string | null; email: string | null; phone: string | null };
  description: string | null;
  cancelledReason: string | null;
  hallCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A hall the event books. `floorVersion` is the floor its stalls are drawn on. */
export interface EventHallView {
  hallId: string;
  name: string;
  code: string | null;
  level: string | null;
  width: number;
  depth: number;
  floorArea: number;
  floorVersion: number;
  /** The hall's floor now; above `floorVersion` when the hall was re-imported since. */
  currentVersion: number;
}

export interface EventDetailView extends EventView {
  halls: EventHallView[];
}

/** A hall of the event's venue, and the other events that hold it on overlapping days. */
export interface HallOptionView {
  hallId: string;
  name: string;
  code: string | null;
  booked: boolean;
  conflicts: { eventId: string; name: string; startsOn: string; endsOn: string }[];
}
