export interface ExhibitorView {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  address: string | null;
  /** The events it is registered for, among those the viewer may see. */
  eventIds: string[];
  createdAt: string;
}
