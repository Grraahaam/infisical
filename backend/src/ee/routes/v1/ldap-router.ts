/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
// All the any rules are disabled because passport typesense with fastify is really poor

import { IncomingMessage } from "node:http";

import { Authenticator } from "@fastify/passport";
import fastifySession from "@fastify/session";
import { FastifyRequest } from "fastify";
import LdapStrategy from "passport-ldapauth";
import { z } from "zod";

import { LdapConfigsSchema } from "@app/db/schemas";
import { getConfig } from "@app/lib/config/env";
import { logger } from "@app/lib/logger";
import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
import { AuthMode } from "@app/services/auth/auth-type";

export const registerLdapRouter = async (server: FastifyZodProvider) => {
  const appCfg = getConfig();
  const passport = new Authenticator({ key: "ldap", userProperty: "passportUser" });
  await server.register(fastifySession, { secret: appCfg.COOKIE_SECRET_SIGN_KEY });
  await server.register(passport.initialize());
  await server.register(passport.secureSession());

  const getLdapPassportOpts = (req: FastifyRequest, done: any) => {
    const { organizationSlug } = req.body as {
      organizationSlug: string;
    };

    process.nextTick(async () => {
      try {
        const { opts, ldapConfig } = await server.services.ldap.bootLdap(organizationSlug);
        req.ldapConfig = ldapConfig;
        done(null, opts);
      } catch (err) {
        done(err);
      }
    });
  };

  passport.use(
    new LdapStrategy(
      getLdapPassportOpts as any,
      // eslint-disable-next-line
      async (req: IncomingMessage, user, cb) => {
        try {
          const { isUserCompleted, providerAuthToken } = await server.services.ldap.ldapLogin({
            externalId: user.uidNumber,
            username: user.uid,
            firstName: user.givenName,
            lastName: user.sn,
            emails: user.mail ? [user.mail] : [],
            relayState: ((req as unknown as FastifyRequest).body as { RelayState?: string }).RelayState,
            orgId: (req as unknown as FastifyRequest).ldapConfig.organization
          });

          return cb(null, { isUserCompleted, providerAuthToken });
        } catch (err) {
          logger.error(err);
          return cb(err, false);
        }
      }
    )
  );

  server.route({
    url: "/login",
    method: "POST",
    schema: {
      body: z.object({
        organizationSlug: z.string().trim()
      })
    },
    preValidation: passport.authenticate("ldapauth", {
      session: false
      // failureFlash: true,
      // failureRedirect: "/login/provider/error"
      // this is due to zod type difference
    }) as any,
    handler: (req, res) => {
      let nextUrl;
      if (req.passportUser.isUserCompleted) {
        nextUrl = `${appCfg.SITE_URL}/login/sso?token=${encodeURIComponent(req.passportUser.providerAuthToken)}`;
      } else {
        nextUrl = `${appCfg.SITE_URL}/signup/sso?token=${encodeURIComponent(req.passportUser.providerAuthToken)}`;
      }

      return res.status(200).send({
        nextUrl
      });
    }
  });

  server.route({
    url: "/config",
    method: "GET",
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      querystring: z.object({
        organizationId: z.string().trim()
      }),
      response: {
        200: z.object({
          id: z.string(),
          organization: z.string(),
          isActive: z.boolean(),
          url: z.string(),
          bindDN: z.string(),
          bindPass: z.string(),
          searchBase: z.string(),
          caCert: z.string()
        })
      }
    },
    handler: async (req) => {
      const ldap = await server.services.ldap.getLdapCfgWithPermissionCheck({
        actor: req.permission.type,
        actorId: req.permission.id,
        orgId: req.query.organizationId,
        actorOrgId: req.permission.orgId
      });
      return ldap;
    }
  });

  server.route({
    url: "/config",
    method: "POST",
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      body: z.object({
        organizationId: z.string().trim(),
        isActive: z.boolean(),
        url: z.string().trim(),
        bindDN: z.string().trim(),
        bindPass: z.string().trim(),
        searchBase: z.string().trim(),
        caCert: z.string().trim().default("")
      }),
      response: {
        200: LdapConfigsSchema
      }
    },
    handler: async (req) => {
      const ldap = await server.services.ldap.createLdapCfg({
        actor: req.permission.type,
        actorId: req.permission.id,
        orgId: req.body.organizationId,
        actorOrgId: req.permission.orgId,
        ...req.body
      });

      return ldap;
    }
  });

  server.route({
    url: "/config",
    method: "PATCH",
    onRequest: verifyAuth([AuthMode.JWT]),
    schema: {
      body: z
        .object({
          isActive: z.boolean(),
          url: z.string().trim(),
          bindDN: z.string().trim(),
          bindPass: z.string().trim(),
          searchBase: z.string().trim(),
          caCert: z.string().trim()
        })
        .partial()
        .merge(z.object({ organizationId: z.string() })),
      response: {
        200: LdapConfigsSchema
      }
    },
    handler: async (req) => {
      const ldap = await server.services.ldap.updateLdapCfg({
        actor: req.permission.type,
        actorId: req.permission.id,
        orgId: req.body.organizationId,
        actorOrgId: req.permission.orgId,
        ...req.body
      });

      return ldap;
    }
  });
};
