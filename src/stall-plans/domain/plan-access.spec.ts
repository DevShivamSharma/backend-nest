import { planAccess, PlanAccessInput } from './plan-access';

const base: PlanAccessInput = {
  kind: 'external',
  approvalStatus: 'Approved',
  cancelled: false,
  organiser: true,
  revision: 3,
  review: null,
  publishedRevision: null,
};

describe('planAccess', () => {
  it('should let ITPO staff plan and publish an internal event, and nobody else', () => {
    const staff = planAccess({ ...base, kind: 'internal', organiser: false, approvalStatus: null });
    expect(staff).toEqual(
      expect.objectContaining({ canEdit: true, canPublish: true, needsApproval: false }),
    );

    const organiser = planAccess({ ...base, kind: 'internal', organiser: true });
    expect(organiser.canEdit).toBe(false);
    expect(organiser.readOnlyReason).toMatch(/internal events/);
  });

  it('should let the organiser plan an external event only once ITPO approved it', () => {
    expect(planAccess({ ...base, approvalStatus: 'Pending' }).readOnlyReason).toMatch(
      /approves the event/,
    );
    expect(planAccess({ ...base, approvalStatus: 'Approved' }).canEdit).toBe(true);
  });

  it('should keep ITPO staff read-only on an external event, with approval once it is sent', () => {
    const idle = planAccess({ ...base, organiser: false });
    expect(idle).toEqual(
      expect.objectContaining({ canEdit: false, canApprove: false, canPublish: false }),
    );

    const waiting = planAccess({
      ...base,
      organiser: false,
      review: { status: 'submitted', revision: 3 },
    });
    expect(waiting.canApprove).toBe(true);
  });

  it('should send an external plan for approval, then publish only the approved revision', () => {
    expect(planAccess(base)).toEqual(
      expect.objectContaining({ canSubmit: true, canPublish: false }),
    );

    const sent = planAccess({ ...base, review: { status: 'submitted', revision: 3 } });
    expect(sent).toEqual(
      expect.objectContaining({ canEdit: false, canWithdraw: true, canSubmit: false }),
    );

    const approved = planAccess({ ...base, review: { status: 'approved', revision: 3 } });
    expect(approved).toEqual(expect.objectContaining({ canPublish: true, canSubmit: false }));

    const stale = planAccess({ ...base, review: { status: 'approved', revision: 2 } });
    expect(stale).toEqual(expect.objectContaining({ canPublish: false, canSubmit: true }));
  });

  it('should have nothing to publish or send before the first save, or after publishing the same revision', () => {
    expect(planAccess({ ...base, revision: 0 }).canSubmit).toBe(false);
    expect(
      planAccess({ ...base, kind: 'internal', organiser: false, revision: 0 }).canPublish,
    ).toBe(false);
    const done = planAccess({ ...base, kind: 'internal', organiser: false, publishedRevision: 3 });
    expect(done.canPublish).toBe(false);
  });

  it('should freeze a cancelled event for everyone', () => {
    const cancelled = planAccess({ ...base, cancelled: true });
    expect(cancelled.canEdit).toBe(false);
    expect(cancelled.canPublish).toBe(false);
  });
});
