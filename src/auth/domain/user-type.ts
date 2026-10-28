/** ITPO staff have no organisation; an organiser belongs to one. */
export enum UserType {
  ItpoStaff = 'itpo_staff',
  Organiser = 'organiser',
}

/** The one rule that tells the two apart: `T_USER.org_id` null is ITPO staff, set is an organiser. */
export function userTypeOf(orgId: string | null): UserType {
  return orgId === null ? UserType.ItpoStaff : UserType.Organiser;
}
