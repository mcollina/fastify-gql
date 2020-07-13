'use strict'

const { join } = require('path')
const Static = require('fastify-static')
const { BadRequest } = require('http-errors')
const { formatError, GraphQLError } = require('graphql')
const subscription = require('./subscription')
const { FEDERATED_ERROR, toGraphQLError } = require('./errors')

const responseProperties = {
  data: {
    type: ['object', 'null'],
    additionalProperties: true
  },
  errors: {
    type: 'array',
    items: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        locations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              line: { type: 'integer' },
              column: { type: 'integer' }
            }
          }
        },
        path: {
          type: 'array',
          items: { type: 'string' }
        },
        extensions: {
          type: 'object',
          properties: {
            code: { type: 'string' }
          },
          additionalProperties: true
        }
      }
    }
  }
}

const requestProperties = {
  query: {
    type: 'string'
  },
  persisted: {
    type: 'boolean'
  },
  operationName: {
    type: 'string'
  }
}

const getSchema = {
  querystring: {
    type: 'object',
    properties: {
      ...requestProperties,
      variables: {
        type: 'string' // Stringified JSON
      }
    }
  },
  response: {
    '2xx': {
      type: 'object',
      properties: responseProperties
    }
  }
}

const postSchema = (allowBatchedQueries) => ({
  body: {
    type: allowBatchedQueries ? ['object', 'array'] : 'object',
    properties: {
      ...requestProperties,
      variables: {
        type: ['object', 'null']
      },
      extensions: {
        type: 'object'
      }
    }
  },
  // JSON schema isn't allowing ['object', 'array'] on response.
  response: allowBatchedQueries ? {} : {
    '2xx': {
      type: 'object',
      properties: responseProperties
    }
  }
})

async function defaultErrorHandler (err, request, reply) {
  if (err.data) {
    reply.code(200)
  } else {
    reply.code(err.statusCode || 500)
  }

  if (err.errors) {
    const errors = err.errors.map((error, idx) => {
      // parses, converts & combines errors if they are the result of a federated request
      if (error.message === FEDERATED_ERROR.toString()) {
        return error.extensions.errors.map(err => formatError(toGraphQLError(err)))
      }
      return error instanceof GraphQLError ? formatError(error) : { message: error.message }
      // as the result of the outer map could potentially contain arrays with federated errors
      // the result needs to be flattened
    }).reduce((acc, val) => acc.concat(val), [])

    return { errors, data: err.data || null }
  } else {
    return {
      errors: [
        { message: err.message }
      ],
      data: err.data || null
    }
  }
}

function validationHandler (validationError) {
  if (validationError) {
    const err = new BadRequest()
    err.errors = [validationError]
    throw err
  }
}

