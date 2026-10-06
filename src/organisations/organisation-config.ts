/**
 * The shapes an organisation is configured with, and their defaults.
 *
 * Two owners, kept apart on purpose:
 *  - `OrganisationConfig` is the organisation's own look and paperwork (branding, languages,
 *    invoice details). Its Venue Admin edits it; every change is a new numbered version.
 *  - `OrganisationFeatures`, `OrganisationLimits` and the booking mode are the platform's
 *    contract with the organisation. Only the Super Admin changes them.
 */

export const FONT_FAMILIES = [
  'Inter',
  'Roboto',
  'Poppins',
  'Noto Sans',
  'Lato',
  'Source Sans 3',
] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

export const LANGUAGES = ['en', 'hi'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface OrganisationBranding {
  /** Seed colour of the generated Material 3 palette, `#rrggbb`. */
  primaryColor: string;
  /** Optional second seed for the tertiary palette; null derives it from the primary. */
  accentColor: string | null;
  fontFamily: FontFamily;
  logoUrl: string | null;
  /** Logo variant for dark surfaces; null reuses `logoUrl`. */
  logoDarkUrl: string | null;
  faviconUrl: string | null;
}

export interface OrganisationLocale {
  defaultLanguage: Language;
  languages: Language[];
  /** ISO 4217 code. */
  currency: string;
  /** IANA zone name. */
  timezone: string;
}

export interface OrganisationLegal {
  legalName: string | null;
  gstin: string | null;
  address: string | null;
  invoicePrefix: string | null;
  supportEmail: string | null;
}

export interface OrganisationEmail {
  senderName: string | null;
  replyTo: string | null;
  /** Plain text appended to every email the organisation sends. */
  footer: string | null;
}

export interface OrganisationConfig {
  branding: OrganisationBranding;
  locale: OrganisationLocale;
  legal: OrganisationLegal;
  email: OrganisationEmail;
}

export interface OrganisationFeatures {
  aiAssist: boolean;
  pdfPlot: boolean;
  exhibitorPortal: boolean;
  wayfinding: boolean;
}

export interface OrganisationLimits {
  venues: number;
  users: number;
  storageMb: number;
}

export enum BookingMode {
  /** Exhibitors book on our white-label portal. */
  OwnPortal = 'own_portal',
  /** Our stall map embedded in the venue's own site. */
  Embed = 'embed',
  /** Layouts and prices pushed to the venue's booking system; status comes back. */
  Sync = 'sync',
  /** We hold the stall; the venue's system takes the payment. */
  HybridHold = 'hybrid_hold',
}

export const DEFAULT_FEATURES: OrganisationFeatures = {
  aiAssist: false,
  pdfPlot: true,
  exhibitorPortal: false,
  wayfinding: false,
};

export const DEFAULT_LIMITS: OrganisationLimits = {
  venues: 1,
  users: 25,
  storageMb: 1024,
};

export function defaultConfig(name: string): OrganisationConfig {
  return {
    branding: {
      primaryColor: '#1f5fbf',
      accentColor: null,
      fontFamily: 'Inter',
      logoUrl: null,
      logoDarkUrl: null,
      faviconUrl: null,
    },
    locale: {
      defaultLanguage: 'en',
      languages: ['en'],
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    },
    legal: {
      legalName: name,
      gstin: null,
      address: null,
      invoicePrefix: null,
      supportEmail: null,
    },
    email: {
      senderName: name,
      replyTo: null,
      footer: null,
    },
  };
}

/**
 * Slugs are the first path segment of every organisation URL, so words the app itself uses
 * at that position can never be taken.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'accept-invite',
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'docs',
  'forgot-password',
  'health',
  'help',
  'invalid-link',
  'login',
  'logout',
  'me',
  'public',
  'register',
  'reset-password',
  'settings',
  'signup',
  'static',
  'status',
  'support',
  'www',
]);

/** 3–40 characters: lower-case letters, digits and single hyphens; starts with a letter. */
export const SLUG_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,39}$/;
