import type {
  BookingMode,
  OrganisationBranding,
  OrganisationConfig,
  OrganisationFeatures,
  OrganisationLimits,
  Language,
} from './organisation-config';
import type { OrganisationEntity, OrganisationStatus } from './organisation.entity';

/** What anyone may know about an organisation from its link: its name and its look. */
export interface PublicConfigView {
  slug: string;
  name: string;
  branding: OrganisationBranding;
  locale: { defaultLanguage: Language; languages: Language[] };
}

export interface OrganisationView {
  id: string;
  slug: string;
  name: string;
  status: OrganisationStatus;
  suspendedReason: string | null;
  bookingMode: BookingMode;
  features: OrganisationFeatures;
  limits: OrganisationLimits;
  config: OrganisationConfig;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigVersionView {
  version: number;
  config: OrganisationConfig;
  changedBy: { id: string; name: string; email: string } | null;
  createdAt: string;
  current: boolean;
}

export function toPublicConfig(org: OrganisationEntity): PublicConfigView {
  return {
    slug: org.slug,
    name: org.name,
    branding: org.config.branding,
    locale: {
      defaultLanguage: org.config.locale.defaultLanguage,
      languages: org.config.locale.languages,
    },
  };
}

export function toOrganisationView(org: OrganisationEntity): OrganisationView {
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    status: org.status,
    suspendedReason: org.suspendedReason,
    bookingMode: org.bookingMode,
    features: org.features,
    limits: org.limits,
    config: org.config,
    configVersion: org.configVersion,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
}