module.exports = async function (app, opts) {
  if (typeof opts.errorHandler === 'function') {
    app.setErrorHandler(opts.errorHandler)
  } else if (opts.errorHandler === true || opts.errorHandler === undefined) {
    app.setErrorHandler(defaultErrorHandler)
  }
  const contextFn = opts.context

  const {
    path: graphqlPath = '/graphql',
    subscriber,
    verifyClient,
    lruGatewayResolvers,
    entityResolversFactory,
    persistedQueryProvider,
    allowBatchedQueries
  } = opts

  // Load the persisted query settings
  const {
    isPersistedQuery,
    getHash,
    getQueryFromHash,
    getHashForQuery,
    saveQuery,
    notFoundError,
    notSupportedError
  } = persistedQueryProvider || {}

  async function executeQuery (query, variables, operationName, request, reply) {
    // Validate a query is present
    if (!query) {
      return new BadRequest('Unknown query')
    }

    // Generate the context for this request
    let context = {}
    if (contextFn) {
      context = await contextFn(request, reply)
    }

    // Handle the query, throwing an error if required
    return reply.graphql(query, { pubsub: subscriber, ...context, __currentQuery: query }, variables, operationName)
  }

  function executeRegularQuery (body, request, reply) {
    const { query, operationName, variables } = body
    return executeQuery(query, variables, operationName, request, reply)
  }

  async function executePersistedQuery (body, request, reply) {
    let { query } = body
    const { operationName, variables } = body

    // Verify if a query matches the persisted format
    const persisted = isPersistedQuery(body)
    if (persisted) {
      // This is a peristed query, so we use the hash in the request
      // to load the full query string.

      // Extract the hash from the request
      const hash = getHash && getHash(body)
      if (hash) {
        // Load the query for the provided hash
        query = await getQueryFromHash(hash)

        if (!query) {
          // Query has not been found, tell the client
          throw new BadRequest(notFoundError)
        }

        // The query has now been set to the full query string
      } else {
        // This client should stop sending persisted queries,
        // as we do not recognise them
        throw new BadRequest(notSupportedError)
      }
    }

    // Execute the query
    const result = await executeQuery(query, variables, operationName, request, reply)

    // Only save queries which are not yet persisted
    if (!persisted && query) {
      // If provided the getHashForQuery, saveQuery settings we save this query
      const hash = getHashForQuery && getHashForQuery(query)
      if (hash) {
        try {
          await saveQuery(hash, query)
        } catch (err) {
          request.log.warn({ err, hash, query }, 'Failed to persist query')
        }
      }
    }

    // Return the result
    return result
  }

  const execute = persistedQueryProvider ? executePersistedQuery : executeRegularQuery

  const getOptions = {
    url: graphqlPath,
    method: 'GET',
    schema: getSchema,
    attachValidation: true,
    handler: async function (request, reply) {
      validationHandler(request.validationError)

      // Parse variables from stringified JSON
      let { variables } = request.query
      if (variables) {
        try {
          variables = JSON.parse(variables)
        } catch (err) {
          request.log.info({ err: err })
          return reply.send(new BadRequest(err.message))
        }
      }

      return execute({
        ...request.query,
        variables
      }, request, reply)
    }
  }

  if (subscriber) {
    app.register(subscription, {
      getOptions,
      schema: opts.schema,
      subscriber,
      verifyClient,
      lruGatewayResolvers,
      entityResolversFactory
    })
  } else {
    app.route(getOptions)
  }

  app.addContentTypeParser('application/graphql', { parseAs: 'string' }, function (req, payload, done) {
    done(null, { query: payload })
  })

  app.post(graphqlPath, {
    schema: postSchema(allowBatchedQueries),
    attachValidation: true
  }, async function (request, reply) {
    validationHandler(request.validationError)

    if (allowBatchedQueries && Array.isArray(request.body)) {
      // Batched query
      return Promise.all(request.body.map(r =>
        execute(r, request, reply)
          .catch(e => ({ errors: [{ message: e.message }] }))
      ))
    } else {
      // Regular query
      return execute(request.body, request, reply)
    }
  })

  if (opts.ide || opts.graphiql) {
    app.register(Static, {
      root: join(__dirname, '../static'),
      wildcard: false,
      serve: false
    })

    if (opts.ide === true || opts.ide === 'graphiql' || opts.graphiql === true) {
      app.get('/graphiql', (req, reply) => {
        reply.sendFile('graphiql.html')
      })

      app.get('/graphiql/main.js', (req, reply) => {
        reply.sendFile('main.js')
      })

      app.get('/graphiql/sw.js', (req, reply) => {
        reply.sendFile('sw.js')
      })

      app.get('/graphiql/config.js', (req, reply) => {
        reply
          .header('Content-Type', 'application/javascript')
          .send(`window.GRAPHQL_ENDPOINT = '${graphqlPath}'`)
      })
    }
    if (opts.ide === 'playground') {
      app.get('/playground', (req, reply) => {
        reply.sendFile('playground.html')
      })
      app.get('/playground/init.js', (req, reply) => {
        reply
          .header('Content-Type', 'application/javascript')
          .send(`window.addEventListener('load', function(event) {
          GraphQLPlayground.init(document.getElementById('root'), {
            subscriptionEndpoint: '${graphqlPath}',
            endpoint: '${graphqlPath}',
          });
        });`)
      })
    }
  }
}
