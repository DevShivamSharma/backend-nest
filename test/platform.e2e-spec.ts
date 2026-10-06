import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { MailService } from '../src/mail/mail.service';
import { ALL_PERMISSIONS } from '../src/roles/permissions';
import { createTestApp, login, refreshCookie, SUPER_ADMIN, tokenFrom } from './test-app';

interface RoleRow {
  id: string;
  key: string;
  permissions: string[];
  assignable: boolean;
  reason: string | null;
}

/**
 * Module A end to end: the Super Admin creates an organisation, its first Venue Admin accepts
 * the invitation and builds a team, and every boundary (tenant, membership, permission,
 * delegation, last owner) holds.
 */
describe('Platform and organisations (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let root: string;
  let organisationId: string;
  let owner: string;
  let roles: Record<string, RoleRow>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    root = (await login(app, SUPER_ADMIN.email, SUPER_ADMIN.password)).token;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe('organisations', () => {
    it('rejects reserved and malformed slugs', async () => {
      const reserved = await http
        .get('/api/admin/organisations/slug-check?slug=admin')
        .set(auth(root))
        .expect(200);
      expect(reserved.body.available).toBe(false);

      const malformed = await http
        .get('/api/admin/organisations/slug-check?slug=Not_Valid')
        .set(auth(root))
        .expect(200);
      expect(malformed.body.available).toBe(false);
    });

    it('creates an organisation and invites its first Venue Admin', async () => {
      const res = await http
        .post('/api/admin/organisations')
        .set(auth(root))
        .send({
          name: 'Bharat Mandapam (ITPO)',
          slug: 'itpo',
          primaryColor: '#0B5394',
          firstAdmin: { email: 'Ops@ITPO.test' },
        })
        .expect(201);

      organisationId = res.body.organisation.id;
      expect(res.body.organisation.config.branding.primaryColor).toBe('#0b5394');
      expect(res.body.invitation.email).toBe('ops@itpo.test');
      expect(res.body.invitation.role.key).toBe('venue_admin');

      const token = tokenFrom(res.body.invitation.inviteUrl);
      const preview = await http.get(`/api/auth/invitations/${token}`).expect(200);
      expect(preview.body).toMatchObject({
        organisation: { slug: 'itpo' },
        accountExists: false,
      });

      const accepted = await http
        .post(`/api/auth/invitations/${token}/accept`)
        .send({ name: 'ITPO Operations', password: 'itpo-ops-password' })
        .expect(200);
      expect(accepted.body.organisationSlug).toBe('itpo');
      owner = accepted.body.accessToken;

      await http
        .post(`/api/auth/invitations/${token}/accept`)
        .send({ name: 'Again', password: 'itpo-ops-password' })
        .expect(404);
    });

    it('refuses a slug that is already taken and unknown fields', async () => {
      await http
        .post('/api/admin/organisations')
        .set(auth(root))
        .send({ name: 'Copy', slug: 'itpo', firstAdmin: { email: 'a@b.test' } })
        .expect(409);

      await http
        .post('/api/admin/organisations')
        .set(auth(root))
        .send({ name: 'Extra', slug: 'extra-org', firstAdmin: { email: 'a@b.test' }, plan: 'x' })
        .expect(400);
    });

    it('serves public config by slug and 404 for anything else', async () => {
      const res = await http.get('/api/orgs/itpo/public-config').expect(200);
      expect(res.body).toEqual({
        slug: 'itpo',
        name: 'Bharat Mandapam (ITPO)',
        branding: expect.objectContaining({ primaryColor: '#0b5394', fontFamily: 'Inter' }),
        locale: { defaultLanguage: 'en', languages: ['en'] },
      });
      expect(res.body).not.toHaveProperty('legal');

      await http.get('/api/orgs/unknown-place/public-config').expect(404);
    });
  });

  describe('access boundaries', () => {
    it('needs a signed-in user for data routes', async () => {
      await http.get('/api/orgs/itpo/members').expect(401);
      await http.get('/api/orgs/itpo/members').set(auth('not-a-token')).expect(401);
    });

    it('keeps the Super Admin out of an organisation it is not a member of', async () => {
      const res = await http.get('/api/orgs/itpo/members').set(auth(root)).expect(403);
      expect(res.body.message).toBe('You do not have access to this organisation.');
    });

    it('keeps members out of the platform console', async () => {
      await http.get('/api/admin/organisations').set(auth(owner)).expect(403);
    });

    it('gives the owner every permission in the catalogue', async () => {
      const res = await http.get('/api/orgs/itpo/context').set(auth(owner)).expect(200);
      expect([...res.body.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
      expect(res.body.membership.role.key).toBe('venue_admin');
    });
  });

  describe('dynamic roles', () => {
    let architect: string;

    beforeAll(async () => {
      const res = await http.get('/api/orgs/itpo/roles').set(auth(owner)).expect(200);
      roles = Object.fromEntries((res.body as RoleRow[]).map((role) => [role.key, role]));
    });

    it('offers event roles only once events exist', () => {
      expect(roles.exhibitor.assignable).toBe(false);
      expect(roles.exhibitor.reason).toMatch(/event/i);
      expect(roles.venue_architect.assignable).toBe(true);
    });

    it('lets the owner invite an architect, who then works within the role', async () => {
      const invited = await http
        .post('/api/orgs/itpo/invitations')
        .set(auth(owner))
        .send({ email: 'arch@itpo.test', roleId: roles.venue_architect.id })
        .expect(201);
      const accepted = await http
        .post(`/api/auth/invitations/${tokenFrom(invited.body.inviteUrl)}/accept`)
        .send({ name: 'Architect', password: 'architect-password' })
        .expect(200);
      architect = accepted.body.accessToken;

      await http.get('/api/orgs/itpo/members').set(auth(architect)).expect(200);
      await http
        .post('/api/orgs/itpo/invitations')
        .set(auth(architect))
        .send({ email: 'x@itpo.test', roleId: roles.venue_architect.id })
        .expect(403);
    });

    it('applies a permission the Super Admin adds to a role on the next request', async () => {
      await http
        .patch(`/api/admin/roles/${roles.venue_architect.id}`)
        .set(auth(root))
        .send({ permissions: [...roles.venue_architect.permissions, 'team.invite'] })
        .expect(200);

      await http
        .post('/api/orgs/itpo/invitations')
        .set(auth(architect))
        .send({ email: 'x@itpo.test', roleId: roles.venue_architect.id })
        .expect(201);
    });

    it('never lets a member give a role with more than they hold', async () => {
      const res = await http
        .post('/api/orgs/itpo/invitations')
        .set(auth(architect))
        .send({ email: 'boss@itpo.test', roleId: roles.venue_admin.id })
        .expect(403);
      expect(res.body.message).toMatch(/permissions you do not have/);
    });

    it('keeps the owner role locked', async () => {
      await http
        .patch(`/api/admin/roles/${roles.venue_admin.id}`)
        .set(auth(root))
        .send({ permissions: [] })
        .expect(409);
      await http.delete(`/api/admin/roles/${roles.venue_admin.id}`).set(auth(root)).expect(409);
    });

    it('creates a role for one organisation only, and refuses a used key', async () => {
      const created = await http
        .post('/api/admin/roles')
        .set(auth(root))
        .send({
          organisationId,
          key: 'itpo_operations',
          name: 'Operations',
          scopeKind: 'organisation',
          permissions: ['team.view', 'org.settings.view'],
        })
        .expect(201);
      expect(created.body.organisation.slug).toBe('itpo');

      const visible = await http.get('/api/orgs/itpo/roles').set(auth(owner)).expect(200);
      expect((visible.body as RoleRow[]).map((role) => role.key)).toContain('itpo_operations');

      await http
        .post('/api/admin/roles')
        .set(auth(root))
        .send({ key: 'itpo_operations', name: 'Clash', scopeKind: 'organisation', permissions: [] })
        .expect(409);

      await http
        .post('/api/admin/roles')
        .set(auth(root))
        .send({
          key: 'bad_role',
          name: 'Bad role',
          scopeKind: 'organisation',
          permissions: ['x.y'],
        })
        .expect(400);

      await http.delete(`/api/admin/roles/${created.body.id}`).set(auth(root)).expect(204);
    });

    it('refuses to delete a role in use', async () => {
      const res = await http
        .post('/api/admin/roles')
        .set(auth(root))
        .send({ key: 'temp_role', name: 'Temporary', scopeKind: 'organisation', permissions: [] })
        .expect(201);
      await http
        .post('/api/orgs/itpo/invitations')
        .set(auth(owner))
        .send({ email: 'temp@itpo.test', roleId: res.body.id })
        .expect(201);
      await http.delete(`/api/admin/roles/${res.body.id}`).set(auth(root)).expect(409);
    });
  });

  describe('team', () => {
    it('protects the last Venue Admin', async () => {
      const members = await http.get('/api/orgs/itpo/members').set(auth(owner)).expect(200);
      const self = (members.body as Array<{ id: string; user: { email: string } }>).find(
        (member) => member.user.email === 'ops@itpo.test',
      )!;

      await http.delete(`/api/orgs/itpo/members/${self.id}`).set(auth(owner)).expect(409);
      await http
        .patch(`/api/orgs/itpo/members/${self.id}`)
        .set(auth(owner))
        .send({ roleId: roles.venue_architect.id })
        .expect(409);
    });

    it('lets an existing account accept with its own password', async () => {
      const second = await http
        .post('/api/admin/organisations')
        .set(auth(root))
        .send({ name: 'Yashobhoomi', slug: 'yashobhoomi', firstAdmin: { email: 'ops@itpo.test' } })
        .expect(201);
      const token = tokenFrom(second.body.invitation.inviteUrl);

      const preview = await http.get(`/api/auth/invitations/${token}`).expect(200);
      expect(preview.body.accountExists).toBe(true);

      await http
        .post(`/api/auth/invitations/${token}/accept`)
        .send({ password: 'wrong-password-here' })
        .expect(401);
      const accepted = await http
        .post(`/api/auth/invitations/${token}/accept`)
        .send({ password: 'itpo-ops-password' })
        .expect(200);

      const me = await http.get('/api/auth/me').set(auth(accepted.body.accessToken)).expect(200);
      expect(
        me.body.memberships.map((m: { organisation: { slug: string } }) => m.organisation.slug),
      ).toEqual(['itpo', 'yashobhoomi']);
    });
  });

  describe('organisation settings', () => {
    const config = {
      branding: {
        primaryColor: '#0B5394',
        accentColor: '',
        fontFamily: 'Poppins',
        logoUrl: 'https://example.com/itpo.svg',
        logoDarkUrl: null,
        faviconUrl: null,
      },
      locale: {
        defaultLanguage: 'en',
        languages: ['en', 'hi'],
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      },
      legal: {
        legalName: 'India Trade Promotion Organisation',
        gstin: '07AAACI1681G1ZN',
        address: 'Pragati Maidan, New Delhi',
        invoicePrefix: 'ITPO-',
        supportEmail: 'help@itpo.test',
      },
      email: { senderName: 'ITPO', replyTo: null, footer: null },
    };

    it('saves each change as a new version and restores an old one forward', async () => {
      const saved = await http
        .put('/api/orgs/itpo/settings/config')
        .set(auth(owner))
        .send(config)
        .expect(200);
      expect(saved.body.configVersion).toBe(2);
      expect(saved.body.config.branding.accentColor).toBeNull();

      const restored = await http
        .post('/api/orgs/itpo/settings/config/versions/1/restore')
        .set(auth(owner))
        .expect(201);
      expect(restored.body.configVersion).toBe(3);
      expect(restored.body.config.branding.fontFamily).toBe('Inter');

      const versions = await http
        .get('/api/orgs/itpo/settings/config/versions')
        .set(auth(owner))
        .expect(200);
      expect(versions.body.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    });

    it('validates the configuration', async () => {
      await http
        .put('/api/orgs/itpo/settings/config')
        .set(auth(owner))
        .send({ ...config, branding: { ...config.branding, logoUrl: 'javascript:alert(1)' } })
        .expect(400);
      await http
        .put('/api/orgs/itpo/settings/config')
        .set(auth(owner))
        .send({ ...config, locale: { ...config.locale, defaultLanguage: 'hi', languages: ['en'] } })
        .expect(400);
    });
  });

  describe('links and status', () => {
    it('keeps an old slug working after a rename', async () => {
      await http
        .put(`/api/admin/organisations/${organisationId}/slug`)
        .set(auth(root))
        .send({ slug: 'bharat-mandapam' })
        .expect(200);

      const res = await http.get('/api/orgs/itpo/public-config').expect(200);
      expect(res.body.slug).toBe('bharat-mandapam');

      // Data routes use the current slug only.
      await http.get('/api/orgs/itpo/context').set(auth(owner)).expect(404);
      await http.get('/api/orgs/bharat-mandapam/context').set(auth(owner)).expect(200);
    });

    it('hides a suspended organisation completely and brings it back', async () => {
      await http
        .post(`/api/admin/organisations/${organisationId}/suspend`)
        .set(auth(root))
        .send({ reason: 'Contract paused' })
        .expect(201);
      await http.get('/api/orgs/bharat-mandapam/public-config').expect(404);
      await http.get('/api/orgs/bharat-mandapam/context').set(auth(owner)).expect(404);

      await http
        .post(`/api/admin/organisations/${organisationId}/activate`)
        .set(auth(root))
        .expect(201);
      await http.get('/api/orgs/bharat-mandapam/public-config').expect(200);
    });

    it('records the actions in the audit log', async () => {
      const res = await http
        .get(`/api/admin/audit?organisationId=${organisationId}&pageSize=100`)
        .set(auth(root))
        .expect(200);
      const actions = new Set(res.body.items.map((item: { action: string }) => item.action));
      for (const action of [
        'organisation.created',
        'invitation.created',
        'invitation.accepted',
        'organisation.config_updated',
        'organisation.config_restored',
        'organisation.slug_changed',
        'organisation.suspended',
        'organisation.activated',
      ]) {
        expect(actions).toContain(action);
      }
    });
  });

  describe('sessions', () => {
    it('rotates the refresh token and detects reuse of an old one', async () => {
      const { cookie } = await login(app, 'arch@itpo.test', 'architect-password');

      const first = await http.post('/api/auth/refresh').set('Cookie', cookie).expect(200);
      const next = refreshCookie(first);
      expect(next).not.toBe(cookie);

      // The old token again, right away: a race between tabs, so retry later — not a theft.
      await http.post('/api/auth/refresh').set('Cookie', cookie).expect(409);

      await http.post('/api/auth/refresh').set('Cookie', next).expect(200);
    });

    it('ends the session on logout', async () => {
      const { cookie } = await login(app, 'arch@itpo.test', 'architect-password');
      await http.post('/api/auth/logout').set('Cookie', cookie).expect(204);
      await http.post('/api/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('resets a password through the emailed link and signs out everywhere', async () => {
      const { cookie } = await login(app, 'arch@itpo.test', 'architect-password');
      const sent = jest.spyOn(app.get(MailService), 'send');

      await http
        .post('/api/auth/forgot-password')
        .send({ email: 'arch@itpo.test', orgSlug: 'bharat-mandapam' })
        .expect(204);
      await http.post('/api/auth/forgot-password').send({ email: 'nobody@itpo.test' }).expect(204);

      expect(sent).toHaveBeenCalledTimes(1);
      const link = /https?:\/\/\S+/.exec(sent.mock.calls[0][0].text)![0];
      expect(link).toContain('/bharat-mandapam/reset-password');

      await http
        .post('/api/auth/reset-password')
        .send({ token: tokenFrom(link), password: 'a-brand-new-password' })
        .expect(204);
      await http.post('/api/auth/refresh').set('Cookie', cookie).expect(401);
      await login(app, 'arch@itpo.test', 'a-brand-new-password');
      await http
        .post('/api/auth/reset-password')
        .send({ token: tokenFrom(link), password: 'yet-another-password' })
        .expect(401);
    });
  });
});
