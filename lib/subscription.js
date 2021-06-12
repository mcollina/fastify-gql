'use strict'

const fastifyWebsocket = require('fastify-websocket')
const { assignLifeCycleHooksToContext, Hooks } = require('./hooks')
const { kHooks } = require('./symbols')
const SubscriptionConnection = require('./subscription-connection')
const GRAPHQL_WS = 'graphql-ws'

function createConnectionHandler ({ subscriber, fastify, onConnect, onDisconnect, lruGatewayResolvers, entityResolversFactory, subscriptionContextFn }) {
  return async (connection, request) => {
    const { socket } = connection
    if (socket.protocol === undefined ||
      (socket.protocol.indexOf(GRAPHQL_WS) === -1)) {
      // Close the connection with an error code, ws v2 ensures that the
      // connection is cleaned up even when the closing handshake fails.
      // 1002: protocol error
      socket.close(1002)

      return
    }

    let context = {
      app: fastify,
      pubsub: subscriber
    }

    if (context.app.graphql && context.app.graphql[kHooks]) {
      context = assignLifeCycleHooksToContext(context.app.graphql[kHooks], context)
    } else {
      context = assignLifeCycleHooksToContext(new Hooks(), context)
    }

    let resolveContext

    if (subscriptionContextFn) {
      resolveContext = () => subscriptionContextFn(connection, request)
    }

    const subscriptionConnection = new SubscriptionConnection(socket, {
      subscriber,
      fastify,
      onConnect,
      onDisconnect,
      lruGatewayResolvers,
      entityResolversFactory,
      context,
      resolveContext
    })

    /* istanbul ignore next */
    connection.socket.on('error', () => {
      subscriptionConnection.close()
    })
    connection.socket.on('close', () => {
      subscriptionConnection.close()
    })
  }
}

module.exports = function (fastify, opts, next) {
  const { getOptions, subscriber, verifyClient, onConnect, onDisconnect, lruGatewayResolvers, entityResolversFactory, subscriptionContextFn } = opts

  // If `fastify.websocketServer` exists, it means `fastify-websocket` already registered.
  // Without this check, fastify-websocket will be registered multiple times and raises FST_ERR_DEC_ALREADY_PRESENT.
  if (fastify.websocketServer === undefined) {
    fastify.register(fastifyWebsocket, {
      options: {
        maxPayload: 1048576,
        verifyClient
      }
    })
  }

  fastify.route({
    ...getOptions,
    wsHandler: createConnectionHandler({
      subscriber,
      fastify,
      onConnect,
      onDisconnect,
      lruGatewayResolvers,
      entityResolversFactory,
      subscriptionContextFn
    })
  })

  next()
}
