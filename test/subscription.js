const { test } = require('tap')
const Fastify = require('fastify')
const websocket = require('websocket-stream')
const mq = require('mqemitter')
const GQL = require('..')

test('subscription server replies with connection_ack', t => {
  const app = Fastify()
  t.tearDown(() => app.close())

  const emitter = mq()
  const schema = `
    type Query {
      add(x: Int, y: Int): Int
    }
  `

  const resolvers = {
    Query: {
      add: (parent, { x, y }) => x + y
    }
  }

  app.register(GQL, {
    schema,
    resolvers,
    subscription: {
      emitter
    }
  })

  app.listen(0, err => {
    t.error(err)

    const client = websocket('ws://localhost:' + (app.server.address()).port + '/graphql', 'graphql-ws')
    t.tearDown(client.destroy.bind(client))

    client.setEncoding('utf8')
    client.write(JSON.stringify({
      type: 'connection_init'
    }))
    client.on('data', chunk => {
      t.equal(chunk, JSON.stringify({
        type: 'connection_ack'
      }))
      client.end()
      t.end()
    })
  })
})

test('subscription server sends update to subscriptions', t => {
  const app = Fastify()
  t.tearDown(() => app.close())

  const emitter = mq()
  const schema = `
    type Notification {
      id: ID!
      message: String
    }

    type Query {
      notifications: [Notification]
    }

    type Mutation {
      addNotification(message: String): Notification
    }

    type Subscription {
      notificationAdded: Notification
    }
  `

  let idCount = 1
  const notifications = [{
    id: idCount,
    message: 'Notification message'
  }]

  const resolvers = {
    Query: {
      notifications: () => notifications
    },
    Mutation: {
      addNotification: (_, { message }) => {
        const id = idCount++
        const notification = {
          id,
          message
        }
        notifications.push(notification)
        emitter.emit({
          topic: 'NOTIFICATION_ADDED',
          payload: {
            notificationAdded: notification
          }
        })

        return notification
      }
    },
    Subscription: {
      notificationAdded: {
        subscribe: (root, args, { pubsub }) => pubsub.subscribe('NOTIFICATION_ADDED')
      }
    }
  }

  app.register(GQL, {
    schema,
    resolvers,
    subscription: {
      emitter
    }
  })

  app.listen(0, err => {
    t.error(err)
    let messageCount = 0

    const client = websocket('ws://localhost:' + (app.server.address()).port + '/graphql', 'graphql-ws', {
      objectMode: true
    })
    t.tearDown(client.destroy.bind(client))
    client.setEncoding('utf8')

    client.write(JSON.stringify({
      type: 'connection_init'
    }))

    client.write(JSON.stringify({
      id: 1,
      type: 'start',
      payload: {
        query: `
          subscription {
            notificationAdded {
              id
              message
            }
          }
        `
      }
    }))

    client.on('data', chunk => {
      messageCount++
      if (messageCount === 2) {
        t.equal(chunk, JSON.stringify({
          type: 'data',
          id: 1,
          payload: {
            data: {
              notificationAdded: {
                id: '1',
                message: 'Hello World'
              }
            }
          }
        }))

        client.end()
        t.end()
      }
    })

    setTimeout(() => {
      app.inject({
        method: 'POST',
        url: '/graphql',
        body: {
          query: `
            mutation {
              addNotification(message: "Hello World") {
                id
              }
            }
          `
        }
      })
    }, 1000)
  })
})
