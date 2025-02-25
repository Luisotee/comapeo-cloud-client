import { Type } from '@sinclair/typebox'

import crypto from 'node:crypto'

import * as errors from '../errors.js'
import * as schemas from '../schemas.js'
import { verifyBearerAuth } from './utils.js'

/**
 * Generate a secure random token
 * @returns {string} 32 byte hex token
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * @typedef {object} RouteOptions
 * @prop {string} serverBearerToken
 */

/** @type {import('fastify').FastifyPluginAsync<RouteOptions>} */
export default async function authRoutes(fastify, opts) {
  const { serverBearerToken } = opts
  if (!fastify.db) {
    throw new Error('Database plugin not registered')
  }

  // POST /auth/register
  fastify.post(
    '/auth/register',
    {
      schema: {
        body: Type.Object({
          phoneNumber: Type.String(),
          projectName: Type.String(),
        }),
        response: {
          200: Type.Object({
            data: Type.Object({
              phoneNumber: Type.String(),
              projectName: Type.String(),
            }),
          }),
          '4xx': schemas.errorResponse,
        },
      },
      async preHandler(req) {
        verifyBearerAuth(req, serverBearerToken)
      },
    },
    async (req) => {
      const { phoneNumber, projectName } =
        /** @type {import('fastify').FastifyRequest<{Body: {phoneNumber: string, projectName: string}}>} */ (
          req
        ).body
      fastify.log.info(
        `Attempting coordinator registration for phone: ${phoneNumber}`,
      )

      // Decode project name
      const decodedProjectName = decodeURIComponent(projectName)

      // Check if coordinator already exists
      const existingCoordinator = fastify.db.findCoordinatorByPhone(phoneNumber)
      if (existingCoordinator) {
        fastify.log.info(
          `Coordinator exists with project: ${existingCoordinator.projectName}, will be removed`,
        )
        // Delete existing coordinator
        fastify.db.deleteCoordinatorByPhone(phoneNumber)
        fastify.log.info(`Deleted existing coordinator: ${phoneNumber}`)
      }

      // Check if project name already exists
      const existingProjectCoordinator =
        fastify.db.findCoordinatorByProject(decodedProjectName)
      if (existingProjectCoordinator) {
        fastify.log.warn(`Project name already exists: ${decodedProjectName}`)
        throw errors.conflictError('Project name already exists')
      }

      const projects = await fastify.comapeo.listProjects()
      const existingProject = projects.find(
        (p) => p.name === decodedProjectName,
      )
      if (existingProject) {
        fastify.log.warn(`Project name already exists: ${decodedProjectName}`)
        throw errors.conflictError('Project name already exists')
      }

      // Create new coordinator
      const coordinator = {
        phoneNumber,
        projectName: decodedProjectName,
        createdAt: new Date().toISOString(),
      }

      fastify.db.saveCoordinator(coordinator)
      fastify.log.info(
        `Registered new coordinator for project: ${decodedProjectName}`,
      )

      return {
        data: {
          phoneNumber: coordinator.phoneNumber,
          projectName: coordinator.projectName,
        },
      }
    },
  )

  // DELETE /auth/unregister
  fastify.delete(
    '/auth/unregister',
    {
      schema: {
        body: Type.Object({
          phoneNumber: Type.String(),
        }),
        response: {
          200: Type.Object({
            data: Type.Object({
              message: Type.String(),
            }),
          }),
          '4xx': schemas.errorResponse,
        },
      },
      async preHandler(req) {
        verifyBearerAuth(req, serverBearerToken)
      },
    },
    async (req) => {
      const { phoneNumber } =
        /** @type {import('fastify').FastifyRequest<{Body: {phoneNumber: string}}>} */ (
          req
        ).body

      fastify.log.info(`Attempting to unregister coordinator: ${phoneNumber}`)

      // Check if coordinator exists
      const coordinator = fastify.db.findCoordinatorByPhone(phoneNumber)
      if (!coordinator) {
        fastify.log.warn(`No coordinator found for phone: ${phoneNumber}`)
        throw errors.notFoundError('Coordinator not found')
      }

      // Delete coordinator
      fastify.db.deleteCoordinatorByPhone(phoneNumber)
      fastify.log.info(`Successfully unregistered coordinator: ${phoneNumber}`)

      return {
        data: {
          message: 'Coordinator successfully unregistered',
        },
      }
    },
  )

  // POST /auth/coordinator
  fastify.post(
    '/auth/coordinator',
    {
      schema: {
        body: Type.Object({
          phoneNumber: Type.String(),
          projectName: Type.String(),
        }),
        response: {
          200: Type.Object({
            data: Type.Object({
              token: Type.String(),
              projectName: Type.String(),
            }),
          }),
          '4xx': schemas.errorResponse,
        },
      },
      async preHandler(req) {
        verifyBearerAuth(req, serverBearerToken)
      },
    },
    async (req) => {
      const { phoneNumber, projectName } =
        /** @type {import('fastify').FastifyRequest<{Body: {phoneNumber: string, projectName: string}}>} */ (
          req
        ).body
      fastify.log.info(`Attempting coordinator login for phone: ${phoneNumber}`)
      // Look up coordinator
      const coordinator = fastify.db.findCoordinatorByPhone(phoneNumber)
      if (!coordinator) {
        fastify.log.warn(`No coordinator found for phone: ${phoneNumber}`)
        throw errors.unauthorizedError('Invalid phone number or project name')
      }
      fastify.log.info(
        `Found coordinator with project: ${coordinator.projectName}`,
      )

      // Verify project name
      if (coordinator.projectName !== projectName) {
        fastify.log.warn(
          `Invalid project name provided for coordinator: ${phoneNumber}`,
        )
        throw errors.unauthorizedError('Invalid phone number or project name')
      }
      fastify.log.info('Coordinator project name verified')

      // Decode project name
      const decodedProjectName = decodeURIComponent(coordinator.projectName)

      // Verify project exists
      const projects = await fastify.comapeo.listProjects()
      fastify.log.debug(`Found ${projects.length} total projects`)
      const project = projects.find((p) => p.name === decodedProjectName)
      if (!project) {
        fastify.log.error(`Project not found: ${decodedProjectName}`)
        throw errors.projectNotFoundError()
      }
      fastify.log.info(`Found matching project: ${project.name}`)

      // Generate and save token
      const token = generateToken()
      fastify.log.debug('Generated new token for coordinator')
      fastify.db.saveCoordinator({
        ...coordinator,
        token,
        createdAt: new Date().toISOString(),
      })
      fastify.log.info('Saved coordinator with new token')

      return {
        data: {
          token,
          projectName: coordinator.projectName,
        },
      }
    },
  )

  // POST /auth/member
  fastify.post(
    '/auth/member',
    {
      schema: {
        headers: Type.Object({
          authorization: Type.String(),
        }),
        body: Type.Object({
          coordPhoneNumber: Type.String(),
          memberPhoneNumber: Type.String(),
        }),
        response: {
          200: Type.Object({
            data: Type.Object({
              token: Type.String(),
            }),
          }),
          '4xx': schemas.errorResponse,
        },
      },
    },
    async (req) => {
      try {
        fastify.log.info('POST /auth/member request received')

        const { coordPhoneNumber, memberPhoneNumber } =
          /** @type {{coordPhoneNumber: string, memberPhoneNumber: string}} */ (
            req.body
          )

        // Find coordinator and their token
        const coordinator = fastify.db.findCoordinatorByPhone(coordPhoneNumber)
        if (!coordinator || !coordinator.token) {
          fastify.log.warn(
            `No coordinator found for phone: ${coordPhoneNumber}`,
          )
          throw errors.unauthorizedError('Invalid coordinator phone number')
        }
        fastify.log.info(
          `Found coordinator with phone: ${coordinator.phoneNumber}`,
        )

        // Get project name for coordinator
        const projectName =
          fastify.db.findProjectByCoordinatorPhone(coordPhoneNumber)
        if (!projectName) {
          fastify.log.warn(
            `No project found for coordinator: ${coordPhoneNumber}`,
          )
          throw errors.unauthorizedError('No project found for coordinator')
        }
        fastify.log.info(`Found project: ${projectName} for coordinator`)

        // Verify bearer token matches coordinator's token
        verifyBearerAuth(req, coordinator.token)

        fastify.log.info(
          `Attempting to register member with phone: ${memberPhoneNumber}`,
        )

        // Validate phone number format
        if (!/^\+?[1-9]\d{1,14}$/u.test(memberPhoneNumber)) {
          fastify.log.warn(`Invalid phone number format: ${memberPhoneNumber}`)
          throw errors.badRequestError('Invalid phone number format')
        }
        fastify.log.debug('Phone number format validated')

        // Check if member already exists
        const existingMember = fastify.db.findMemberByPhone(memberPhoneNumber)
        if (existingMember) {
          fastify.log.warn(
            `Member already exists with phone: ${memberPhoneNumber}`,
          )
          throw errors.badRequestError('Phone number already registered')
        }
        fastify.log.debug('Verified member does not exist')

        // Generate member token and save record
        const memberToken = generateToken()
        fastify.log.debug('Generated new token for member')

        fastify.db.saveMember({
          phoneNumber: memberPhoneNumber,
          token: memberToken,
          coordinatorPhone: coordinator.phoneNumber,
          projectName,
          createdAt: new Date().toISOString(),
        })
        fastify.log.info(
          `Successfully registered member with phone: ${memberPhoneNumber}`,
        )

        return {
          data: {
            token: memberToken,
            projectName,
          },
        }
      } catch (err) {
        fastify.log.error('Error registering member:', err)
        throw err
      }
    },
  )
}
